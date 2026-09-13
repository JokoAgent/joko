import { join } from "node:path";

import type { AndroidAdbAdapter } from "./adb-adapter.js";
import { redactAndroidOutput } from "./redaction.js";
import { AndroidRuntimeError, type AndroidAdbPathSource } from "./types.js";

export interface AndroidAdbCandidate {
  readonly executablePath: string;
  readonly pathSource: AndroidAdbPathSource;
  readonly strict: boolean;
}

export interface AndroidAdbPreparationState {
  readonly supported: boolean;
  readonly attempted: boolean;
  readonly ready: boolean;
  readonly executablePath?: string;
  readonly error?: string;
}

export interface AndroidAdbPrepareResult {
  readonly executablePath: string;
}

export interface AndroidAdbPreparer {
  prepare(signal?: AbortSignal): Promise<AndroidAdbPrepareResult>;
}

export interface AndroidResolvedAdb {
  readonly adapter: AndroidAdbAdapter;
  readonly executablePath: string;
  readonly pathSource: AndroidAdbPathSource;
  readonly version: string;
}

export interface AndroidAdbResolverOptions {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly customPath?: string;
  readonly bundledPaths?: readonly string[];
  readonly preparedPath?: string;
  readonly pathExecutablePaths?: readonly string[];
  readonly pathExists: (path: string) => boolean;
  readonly adapterFactory: (candidate: AndroidAdbCandidate) => AndroidAdbAdapter;
  readonly preparer?: AndroidAdbPreparer;
  readonly redactRoots?: readonly string[];
  readonly onPreparingChange?: (preparing: boolean) => void;
}

export class AndroidAdbResolver {
  readonly #options: AndroidAdbResolverOptions;
  #resolved: AndroidResolvedAdb | undefined;
  #resolvingWithPreparation: Promise<AndroidResolvedAdb> | undefined;
  #resolvingWithoutPreparation: Promise<AndroidResolvedAdb> | undefined;
  #preparation: AndroidAdbPreparationState;

  constructor(options: AndroidAdbResolverOptions) {
    this.#options = options;
    this.#preparation = {
      supported: options.preparer !== undefined,
      attempted: false,
      ready: false,
      ...(options.preparedPath === undefined ? {} : { executablePath: options.preparedPath })
    };
  }

  candidates(): readonly AndroidAdbCandidate[] {
    return buildAndroidAdbCandidates(this.#options);
  }

  preparationState(): AndroidAdbPreparationState {
    const roots = this.#options.redactRoots ?? [];
    return {
      ...this.#preparation,
      ...(this.#preparation.executablePath === undefined ? {} : {
        executablePath: redactAndroidOutput(this.#preparation.executablePath, roots)
      }),
      ...(this.#preparation.error === undefined ? {} : {
        error: redactAndroidOutput(this.#preparation.error, roots)
      })
    };
  }

  resolve(
    signal?: AbortSignal,
    options: { readonly allowPreparation?: boolean } = {}
  ): Promise<AndroidResolvedAdb> {
    if (signal?.aborted === true) return Promise.reject(abortError());
    if (this.#resolved !== undefined) return Promise.resolve(this.#resolved);
    const allowPreparation = options.allowPreparation !== false;
    const existing = allowPreparation
      ? this.#resolvingWithPreparation
      : this.#resolvingWithoutPreparation;
    if (existing !== undefined) return withSignal(existing, signal);
    const resolving = this.#resolveNow(signal, allowPreparation);
    if (allowPreparation) this.#resolvingWithPreparation = resolving;
    else this.#resolvingWithoutPreparation = resolving;
    return resolving.finally(() => {
      if (allowPreparation && this.#resolvingWithPreparation === resolving) {
        this.#resolvingWithPreparation = undefined;
      }
      if (!allowPreparation && this.#resolvingWithoutPreparation === resolving) {
        this.#resolvingWithoutPreparation = undefined;
      }
    });
  }

  invalidate(): void {
    this.#resolved = undefined;
  }

  async #resolveNow(signal: AbortSignal | undefined, allowPreparation: boolean): Promise<AndroidResolvedAdb> {
    let lastError: unknown;
    // Rebuild on every uncached resolution. A successful preparer atomically
    // creates the prepared path after this resolver was constructed, and a
    // later fresh probe must discover that promoted binary without downloading
    // it again.
    for (const candidate of this.candidates()) {
      try {
        const resolved = await this.#probeCandidate(candidate, signal);
        this.#resolved = resolved;
        return resolved;
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
        if (candidate.strict) throw safeNotFound(error, this.#options.redactRoots ?? []);
      }
    }

    if (allowPreparation && this.#options.preparer !== undefined) {
      this.#preparation = {
        supported: true,
        attempted: true,
        ready: false,
        ...(this.#options.preparedPath === undefined ? {} : {
          executablePath: this.#options.preparedPath
        })
      };
      try {
        this.#notifyPreparing(true);
        const prepared = await this.#options.preparer.prepare(signal);
        const candidate: AndroidAdbCandidate = {
          executablePath: boundedPath(prepared.executablePath),
          pathSource: "prepared",
          strict: true
        };
        const resolved = await this.#probeCandidate(candidate, signal);
        this.#preparation = {
          supported: true,
          attempted: true,
          ready: true,
          executablePath: candidate.executablePath
        };
        this.#resolved = resolved;
        return resolved;
      } catch (error) {
        if (isAbortError(error)) throw error;
        lastError = error;
        this.#preparation = {
          supported: true,
          attempted: true,
          ready: false,
          ...(this.#options.preparedPath === undefined ? {} : {
            executablePath: this.#options.preparedPath
          }),
          error: safeMessage(error, this.#options.redactRoots ?? [])
        };
      } finally {
        this.#notifyPreparing(false);
      }
    }
    throw safeNotFound(lastError, this.#options.redactRoots ?? []);
  }

  async #probeCandidate(candidate: AndroidAdbCandidate, signal?: AbortSignal): Promise<AndroidResolvedAdb> {
    const adapter = this.#options.adapterFactory(candidate);
    const version = await adapter.probe(signal);
    return {
      adapter,
      executablePath: candidate.executablePath,
      pathSource: candidate.pathSource,
      version
    };
  }

  #notifyPreparing(preparing: boolean): void {
    try {
      this.#options.onPreparingChange?.(preparing);
    } catch {
      // State observers are informational and cannot alter preparation.
    }
  }
}

export function buildAndroidAdbCandidates(options: Pick<
  AndroidAdbResolverOptions,
  | "bundledPaths"
  | "customPath"
  | "environment"
  | "homeDirectory"
  | "pathExists"
  | "pathExecutablePaths"
  | "platform"
  | "preparedPath"
>): readonly AndroidAdbCandidate[] {
  const customPath = options.customPath?.trim();
  if (customPath !== undefined && customPath !== "") {
    return [{ executablePath: boundedPath(customPath), pathSource: "custom", strict: true }];
  }
  const environmentPath = options.environment["JOKO_ANDROID_ADB_PATH"]?.trim();
  if (environmentPath !== undefined && environmentPath !== "") {
    return [{ executablePath: boundedPath(environmentPath), pathSource: "environment", strict: true }];
  }

  const candidates: AndroidAdbCandidate[] = [];
  for (const path of options.bundledPaths ?? []) {
    if (options.pathExists(path)) {
      candidates.push({ executablePath: boundedPath(path), pathSource: "bundled", strict: false });
    }
  }
  if (options.preparedPath !== undefined && options.pathExists(options.preparedPath)) {
    candidates.push({
      executablePath: boundedPath(options.preparedPath),
      pathSource: "prepared",
      strict: false
    });
  }
  for (const path of sdkCandidates(options.platform, options.environment, options.homeDirectory)) {
    if (options.pathExists(path)) {
      candidates.push({ executablePath: path, pathSource: "sdk", strict: false });
    }
  }
  for (const path of options.pathExecutablePaths ?? defaultPathCandidates(options.platform)) {
    if (options.pathExists(path)) {
      candidates.push({ executablePath: path, pathSource: "path", strict: false });
    }
  }
  candidates.push({
    executablePath: options.platform === "win32" ? "adb.exe" : "adb",
    pathSource: "fallback",
    strict: false
  });
  const caseInsensitive = options.platform === "win32";
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = caseInsensitive ? candidate.executablePath.toLowerCase() : candidate.executablePath;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sdkCandidates(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string
): readonly string[] {
  const executableName = platform === "win32" ? "adb.exe" : "adb";
  const configuredRoots = [environment["ANDROID_SDK_ROOT"], environment["ANDROID_HOME"]]
    .flatMap((root) => {
      const normalizedRoot = root?.trim();
      return normalizedRoot === undefined || normalizedRoot === ""
        ? []
        : [join(normalizedRoot, "platform-tools", executableName)];
    });
  if (platform === "win32") {
    return [
      ...configuredRoots,
      ...(environment["LOCALAPPDATA"] === undefined ? [] : [
        join(environment["LOCALAPPDATA"], "Android", "Sdk", "platform-tools", "adb.exe")
      ]),
      join(homeDirectory, "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe")
    ];
  }
  return [
    ...configuredRoots,
    join(homeDirectory, "Library", "Android", "sdk", "platform-tools", "adb"),
    join(homeDirectory, "Android", "Sdk", "platform-tools", "adb")
  ];
}

function defaultPathCandidates(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32" ? [] : ["/opt/homebrew/bin/adb", "/usr/local/bin/adb"];
}

function safeNotFound(error: unknown, roots: readonly string[]): AndroidRuntimeError {
  return new AndroidRuntimeError(
    "adb_not_found",
    error === undefined ? "ADB executable was not found." : safeMessage(error, roots)
  );
}

function safeMessage(error: unknown, roots: readonly string[]): string {
  return redactAndroidOutput(error instanceof Error ? error.message : String(error), roots).slice(0, 2_048);
}

function boundedPath(value: string): string {
  const path = value.trim();
  if (path === "" || path.length > 32_768 || path.includes("\0")) {
    throw new TypeError("ADB executable path is invalid.");
  }
  return path;
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
  });
}

function abortError(): Error {
  return new DOMException("ADB resolution was cancelled.", "AbortError");
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}
