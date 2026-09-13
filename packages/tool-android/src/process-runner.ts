import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { redactAndroidOutput } from "./redaction.js";

export interface AndroidCommandRequest {
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
  readonly stdoutMode?: "binary" | "text";
  readonly maximumStdoutBytes?: number;
  readonly maximumStderrBytes?: number;
  readonly onSpawn?: (pid: number | undefined) => void;
}

export interface AndroidCommandResult {
  readonly stdout: string;
  readonly stdoutBuffer?: Buffer;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface AndroidCommandRunner {
  run(request: AndroidCommandRequest): Promise<AndroidCommandResult>;
}

export type AndroidSpawn = (
  command: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface BoundedAndroidCommandRunnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: AndroidSpawn;
  readonly maximumStdoutBytes?: number;
  readonly maximumStderrBytes?: number;
  readonly redactRoots?: readonly string[];
}

export class AndroidProcessError extends Error {
  constructor(
    readonly kind: "spawn" | "timeout",
    readonly result: AndroidCommandResult
  ) {
    super(kind === "timeout" ? "ADB command timed out." : "ADB command could not start.");
    this.name = "AndroidProcessError";
  }
}

const DEFAULT_MAXIMUM_STDOUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAXIMUM_STDERR_BYTES = 512 * 1024;
const MAXIMUM_CAPTURE_BYTES = 32 * 1024 * 1024;

export class BoundedAndroidCommandRunner implements AndroidCommandRunner {
  readonly #platform: NodeJS.Platform;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #spawn: AndroidSpawn;
  readonly #maximumStdoutBytes: number;
  readonly #maximumStderrBytes: number;
  readonly #redactRoots: readonly string[];

  constructor(options: BoundedAndroidCommandRunnerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#environment = options.environment ?? process.env;
    this.#spawn = options.spawn ?? ((command, arguments_, spawnOptions) =>
      nodeSpawn(command, [...arguments_], spawnOptions));
    this.#maximumStdoutBytes = captureLimit(
      options.maximumStdoutBytes ?? DEFAULT_MAXIMUM_STDOUT_BYTES,
      "Default stdout capture limit"
    );
    this.#maximumStderrBytes = captureLimit(
      options.maximumStderrBytes ?? DEFAULT_MAXIMUM_STDERR_BYTES,
      "Default stderr capture limit"
    );
    this.#redactRoots = [...(options.redactRoots ?? [])];
  }

  run(request: AndroidCommandRequest): Promise<AndroidCommandResult> {
    validateCommandRequest(request);
    if (request.signal?.aborted === true) return Promise.reject(abortError());
    const stdout = new BoundedBytes(captureLimit(
      request.maximumStdoutBytes ?? this.#maximumStdoutBytes,
      "Stdout capture limit"
    ));
    const stderr = new BoundedBytes(captureLimit(
      request.maximumStderrBytes ?? this.#maximumStderrBytes,
      "Stderr capture limit"
    ));

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.#spawn(request.command, request.arguments ?? [], {
          stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          env: safeAndroidEnvironment(this.#environment, this.#platform)
        });
      } catch {
        reject(new AndroidProcessError("spawn", commandResult(
          stdout,
          stderr,
          null,
          null,
          request.stdoutMode,
          this.#redactRoots
        )));
        return;
      }

      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const stop = (): void => {
        try {
          child.kill();
        } catch {
          // A concurrently exiting process needs no further action.
        }
      };
      const onAbort = (): void => finish(() => {
        stop();
        reject(abortError());
      });
      const timer = setTimeout(() => finish(() => {
        stop();
        reject(new AndroidProcessError("timeout", commandResult(
          stdout,
          stderr,
          null,
          null,
          request.stdoutMode,
          this.#redactRoots
        )));
      }), request.timeoutMs);

      request.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("spawn", () => {
        try {
          request.onSpawn?.(child.pid);
        } catch {
          // Observability callbacks must not affect the process lifecycle.
        }
      });
      child.once("error", () => finish(() => {
        reject(new AndroidProcessError("spawn", commandResult(
          stdout,
          stderr,
          null,
          null,
          request.stdoutMode,
          this.#redactRoots
        )));
      }));
      child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
      child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));
      if (request.stdin !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(request.stdin);
      }
      child.once("close", (exitCode, signal) => finish(() => {
        resolve(commandResult(
          stdout,
          stderr,
          exitCode,
          signal,
          request.stdoutMode,
          this.#redactRoots
        ));
      }));
    });
  }
}

export function safeAndroidEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const keys = platform === "win32"
    ? [
        "APPDATA",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERPROFILE"
      ]
    : ["HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TEMP", "TMP", "TMPDIR", "USER"];
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.startsWith("()")) result[key] = value;
  }
  const serverPort = source["ANDROID_ADB_SERVER_PORT"];
  if (typeof serverPort === "string" && /^\d{1,5}$/u.test(serverPort)) {
    const parsed = Number(serverPort);
    if (parsed >= 1 && parsed <= 65_535) result["ANDROID_ADB_SERVER_PORT"] = String(parsed);
  }
  return result;
}

function validateCommandRequest(request: AndroidCommandRequest): void {
  if (request.command.trim() === "" || request.command.length > 32_768 || request.command.includes("\0")) {
    throw new TypeError("ADB executable must be a bounded name or path.");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60 * 60 * 1_000) {
    throw new RangeError("ADB command timeout must be between one millisecond and one hour.");
  }
  for (const argument of request.arguments ?? []) {
    if (argument.length > 1024 * 1024 || argument.includes("\0")) {
      throw new TypeError("ADB command argument is invalid.");
    }
  }
}

function captureLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_CAPTURE_BYTES) {
    throw new RangeError(`${label} must be between one byte and 32 MiB.`);
  }
  return value;
}

function commandResult(
  stdout: BoundedBytes,
  stderr: BoundedBytes,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stdoutMode: AndroidCommandRequest["stdoutMode"],
  redactRoots: readonly string[]
): AndroidCommandResult {
  const stdoutBuffer = stdout.buffer();
  return {
    stdout: stdoutMode === "binary" ? "" : redactAndroidOutput(stdoutBuffer.toString("utf8"), redactRoots),
    ...(stdoutMode === "binary" ? { stdoutBuffer } : {}),
    stderr: redactAndroidOutput(stderr.buffer().toString("utf8"), redactRoots),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    exitCode,
    signal
  };
}

class BoundedBytes {
  readonly #maximumBytes: number;
  readonly #chunks: Buffer[] = [];
  #byteLength = 0;
  truncated = false;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = this.#maximumBytes - this.#byteLength;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.byteLength <= remaining) {
      this.#chunks.push(chunk);
      this.#byteLength += chunk.byteLength;
      return;
    }
    this.#chunks.push(chunk.subarray(0, remaining));
    this.#byteLength += remaining;
    this.truncated = true;
  }

  buffer(): Buffer {
    return Buffer.concat(this.#chunks, this.#byteLength);
  }
}

function abortError(): Error {
  return new DOMException("The ADB command was cancelled.", "AbortError");
}
