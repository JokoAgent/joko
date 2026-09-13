import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import ssh2, { type ParsedKey } from "ssh2";
import { encodeAgentPrivateKey } from "./agent-private-key.js";
import { createPrivateFile, PrivateFileCreationError } from "./create-private-file.js";
import { assertSshPrivateKeyInput } from "./key-input-policy.js";

const MAXIMUM_KEY_BYTES = 64 * 1024;
const MAXIMUM_PUBLIC_BYTES = 4096;
const MAXIMUM_KEYS = 512;

export type SshKeyFailure = "invalid_name" | "invalid_key" | "bad_passphrase" | "key_changed" | "not_found"
  | "agent_unavailable" | "agent_failed" | "busy" | "aborted" | "outcome_unknown" | "io_failed";
export class SshKeyError extends Error {
  constructor(readonly code: SshKeyFailure) { super(`ssh_key.${code}`); this.name = "SshKeyError"; }
}
export interface SshKeyInfo {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  readonly comment: string;
  readonly sha256Fingerprint: string;
  readonly modifiedAt: number;
  readonly inAgent: boolean;
}
export interface SshKeyCatalog {
  readonly keys: readonly SshKeyInfo[];
  readonly agentState: "ready" | "unavailable" | "failed";
  readonly generationSupported: boolean;
}
export interface SshAgentCommandResult { readonly code: number; readonly stdout: string; }
export type SshAgentCommand = (args: readonly string[], input: Buffer | undefined, signal: AbortSignal) => Promise<SshAgentCommandResult>;
export interface SshKeyManagerOptions {
  /** Fixed by the service composition. No client path reaches this option. */
  readonly directory?: string;
  readonly agentCommand?: SshAgentCommand;
}

/** Owns node-local SSH identities; no private bytes are returned by its public API. */
export class SshKeyManager {
  readonly #directory: string;
  readonly #agent: SshAgentCommand;
  readonly #lifetime = new AbortController();
  #mutating = false;
  constructor(options: SshKeyManagerOptions = {}) {
    this.#directory = resolve(options.directory ?? join(homedir(), ".ssh"));
    this.#agent = options.agentCommand ?? runSshAgentCommand;
  }

  async list(signal: AbortSignal): Promise<SshKeyCatalog> {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    abortIfNeeded(signal);
    const exists = await this.#root(false);
    const keys: SshKeyInfo[] = [];
    if (exists) {
      const directory = await readdir(this.#directory, { withFileTypes: true });
      if (directory.length > MAXIMUM_KEYS * 4) throw new SshKeyError("io_failed");
      for (const entry of directory) {
        abortIfNeeded(signal);
        if (!entry.isFile() || !entry.name.endsWith(".pub")) continue;
        const id = entry.name.slice(0, -4);
        try {
          validateName(id);
          const key = await this.#public(id);
          const privateFile = await this.#openRegular(id, MAXIMUM_KEY_BYTES);
          await privateFile.close();
          keys.push(key.info);
        } catch (error) {
          if (!(error instanceof SshKeyError)) throw new SshKeyError("io_failed");
          // Unsupported, incomplete or unsafe pairs are not selectable identities.
        }
        if (keys.length > MAXIMUM_KEYS) throw new SshKeyError("io_failed");
      }
    }
    let agentState: SshKeyCatalog["agentState"] = "unavailable";
    const agentFingerprints = new Set<string>();
    try {
      const result = await this.#agent(["-L"], undefined, signal);
      if (result.code === 0) {
        agentState = "ready";
        for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
          try { agentFingerprints.add(fingerprint(parsePublic(line))); }
          catch { agentState = "failed"; agentFingerprints.clear(); break; }
        }
      } else if (result.code === 1 && result.stdout.trim() === "The agent has no identities.") {
        agentState = "ready";
      } else if (result.code !== 2) agentState = "failed";
    } catch (error) {
      if (signal.aborted) throw new SshKeyError("aborted");
      if (!(error instanceof SshKeyError) || error.code !== "agent_unavailable") agentState = "failed";
    }
    abortIfNeeded(signal);
    return {
      keys: keys.map(key => ({ ...key, inAgent: agentFingerprints.has(key.sha256Fingerprint) })).sort((a, b) =>
        Number(b.algorithm === "ssh-ed25519") - Number(a.algorithm === "ssh-ed25519") || a.name.localeCompare(b.name, "en")),
      agentState, generationSupported: true
    };
  }

  async readPublic(id: string, expectedFingerprint: string, signal: AbortSignal): Promise<string> {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    abortIfNeeded(signal);
    await this.#root(false);
    const value = await this.#public(validateName(id));
    assertFingerprint(value.info, expectedFingerprint);
    abortIfNeeded(signal);
    return value.publicKey;
  }

  async generate(input: { readonly name: string; readonly comment: string; readonly passphrase?: string }, signal: AbortSignal): Promise<SshKeyInfo> {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    return this.#mutation(async () => {
      abortIfNeeded(signal);
      const name = validateName(input.name || "id_joko_ed25519");
      if (Buffer.byteLength(input.comment) > 256 || /[\x00-\x1f\x7f]/u.test(input.comment)) throw new SshKeyError("invalid_name");
      validatePassphrase(input.passphrase);
      await this.#root(true);
      const pair = await new Promise<{ private: string; public: string }>((accept, reject) => {
        ssh2.utils.generateKeyPair("ed25519", {
          comment: input.comment,
          ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase, cipher: "aes256-ctr", rounds: 16 })
        }, (error, keys) => error ? reject(new SshKeyError("io_failed")) : accept(keys));
      });
      abortIfNeeded(signal);
      await this.#root(false);
      const secret = Buffer.from(pair.private);
      try {
        for (let suffix = 0; suffix < MAXIMUM_KEYS; suffix += 1) {
          abortIfNeeded(signal);
          const id = suffix === 0 ? name : `${name.slice(0, 99 - String(suffix).length)}_${suffix}`;
          // Check both names so an existing public-only identity does not leave
          // an empty private file. Exclusive create still owns admission.
          const occupied = await Promise.all([this.#exists(id), this.#exists(`${id}.pub`)]);
          if (occupied.some(Boolean)) continue;
          await this.#root(false);
          abortIfNeeded(signal);
          const handles: Array<{ name: string; handle: FileHandle }> = [];
          try {
            handles.push({ name: id, handle: await createPrivateFile(join(this.#directory, id), signal) });
            await this.#assertHandle(id, handles[0]!.handle);
            handles.push({ name: `${id}.pub`, handle: await open(join(this.#directory, `${id}.pub`), "wx", 0o644) });
            await this.#root(false);
            abortIfNeeded(signal);
            await handles[0]!.handle.writeFile(secret);
            await handles[0]!.handle.sync();
            await handles[1]!.handle.writeFile(`${pair.public.trim()}\n`);
            await handles[1]!.handle.sync();
            await this.#root(false);
            await this.#assertHandle(id, handles[0]!.handle);
            await this.#assertHandle(`${id}.pub`, handles[1]!.handle);
            const writtenSecret = await this.#readHandle(id, handles[0]!.handle, MAXIMUM_KEY_BYTES);
            try { if (!writtenSecret.equals(secret)) throw new SshKeyError("key_changed"); }
            finally { writtenSecret.fill(0); }
            const current = await this.#public(id);
            if (current.info.sha256Fingerprint !== fingerprint(parsePublic(pair.public))) throw new SshKeyError("key_changed");
            await this.#assertHandle(id, handles[0]!.handle);
            await this.#assertHandle(`${id}.pub`, handles[1]!.handle);
            abortIfNeeded(signal);
            return current.info;
          } catch (error) {
            // A verified descriptor does not make a later pathname unlink
            // atomic. Preserve files after creation instead of deleting a
            // replacement identity or claiming that cleanup was confirmed.
            if (handles.length > 0 || error instanceof PrivateFileCreationError && error.code === "outcome_unknown") throw new SshKeyError("outcome_unknown");
            if (isCode(error, "EEXIST") || error instanceof PrivateFileCreationError && error.code === "exists") continue;
            if (signal.aborted) throw new SshKeyError("aborted");
            throw error instanceof SshKeyError ? error : new SshKeyError("io_failed");
          } finally {
            for (const file of handles) await file.handle.close().catch(() => undefined);
          }
        }
        throw new SshKeyError("busy");
      } finally { secret.fill(0); }
    });
  }

  async addToAgent(id: string, expectedFingerprint: string, passphrase: string | undefined, signal: AbortSignal): Promise<void> {
    signal = AbortSignal.any([signal, this.#lifetime.signal]);
    return this.#mutation(async () => {
      validatePassphrase(passphrase);
      await this.readPublic(id, expectedFingerprint, signal);
      const handle = await this.#openRegular(id, MAXIMUM_KEY_BYTES);
      let encoded: Buffer | undefined;
      let plain: Buffer | undefined;
      try {
        encoded = await this.#readHandle(id, handle, MAXIMUM_KEY_BYTES);
        try { assertSshPrivateKeyInput(encoded); }
        catch { throw new SshKeyError("invalid_key"); }
        const parsed = ssh2.utils.parseKey(encoded, passphrase);
        if (parsed instanceof Error) throw new SshKeyError("bad_passphrase");
        // A current OpenSSH file can contain one key. Multiple-key shapes are rejected.
        if (Array.isArray(parsed) || !parsed.isPrivateKey()) throw new SshKeyError("invalid_key");
        if (fingerprint(parsed) !== expectedFingerprint) throw new SshKeyError("key_changed");
        try { plain = encodeAgentPrivateKey(parsed); }
        catch { throw new SshKeyError("invalid_key"); }
        await this.readPublic(id, expectedFingerprint, signal);
        await this.#assertHandle(id, handle);
        abortIfNeeded(signal);
        let result: SshAgentCommandResult;
        try { result = await this.#agent(["-"], plain, signal); }
        catch (error) {
          if (error instanceof SshKeyError && error.code === "agent_unavailable") throw error;
          throw new SshKeyError("outcome_unknown");
        }
        if (signal.aborted) throw new SshKeyError("outcome_unknown");
        if (result.code === 2) throw new SshKeyError("agent_unavailable");
        if (result.code !== 0) throw new SshKeyError("agent_failed");
      } finally {
        encoded?.fill(0); plain?.fill(0);
        await handle.close();
      }
    });
  }

  close(): void { this.#lifetime.abort(); }

  async #mutation<T>(action: () => Promise<T>): Promise<T> {
    if (this.#mutating) throw new SshKeyError("busy");
    this.#mutating = true;
    try { return await action(); }
    catch (error) { throw error instanceof SshKeyError ? error : new SshKeyError("io_failed"); }
    finally { this.#mutating = false; }
  }
  async #root(create: boolean): Promise<boolean> {
    try {
      if (create) await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.#directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(this.#directory), this.#directory)) throw new SshKeyError("io_failed");
      return true;
    } catch (error) {
      if (!create && isCode(error, "ENOENT")) return false;
      throw new SshKeyError("io_failed");
    }
  }
  async #openRegular(name: string, maximumBytes: number): Promise<FileHandle> {
    const path = join(this.#directory, name);
    let handle: FileHandle | undefined;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > maximumBytes) throw new SshKeyError("invalid_key");
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      await this.#assertHandle(name, handle);
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error instanceof SshKeyError ? error : new SshKeyError(isCode(error, "ENOENT") ? "not_found" : "io_failed");
    }
  }
  async #assertHandle(name: string, handle: FileHandle): Promise<void> {
    await this.#root(false);
    const path = join(this.#directory, name);
    const [held, current, canonical] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true }), realpath(path)]);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !samePath(canonical, path)
      || held.dev !== current.dev || held.ino !== current.ino || held.size !== current.size || held.mtimeNs !== current.mtimeNs) throw new SshKeyError("key_changed");
  }
  async #readHandle(name: string, handle: FileHandle, maximumBytes: number): Promise<Buffer> {
    const before = await handle.stat({ bigint: true });
    if (before.size < 1n || before.size > BigInt(maximumBytes)) throw new SshKeyError("invalid_key");
    const buffer = Buffer.alloc(maximumBytes + 1);
    try {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat({ bigint: true });
      await this.#assertHandle(name, handle);
      if (BigInt(bytesRead) !== before.size || bytesRead > maximumBytes || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new SshKeyError("key_changed");
      return Buffer.from(buffer.subarray(0, bytesRead));
    } finally { buffer.fill(0); }
  }
  async #public(id: string): Promise<{ info: SshKeyInfo; publicKey: string }> {
    const name = `${id}.pub`;
    const handle = await this.#openRegular(name, MAXIMUM_PUBLIC_BYTES);
    try {
      const bytes = await this.#readHandle(name, handle, MAXIMUM_PUBLIC_BYTES);
      const publicKey = bytes.toString("utf8").trim();
      const parsed = parsePublic(publicKey);
      const modifiedAt = (await handle.stat()).mtimeMs;
      return { publicKey, info: { id, name: id, algorithm: parsed.type, comment: parsed.comment,
        sha256Fingerprint: fingerprint(parsed), modifiedAt, inAgent: false } };
    } finally { await handle.close(); }
  }
  async #exists(name: string): Promise<boolean> {
    try { await lstat(join(this.#directory, name)); return true; }
    catch (error) { if (isCode(error, "ENOENT")) return false; throw new SshKeyError("io_failed"); }
  }
}

export function sshKeyInstallCommand(publicKey: string, host: { hostname: string; user: string; port: number }, shell: "posix" | "powershell"): string {
  const key = parsePublic(publicKey);
  // Install the public identity without its display comment. This also keeps
  // the recipe portable across native argument handling in PowerShell versions.
  const identity = `${key.type} ${key.getPublicSSH().toString("base64")}`;
  if (!host.hostname || !host.user || host.hostname.length > 1024 || host.user.length > 256 || /[\x00-\x20\x7f@'"\\]/u.test(host.hostname + host.user)
    || host.hostname.startsWith("-") || host.user.startsWith("-") || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new SshKeyError("invalid_name");
  const install = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && { grep -qxF -- ${posixQuote(identity)} ~/.ssh/authorized_keys || printf '%s\\n' ${posixQuote(identity)} >> ~/.ssh/authorized_keys; }`;
  const quote = shell === "posix" ? posixQuote : (value: string): string => `'${value.replaceAll("'", "''")}'`;
  return `ssh -p ${host.port} -- ${quote(`${host.user}@${host.hostname}`)} ${quote(install)}`;
}

function validateName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(value) || value.endsWith(".") || value.endsWith(".pub")
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)) throw new SshKeyError("invalid_name");
  return value;
}
function validatePassphrase(value: string | undefined): void {
  if (value !== undefined && (value.length === 0 || Buffer.byteLength(value) > 4096 || value.includes("\0"))) throw new SshKeyError("bad_passphrase");
}
function parsePublic(value: string): ParsedKey {
  if (Buffer.byteLength(value) > MAXIMUM_PUBLIC_BYTES || /[\x00-\x1f\x7f]/u.test(value.trim()) || !value.trim().startsWith("ssh-") && !value.trim().startsWith("ecdsa-")) throw new SshKeyError("invalid_key");
  const key = ssh2.utils.parseKey(value.trim());
  if (key instanceof Error || Array.isArray(key) || key.isPrivateKey()) throw new SshKeyError("invalid_key");
  return key;
}
function fingerprint(key: ParsedKey): string { return `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/u, "")}`; }
function assertFingerprint(key: SshKeyInfo, expected: string): void { if (key.sha256Fingerprint !== expected) throw new SshKeyError("key_changed"); }
function abortIfNeeded(signal: AbortSignal): void { if (signal.aborted) throw new SshKeyError("aborted"); }
function samePath(a: string, b: string): boolean { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function isCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
function posixQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** The decrypted key travels only over stdin; raw subprocess output is never exposed. */
export async function runSshAgentCommand(args: readonly string[], input: Buffer | undefined, signal: AbortSignal): Promise<SshAgentCommandResult> {
  abortIfNeeded(signal);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (process.platform === "win32" && (!systemRoot || resolve(systemRoot) !== systemRoot)) throw new SshKeyError("agent_unavailable");
  // Do not let the service working directory supply a same-named executable.
  const executable = process.platform === "win32" ? join(systemRoot!, "System32", "OpenSSH", "ssh-add.exe") : "/usr/bin/ssh-add";
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE", "SSH_AUTH_SOCK", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.LC_ALL = "C";
  env.SSH_ASKPASS_REQUIRE = "never";
  return new Promise((accept, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let bytes = 0;
    let failure: SshKeyError | undefined;
    let settled = false;
    let retirement: ReturnType<typeof setTimeout> | undefined;
    const finish = (result?: SshAgentCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (retirement !== undefined) clearTimeout(retirement);
      signal.removeEventListener("abort", abort);
      for (const chunk of output) chunk.fill(0);
      output.splice(0);
      if (failure !== undefined) reject(failure);
      else if (result !== undefined) accept(result);
      else reject(new SshKeyError("agent_failed"));
    };
    const stop = (code: SshKeyFailure): void => {
      if (settled) return;
      failure ??= new SshKeyError(code);
      if (retirement !== undefined) return;
      try { child.kill("SIGKILL"); } catch { /* The command outcome remains unknown. */ }
      // Descendants can retain stdio even after the exact child is killed.
      // Bound our wait without interpreting missing close as successful cancellation.
      retirement = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish();
      }, 500);
      retirement.unref();
    };
    const abort = (): void => stop("aborted");
    const timer = setTimeout(() => stop("agent_failed"), 10_000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => { bytes += data.length; if (bytes > MAXIMUM_PUBLIC_BYTES * MAXIMUM_KEYS) stop("agent_failed"); else output.push(data); });
    child.stderr.on("data", (data: Buffer) => { bytes += data.length; if (bytes > MAXIMUM_PUBLIC_BYTES * MAXIMUM_KEYS) stop("agent_failed"); });
    child.stdin.on("error", () => undefined);
    child.once("error", () => stop("agent_unavailable"));
    child.once("close", code => {
      if (code === null) failure ??= new SshKeyError("agent_failed");
      const result = failure === undefined ? { code: code!, stdout: Buffer.concat(output).toString("utf8") } : undefined;
      finish(result);
    });
    child.stdin.end(input);
    if (signal.aborted) abort();
  });
}
