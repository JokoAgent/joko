import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";

const POSITIVE_CACHE_TTL_MS = 5 * 60_000;
const NEGATIVE_CACHE_TTL_MS = 30_000;
const COMMAND_TIMEOUT_MS = 3_000;
const MAXIMUM_COMMAND_OUTPUT_BYTES = 16 * 1024;
const MAXIMUM_TOKEN_LENGTH = 8 * 1024;
const LOGIN_TIMEOUT_MS = 15 * 60_000;

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

export type GhCliLoginCommand = (file: string, signal: AbortSignal, onDeviceCode: (code: string) => void) => Promise<void>;

export class GhCliCommandError extends Error {
  constructor(readonly reason: "notSignedIn" | "unavailable") {
    super("The GitHub CLI credential command did not return a credential.");
  }
}

type GhCliCredentialState =
  | { readonly kind: "credential"; readonly credential: GhCliCredentialLease }
  | { readonly kind: "notSignedIn"; readonly binary: string }
  | { readonly kind: "unavailable" };

export interface GhCliTokenSourceOptions {
  readonly command?: GhCliCommand;
  readonly loginCommand?: GhCliLoginCommand;
  readonly exists?: (path: string) => boolean;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly positiveCacheTtlMs?: number;
  readonly negativeCacheTtlMs?: number;
}

/** Bounded, memory-only reader for the CLI's github.com login credential. */
export class GhCliTokenSource {
  readonly #command: GhCliCommand;
  readonly #loginCommand: GhCliLoginCommand;
  readonly #exists: (path: string) => boolean;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => number;
  readonly #positiveCacheTtlMs: number;
  readonly #negativeCacheTtlMs: number;
  #generation = 0;
  #cache: { readonly state: GhCliCredentialState; readonly expiresAt: number } | undefined;
  #inflight: Promise<GhCliCredentialState> | undefined;

  constructor(options: GhCliTokenSourceOptions = {}) {
    this.#command = options.command ?? runGhCliCommand;
    this.#loginCommand = options.loginCommand ?? loginWithGh;
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
    const state = await this.#readState();
    return state.kind === "credential" && this.isCurrent(state.credential) ? state.credential : undefined;
  }

  async isSignInRequired(): Promise<boolean> {
    const state = await this.#readState();
    return state.kind === "notSignedIn" && this.#cache?.state === state;
  }

  async signIn(signal: AbortSignal, assertCurrent: () => void, onDeviceCode: (code: string) => void): Promise<void> {
    assertCurrent();
    signal.throwIfAborted();
    this.invalidate();
    const state = await this.#readState();
    assertCurrent();
    signal.throwIfAborted();
    if (state.kind === "credential") return;
    if (state.kind !== "notSignedIn" || this.#cache?.state !== state) throw new Error("GitHub CLI sign-in is unavailable.");
    try {
      await this.#loginCommand(state.binary, signal, onDeviceCode);
    } finally {
      // A cancelled process can have just finished saving its credential.
      this.invalidate();
    }
    assertCurrent();
    signal.throwIfAborted();
    const credential = await this.readCredential();
    assertCurrent();
    signal.throwIfAborted();
    if (credential === undefined || !this.isCurrent(credential)) throw new Error("GitHub CLI sign-in could not be confirmed.");
  }

  async #readState(): Promise<GhCliCredentialState> {
    if (this.#cache !== undefined && this.#cache.expiresAt > this.#now()) {
      return this.#cache.state;
    }
    if (this.#inflight !== undefined) return this.#inflight;
    const request = this.#readUncached().finally(() => {
      if (this.#inflight === request) this.#inflight = undefined;
    });
    this.#inflight = request;
    return request;
  }

  isCurrent(credential: GhCliCredentialLease): boolean {
    return this.#cache?.state.kind === "credential" && this.#cache.state.credential === credential
      && credential.generation === this.#generation;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#cache = undefined;
    this.#inflight = undefined;
  }

  async #readUncached(): Promise<GhCliCredentialState> {
    const startingGeneration = this.#generation;
    let state: GhCliCredentialState = { kind: "unavailable" };
    try {
      const binary = resolveGhBinary(this.#platform, this.#exists);
      try {
        const output = await this.#command(binary, ["auth", "token", "--hostname", "github.com"], {
          timeoutMs: COMMAND_TIMEOUT_MS, maximumOutputBytes: MAXIMUM_COMMAND_OUTPUT_BYTES
        });
        const token = parseTokenOutput(output);
        if (token !== undefined) state = { kind: "credential", credential: Object.freeze({ token, generation: startingGeneration + 1 }) };
      } catch (error) {
        if (error instanceof GhCliCommandError && error.reason === "notSignedIn") state = { kind: "notSignedIn", binary };
      }
    } catch {
      // An inaccessible executable or environment cannot establish sign-in eligibility.
    }
    if (this.#generation !== startingGeneration) return { kind: "unavailable" };
    this.#generation += 1;
    this.#cache = {
      state,
      expiresAt: this.#now() + (state.kind === "credential" ? this.#positiveCacheTtlMs : this.#negativeCacheTtlMs)
    };
    return state;
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
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const notSignedIn = typeof error.code === "number" && !error.killed && !error.signal
          && /^(?:gh: )?no oauth token found for github\.com$/u.test(stderr.toString().trim());
        reject(new GhCliCommandError(notSignedIn ? "notSignedIn" : "unavailable"));
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

/** The non-interactive CLI owns OAuth and credential storage. Only its device code crosses the pipe boundary. */
export function loginWithGh(file: string, signal: AbortSignal, onDeviceCode: (code: string) => void): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, ["auth", "login", "--hostname", "github.com", "--web", "--skip-ssh-key"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: { ...ghCliEnvironment(process.env), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }
    });
    const stop = () => { child.kill("SIGKILL"); };
    let failed = false;
    let sawCode = false;
    let output = "";
    const timer = setTimeout(() => { failed = true; stop(); }, LOGIN_TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      if (sawCode || failed || signal.aborted) return;
      output = (output + chunk.toString("utf8")).slice(-8192);
      const code = /(?:^|\n)[^\r\n]*First copy your one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})(?=\r?\n)/u.exec(output)?.[1];
      if (code === undefined) return;
      sawCode = true;
      output = "";
      onDeviceCode(code);
    });
    child.once("error", () => { failed = true; });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (failed || signal.aborted || code !== 0 || !sawCode) reject(new Error("GitHub CLI sign-in did not complete."));
      else resolve();
    });
    if (signal.aborted) stop();
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
