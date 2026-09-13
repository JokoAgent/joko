import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

const POSITIVE_CACHE_TTL_MS = 5 * 60_000;
const NEGATIVE_CACHE_TTL_MS = 30_000;
const COMMAND_TIMEOUT_MS = 3_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 16 * 1024;
const MAXIMUM_TOKEN_LENGTH = 8 * 1024;

const GH_BINARY_CANDIDATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  darwin: Object.freeze(["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]),
  linux: Object.freeze(["/usr/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"]),
  win32: Object.freeze([
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    "C:\\Program Files (x86)\\GitHub CLI\\gh.exe"
  ])
});

export interface GhCliCredentialLease {
  /** Process-memory only. Never persist, log, diagnose, or pass through product contracts. */
  readonly token: string;
  readonly generation: number;
}

export interface GhCliCommandOptions {
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

export type GhCliCommand = (
  file: string,
  args: readonly string[],
  options: GhCliCommandOptions
) => Promise<Uint8Array>;

export interface GhCliTokenSourceOptions {
  readonly command?: GhCliCommand;
  readonly exists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly positiveCacheTtlMs?: number;
  readonly negativeCacheTtlMs?: number;
}

/** Bounded, memory-only reader for the host CLI login credential. */
export class GhCliTokenSource {
  readonly #command: GhCliCommand;
  readonly #exists: (path: string) => boolean;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #positiveCacheTtlMs: number;
  readonly #negativeCacheTtlMs: number;
  #generation = 0;
  #cache: { readonly credential?: GhCliCredentialLease; readonly expiresAt: number } | undefined;
  #inflight: Promise<GhCliCredentialLease | undefined> | undefined;

  constructor(options: GhCliTokenSourceOptions = {}) {
    this.#command = options.command ?? runGhCliCommand;
    this.#exists = options.exists ?? existsSync;
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? Date.now;
    this.#positiveCacheTtlMs = boundedDuration(
      options.positiveCacheTtlMs ?? POSITIVE_CACHE_TTL_MS,
      "positive cache TTL"
    );
    this.#negativeCacheTtlMs = boundedDuration(
      options.negativeCacheTtlMs ?? NEGATIVE_CACHE_TTL_MS,
      "negative cache TTL"
    );
  }

  async readCredential(): Promise<GhCliCredentialLease | undefined> {
    if (this.#cache !== undefined && this.#cache.expiresAt > this.#now()) {
      return this.#cache.credential;
    }
    if (this.#inflight !== undefined) return this.#inflight;
    const request = this.#readUncached().finally(() => {
      if (this.#inflight === request) this.#inflight = undefined;
    });
    this.#inflight = request;
    return request;
  }

  isCurrent(credential: GhCliCredentialLease): boolean {
    return this.#cache?.credential === credential
      && credential.generation === this.#generation;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#cache = undefined;
  }

  async #readUncached(): Promise<GhCliCredentialLease | undefined> {
    const startingGeneration = this.#generation;
    let token: string | undefined;
    try {
      const output = await this.#command(
        resolveGhBinary(this.#platform, this.#exists),
        Object.freeze(["auth", "token"]),
        { timeoutMs: COMMAND_TIMEOUT_MS, maximumOutputBytes: MAXIMUM_COMMAND_OUTPUT_BYTES }
      );
      token = parseTokenOutput(output);
    } catch {
      token = undefined;
    }
    if (this.#generation !== startingGeneration) return undefined;
    this.#generation += 1;
    const credential = token === undefined
      ? undefined
      : Object.freeze({ token, generation: this.#generation });
    this.#cache = {
      ...(credential === undefined ? {} : { credential }),
      expiresAt: this.#now() + (credential === undefined
        ? this.#negativeCacheTtlMs
        : this.#positiveCacheTtlMs)
    };
    return credential;
  }
}

export function createGhCliTokenSource(options: GhCliTokenSourceOptions = {}): GhCliTokenSource {
  return new GhCliTokenSource(options);
}

function resolveGhBinary(platform: NodeJS.Platform, exists: (path: string) => boolean): string {
  for (const candidate of GH_BINARY_CANDIDATES[platform] ?? []) {
    if (exists(candidate)) return candidate;
  }
  return platform === "win32" ? "gh.exe" : "gh";
}

function parseTokenOutput(output: Uint8Array): string | undefined {
  if (output.byteLength === 0 || output.byteLength > MAXIMUM_COMMAND_OUTPUT_BYTES) return undefined;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    return undefined;
  }
  const token = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n")
      ? text.slice(0, -1)
      : text;
  if (
    token.length === 0
    || token.length > MAXIMUM_TOKEN_LENGTH
    || !/^[\x21-\x7e]+$/u.test(token)
  ) return undefined;
  return token;
}

async function runGhCliCommand(
  file: string,
  args: readonly string[],
  options: GhCliCommandOptions
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], {
      timeout: options.timeoutMs,
      maxBuffer: options.maximumOutputBytes,
      windowsHide: true,
      encoding: "buffer",
      env: ghCliEnvironment(process.env)
    }, (error, stdout) => {
      if (error !== null) {
        reject(new Error("The code-host credential command is unavailable."));
        return;
      }
      const bytes = typeof stdout === "string" ? Buffer.from(stdout, "utf8") : stdout;
      if (bytes.byteLength > options.maximumOutputBytes) {
        reject(new Error("The code-host credential command output is invalid."));
        return;
      }
      resolve(new Uint8Array(bytes));
    });
  });
}

function ghCliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "appdata",
    "gh_config_dir",
    "home",
    "localappdata",
    "path",
    "systemdrive",
    "systemroot",
    "tmp",
    "tmpdir",
    "temp",
    "userprofile",
    "xdg_config_home"
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toLocaleLowerCase("en-US"))) result[key] = value;
  }
  return result;
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new RangeError(`The code-host ${label} is invalid.`);
  }
  return value;
}
