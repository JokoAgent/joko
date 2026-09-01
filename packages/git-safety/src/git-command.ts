import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GitCommandOptions {
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxBufferBytes?: number;
  readonly timeoutMs?: number;
}

export interface GitCommandResult {
  readonly stdout: string;
}

export interface GitCommandRunner {
  run(repositoryRoot: string, args: readonly string[], options?: GitCommandOptions): Promise<GitCommandResult>;
}

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly outputOverflow: boolean;
  readonly timedOut: boolean;

  constructor(input: {
    readonly exitCode: number | null;
    readonly outputOverflow: boolean;
    readonly timedOut: boolean;
  }) {
    super(input.outputOverflow
      ? "Git command output exceeded the safety limit."
      : input.timedOut
        ? "Git command exceeded the execution time limit."
        : "Git command failed.");
    this.name = "GitCommandError";
    this.exitCode = input.exitCode;
    this.outputOverflow = input.outputOverflow;
    this.timedOut = input.timedOut;
  }
}

export class NodeGitCommandRunner implements GitCommandRunner {
  readonly #executable: string;
  readonly #maxBufferBytes: number;
  readonly #timeoutMs: number;

  constructor(options: {
    readonly executable?: string;
    readonly maxBufferBytes?: number;
    readonly timeoutMs?: number;
  } = {}) {
    this.#executable = options.executable ?? "git";
    this.#maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  run(repositoryRoot: string, args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
    return new Promise((resolveResult, rejectResult) => {
      execFile(this.#executable, [...args], {
        cwd: repositoryRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: options.timeoutMs ?? this.#timeoutMs,
        maxBuffer: options.maxBufferBytes ?? this.#maxBufferBytes,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          ...options.environment
        }
      }, (error, stdout) => {
        if (error === null) {
          resolveResult({ stdout });
          return;
        }
        const candidate = error as NodeJS.ErrnoException & {
          readonly code?: string | number;
          readonly killed?: boolean;
          readonly signal?: NodeJS.Signals | null;
        };
        rejectResult(new GitCommandError({
          exitCode: typeof candidate.code === "number" ? candidate.code : null,
          outputOverflow: candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxbuffer/iu.test(error.message),
          timedOut: candidate.killed === true || candidate.signal !== undefined && candidate.signal !== null
        }));
      });
    });
  }
}

export async function detectRepositoryRoot(
  workingDirectory: string,
  runner: GitCommandRunner
): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await runner.run(workingDirectory, ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
  const candidate = stdout.trim();
  if (candidate === "") return null;
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(workingDirectory, candidate);
  return realpath(absolute).catch(() => null);
}
