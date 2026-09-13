import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";

import { WorktreeServiceError } from "./errors.js";
import { WorktreeOperationControl } from "./operation.js";

const MAXIMUM_GIT_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_GIT_STEP_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 750;
const TERMINATION_SETTLE_MS = 5_000;

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitRunOptions {
  readonly timeoutCapMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly indexFile?: string;
}

export class GitCommandError extends WorktreeServiceError {
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(message: string, stderr: string, exitCode: number | null) {
    super("GIT_FAILED", message, {
      ...(exitCode === null ? {} : { exitCode }),
      hasStderr: stderr.trim().length > 0
    });
    this.name = "GitCommandError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export async function runGit(
  args: readonly string[],
  cwd: string | undefined,
  control: WorktreeOperationControl,
  options: GitRunOptions = {}
): Promise<GitResult> {
  control.check();
  if (!Array.isArray(args) || args.length === 0 || args.length > 128
    || args.some((argument) => typeof argument !== "string" || argument.length > 32_768 || argument.includes("\0"))) {
    throw new WorktreeServiceError("INVALID_ARGUMENT", "The Git argument vector is invalid.");
  }
  const timeoutMs = control.remaining(options.timeoutCapMs ?? DEFAULT_GIT_STEP_TIMEOUT_MS);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: "C",
    ...options.environment
  };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE"
  ]) {
    delete environment[key];
  }
  if (options.indexFile !== undefined) {
    if (typeof options.indexFile !== "string" || !isAbsolute(options.indexFile)
      || options.indexFile.includes("\0") || /[\r\n]/u.test(options.indexFile)) {
      throw new WorktreeServiceError("INVALID_ARGUMENT", "The temporary Git index path is invalid.");
    }
    environment.GIT_INDEX_FILE = options.indexFile;
  }

  return new Promise<GitResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("git", [...args], {
        ...(cwd === undefined ? {} : { cwd }),
        env: environment,
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(spawnError(error));
      return;
    }

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream === null || stderrStream === null) {
      terminateProcessTree(child, "SIGKILL");
      reject(new WorktreeServiceError("GIT_FAILED", "Git output streams were unavailable."));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: WorktreeServiceError | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      control.signal?.removeEventListener("abort", abort);
    };
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const terminate = (error: WorktreeServiceError): void => {
      if (terminationError !== undefined || settled) return;
      terminationError = error;
      terminateProcessTree(child, "SIGTERM");
      forceTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
      forceTimer.unref();
      settleTimer = setTimeout(() => {
        finish(() => reject(terminationError ?? error));
      }, TERMINATION_SETTLE_MS);
      settleTimer.unref();
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAXIMUM_GIT_OUTPUT_BYTES) {
        terminate(new WorktreeServiceError(
          "OUTPUT_LIMIT_EXCEEDED",
          "Git output exceeded its safe limit.",
          { maximumBytes: MAXIMUM_GIT_OUTPUT_BYTES }
        ));
        return;
      }
      target.push(chunk);
    };
    const abort = (): void => terminate(new WorktreeServiceError("ABORTED", "The worktree operation was aborted."));
    const timeoutTimer = setTimeout(() => {
      terminate(new WorktreeServiceError("OPERATION_TIMEOUT", "A Git operation exceeded its deadline."));
    }, timeoutMs);
    timeoutTimer.unref();

    stdoutStream.on("data", (chunk: Buffer) => collect(stdout, chunk));
    stderrStream.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(() => reject(spawnError(error))));
    child.once("close", (code) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (terminationError !== undefined) {
        finish(() => reject(terminationError));
        return;
      }
      if (code !== 0) {
        finish(() => reject(new GitCommandError("Git command failed.", stderrText, code)));
        return;
      }
      finish(() => resolve({ stdout: stdoutText, stderr: stderrText, exitCode: code }));
    });
    control.signal?.addEventListener("abort", abort, { once: true });
    if (control.signal?.aborted === true) abort();
  });
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        detached: false,
        stdio: "ignore"
      });
      killer.unref();
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* Process already exited. */ }
  }
}

function spawnError(error: unknown): WorktreeServiceError {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code ?? "")
    : "";
  if (code === "ENOENT") return new WorktreeServiceError("GIT_NOT_FOUND", "Git is not installed or is unavailable.");
  return new WorktreeServiceError("GIT_FAILED", "Git could not be started safely.");
}
