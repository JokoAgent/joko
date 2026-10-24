import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createGrepToolDefinition, createLocalBashOperations, type ExtensionContext, type GrepToolInput } from "@earendil-works/pi-coding-agent";
import { classifyToolCall, decideToolCall, evaluateOrderedPolicyRules, policyObservationForToolCall, redactSecrets, type AdapterContext, type ApprovedDirectory,
  type PermissionMode, type PolicySnapshot, type ToolCall, type NativeToolAuthorizationDecision } from "@joko/core";
import type { CommandConcurrencyGate } from "@joko/runtime-governance";
import { terminalEnvironment } from "@joko/tool-terminal";
import { ExecutorWorkspace, realPathOrAncestor, type ExecutorPathAlias } from "./hosted-agent-workspace.js";
import { isShareCredentialCommand, isShareCredentialPath, shareCredentialGitReads } from "./hosted-agent-credentials.js";
import { GitCredentialHistory } from "./hosted-agent-git-credentials.js";
import { reviewNativeToolPolicy } from "./native-tool-policy.js";
import { tightenNativeCodexFileSystemPolicy } from "./native-codex-filesystem-policy.js";
import { hostedDirectoryId, hostedDirectoryPath } from "./hosted-agent-directories.js";
import type { SourceInputMount } from "./hosted-agent-source-attachments.js";
import type { HostedAgentPeerWorkspace } from "./hosted-agent-peer-workspace.js";

const RAW_FILE_LIMIT = 16 * 1024 * 1024;
const REQUEST_LIMIT = 64 * 1024 * 1024;
const SHELL_OUTPUT_LIMIT = 8 * 1024 * 1024;
const APPROVAL_TTL = 2 * 60_000;
const runFile = promisify(execFile);

export interface HostedAgentExecutorPolicy {
  /** Includes permission/plan mode, roots, ordered rules and sharing trust. */
  readonly revision: string;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly approvedRoots: readonly ApprovedDirectory[];
  readonly snapshot?: PolicySnapshot;
  readonly confirmCredentials: boolean;
}
export interface HostedAgentExecutorOptions {
  readonly remote?: HostedAgentPeerWorkspace;
  readonly context: AdapterContext;
  readonly virtualRoot: string;
  readonly aliases?: readonly ExecutorPathAlias[];
  readonly inputFiles?: () => readonly SourceInputMount[];
  readonly readPolicy: () => HostedAgentExecutorPolicy;
  /** Captured by the original SessionHost dispatch, never an inbound identity. */
  readonly assertCurrent: () => void;
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
  readonly ripgrepExecutable?: string;
  readonly reviewTool?: (call: ToolCall, signal: AbortSignal, assertCurrent: () => void, policy: HostedAgentExecutorPolicy) => Promise<NativeToolAuthorizationDecision>;
  readonly credentialConsent?: {
    readonly hasForSession: () => boolean;
    readonly allowForSession: () => Promise<void>;
  };
}
export type NativeExecutorAction = { readonly kind: "read"; readonly path: string; readonly scope?: "tree" }
  | { readonly kind: "write"; readonly path: string; readonly scope?: "tree" } | { readonly kind: "exec"; readonly command: string; readonly cwd: string }
  | { readonly kind: "network"; readonly url: string; readonly method: string };
export interface HostedAgentExecutorEffects {
  readonly onOutput?: (chunk: Buffer) => void;
  readonly captureCwd?: boolean;
  readonly background?: boolean;
  /** Source-only native Read options; never accepted in an inbound payload. */
  readonly readMaximumBytes?: number;
  readonly readLines?: { readonly offset: number; readonly limit: number; readonly maxLineChars: number };
}

export class HostedAgentExecutorError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "ACCESS_DENIED" | "STALE_AUTHORITY" | "REQUEST_REPLAYED" | "RESOURCE_EXHAUSTED" | "NOT_FOUND" | "EXECUTOR_FAILED") {
    super("The task executor rejected the operation.");
  }
}
interface ExecutorRequest {
  readonly format: 1;
  readonly callId: string;
  readonly requestId: string;
  readonly operation: string;
  readonly payload: Record<string, unknown>;
}
interface ToolLease {
  readonly name: string;
  readonly path: string;
  readonly command?: string;
  readonly timeout?: number;
  readonly pattern?: string;
  readonly search?: string;
  readonly expiresAt: number;
  readonly assert: () => void;
}

/** The task's executor lives on its original service node. Native tools on a
 * provider node receive only this bounded, authenticated operation port. */
export class HostedAgentExecutor {
  readonly #options: HostedAgentExecutorOptions;
  readonly #workspace: ExecutorWorkspace;
  readonly #lifetime = new AbortController();
  readonly #seen = new Set<string>();
  readonly #approvals = new Map<string, { revision: string; authorization?: string; expiresAt: number }>();
  readonly #gitCredentials = new GitCredentialHistory();
  readonly #tools = new Map<string, ToolLease>();
  constructor(options: HostedAgentExecutorOptions) {
    if (options.context.hostedExecution || options.context.target.remoteWorkspace && (!options.remote || options.context.target.remoteWorkspace.kind !== "device_peer")) throw new HostedAgentExecutorError("INVALID_REQUEST");
    options.assertCurrent();
    const native = /^[A-Za-z]:|^\\\\/u.test(options.virtualRoot) ? "\\" : "/";
    const virtual = (name: string) => options.virtualRoot.replace(/[\\/]+$/u, "") + native + "additional" + native + name;
    this.#options = options;
    this.#workspace = new ExecutorWorkspace({ workingDir: options.context.target.workspaceRoot, aliases: [
      { from: options.virtualRoot, to: options.context.target.workspaceRoot },
      { from: virtual("home"), to: options.remote?.home ?? homedir() }, { from: virtual("temporary"), to: options.remote?.temporary ?? tmpdir() },
      ...(options.context.extraDirectories ?? []).map(directory => ({ from: hostedDirectoryPath(options.virtualRoot, hostedDirectoryId(directory)), to: directory.path })),
      ...(options.aliases ?? [])
    ], ...(options.remote ? { remote: options.remote.projection } : {}) });
    this.#workspace.setVirtualRoot(options.virtualRoot);
  }

  dispose(): void { this.#lifetime.abort(); this.#seen.clear(); this.#approvals.clear(); this.#tools.clear(); }
  get workspace(): ExecutorWorkspace { return this.#workspace; }
  assertCurrent(signal: AbortSignal): void { this.#assertCurrent(signal); }
  async prepareNativeParams(method: string, params: unknown, actions: readonly NativeExecutorAction[], signal: AbortSignal): Promise<unknown> {
    const policy = this.#options.readPolicy(), native = this.#options.context.nativeToolAuthorization, revision = native?.capture();
    const assertCurrent = () => {
      this.#assertCurrent(signal); native?.assertCurrent(revision);
      if (this.#options.readPolicy().revision !== policy.revision) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    };
    assertCurrent();
    if (policy.snapshot === undefined) return params;
    const prepared = await tightenNativeCodexFileSystemPolicy({ snapshot: policy.snapshot, method, params, actions,
      pathStyle: this.#options.remote?.authority.pathStyle ?? (process.platform === "win32" ? "win32" : "posix"), enforcement: "native-os-sandbox",
      canonicalize: path => this.#canonical(this.#workspace.resolve(path), signal), assertCurrent });
    assertCurrent(); return prepared;
  }
  /** A native exec-server primitive is independently authorized by the exact
   * Source dispatch. Approval of one primitive never grants its connection. */
  async authorizeNativeActions(actions: readonly NativeExecutorAction[], signal: AbortSignal): Promise<() => void> {
    const active = AbortSignal.any([signal, this.#lifetime.signal, this.#options.context.signal]); this.#assertCurrent(active);
    await this.#options.remote?.synchronize(active);
    if (!Array.isArray(actions) || actions.length > 256) throw new HostedAgentExecutorError("INVALID_REQUEST");
    const fences: (() => void)[] = [];
    for (const action of actions) {
      const callId = randomUUID(), request: ExecutorRequest = { format: 1, callId, requestId: randomUUID(), operation: "tool.begin", payload: {} };
      if (action.kind === "network") {
        fences.push(await this.#authorize(request, { name: "WebFetch", args: { url: text(action.url, 16_384), method: text(action.method, 32) } }, active));
      } else if (action.kind === "exec") {
        const cwd = await this.#canonical(this.#workspace.resolve(text(action.cwd, 16_384)), active);
        const command = this.#workspace.mapCommand(text(action.command, 1024 * 1024));
        fences.push(await this.#authorize(request, { name: "bash", args: { command, cwd } }, active));
      } else {
        if (action.kind !== "read" && action.kind !== "write") throw new HostedAgentExecutorError("INVALID_REQUEST");
        const requested = this.#workspace.resolve(text(action.path, 16_384)), path = await this.#canonical(requested, active);
        fences.push(await this.#authorize(request, { name: action.kind === "write" ? "write" : action.scope === "tree" ? "ls" : "read",
          args: { path, ...(action.scope === "tree" ? { recursive: true } : {}) } }, active, requested));
      }
    }
    const assert = () => { this.#assertCurrent(active); for (const fence of fences) fence(); }; assert(); return assert;
  }

  async execute(input: unknown, signal?: AbortSignal, effects?: HostedAgentExecutorEffects): Promise<Record<string, unknown>> {
    const request = parseRequest(input);
    const activeSignal = AbortSignal.any([this.#lifetime.signal, this.#options.context.signal, ...(signal ? [signal] : [])]);
    this.#assertCurrent(activeSignal);
    if (this.#seen.has(request.requestId)) throw new HostedAgentExecutorError("REQUEST_REPLAYED");
    if (this.#seen.size >= 65_536) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    this.#seen.add(request.requestId); // Reserve before the first asynchronous effect; never replay an uncertain write.
    try {
      const payload = request.payload;
      const path = () => this.#workspace.resolve(text(payload.path, 16_384));
      switch (request.operation) {
        case "tool.begin": {
          keys(payload, ["name", "input"]);
          const name = text(payload.name, 32), input = record(payload.input);
          if (!["read", "write", "edit", "ls", "find", "grep", "bash"].includes(name)) throw new HostedAgentExecutorError("INVALID_REQUEST");
          for (const [id, lease] of this.#tools) if (lease.expiresAt <= Date.now()) this.#tools.delete(id);
          if (this.#tools.has(request.callId) || this.#tools.size >= 256) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
          const requestedPath = this.#workspace.resolve(name === "bash"
            ? input.cwd === undefined ? "." : text(input.cwd, 16_384)
            : input.path === undefined && ["ls", "find", "grep"].includes(name) ? "." : text(input.path, 16_384));
          const target = await this.#canonical(requestedPath, activeSignal);
          const args: Record<string, unknown> = name === "bash" ? { ...input, command: this.#workspace.mapCommand(text(input.command, 1024 * 1024)), cwd: target }
            : { ...input, path: target };
          const assert = await this.#authorize(request, { name, args }, activeSignal, requestedPath); assert();
          this.#tools.set(request.callId, { name, path: target, expiresAt: Date.now() + APPROVAL_TTL, assert,
            ...(name === "bash" ? { command: String(args.command), timeout: input.timeout === undefined ? 300 : Number(input.timeout) } : {}),
            ...(name === "find" ? { pattern: text(input.pattern, 4096) } : {}),
            ...(name === "grep" ? { search: searchIdentity(args) } : {}) });
          return {};
        }
        case "tool.end": keys(payload, []); this.#tools.delete(request.callId); return {};
        case "fs.read": {
          keys(payload, ["path"]);
          const maximum = effects?.readMaximumBytes ?? RAW_FILE_LIMIT, range = effects?.readLines;
          if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32 * 1024 * 1024
            || range && (!Number.isSafeInteger(range.offset) || range.offset < 1 || !Number.isSafeInteger(range.limit) || range.limit < 1
              || !Number.isSafeInteger(range.maxLineChars) || range.maxLineChars < 1 || range.maxLineChars > 2000)) {
            throw new HostedAgentExecutorError("INVALID_REQUEST");
          }
          const target = await this.#canonical(path(), activeSignal), assert = await this.#authorize(request, { name: "read", args: { path: target } }, activeSignal);
          if (this.#options.remote) {
            if (range) { const result = await this.#options.remote.readLines(target, range, activeSignal, this.#workspace); assert(); return result; }
            const bytes = await this.#options.remote.read(target, maximum, activeSignal); assert();
            return { data: this.#workspace.mapOutputForAgent(bytes).toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
          }
          return await this.#withFile(target, "read", assert, async handle => {
            const info = await handle.stat(); if (!info.isFile() || !range && info.size > maximum) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
            if (range) return readAuthorizedLines(handle, range, activeSignal, assert, lines => this.#workspace.mapOutputLinesForAgent(lines));
            const bytes = await handle.readFile(); assert();
            const after = await handle.stat(); assert();
            if (bytes.byteLength > maximum) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
            if (bytes.byteLength !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new HostedAgentExecutorError("STALE_AUTHORITY");
            return { data: this.#workspace.mapOutputForAgent(bytes).toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
          });
        }
        case "fs.write": {
          keys(payload, ["path", "data"]);
          const bytes = decodeBytes(payload.data), target = await this.#canonical(path(), activeSignal);
          const assert = await this.#authorize(request, { name: "write", args: { path: target } }, activeSignal);
          if (this.#options.remote) {
            let original: string | null = null;
            try { const prior = await this.#options.remote.read(target, RAW_FILE_LIMIT, activeSignal); if (!prior.includes(0) && Buffer.from(prior.toString("utf8")).equals(prior)) original = prior.toString("utf8"); }
            catch { assert(); }
            await this.#options.remote.write(target, this.#workspace.mapInputFromAgent(bytes, original), activeSignal); assert(); return {};
          }
          assert(); await mkdir(dirname(target), { recursive: true }); assert();
          let original: string | null = null;
          try {
            original = await this.#withFile(target, "read", assert, async handle => {
              const info = await handle.stat(); if (info.size > RAW_FILE_LIMIT) return null;
              const bytes = await handle.readFile(); assert();
              return bytes.length <= RAW_FILE_LIMIT && !bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes) ? bytes.toString("utf8") : null;
            });
          } catch (error) {
            assert(); if (error instanceof HostedAgentExecutorError) throw error;
            // Existing content is optional when retaining path spellings. A
            // write-only file remains writable, as with the native write tool.
          }
          return await this.#withFile(target, "write", assert, async handle => {
            const info = await handle.stat(); if (!info.isFile()) throw new HostedAgentExecutorError("ACCESS_DENIED");
            const mapped = this.#workspace.mapInputFromAgent(bytes, original);
            assert(); await handle.truncate(0);
            for (let offset = 0; offset < mapped.length;) {
              assert(); const result = await handle.write(mapped, offset, mapped.length - offset, offset);
              if (result.bytesWritten <= 0) throw new HostedAgentExecutorError("EXECUTOR_FAILED"); offset += result.bytesWritten;
            }
            await handle.sync(); assert();
            return {};
          });
        }
        case "fs.access": {
          keys(payload, ["path", "mode"]); if (!["read", "write"].includes(String(payload.mode))) throw new HostedAgentExecutorError("INVALID_REQUEST");
          const target = await this.#canonical(path(), activeSignal), assert = await this.#authorize(request,
            { name: payload.mode === "write" ? "edit" : "read", args: { path: target } }, activeSignal);
          if (this.#options.remote) { await this.#options.remote.info(target, activeSignal); assert(); return {}; }
          assert(); await access(target, payload.mode === "write" ? constants.R_OK | constants.W_OK : constants.R_OK); assert(); return {};
        }
        case "fs.mkdir": {
          keys(payload, ["path"]);
          const target = await this.#canonical(path(), activeSignal), assert = await this.#authorize(request, { name: "write", args: { path: target } }, activeSignal);
          if (this.#options.remote) { await this.#options.remote.mkdir(target, activeSignal); assert(); return {}; }
          assert(); await mkdir(target, { recursive: true }); assert(); return {};
        }
        case "fs.stat": {
          keys(payload, ["path"]);
          const target = await this.#canonical(path(), activeSignal), assert = await this.#authorize(request, { name: "read", args: { path: target } }, activeSignal);
          if (this.#options.remote) { const info = await this.#options.remote.info(target, activeSignal); assert(); return { type: info.kind, size: info.size, mtimeMs: info.modifiedAt }; }
          const info = await stat(target); assert(); return { type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, mtimeMs: info.mtimeMs };
        }
        case "fs.readdir": {
          keys(payload, ["path"]);
          const target = await this.#canonical(path(), activeSignal), assert = await this.#authorize(request, { name: "ls", args: { path: target } }, activeSignal);
          if (this.#options.remote) { const entries = await this.#options.remote.directory(target, activeSignal); assert(); return { entries }; }
          const entries = await readdir(target); assert(); return { entries };
        }
        case "fs.mime": {
          keys(payload, ["path"]);
          const target = await this.#canonical(path(), activeSignal), assert = await this.#authorize(request, { name: "read", args: { path: target } }, activeSignal);
          if (this.#options.remote) { const header = await this.#options.remote.read(target, 16, activeSignal, true); assert(); return { mime: imageMime(header) }; }
          return await this.#withFile(target, "read", assert, async handle => {
            const header = Buffer.alloc(16), { bytesRead } = await handle.read(header, 0, 16, 0); assert(); return { mime: imageMime(header.subarray(0, bytesRead)) };
          });
        }
        case "fs.glob": {
          keys(payload, ["pattern", "cwd", "limit", "ignore"]);
          const cwd = await this.#canonical(this.#workspace.resolve(text(payload.cwd, 16_384)), activeSignal), pattern = text(payload.pattern, 4096);
          if (!Number.isSafeInteger(payload.limit) || Number(payload.limit) < 1 || Number(payload.limit) > 100_000
            || !Array.isArray(payload.ignore) || payload.ignore.length > 128 || payload.ignore.some(value => typeof value !== "string" || value.length > 4096)) throw new HostedAgentExecutorError("INVALID_REQUEST");
          const assert = await this.#authorize(request, { name: "find", args: { path: cwd, pattern } }, activeSignal);
          const args = ["--files", "--hidden", "--glob", "!.git", "--glob", pattern, ...(payload.ignore as string[]).flatMap(ignore => ["--glob", "!" + ignore])];
          if (this.#options.remote) { const result = await this.#options.remote.process("rg", args, cwd, activeSignal, 30); assert();
            if (result.exitCode !== 0 && result.exitCode !== 1) throw new HostedAgentExecutorError("EXECUTOR_FAILED");
            return { paths: result.output.toString("utf8").split(/\r?\n/u).filter(Boolean).slice(0, Number(payload.limit)).map(value => this.#workspace.toAgentPath(this.#options.remote!.paths.join(cwd, value))) }; }
          let stdout: string;
          try { ({ stdout } = await runFile(this.#options.ripgrepExecutable ?? "rg", args, { cwd, signal: activeSignal,
            windowsHide: true, timeout: 30_000, maxBuffer: RAW_FILE_LIMIT, encoding: "utf8", env: terminalEnvironment() })); }
          catch (error) { if ((error as { code?: unknown }).code === 1) stdout = ""; else throw error; }
          assert(); return { paths: stdout.split(/\r?\n/u).filter(Boolean).slice(0, Number(payload.limit)).map(value => this.#workspace.toAgentPath(join(cwd, value))) };
        }
        case "pi.grep": {
          keys(payload, ["params"]); const params = record(payload.params);
          keys(params, ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"]);
          const path = await this.#canonical(this.#workspace.resolve(params.path === undefined ? "." : text(params.path, 16_384)), activeSignal);
          text(params.pattern, 16_384);
          if (params.glob !== undefined) text(params.glob, 4096);
          for (const key of ["ignoreCase", "literal"]) if (params[key] !== undefined && typeof params[key] !== "boolean") throw new HostedAgentExecutorError("INVALID_REQUEST");
          for (const key of ["context", "limit"]) if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || Number(params[key]) < 0 || Number(params[key]) > 100_000)) throw new HostedAgentExecutorError("INVALID_REQUEST");
          const assert = await this.#authorize(request, { name: "grep", args: { ...params, path } }, activeSignal);
          if (this.#options.remote) { const args = ["--line-number", "--hidden", "--glob", "!.git", ...(params.ignoreCase ? ["-i"] : []), ...(params.literal ? ["-F"] : []),
            ...(typeof params.glob === "string" ? ["--glob", params.glob] : []), ...(typeof params.context === "number" ? ["-C", String(params.context)] : []), "--", String(params.pattern), path];
            const result = await this.#options.remote.process("rg", args, this.#options.context.target.workspaceRoot, activeSignal, 30); assert();
            if (result.exitCode !== 0 && result.exitCode !== 1) throw new HostedAgentExecutorError("EXECUTOR_FAILED");
            const lines = result.output.toString("utf8").split(/\r?\n/u).filter(Boolean).slice(0, Number(params.limit ?? 100));
            return { text: this.#workspace.mapTextForAgent(lines.join("\n")), details: {} }; }
          const result = await createGrepToolDefinition(this.#options.context.target.workspaceRoot).execute(request.callId,
            { ...params, path } as GrepToolInput, activeSignal, undefined, {} as ExtensionContext);
          assert(); return { text: this.#workspace.mapTextForAgent(result.content.filter(part => part.type === "text").map(part => part.text).join("\n")), details: result.details };
        }
        case "exec.run": {
          keys(payload, ["command", "cwd", "timeout"]);
          const command = this.#workspace.mapCommand(text(payload.command, 1024 * 1024)), cwd = await this.#canonical(this.#workspace.resolve(text(payload.cwd, 16_384)), activeSignal);
          const timeout = payload.timeout === undefined ? 300 : Number(payload.timeout);
          if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 1800) throw new HostedAgentExecutorError("INVALID_REQUEST");
          const assert = await this.#authorize(request, { name: "bash", args: { command, cwd } }, activeSignal);
          const commandId = `hosted:${this.#options.context.sessionId}:${randomUUID()}`, gate = this.#options.commandConcurrencyGate;
          if (gate) { const admitted = await gate.acquire({ commandId, sessionId: this.#options.context.sessionId, signal: activeSignal });
            if (admitted !== "immediate" && admitted !== "queued") throw new HostedAgentExecutorError("ACCESS_DENIED"); }
          try {
            if (this.#options.remote) { const result = await this.#options.remote.execute(command, cwd, timeout, activeSignal, this.#workspace, effects); assert(); return result; }
            assert(); let output = Buffer.alloc(0), pendingOutput = Buffer.alloc(0);
            const marker = `\u001eJOKO_CWD_${randomUUID()}:`;
            const emit = (line: Buffer) => {
              const position = line.indexOf(marker), visible = position < 0 ? line : line.subarray(0, position);
              if (visible.length) effects?.onOutput?.(this.#workspace.mapOutputForAgent(visible));
            };
            const append = (chunk: Buffer) => {
              output = Buffer.concat([output, chunk]); if (output.byteLength > SHELL_OUTPUT_LIMIT) output = output.subarray(output.byteLength - SHELL_OUTPUT_LIMIT);
              if (effects?.onOutput) {
                pendingOutput = Buffer.concat([pendingOutput, chunk]);
                for (;;) { const end = pendingOutput.indexOf(10); if (end < 0) break; emit(pendingOutput.subarray(0, end + 1)); pendingOutput = pendingOutput.subarray(end + 1); }
                if (pendingOutput.length > SHELL_OUTPUT_LIMIT) { emit(pendingOutput.subarray(0, pendingOutput.length - 1024)); pendingOutput = pendingOutput.subarray(pendingOutput.length - 1024); }
              }
            };
            const projected = () => {
              const position = effects?.captureCwd ? output.lastIndexOf(marker) : -1;
              const observed = position < 0 ? undefined : output.subarray(position + Buffer.byteLength(marker)).toString("utf8").trim();
              const visible = position < 0 ? output : output.subarray(0, position);
              return { output: this.#workspace.mapOutputForAgent(visible).toString("base64"),
                ...(effects?.captureCwd ? { cwd: observed ? this.#workspace.toAgentPath(realPathOrAncestor(observed)) : this.#workspace.toAgentPath(cwd) } : {}) };
            };
            const shellCommand = effects?.captureCwd
              ? `trap 'joko_shell_exit=$?; printf "\\036JOKO_CWD_${marker.slice(10)}"; ${process.platform === "win32" ? "pwd -W 2>/dev/null || pwd -P" : "pwd -P"}; exit "$joko_shell_exit"' EXIT\n${command}`
              : command;
            try {
              const result = await createLocalBashOperations().exec(shellCommand, cwd, { signal: activeSignal,
                ...(effects?.background ? {} : { timeout }), env: terminalEnvironment(), onData: append });
              assert(); if (pendingOutput.length) emit(pendingOutput);
              return { ...projected(), exitCode: result.exitCode, timedOut: false, aborted: false };
            } catch (error) {
              if (activeSignal.aborted) throw new HostedAgentExecutorError("STALE_AUTHORITY");
              if (error instanceof Error && error.message.startsWith("timeout:")) { assert(); if (pendingOutput.length) emit(pendingOutput);
                return { ...projected(), exitCode: null, timedOut: true, aborted: false }; }
              throw error;
            }
          } finally { gate?.release(commandId, "hosted_command_finished"); }
        }
        default: throw new HostedAgentExecutorError("INVALID_REQUEST");
      }
    } catch (error) {
      if (error instanceof HostedAgentExecutorError) throw error;
      if (["ENOENT", "ENOTDIR", "NOT_FOUND", "not_found"].includes(String((error as { code?: unknown })?.code))) throw new HostedAgentExecutorError("NOT_FOUND");
      throw new HostedAgentExecutorError(activeSignal.aborted ? "STALE_AUTHORITY" : "EXECUTOR_FAILED");
    }
  }

  #assertCurrent(signal: AbortSignal): void {
    if (signal.aborted || this.#lifetime.signal.aborted) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    try { this.#options.assertCurrent(); this.#options.remote?.assertCurrent(); } catch { throw new HostedAgentExecutorError("STALE_AUTHORITY"); }
  }
  #canonical(path: string, signal: AbortSignal): Promise<string> { return this.#options.remote ? this.#options.remote.canonical(path, signal) : Promise.resolve(realPathOrAncestor(path)); }
  async #authorize(request: ExecutorRequest, call: ToolCall, signal: AbortSignal, requestedPath?: string): Promise<() => void> {
    this.#assertCurrent(signal);
    if (request.operation !== "tool.begin") return this.#toolOperation(request, call, signal);
    const policy = this.#options.readPolicy(), native = this.#options.context.nativeToolAuthorization, revision = native?.capture();
    const inputFiles = this.#options.inputFiles?.() ?? [], inputPath = String(call.args.path ?? call.args.cwd ?? "");
    const inputMount = inputFiles.find(file => isWithinInput(file.path, inputPath));
    if (inputMount && (!sameInputPath(inputMount.path, inputPath) || !["read", "ls", "find", "grep"].includes(call.name))) throw new HostedAgentExecutorError("ACCESS_DENIED");
    const assert = () => {
      this.#assertCurrent(signal);
      inputMount?.assertCurrent();
      if (this.#options.readPolicy().revision !== policy.revision) throw new HostedAgentExecutorError("STALE_AUTHORITY");
      try { native?.assertCurrent(revision); } catch { throw new HostedAgentExecutorError("STALE_AUTHORITY"); }
    };
    assert(); this.#workspace.setExtraDirs(policy.approvedRoots.map(root => root.path));
    const context = { workspaceRoot: this.#options.context.target.workspaceRoot, mode: policy.permissionMode,
      ...(this.#options.remote ? { pathStyle: this.#options.remote.authority.pathStyle } : {}),
      readOnly: this.#options.context.runtimePolicy === "review_read_only", extraReadOnlyRoots: policy.approvedRoots.map(root => root.path),
      explicitDenyTools: new Set<string>(), explicitAllowTools: new Set<string>(), policySnapshot: policy.snapshot };
    const risk = classifyToolCall(call, context);
    const nativePolicy = policy.snapshot === undefined ? undefined : reviewNativeToolPolicy(policy.snapshot,
      { toolName: call.name, input: call.args, signal }, { remote: this.#options.remote !== undefined,
        ...(this.#options.remote ? { pathStyle: this.#options.remote.authority.pathStyle } : {}), extraReadOnlyRoots: context.extraReadOnlyRoots });
    if (nativePolicy?.verdict === "block" || nativePolicy?.unavailable) throw new HostedAgentExecutorError("ACCESS_DENIED");
    if (policy.planMode && !["safe_read", "safe_command"].includes(risk)) throw new HostedAgentExecutorError("ACCESS_DENIED");
    const local = decideToolCall(call, context);
    const requested = requestedPath && call.name !== "bash" ? decideToolCall({ ...call, args: { ...call.args, path: requestedPath } }, context) : local;
    if (local.action === "deny" || requested.action === "deny") throw new HostedAgentExecutorError("ACCESS_DENIED");
    const orderedAsk = nativePolicy?.verdict === "ask" || policy.snapshot !== undefined && [call, ...(requestedPath && call.name !== "bash"
      ? [{ ...call, args: { ...call.args, path: requestedPath } }] : [])].some(value =>
        evaluateOrderedPolicyRules(policy.snapshot!, policyObservationForToolCall(value, context))?.action === "ask");
    const delegated = await native?.review({ toolName: call.name, input: call.args, signal }); assert();
    if (delegated?.verdict === "block" || delegated?.unavailable) throw new HostedAgentExecutorError("ACCESS_DENIED");
    const commandOptions = { cwd: String(call.args.cwd ?? this.#options.context.target.workspaceRoot), platform: this.#options.remote?.authority.pathStyle === "win32" ? "win32" : this.#options.remote ? "linux" : process.platform,
      resolveFilePath: (operand: string, cwd: string) => this.#options.remote ? this.#workspace.resolve(operand, cwd) : realPathOrAncestor(this.#workspace.resolve(operand, cwd)) };
    let credential = policy.confirmCredentials && !this.#options.credentialConsent?.hasForSession() && (call.name === "bash"
      ? isShareCredentialCommand(String(call.args.command), this.#workspace.allRoots(), commandOptions)
      : isShareCredentialPath(String(call.args.path ?? "")) || isShareCredentialPath(requestedPath ?? ""));
    if (credential && call.name === "bash" && !this.#options.remote) {
      const reads = shareCredentialGitReads(String(call.args.command), this.#workspace.allRoots(), commandOptions);
      if (reads && await this.#gitCredentials.provesSafe(String(call.args.command), reads, signal)) credential = false;
      assert();
    }
    // The Provider's native approval is not authority on this computer. Run
    // contextual review here, after deterministic policy and credential gates.
    const automatic = !credential && !orderedAsk && policy.permissionMode === "auto" && delegated?.verdict !== "ask" && delegated?.verdict !== "allow"
      && (local.action === "ask" || requested.action === "ask")
      ? await this.#options.reviewTool?.(call, signal, assert, policy) : undefined;
    assert();
    if (automatic?.verdict === "block") throw new HostedAgentExecutorError("ACCESS_DENIED");
    const key = createHash("sha256").update(JSON.stringify([request.callId, call.name === "edit" ? "write" : call.name, call.args])).digest("hex");
    const approval = this.#approvals.get(key);
    const approved = approval && approval.revision === policy.revision && approval.authorization === revision && approval.expiresAt > Date.now();
    if (!approved && (credential || orderedAsk || delegated?.verdict === "ask" || automatic?.verdict === "ask"
      || (local.action === "ask" || requested.action === "ask") && delegated?.verdict !== "allow" && automatic?.verdict !== "allow")) {
      const summaryInput = ["write", "edit"].includes(call.name) ? { path: call.args.path } : call.args;
      const summary = credential ? "This operation may expose task credentials to the shared Provider's computer. Confirm it on this task's computer.\n" + redactSecrets(JSON.stringify(summaryInput)).slice(0, 8192)
        : `Allow ${call.name} on the task's computer?\n${redactSecrets(JSON.stringify(summaryInput)).slice(0, 8192)}`;
      const decision = await this.#options.context.requestInteraction({ id: `hosted-executor:${this.#options.context.generation}:${randomUUID()}`,
        kind: "permission", title: credential ? "Allow credential access" : "Allow task operation", toolName: call.name, summary,
        risk: credential || risk === "dangerous" ? "high" : "medium", choices: credential && this.#options.credentialConsent
          ? ["allow_once", "allow_for_session", "deny_once"] : ["allow_once", "deny_once"] }, { signal });
      assert();
      if (credential && decision.kind === "selected" && decision.value === "allow_for_session" && this.#options.credentialConsent) {
        await this.#options.credentialConsent.allowForSession(); assert();
      } else if (!(decision.kind === "confirmed" && decision.confirmed || decision.kind === "selected" && decision.value === "allow_once")) throw new HostedAgentExecutorError("ACCESS_DENIED");
      if (this.#approvals.size >= 256) this.#approvals.delete(this.#approvals.keys().next().value!);
      this.#approvals.set(key, { revision: policy.revision, authorization: revision, expiresAt: Date.now() + APPROVAL_TTL });
    }
    return assert;
  }
  #toolOperation(request: ExecutorRequest, call: ToolCall, signal: AbortSignal): () => void {
    const lease = this.#tools.get(request.callId);
    const operations: Readonly<Record<string, readonly string[]>> = {
      read: ["fs.read", "fs.access", "fs.mime", "fs.stat"], write: ["fs.mkdir", "fs.write"], edit: ["fs.mkdir", "fs.access", "fs.read", "fs.write"],
      ls: ["fs.stat", "fs.readdir"], find: ["fs.stat", "fs.glob"], grep: ["pi.grep"], bash: ["exec.run"]
    };
    if (!lease || lease.expiresAt <= Date.now() || !operations[lease.name]?.includes(request.operation)) throw new HostedAgentExecutorError("ACCESS_DENIED");
    const expectedPath = request.operation === "fs.mkdir" ? (this.#options.remote?.paths.dirname(lease.path) ?? dirname(lease.path)) : lease.path;
    if (String(call.args.path ?? call.args.cwd) !== expectedPath
      || request.operation === "fs.access" && request.payload.mode === "write" && lease.name !== "edit"
      || request.operation === "fs.glob" && request.payload.pattern !== lease.pattern
      || request.operation === "pi.grep" && searchIdentity(call.args) !== lease.search
      || request.operation === "exec.run" && (call.args.command !== lease.command || Number(request.payload.timeout ?? 300) !== lease.timeout)) {
      throw new HostedAgentExecutorError("ACCESS_DENIED");
    }
    const assert = () => { this.#assertCurrent(signal); lease.assert(); };
    assert(); return assert;
  }
  async #withFile<T>(path: string, mode: "read" | "write", assert: () => void,
    action: (handle: Awaited<ReturnType<typeof open>>) => Promise<T>): Promise<T> {
    assert(); const handle = await open(path, (mode === "read" ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT) | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const [actual, opened, current] = await Promise.all([realpath(path), handle.stat(), stat(path)]); assert();
      if (actual !== path || opened.dev !== current.dev || opened.ino !== current.ino || !opened.isFile()) throw new HostedAgentExecutorError("STALE_AUTHORITY");
      return await action(handle);
    } finally { await handle.close(); }
  }
}

async function readAuthorizedLines(handle: Awaited<ReturnType<typeof open>>, range: NonNullable<HostedAgentExecutorEffects["readLines"]>,
  signal: AbortSignal, assert: () => void, project: (lines: readonly string[]) => readonly string[]): Promise<Record<string, unknown>> {
  const before = await handle.stat(), hash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true });
  const lines: string[] = []; let partial = "", totalLines = 0, returnedBytes = 0, readBytes = 0;
  const append = (part: string) => { if (partial.length <= range.maxLineChars) partial = (partial + part).slice(0, range.maxLineChars + 1); };
  const finish = () => {
    totalLines++;
    if (totalLines >= range.offset && totalLines - range.offset < range.limit) {
      const raw = partial.endsWith("\r") ? partial.slice(0, -1) : partial;
      const line = raw.slice(0, range.maxLineChars);
      returnedBytes += Buffer.byteLength(line) + 1;
      if (returnedBytes > RAW_FILE_LIMIT) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
      lines.push(line);
    }
    partial = "";
  };
  const consume = (text: string) => {
    if (text.includes("\0")) throw new HostedAgentExecutorError("INVALID_REQUEST");
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
      append(text.slice(start, end)); finish(); start = end + 1;
    }
    append(text.slice(start));
  };
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, signal })) {
    assert(); readBytes += chunk.byteLength; hash.update(chunk); consume(decoder.decode(chunk, { stream: true }));
  }
  consume(decoder.decode()); finish(); assert();
  const after = await handle.stat(); assert();
  if (readBytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new HostedAgentExecutorError("STALE_AUTHORITY");
  const projected = project(lines); assert();
  if (projected.reduce((size, line) => size + Buffer.byteLength(line) + 1, 0) > RAW_FILE_LIMIT) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
  return { lines: projected, totalLines, sha256: hash.digest("hex") };
}

function sameInputPath(a: string, b: string): boolean { return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b); }
function isWithinInput(root: string, target: string): boolean { const value = relative(root, target); return value === "" || value !== ".." && !value.startsWith("..\\") && !value.startsWith("../") && !isAbsolute(value); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostedAgentExecutorError("INVALID_REQUEST"); return value as Record<string, unknown>; }
function text(value: unknown, maximum: number): string { if (typeof value !== "string" || !value || value.length > maximum || value.includes("\0")) throw new HostedAgentExecutorError("INVALID_REQUEST"); return value; }
function keys(value: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) throw new HostedAgentExecutorError("INVALID_REQUEST"); }
function parseRequest(input: unknown): ExecutorRequest {
  const value = record(input); keys(value, ["format", "callId", "requestId", "operation", "payload"]);
  const callId = text(value.callId, 1024), requestId = text(value.requestId, 1100), operation = text(value.operation, 64), payload = record(value.payload);
  if (value.format !== 1 || !requestId.startsWith(callId + ":") || !/^[1-9]\d{0,3}$/u.test(requestId.slice(callId.length + 1))
    || Number(requestId.slice(callId.length + 1)) > 1024 || Buffer.byteLength(JSON.stringify(input)) > REQUEST_LIMIT) throw new HostedAgentExecutorError("INVALID_REQUEST");
  return { format: 1, callId, requestId, operation, payload };
}
function decodeBytes(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(RAW_FILE_LIMIT / 3) * 4 || value.length % 4 !== 0) throw new HostedAgentExecutorError("INVALID_REQUEST");
  const bytes = Buffer.from(value, "base64"); if (bytes.toString("base64") !== value || bytes.byteLength > RAW_FILE_LIMIT) throw new HostedAgentExecutorError("INVALID_REQUEST"); return bytes;
}
function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
function searchIdentity(input: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b, "en")));
}
