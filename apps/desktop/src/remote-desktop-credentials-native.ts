import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import { verifyPackagedDesktopRemoteDesktopBinary } from "./remote-desktop-native-manifest.js";
import { resolveDesktopRemoteDesktopLinuxCredentialScript } from "./remote-desktop-linux-credentials.js";

export interface DesktopRemoteCredentialsNativeOwner {
  readonly serverId: string;
  readonly deviceId: string;
  readonly profileId: string;
}
export interface DesktopRemoteCredentialsNativeSettings {
  readonly autoUnlock: boolean;
  readonly biometricVerification: boolean;
  readonly biometricAvailable: boolean;
  readonly biometricPreferred: boolean;
}
export type DesktopRemoteCredentialsNativeDelivery =
  | { readonly kind: "reply"; readonly ciphertext: string }
  | { readonly kind: "command"; readonly id: string; readonly body: string; readonly authenticationSession: string }
  | { readonly kind: "closed" };

export interface DesktopRemoteCredentialsNativeArgs {
  configure: { readonly owner: DesktopRemoteCredentialsNativeOwner };
  begin: { readonly peer: string; readonly offer: string; readonly descriptor: string };
  receive: { readonly peer: string; readonly handle: string; readonly ciphertext: string };
  response: { readonly peer: string; readonly handle: string; readonly requestId: string; readonly body: string; readonly success: boolean };
  status: Readonly<Record<string, never>>;
  closeHandle: { readonly peer: string; readonly handle: string };
  closeAll: Readonly<Record<string, never>>;
  reset: Readonly<Record<string, never>>;
  viewerSettings: { readonly owner: DesktopRemoteCredentialsNativeOwner; readonly target: string };
  viewerConfigure: { readonly owner: DesktopRemoteCredentialsNativeOwner };
  viewerBegin: { readonly target: string; readonly setup: boolean; readonly biometric: boolean; readonly descriptor: string };
  viewerAccept: { readonly handle: string; readonly offer: string };
  viewerReceive: { readonly handle: string; readonly ciphertext: string };
  viewerPassword: { readonly handle: string; readonly useSaved: boolean; readonly locale: string; readonly theme: "light" | "dark" };
  viewerAuthenticationStatus: { readonly handle: string };
  viewerForget: { readonly owner: DesktopRemoteCredentialsNativeOwner; readonly target: string };
  viewerBiometric: { readonly owner: DesktopRemoteCredentialsNativeOwner; readonly target: string; readonly enabled: boolean; readonly locale: string };
  viewerEnd: { readonly handle: string };
  viewerReset: Readonly<Record<string, never>>;
}
export interface DesktopRemoteCredentialsNativeResults {
  configure: string;
  begin: { readonly handle: string; readonly offer: string };
  receive: DesktopRemoteCredentialsNativeDelivery;
  response: string;
  status: Readonly<Record<string, string>>;
  closeHandle: true;
  closeAll: true;
  reset: true;
  viewerSettings: DesktopRemoteCredentialsNativeSettings;
  viewerConfigure: string;
  viewerBegin: { readonly handle: string; readonly offer: string; readonly descriptor: string };
  viewerAccept: string;
  viewerReceive: string;
  viewerPassword: string;
  viewerAuthenticationStatus: string;
  viewerForget: true;
  viewerBiometric: true;
  viewerEnd: string;
  viewerReset: true;
}
export type DesktopRemoteCredentialsNativeMethod = keyof DesktopRemoteCredentialsNativeArgs;
const ERROR_CODES = [
  "CREDENTIAL_INVALID_MESSAGE", "CREDENTIAL_INVALID_IDENTITY", "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_APPLICATION_INACTIVE", "CREDENTIAL_AUTHENTICATION_BUSY", "CREDENTIAL_SAVED_PASSWORD_MISSING",
  "CREDENTIAL_SAVED_BINDING_CHANGED", "CREDENTIAL_SAVED_READ_DENIED", "CREDENTIAL_SAVED_INTERACTION_REQUIRED",
  "CREDENTIAL_SAVED_READ_FAILED", "CREDENTIAL_EXPIRED", "CREDENTIAL_CANCELLED", "CREDENTIAL_ACCESSIBILITY_REQUIRED",
  "CREDENTIAL_UNLOCK_UNAVAILABLE", "CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED", "CREDENTIAL_OUTCOME_UNKNOWN"
] as const;
export type DesktopRemoteCredentialsNativeErrorCode = typeof ERROR_CODES[number];
export class DesktopRemoteCredentialsNativeError extends Error {
  constructor(readonly code: DesktopRemoteCredentialsNativeErrorCode) { super(code); this.name = "DesktopRemoteCredentialsNativeError"; }
}
export interface DesktopRemoteCredentialsNativeRuntime {
  readonly platform: NodeJS.Platform;
  readonly storageDirectory: string;
  readonly timeoutMs?: number;
  resolveBinary(): Promise<string>;
  spawn(binary: string, arguments_: readonly string[]): ChildProcessWithoutNullStreams;
}
interface Pending {
  finish(value: unknown, error?: DesktopRemoteCredentialsNativeError): void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly sideEffect: boolean;
  dispatched: boolean;
}

/** Private native pipe. An uncertain effect occupies its occurrence until receipt or actual process close. */
export class DesktopRemoteCredentialsNative {
  readonly #runtime: DesktopRemoteCredentialsNativeRuntime;
  #child: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<void> | undefined;
  #actualClose: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;
  #closing = false;
  #pending = new Map<string, Pending>();
  #settlement = new Set<Promise<unknown>>();
  #buffer = "";
  constructor(runtime: DesktopRemoteCredentialsNativeRuntime = nativeRuntime()) { this.#runtime = runtime; }
  hasPendingEffect(): boolean { return this.#pending.size > 0 || this.#closing || this.#starting !== undefined; }
  async awaitSettlement(): Promise<void> {
    await Promise.allSettled([...this.#settlement]);
    if (this.#closing) await this.#actualClose;
  }
  async request<M extends DesktopRemoteCredentialsNativeMethod>(
    method: M, args: DesktopRemoteCredentialsNativeArgs[M], options: { readonly signal?: AbortSignal } = {}
  ): Promise<DesktopRemoteCredentialsNativeResults[M]> {
    if (options.signal?.aborted) throw nativeError("CREDENTIAL_CANCELLED");
    validateArguments(method, args);
    if (this.#runtime.platform === "linux" && method.startsWith("viewer")) throw nativeError("CREDENTIAL_UNAVAILABLE");
    await this.#start();
    if (options.signal?.aborted) throw nativeError("CREDENTIAL_CANCELLED");
    const child = this.#child;
    if (this.#closing || child === undefined || this.#pending.size >= 64) throw nativeError("CREDENTIAL_UNAVAILABLE");
    const id = randomUUID();
    const operation = new Promise<DesktopRemoteCredentialsNativeResults[M]>((resolveResult, rejectResult) => {
      const timeout = this.#runtime.timeoutMs ?? ((method === "viewerPassword" || method === "viewerBiometric") ? 120_000 : 50_000);
      const timer = setTimeout(() => { void this.close(); }, timeout);
      const pending: Pending = {
        timer,
        sideEffect: method !== "status" && method !== "viewerSettings",
        dispatched: false,
        finish: (value, error) => {
          clearTimeout(timer);
          if (error !== undefined) { rejectResult(error); return; }
          try { resolveResult(RESULT_PARSERS[method](value)); }
          catch { rejectResult(nativeError("CREDENTIAL_INVALID_MESSAGE")); }
        }
      };
      this.#pending.set(id, pending);
      // After dispatch, cancellation belongs to the captured adapter owner. Keep the late receipt for exact cleanup.
      try {
        child.stdin.write(`${JSON.stringify({ id, method, ...args })}\n`, error => {
          if (error !== null && error !== undefined) void this.close();
        });
        pending.dispatched = true;
      } catch { this.#pending.delete(id); pending.finish(undefined, nativeError("CREDENTIAL_UNAVAILABLE")); void this.close(); }
    });
    this.#settlement.add(operation);
    void operation.then(() => this.#settlement.delete(operation), () => this.#settlement.delete(operation));
    return operation;
  }
  async close(): Promise<void> {
    this.#closing = true;
    if (this.#starting !== undefined) {
      try { await this.#starting; } catch { /* No process was spawned. */ }
    }
    const child = this.#child;
    if (child === undefined) { this.#closing = false; return; }
    child.stdin.end();
    try { child.kill(); } catch { /* The captured slot remains occupied until close. */ }
    await this.#actualClose;
  }
  async #start(): Promise<void> {
    if (this.#runtime.platform !== "darwin" && this.#runtime.platform !== "linux") throw nativeError("CREDENTIAL_UNAVAILABLE");
    if (this.#closing) throw nativeError("CREDENTIAL_UNAVAILABLE");
    if (this.#child !== undefined) return;
    if (this.#starting !== undefined) return this.#starting;
    const starting = (async () => {
      const binary = await this.#runtime.resolveBinary();
      if (this.#closing) throw nativeError("CREDENTIAL_CANCELLED");
      const child = this.#runtime.platform === "linux"
        ? this.#runtime.spawn("/usr/bin/python3", ["-I", "-B", "-u", binary, "--serve",
          this.#runtime.storageDirectory, String(process.pid), process.execPath])
        : this.#runtime.spawn(binary, [this.#runtime.storageDirectory]);
      this.#child = child;
      this.#buffer = "";
      this.#actualClose = new Promise<void>(resolveClose => { this.#resolveClose = resolveClose; });
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.#receive(child, chunk));
      child.stdin.on("error", () => { if (this.#child === child) void this.close(); });
      child.on("error", () => { if (this.#child === child) void this.close(); });
      child.on("exit", () => { if (this.#child === child) this.#closing = true; });
      child.on("close", () => {
        if (this.#child !== child) return;
        for (const pending of this.#pending.values()) pending.finish(undefined,
          nativeError(pending.dispatched && pending.sideEffect ? "CREDENTIAL_OUTCOME_UNKNOWN" : "CREDENTIAL_UNAVAILABLE"));
        this.#pending.clear(); this.#buffer = ""; this.#child = undefined; this.#closing = false;
        this.#resolveClose?.(); this.#resolveClose = undefined;
      });
    })();
    this.#starting = starting;
    try { await starting; }
    catch (error) { if (error instanceof DesktopRemoteCredentialsNativeError) throw error; throw nativeError("CREDENTIAL_UNAVAILABLE"); }
    finally { if (this.#starting === starting) this.#starting = undefined; }
  }
  #receive(child: ChildProcessWithoutNullStreams, chunk: string): void {
    if (this.#child !== child || this.#closing) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > 4 * 1024 * 1024) { void this.close(); return; }
    let end: number;
    while ((end = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      try {
        const receipt = object(JSON.parse(line));
        if (typeof receipt["id"] !== "string" || !exact(receipt, "id", "result") && !exact(receipt, "id", "error")) throw nativeError("CREDENTIAL_INVALID_MESSAGE");
        const pending = this.#pending.get(receipt["id"]);
        if (pending === undefined) continue;
        this.#pending.delete(receipt["id"]);
        if ("error" in receipt) {
          const code = ERROR_CODES.find(value => value === receipt["error"]) ?? "CREDENTIAL_UNAVAILABLE";
          pending.finish(undefined, nativeError(code));
        } else pending.finish(receipt["result"]);
      } catch { void this.close(); return; }
    }
  }
}
const nativeError = (code: DesktopRemoteCredentialsNativeErrorCode): DesktopRemoteCredentialsNativeError => new DesktopRemoteCredentialsNativeError(code);
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw nativeError("CREDENTIAL_INVALID_MESSAGE");
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, ...keys: readonly string[]): boolean => Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw nativeError("CREDENTIAL_INVALID_MESSAGE");
  return value;
};
const text = (value: unknown, limit: number, ascii = false, empty = false): string => {
  if (typeof value !== "string" || !empty && !value.length || Buffer.byteLength(value, "utf8") > limit
    || ascii && !/^[A-Za-z0-9_.-]*$/u.test(value)) throw nativeError("CREDENTIAL_INVALID_MESSAGE");
  return value;
};
const descriptor = (value: unknown): string => text(value, 4_096);
const ciphertext = (value: unknown): string => text(value, 2 * 1024 * 1024, true);
const trueResult = (value: unknown): true => { if (value !== true) throw nativeError("CREDENTIAL_INVALID_MESSAGE"); return true; };
const RESULT_PARSERS: { [M in DesktopRemoteCredentialsNativeMethod]: (value: unknown) => DesktopRemoteCredentialsNativeResults[M] } = {
  configure: descriptor, viewerConfigure: descriptor,
  begin: value => { const v = object(value); if (!exact(v, "handle", "offer")) throw nativeError("CREDENTIAL_INVALID_MESSAGE"); return { handle: uuid(v["handle"]), offer: text(v["offer"], 4_096, true) }; },
  viewerBegin: value => { const v = object(value); if (!exact(v, "handle", "offer", "descriptor")) throw nativeError("CREDENTIAL_INVALID_MESSAGE"); return { handle: uuid(v["handle"]), offer: text(v["offer"], 4_096, true), descriptor: descriptor(v["descriptor"]) }; },
  receive: value => {
    const v = object(value);
    if (v["kind"] === "closed" && exact(v, "kind")) return { kind: "closed" };
    if (v["kind"] === "reply" && exact(v, "kind", "ciphertext")) return { kind: "reply", ciphertext: ciphertext(v["ciphertext"]) };
    if (v["kind"] === "command" && exact(v, "kind", "id", "body", "authenticationSession")) return { kind: "command", id: uuid(v["id"]), body: text(v["body"], 2 * 1024 * 1024), authenticationSession: uuid(v["authenticationSession"]) };
    throw nativeError("CREDENTIAL_INVALID_MESSAGE");
  },
  response: ciphertext, viewerAccept: ciphertext, viewerPassword: ciphertext, viewerAuthenticationStatus: ciphertext,
  status: value => { const v = object(value); if (Object.keys(v).length > 8) throw nativeError("CREDENTIAL_INVALID_MESSAGE"); const result: Record<string, string> = {}; for (const [peer, proof] of Object.entries(v)) { text(peer, 512); result[peer] = uuid(proof); } return Object.freeze(result); },
  closeHandle: trueResult, closeAll: trueResult, reset: trueResult, viewerForget: trueResult, viewerBiometric: trueResult, viewerReset: trueResult,
  viewerEnd: value => value === "" ? "" : ciphertext(value),
  viewerSettings: value => { const v = object(value); if (!exact(v, "autoUnlock", "biometricVerification", "biometricAvailable", "biometricPreferred")) throw nativeError("CREDENTIAL_INVALID_MESSAGE"); for (const flag of Object.values(v)) if (typeof flag !== "boolean") throw nativeError("CREDENTIAL_INVALID_MESSAGE"); return { autoUnlock: v["autoUnlock"] as boolean, biometricVerification: v["biometricVerification"] as boolean, biometricAvailable: v["biometricAvailable"] as boolean, biometricPreferred: v["biometricPreferred"] as boolean }; },
  viewerReceive: value => text(value, 2 * 1024 * 1024)
};
function validateArguments(method: DesktopRemoteCredentialsNativeMethod, value: unknown): void {
  const v = object(value);
  const fields: Record<DesktopRemoteCredentialsNativeMethod, readonly string[]> = {
    configure: ["owner"], begin: ["peer", "offer", "descriptor"], receive: ["peer", "handle", "ciphertext"],
    response: ["peer", "handle", "requestId", "body", "success"], status: [], closeHandle: ["peer", "handle"], closeAll: [], reset: [],
    viewerSettings: ["owner", "target"], viewerConfigure: ["owner"], viewerBegin: ["target", "setup", "biometric", "descriptor"],
    viewerAccept: ["handle", "offer"], viewerReceive: ["handle", "ciphertext"], viewerPassword: ["handle", "useSaved", "locale", "theme"],
    viewerAuthenticationStatus: ["handle"], viewerForget: ["owner", "target"], viewerBiometric: ["owner", "target", "enabled", "locale"], viewerEnd: ["handle"], viewerReset: []
  };
  if (!exact(v, ...fields[method])) throw nativeError("CREDENTIAL_INVALID_MESSAGE");
  for (const [key, field] of Object.entries(v)) {
    if (key === "owner") { const owner = object(field); if (!exact(owner, "serverId", "deviceId", "profileId")) throw nativeError("CREDENTIAL_INVALID_IDENTITY"); for (const id of Object.values(owner)) { const identity = text(id, 512); if (identity.trim() !== identity || /[\u0000-\u001f]/u.test(identity)) throw nativeError("CREDENTIAL_INVALID_IDENTITY"); } }
    else if (key === "handle" || key === "requestId") uuid(field);
    else if (key === "ciphertext") ciphertext(field);
    else if (key === "offer") text(field, 4_096, true);
    else if (key === "descriptor") descriptor(field);
    else if (["success", "setup", "biometric", "useSaved", "enabled"].includes(key)) { if (typeof field !== "boolean") throw nativeError("CREDENTIAL_INVALID_MESSAGE"); }
    else if (key === "theme") { if (field !== "light" && field !== "dark") throw nativeError("CREDENTIAL_INVALID_MESSAGE"); }
    else text(field, key === "body" ? 2 * 1024 * 1024 : 512);
  }
}

const exec = promisify(execFile);
const HELPER = "joko-macos-remote-credentials";
const BUNDLE = "JokoRemoteCredentials_JokoRemoteCredentials.bundle";
let building: Promise<string> | undefined;
function nativeRuntime(): DesktopRemoteCredentialsNativeRuntime {
  return {
    platform: process.platform,
    storageDirectory: join(app.getPath("userData"), "remote-desktop", "credential-identity"),
    resolveBinary: () => process.platform === "linux" ? resolveDesktopRemoteDesktopLinuxCredentialScript() : resolveBinary(),
    spawn: (binary, args) => spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  };
}
async function resolveBinary(): Promise<string> {
  if (process.platform !== "darwin") throw nativeError("CREDENTIAL_UNAVAILABLE");
  if (app.isPackaged) return verifyPackagedDesktopRemoteDesktopBinary(join(process.resourcesPath, "native-remote-desktop"), "credentials", HELPER, "darwin", process.arch);
  if (building !== undefined) return building;
  const signingIdentity = process.env["JOKO_REMOTE_CREDENTIALS_SIGNING_IDENTITY"]?.trim().toUpperCase();
  if (signingIdentity === undefined || !/^[A-F0-9]{40}$/u.test(signingIdentity)) throw nativeError("CREDENTIAL_DEVELOPMENT_SIGNING_REQUIRED");
  const compile = (async () => {
    const sourceRoot = resolve(app.getAppPath(), "../..", "packages", "remote-credentials-native");
    const hash = createHash("sha256").update(process.execPath).update(process.arch).update(signingIdentity);
    async function digest(path: string): Promise<void> { for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { hash.update(entry.name); if (entry.isDirectory()) await digest(join(path, entry.name)); else hash.update(await readFile(join(path, entry.name))); } }
    await digest(join(sourceRoot, "Sources"));
    for (const file of ["Package.swift", "Package.resolved"]) hash.update(await readFile(join(sourceRoot, file)));
    const directory = join(app.getPath("userData"), "remote-desktop", "native-credentials", hash.digest("hex"));
    const binary = join(directory, HELPER);
    const identifier = "app.joko.remote-credentials.development";
    const verify = async (path: string): Promise<void> => { await exec("/usr/bin/codesign", ["--verify", "--strict", "-R", `=anchor apple generic and identifier "${identifier}" and certificate leaf = H"${signingIdentity}"`, path], { maxBuffer: 1_024 * 1_024 }); };
    try { await access(binary); await access(join(directory, BUNDLE)); await verify(binary); return binary; } catch { /* Build the exact certificate-backed native source. */ }
    await mkdir(directory, { recursive: true });
    const source = await mkdtemp(join(directory, "compile-"));
    try {
      for (const file of ["Package.swift", "Package.resolved", "Sources"]) await cp(join(sourceRoot, file), join(source, file), { recursive: true });
      const main = join(source, "Sources", "CredentialHost", "main.swift");
      await writeFile(main, (await readFile(main, "utf8")).replace('"CREDENTIAL_HOST_DEVELOPMENT_EXECUTABLE"', JSON.stringify(Buffer.from(process.execPath).toString("base64"))));
      const args = ["build", "--package-path", source, "-c", "release", "--product", HELPER, "-Xswiftc", "-D", "-Xswiftc", "REMOTE_CREDENTIALS_DEVELOPMENT"];
      await exec("swift", args, { timeout: 240_000, maxBuffer: 1_024 * 1_024 });
      const location = await exec("swift", [...args, "--show-bin-path"], { maxBuffer: 1_024 * 1_024 });
      const output = location.stdout.trim(); const temporary = `${binary}.${process.pid}.tmp`;
      await cp(join(output, HELPER), temporary); await cp(join(output, BUNDLE), join(directory, BUNDLE), { recursive: true });
      await exec("/usr/bin/codesign", ["--force", "--sign", signingIdentity, "--identifier", identifier, "--timestamp=none", temporary], { maxBuffer: 1_024 * 1_024 });
      await verify(temporary); await rename(temporary, binary); return binary;
    } catch (error) { if (error instanceof DesktopRemoteCredentialsNativeError) throw error; throw nativeError("CREDENTIAL_UNAVAILABLE"); }
    finally { await rm(source, { recursive: true, force: true }); }
  })();
  building = compile;
  try { return await compile; } finally { if (building === compile) building = undefined; }
}
