import { posix, win32, type PlatformPath } from "node:path";
import { RemoteSshError, type RemoteFileTransportPort, type RemoteProcessHandle, type RemoteProcessTransportPort } from "@joko/remote-ssh";
import { TerminalError, type TerminalRuntime, type TerminalScope, type TerminalShell } from "@joko/tool-terminal";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";

const DISCOVERY_OUTPUT_BYTES = 16 * 1024;
const DISCOVERY_TIMEOUT_MS = 5000;
const SHELL_DISCOVERY = `for candidate in "$SHELL" /bin/bash /usr/bin/bash /bin/zsh /usr/bin/zsh /usr/bin/fish /bin/sh; do
  case "$candidate" in
    /*) if [ -f "$candidate" ] && [ -x "$candidate" ]; then printf '%s\\n' "$candidate"; fi ;;
  esac
done`;
const WINDOWS_SHELL_DISCOVERY = "where.exe pwsh.exe 2>nul & where.exe powershell.exe 2>nul & where.exe cmd.exe 2>nul";

/** Resolves one authenticated remote connection for each terminal creation. */
export class RemoteTerminalRuntimeResolver {
  constructor(private readonly remoteExecution: RemoteExecutionRouter) {}

  async resolve(scope: TerminalScope, signal?: AbortSignal): Promise<TerminalRuntime> {
    if (scope.remoteWorkspace === undefined) throw unavailable();
    try {
      signal?.throwIfAborted();
      const authority = await this.remoteExecution.terminal(scope.remoteWorkspace, signal);
      const { terminals, files, processes } = authority;
      const paths = authority.pathStyle === "win32" ? win32 : posix;
      return {
        discoverShells: () => discoverShells(processes, scope.workspaceRoot, paths, signal),
        canonicalDirectory: (root, cwd) => canonicalDirectory(files, paths, root, cwd, signal),
        spawn: async (shell, options, creationSignal) => {
          try {
            authority.assertCurrent();
            const terminal = await terminals.open({ executable: shell.executable, args: shell.args, ...options,
              ...(creationSignal === undefined ? {} : { signal: creationSignal }) });
            try {
              authority.assertCurrent();
              return terminal;
            } catch (error) {
              await terminal.kill().catch(() => undefined);
              throw error;
            }
          } catch (error) { throw terminalError(error); }
        }
      };
    } catch (error) { throw terminalError(error); }
  }
}

async function canonicalDirectory(
  files: RemoteFileTransportPort,
  paths: PlatformPath,
  root: string,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    signal?.throwIfAborted();
    if (!paths.isAbsolute(root) || paths.normalize(root) !== root || root.includes("\0")
      || paths.isAbsolute(cwd) || cwd.includes("\0")) throw new Error();
    const candidate = paths.resolve(root, cwd);
    const relative = paths.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new Error();
    if (await files.realpath(root, signal) !== root || (await files.stat(root, signal)).kind !== "directory"
      || await files.realpath(candidate, signal) !== candidate || (await files.stat(candidate, signal)).kind !== "directory") throw new Error();
    signal?.throwIfAborted();
    return candidate;
  } catch (error) {
    if (signal?.aborted === true) throw new TerminalError("ABORTED", "Terminal request cancelled.");
    if (error instanceof RemoteSshError) throw terminalError(error);
    throw new TerminalError("WORKSPACE_PATH_DENIED", "The remote terminal directory must remain within its canonical workspace.");
  }
}

async function discoverShells(
  processes: RemoteProcessTransportPort,
  cwd: string,
  paths: PlatformPath,
  signal?: AbortSignal
): Promise<readonly TerminalShell[]> {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const lifetime = AbortSignal.any([timeout, ...(signal === undefined ? [] : [signal])]);
  try {
    lifetime.throwIfAborted();
    const process = await openProbe(processes, cwd, paths === win32, lifetime);
    const output = await new Promise<string>((resolve, reject) => {
      let size = 0;
      let settled = false;
      let stdoutEnded = process.stdout.readableEnded;
      let stderrEnded = process.stderr.readableEnded;
      let exited = process.exitCode !== null || process.signalCode !== null;
      let successful = process.exitCode === 0 && process.signalCode === null;
      const chunks: Buffer[] = [];
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        lifetime.removeEventListener("abort", abort);
        if (error !== undefined) void stopProbe(process).then(() => reject(error), reject);
        else resolve(Buffer.concat(chunks).toString("utf8"));
      };
      const abort = (): void => finish(unavailable());
      const complete = (): void => { if (exited && stdoutEnded && stderrEnded) finish(successful ? undefined : unavailable()); };
      lifetime.addEventListener("abort", abort, { once: true });
      process.stdout.on("data", (data: Buffer | string) => {
        if (settled) return;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        size += chunk.length;
        if (size > DISCOVERY_OUTPUT_BYTES) finish(unavailable());
        else chunks.push(chunk);
      });
      process.stderr.on("data", (data: Buffer | string) => {
        if (settled) return;
        size += Buffer.byteLength(data);
        if (size > DISCOVERY_OUTPUT_BYTES) finish(unavailable());
      });
      process.stdout.on("error", () => finish(unavailable()));
      process.stderr.on("error", () => finish(unavailable()));
      process.stdout.once("end", () => { stdoutEnded = true; complete(); });
      process.stderr.once("end", () => { stderrEnded = true; complete(); });
      process.stdin.on("error", () => finish(unavailable()));
      process.once("error", () => finish(unavailable()));
      process.once("exit", (code, exitSignal) => { exited = true; successful = code === 0 && exitSignal === null; complete(); });
      if (lifetime.aborted) abort();
      else { process.stdin.end(); complete(); }
    });
    lifetime.throwIfAborted();
    const executables = [...new Set(output.split(/\r?\n/u).map((value) => value.trim()).filter((value) => value !== ""))];
    if (executables.length > 32 || executables.some((path) => !paths.isAbsolute(path) || path.length > 1024 || /[\u0000-\u001f\u007f]/u.test(path))) throw unavailable();
    return executables.map((executable, index) => ({
      id: executable,
      label: paths.basename(executable),
      executable,
      args: paths === win32
        ? (paths.basename(executable).toLowerCase() === "cmd.exe" ? ["/Q"] : ["-NoLogo"])
        : ["-i"],
      isDefault: index === 0
    }));
  } catch (error) {
    const failure = terminalError(error);
    if (failure.stateMayHaveChanged) throw failure;
    if (signal?.aborted === true) throw new TerminalError("ABORTED", "Terminal request cancelled.");
    throw failure;
  }
}

async function openProbe(
  processes: RemoteProcessTransportPort,
  cwd: string,
  windows: boolean,
  signal: AbortSignal
): Promise<RemoteProcessHandle> {
  signal.throwIfAborted();
  return new Promise<RemoteProcessHandle>((resolve, reject) => {
    let settled = false;
    let attempted = false;
    const abort = (): void => { if (!settled) { settled = true; reject(attempted ? probeUnknown() : new TerminalError("ABORTED", "Terminal request cancelled.")); } };
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      attempted = true;
      return processes.open(windows
        ? { executable: "cmd.exe", args: ["/d", "/s", "/c", WINDOWS_SHELL_DISCOVERY], cwd, signal }
        : { executable: "/bin/sh", args: ["-c", SHELL_DISCOVERY], cwd, signal });
    }).then((process) => {
      signal.removeEventListener("abort", abort);
      if (settled || signal.aborted) {
        // A late read-only discovery channel must never become an interactive terminal.
        process.on("error", () => undefined);
        void stopProbe(process).catch(() => undefined);
        abort();
        return;
      }
      settled = true;
      resolve(process);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      if (!settled) { settled = true; reject(attempted ? probeUnknown() : terminalError(error)); }
    });
  });
}

function stopProbe(process: RemoteProcessHandle): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (confirmed) resolve(); else reject(probeUnknown());
    };
    const timer = setTimeout(() => finish(false), 2000);
    process.once("exit", (code, signal) => finish(code !== null || signal !== null));
    process.once("error", () => finish(false));
    try { process.kill("SIGTERM"); } catch { finish(false); }
  });
}

function probeUnknown(): TerminalError {
  return new TerminalError("CLEANUP_UNKNOWN", "The remote shell discovery process exit could not be confirmed.", true);
}

function unavailable(): TerminalError {
  return new TerminalError("RUNTIME_UNAVAILABLE", "Connect the remote execution target and ensure an interactive shell is available.");
}

function terminalError(error: unknown): TerminalError {
  if (error instanceof TerminalError) return error;
  if (error instanceof RemoteSshError && error.details?.stateMayHaveChanged === true) {
    return new TerminalError("CLEANUP_UNKNOWN", "The remote terminal process exit could not be confirmed.", true);
  }
  if (hasUnknownRemoteOutcome(error)) {
    return new TerminalError("CLEANUP_UNKNOWN", "The remote terminal process exit could not be confirmed.", true);
  }
  if (error instanceof Error && error.name === "AbortError" || error instanceof RemoteSshError && error.code === "ABORTED") {
    return new TerminalError("ABORTED", "Terminal request cancelled.");
  }
  return unavailable();
}

function hasUnknownRemoteOutcome(error: unknown): boolean {
  return error instanceof Error
    && "stateMayHaveChanged" in error
    && (error as Error & { readonly stateMayHaveChanged?: unknown }).stateMayHaveChanged === true;
}
