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
  /** Optional inactivity budget within the existing whole-operation deadline. */
  readonly idleTimeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly indexFile?: string;
  readonly input?: string;
  readonly refTransaction?: {
    readonly commands: string;
    readonly beforeCommit: () => Promise<void>;
  };
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
  if (options.idleTimeoutMs !== undefined && (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1)) {
    throw new WorktreeServiceError("INVALID_ARGUMENT", "The Git inactivity budget is invalid.");
  }
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

  const transaction = options.refTransaction;
  if (transaction !== undefined && options.input !== undefined) {
    throw new WorktreeServiceError("INVALID_ARGUMENT", "A Git reference transaction already owns the input stream.");
  }
  const writesInput = transaction !== undefined || options.input !== undefined;
  return new Promise<GitResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn("git", [...args], {
        ...(cwd === undefined ? {} : { cwd }),
        env: environment,
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
        stdio: [writesInput ? "pipe" : "ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(spawnError(error));
      return;
    }

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (stdoutStream === null || stderrStream === null || (writesInput && stdinStream === null)) {
      terminateProcessTree(child, "SIGKILL");
      reject(new WorktreeServiceError("GIT_FAILED", "Git process streams were unavailable."));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let terminationError: WorktreeServiceError | undefined;
    let transactionPrepared = false;
    let transactionRejection: { readonly error: unknown } | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      clearTimeout(idleTimer);
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
      resetIdleTimer();
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
    const resetIdleTimer = (): void => {
      if (options.idleTimeoutMs === undefined || settled || terminationError !== undefined) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate(new WorktreeServiceError("OPERATION_TIMEOUT", "Git stopped reporting progress.")), options.idleTimeoutMs);
      idleTimer.unref();
    };
    const timeoutTimer = setTimeout(() => {
      terminate(new WorktreeServiceError("OPERATION_TIMEOUT", "A Git operation exceeded its deadline."));
    }, timeoutMs);
    timeoutTimer.unref();
    resetIdleTimer();

    stdoutStream.on("data", (chunk: Buffer) => {
      collect(stdout, chunk);
      if (transaction === undefined || stdinStream === null || transactionPrepared || terminationError !== undefined
        || !/^prepare: ok\r?$/mu.test(Buffer.concat(stdout).toString("utf8"))) return;
      transactionPrepared = true;
      void (async () => {
        try {
          await transaction.beforeCommit();
          if (settled || terminationError !== undefined) return;
          control.check();
          stdinStream.end("commit\n");
        } catch (error) {
          if (settled || terminationError !== undefined) return;
          transactionRejection = { error };
          stdinStream.end("abort\n");
        }
      })();
    });
    stderrStream.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(() => reject(spawnError(error))));
    child.once("close", (code) => {
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      if (terminationError !== undefined) {
        finish(() => reject(terminationError));
        return;
      }
      if (transactionRejection !== undefined) {
        const { error } = transactionRejection;
        finish(() => reject(error));
        return;
      }
      if (code !== 0) {
        finish(() => reject(new GitCommandError("Git command failed.", stderrText, code)));
        return;
      }
      if (transaction !== undefined && !/^commit: ok\r?$/mu.test(stdoutText)) {
        finish(() => reject(new GitCommandError("Git did not confirm the reference transaction.", stderrText, code)));
        return;
      }
      finish(() => resolve({ stdout: stdoutText, stderr: stderrText, exitCode: code }));
    });
    control.signal?.addEventListener("abort", abort, { once: true });
    if (control.signal?.aborted === true) abort();
    else if (writesInput && stdinStream !== null) {
      stdinStream.on("error", () => { /* Git supplies the command error on exit. */ });
      if (transaction !== undefined) stdinStream.write(transaction.commands);
      else stdinStream.end(options.input);
    }
  });
}

export async function restoreMissingWorktreeBranch(
  repositoryRoot: string,
  input: {
    readonly gitDirectory: string;
    readonly branchRef: string;
    readonly head: string;
    readonly snapshotRef: string;
    readonly snapshotSha: string;
  },
  control: WorktreeOperationControl,
  assertVacantCheckout: () => Promise<void>
): Promise<void> {
  const { branchRef, head, snapshotRef, snapshotSha } = input;
  const gitDirectory = `--git-dir=${input.gitDirectory}`;
  const commands = ["start", "option no-deref", `verify ${snapshotRef} ${snapshotSha}`,
    "option no-deref", `create ${branchRef} ${head}`, "prepare", ""].join("\n");
  try {
    await runGit([gitDirectory, "update-ref", "--stdin", "-m", "restore archived Joko worktree"], repositoryRoot, control, {
      refTransaction: {
        commands,
        beforeCommit: async () => {
          // File-based Git versions may accept a dangling symbolic ref in an OID comparison.
          // Check the raw refs while Git holds both transaction locks.
          for (const ref of [branchRef, snapshotRef]) {
            const direct = await runGit([gitDirectory, "symbolic-ref", "--quiet", "--no-recurse", ref], repositoryRoot, control).then(
              () => false,
              (error: unknown) => {
                if (error instanceof GitCommandError && error.exitCode === 1) return true;
                throw error;
              }
            );
            if (!direct) throw new WorktreeServiceError("SESSION_CONFLICT", "A symbolic reference occupies the archive or restored branch.");
          }
          await assertVacantCheckout();
        }
      }
    });
  } catch (error) {
    if (!(error instanceof GitCommandError)) throw error;
    throw new WorktreeServiceError("SESSION_CONFLICT", "The archived branch could not be reserved with its original snapshot.");
  }
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
