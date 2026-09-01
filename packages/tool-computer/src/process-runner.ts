import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type ComputerHostPlatform = "darwin" | "win32" | "linux" | "unsupported";

export interface ComputerCommandRequest {
  readonly command: string;
  readonly arguments?: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
  readonly maximumStdoutBytes?: number;
  readonly maximumStderrBytes?: number;
  readonly onSpawn?: (pid: number | undefined) => void;
  readonly extraEnvironment?: Readonly<Record<string, string>>;
  readonly idleTimeoutMs?: number;
  readonly activityPollMs?: number;
  readonly sampleProcessActivity?: (
    rootPid: number,
    signal: AbortSignal
  ) => Promise<ComputerProcessActivitySample | undefined>;
  readonly onProcessActivity?: (sample: ComputerProcessActivitySample) => void;
  readonly killProcessTree?: boolean;
}

export interface ComputerProcessActivitySample {
  readonly fingerprint: string;
  readonly phase?: "downloading" | "installing";
  readonly downloadedBytes?: number | null;
  readonly totalBytes?: number | null;
}

export interface ComputerCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ComputerCommandRunner {
  run(request: ComputerCommandRequest): Promise<ComputerCommandResult>;
}

export type ComputerSpawn = (
  command: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface BoundedCommandRunnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: ComputerSpawn;
  readonly maximumStdoutBytes?: number;
  readonly maximumStderrBytes?: number;
}

export class ComputerProcessError extends Error {
  constructor(
    readonly kind: "spawn" | "timeout" | "idle_timeout",
    readonly result: ComputerCommandResult
  ) {
    super(kind === "spawn"
      ? "Computer runtime command could not start."
      : kind === "idle_timeout"
        ? "Computer runtime command stopped making progress."
        : "Computer runtime command timed out.");
    this.name = "ComputerProcessError";
  }
}

const DEFAULT_MAXIMUM_STDOUT_BYTES = 256 * 1024;
const DEFAULT_MAXIMUM_STDERR_BYTES = 128 * 1024;
const MAXIMUM_CAPTURE_BYTES = 4 * 1024 * 1024;

export class BoundedCommandRunner implements ComputerCommandRunner {
  readonly #platform: NodeJS.Platform;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #spawn: ComputerSpawn;
  readonly #maximumStdoutBytes: number;
  readonly #maximumStderrBytes: number;

  constructor(options: BoundedCommandRunnerOptions = {}) {
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
  }

  run(request: ComputerCommandRequest): Promise<ComputerCommandResult> {
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
          detached: request.killProcessTree === true && this.#platform !== "win32",
          env: {
            ...safeComputerEnvironment(this.#environment, this.#platform),
            ...safeComputerExtraEnvironment(request.extraEnvironment)
          }
        });
      } catch {
        reject(new ComputerProcessError("spawn", commandResult(stdout, stderr, null, null)));
        return;
      }

      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let activityTimer: NodeJS.Timeout | undefined;
      let lastActivityAt = Date.now();
      let lastActivityFingerprint: string | undefined;
      const activityAbort = new AbortController();
      const cleanup = (): void => {
        clearTimeout(timer);
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        if (activityTimer !== undefined) clearTimeout(activityTimer);
        activityAbort.abort();
        request.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const stop = (): void => {
        if (request.killProcessTree === true) {
          stopComputerProcessTree(child, this.#platform);
          return;
        }
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
        reject(new ComputerProcessError("timeout", commandResult(stdout, stderr, null, null)));
      }), request.timeoutMs);

      const markActivity = (): void => {
        lastActivityAt = Date.now();
      };
      const armIdleTimer = (): void => {
        if (settled || request.idleTimeoutMs === undefined) return;
        const idleFor = Date.now() - lastActivityAt;
        if (idleFor >= request.idleTimeoutMs) {
          finish(() => {
            stop();
            reject(new ComputerProcessError("idle_timeout", commandResult(stdout, stderr, null, null)));
          });
          return;
        }
        idleTimer = setTimeout(armIdleTimer, Math.max(1_000, request.idleTimeoutMs - idleFor));
        idleTimer.unref?.();
      };
      const pollActivity = (): void => {
        if (
          settled
          || child.pid === undefined
          || request.sampleProcessActivity === undefined
          || request.activityPollMs === undefined
        ) return;
        activityTimer = setTimeout(() => {
          void request.sampleProcessActivity!(child.pid!, activityAbort.signal)
            .then((sample) => {
              if (settled || sample === undefined) return;
              if (sample.fingerprint !== lastActivityFingerprint) {
                lastActivityFingerprint = sample.fingerprint;
                markActivity();
              }
              try {
                request.onProcessActivity?.(sample);
              } catch {
                // Progress observers cannot affect installer lifecycle.
              }
            })
            .catch(() => undefined)
            .finally(pollActivity);
        }, request.activityPollMs);
        activityTimer.unref?.();
      };

      request.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("spawn", () => {
        markActivity();
        armIdleTimer();
        pollActivity();
        try {
          request.onSpawn?.(child.pid);
        } catch {
          // Observability callbacks must not change process lifecycle semantics.
        }
      });
      child.once("error", () => finish(() => {
        reject(new ComputerProcessError("spawn", commandResult(stdout, stderr, null, null)));
      }));
      child.stdout?.on("data", (chunk: Buffer | string) => {
        markActivity();
        stdout.append(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        markActivity();
        stderr.append(chunk);
      });
      if (request.stdin !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(request.stdin);
      }
      child.once("close", (exitCode, signal) => finish(() => {
        resolve(commandResult(stdout, stderr, exitCode, signal));
      }));
    });
  }
}

export function safeComputerEnvironment(
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
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERPROFILE"
      ]
    : [
        "DBUS_SESSION_BUS_ADDRESS",
        "DISPLAY",
        "HOME",
        "LANG",
        "LC_ALL",
        "LOGNAME",
        "PATH",
        "SHELL",
        "TEMP",
        "TMP",
        "TMPDIR",
        "USER",
        "WAYLAND_DISPLAY",
        "XAUTHORITY",
        "XDG_RUNTIME_DIR",
        "XDG_SESSION_TYPE"
      ];
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && !value.startsWith("()")) result[key] = value;
  }
  return result;
}

export function normalizeComputerPlatform(platform: NodeJS.Platform): ComputerHostPlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return "unsupported";
}

function validateCommandRequest(request: ComputerCommandRequest): void {
  if (request.command.trim() === "" || request.command.length > 32_768 || request.command.includes("\0")) {
    throw new TypeError("Computer runtime command must be a bounded executable name or path.");
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60 * 60 * 1_000) {
    throw new RangeError("Computer runtime command timeout must be between one millisecond and one hour.");
  }
  for (const argument of request.arguments ?? []) {
    if (argument.length > 1024 * 1024 || argument.includes("\0")) {
      throw new TypeError("Computer runtime command argument is invalid.");
    }
  }
  if (request.idleTimeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(request.idleTimeoutMs)
      || request.idleTimeoutMs < 1_000
      || request.idleTimeoutMs > request.timeoutMs
    ) throw new RangeError("Computer runtime idle timeout is invalid.");
  }
  if (request.activityPollMs !== undefined) {
    if (!Number.isSafeInteger(request.activityPollMs) || request.activityPollMs < 100 || request.activityPollMs > 60_000) {
      throw new RangeError("Computer runtime activity polling interval is invalid.");
    }
    if (request.sampleProcessActivity === undefined) {
      throw new TypeError("Computer runtime activity polling requires a sampler.");
    }
  }
  safeComputerExtraEnvironment(request.extraEnvironment);
}

function safeComputerExtraEnvironment(
  source: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  if (source === undefined) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!validComputerExtraEnvironmentEntry(key, value)) {
      throw new TypeError("Computer runtime extra environment is invalid.");
    }
    result[key] = value;
  }
  return result;
}

function validComputerExtraEnvironmentEntry(key: string, value: string): boolean {
  if (key === "CUA_DRIVER_RS_VERSION") return /^\d+\.\d+\.\d+$/u.test(value);
  if (key === "CUA_DRIVER_NO_MODIFY_PATH" || key === "CUA_DRIVER_RS_NO_MODIFY_PATH") return value === "1";
  if (key === "NO_PROXY" || key === "no_proxy") {
    return value.length <= 16 * 1024 && !/[\0\r\n]/u.test(value);
  }
  if (!/^(?:HTTPS?|https?)_PROXY$/u.test(key) && key !== "ALL_PROXY" && key !== "all_proxy") return false;
  if (value.length > 16 * 1024 || /[\0\r\n]/u.test(value)) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "socks5:" || protocol === "socks5h:";
  } catch {
    return false;
  }
}

function stopComputerProcessTree(child: ChildProcess, platform: NodeJS.Platform): void {
  const pid = child.pid;
  const stopDirectChild = (): void => {
    try {
      child.kill();
    } catch {
      // The child may have exited between the timeout and cleanup.
    }
  };
  if (pid === undefined) {
    stopDirectChild();
    return;
  }
  if (platform === "win32") {
    try {
      const killer = nodeSpawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
        windowsHide: true
      });
      const fallbackTimer = setTimeout(stopDirectChild, 500);
      fallbackTimer.unref?.();
      killer.once("error", () => {
        clearTimeout(fallbackTimer);
        stopDirectChild();
      });
      killer.once("close", (exitCode) => {
        clearTimeout(fallbackTimer);
        if (exitCode !== 0) stopDirectChild();
      });
      killer.unref();
    } catch {
      stopDirectChild();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    stopDirectChild();
    return;
  }
  const forceTimer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
  }, 2_000);
  forceTimer.unref?.();
}

function captureLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_CAPTURE_BYTES) {
    throw new RangeError(`${label} must be between one byte and four MiB.`);
  }
  return value;
}

function commandResult(
  stdout: BoundedBytes,
  stderr: BoundedBytes,
  exitCode: number | null,
  signal: NodeJS.Signals | null
): ComputerCommandResult {
  return {
    stdout: stdout.text(),
    stderr: stderr.text(),
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

  text(): string {
    return Buffer.concat(this.#chunks, this.#byteLength).toString("utf8");
  }
}

function abortError(): Error {
  return new DOMException("The computer runtime command was cancelled.", "AbortError");
}
