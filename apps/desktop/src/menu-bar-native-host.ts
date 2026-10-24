import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { MenubarView, MenubarHelperMessage } from "@joko/contracts";
import { parseMenubarHelperMessage } from "./native-task-status-contract.js";

const HELPER_NAME = "joko-macos-menu-bar-helper";
const HELPER_MANIFEST = "manifest.json";
const MAXIMUM_HELPER_BYTES = 16 * 1024 * 1024;
const MAXIMUM_PROTOCOL_LINE_BYTES = 64 * 1024;
const HELPER_RESTART_LIMIT = 3;
const HELPER_RESTART_BASE_MS = 1_000;
const HELPER_STABLE_MS = 30_000;
const HELPER_STOP_TIMEOUT_MS = 1_000;
const HELPER_KILL_CONFIRM_TIMEOUT_MS = 1_000;

function spawnMenuBarHelper(path: string): ChildProcessWithoutNullStreams {
  // The presentation helper needs no service URL, auth token or inherited loader configuration.
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
  if (process.env["HOME"]) env["HOME"] = process.env["HOME"];
  if (process.env["TMPDIR"]) env["TMPDIR"] = process.env["TMPDIR"];
  return spawn(path, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
}

export interface MenuBarNativeHostOptions {
  readonly resolveHelper: () => string | undefined;
  readonly spawnProcess?: (helperPath: string) => ChildProcessWithoutNullStreams;
  readonly onStarted: () => void;
  readonly onRestarting: () => void;
  readonly onFailure: (message: string) => void;
  readonly onMessage: (message: MenubarHelperMessage) => void;
}

export class MenuBarNativeHost {
  readonly #options: MenuBarNativeHostOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  readonly #retiringChildren = new Map<ChildProcessWithoutNullStreams, Promise<void>>();
  #wanted = false;
  #ready = false;
  #latest: string | undefined;
  #pending = false;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  #starting = false;
  #generation = 0;
  #restartAttempts = 0;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: MenuBarNativeHostOptions) {
    this.#options = options;
  }

  publish(view: MenubarView): void {
    this.#latest = JSON.stringify({ type: "update", view }) + "\n";
    this.#pending = true;
    this.start();
    this.#flush();
  }

  #flush(): void {
    const child = this.#child;
    if (!this.#ready || !this.#pending || !this.#latest || !child || child.stdin.writableNeedDrain) return;
    this.#pending = false;
    if (!this.#write(child, this.#latest)) void this.#retireChild(child, false).catch(() => undefined);
  }

  start(): void {
    if (this.#wanted) return;
    this.#generation += 1;
    this.#wanted = true;
    this.#restartAttempts = 0;
    this.#clearRestartTimer();
    this.#startChild();
  }

  probe(): void {
    if (!this.#wanted) return;
    if (this.#child !== undefined) { this.#pending = true; this.#flush(); return; }
    this.#restartAttempts = 0;
    this.#clearRestartTimer();
    this.#startChild();
  }

  stop(): Promise<void> {
    this.#generation += 1;
    this.#wanted = false;
    this.#ready = false;
    this.#clearReadyTimer();
    this.#starting = false;
    this.#restartAttempts = 0;
    this.#clearRestartTimer();
    this.#clearStableTimer();
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined) this.#retireChild(child, true);
    return Promise.all([...this.#retiringChildren.values()]).then(() => undefined);
  }

  #retireChild(child: ChildProcessWithoutNullStreams, graceful: boolean): Promise<void> {
    const existing = this.#retiringChildren.get(child);
    if (existing !== undefined) return existing;
    let confirmed = false;
    let settled = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let killConfirmationTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveRetirement!: () => void;
    let rejectRetirement!: (error: Error) => void;
    const retirement = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveRetirement = resolvePromise;
      rejectRetirement = rejectPromise;
    });
    this.#retiringChildren.set(child, retirement);
    const finishRetirement = (): void => {
      if (confirmed) return;
      confirmed = true;
      if (stopTimer !== undefined) clearTimeout(stopTimer);
      if (killConfirmationTimer !== undefined) clearTimeout(killConfirmationTimer);
      this.#retiringChildren.delete(child);
      if (!settled) {
        settled = true;
        resolveRetirement();
      }
      if (this.#wanted && this.#restartTimer === undefined) this.#startChild();
    };
    const failRetirement = (message: string): void => {
      if (confirmed || settled) return;
      settled = true;
      rejectRetirement(new Error(message));
    };
    child.once("exit", finishRetirement);
    child.once("close", finishRetirement);
    stopTimer = setTimeout(() => {
      let accepted = false;
      try { accepted = child.kill("SIGKILL"); } catch { /* The retirement fence remains owned below. */ }
      if (confirmed) return;
      if (!accepted) {
        failRetirement("Native menu bar helper could not be killed after its stop timeout.");
        return;
      }
      killConfirmationTimer = setTimeout(() => {
        failRetirement("Native menu bar helper did not confirm exit after SIGKILL.");
      }, HELPER_KILL_CONFIRM_TIMEOUT_MS);
    }, HELPER_STOP_TIMEOUT_MS);
    if (graceful) {
      try {
        if (!child.stdin.destroyed) {
          child.stdin.write('{"type":"shutdown"}\n');
          child.stdin.end();
        }
      } catch {
        // The bounded hard kill above still closes an already-failing helper.
      }
      return retirement;
    }
    try { child.kill(); } catch { /* The bounded hard kill above remains armed. */ }
    return retirement;
  }

  #startChild(): void {
    if (!this.#wanted || this.#starting || this.#child !== undefined ||
      this.#retiringChildren.size > 0 || this.#restartAttempts > HELPER_RESTART_LIMIT) return;
    this.#starting = true;
    const helperPath = this.#options.resolveHelper();
    if (helperPath === undefined) {
      this.#starting = false;
      this.#failed("Native menu bar helper admission failed.");
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.#options.spawnProcess ?? spawnMenuBarHelper)(helperPath);
    } catch (error) {
      this.#starting = false;
      this.#failed(error instanceof Error ? error.message : "Native menu bar helper spawn failed.");
      return;
    }
    this.#attach(child, this.#generation);
  }

  #attach(child: ChildProcessWithoutNullStreams, generation: number): void {
    this.#child = child;
    this.#starting = false;
    this.#clearStableTimer();
    this.#stableTimer = setTimeout(() => {
      if (this.#child === child) this.#restartAttempts = 0;
    }, HELPER_STABLE_MS);
    this.#stableTimer.unref?.();
    this.#ready = false;
    this.#readyTimer = setTimeout(() => fail("Native menu bar helper did not become ready."), 2_500);
    this.#readyTimer.unref?.();
    let buffer = "";
    let accounted = false;
    const fail = (message: string, alreadyExited = false): void => {
      if (accounted) return;
      accounted = true;
      if (generation !== this.#generation || this.#child !== child) return;
      if (this.#child === child) this.#child = undefined;
      this.#ready = false;
      this.#clearReadyTimer();
      this.#clearStableTimer();
      if (this.#wanted) this.#failed(message);
      if (!alreadyExited) void this.#retireChild(child, false).catch(() => undefined);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string | Buffer) => {
      if (this.#child !== child) return;
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(rawLine, "utf8") > MAXIMUM_PROTOCOL_LINE_BYTES) {
          buffer = "";
          fail("Native menu bar helper emitted an oversized protocol line.");
          return;
        }
        const line = rawLine.trim();
        if (line !== "") {
          let message: MenubarHelperMessage | undefined;
          try { message = parseMenubarHelperMessage(JSON.parse(line)); } catch { message = undefined; }
          if (message === undefined) {
            buffer = "";
            fail("Native menu bar helper emitted an invalid protocol message.");
            return;
          }
          if (message.type === "ready") {
            if (this.#ready) { fail("Duplicate native menu bar readiness."); return; }
            this.#ready = true;
            this.#clearReadyTimer();
            this.#pending = true;
            this.#flush();
            this.#options.onStarted();
          } else if (!this.#ready || message.type === "error") {
            fail("Native menu bar helper rejected its presentation.");
            return;
          } else this.#options.onMessage(message);
        }
        if (this.#child !== child) return;
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > MAXIMUM_PROTOCOL_LINE_BYTES) {
        buffer = "";
        fail("Native menu bar helper exceeded the protocol buffer limit.");
      }
    });
    child.stdout.on("error", (error: Error) => fail(error.message));
    child.stderr.on("error", (error: Error) => fail(error.message));
    child.stderr.resume();
    child.stdin.on("error", (error: Error) => fail(error.message));
    child.on("error", (error: Error) => fail(error.message));
    child.once("exit", (code, signal) => {
      fail(`Native menu bar helper exited (${code ?? signal ?? "unknown"}).`, true);
    });
    child.once("close", (code, signal) => {
      fail(`Native menu bar helper closed (${code ?? signal ?? "unknown"}).`, true);
    });
    child.stdin.on("drain", () => { if (this.#child === child) this.#flush(); });
  }

  #write(child: ChildProcessWithoutNullStreams | undefined, line: string): boolean {
    if (child === undefined || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(line, (error) => {
        if (error !== null && error !== undefined && this.#child === child) {
          if (!child.killed) child.kill();
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  #failed(message: string): void {
    if (!this.#wanted) return;
    this.#options.onFailure(message);
    this.#restartAttempts += 1;
    if (this.#restartAttempts > HELPER_RESTART_LIMIT || this.#restartTimer !== undefined) return;
    const delay = HELPER_RESTART_BASE_MS * 2 ** (this.#restartAttempts - 1);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      if (!this.#wanted) return;
      this.#options.onRestarting();
      this.#startChild();
    }, delay);
    this.#restartTimer.unref?.();
  }

  #clearReadyTimer(): void {
    if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
  }

  #clearRestartTimer(): void {
    if (this.#restartTimer === undefined) return;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
  }

  #clearStableTimer(): void {
    if (this.#stableTimer === undefined) return;
    clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
  }
}

export function verifyMenuBarHelper(options: {
  readonly directory: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
}): string | undefined {
  if (options.platform !== "darwin" || (options.architecture !== "x64" && options.architecture !== "arm64")) {
    return undefined;
  }
  try {
    const directory = resolve(options.directory);
    const directoryInfo = lstatSync(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || realpathSync(directory) !== directory) {
      return undefined;
    }
    const entries = readdirSync(directory).sort();
    if (entries.length !== 2 || entries[0] !== HELPER_NAME || entries[1] !== HELPER_MANIFEST) return undefined;
    const manifestPath = resolve(directory, HELPER_MANIFEST);
    if (!regularFile(manifestPath, 4_096)) return undefined;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!exactRecord(manifest, ["architecture", "helper", "platform", "protocolVersion", "sha256"]) ||
      manifest.architecture !== options.architecture || manifest.helper !== HELPER_NAME || manifest.platform !== "darwin" ||
      manifest.protocolVersion !== 1 || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) {
      return undefined;
    }
    const helperPath = resolve(directory, HELPER_NAME);
    if (!regularExecutableFile(helperPath, MAXIMUM_HELPER_BYTES)) return undefined;
    const helperBytes = readFileSync(helperPath);
    if (!isTargetMachOExecutable(helperBytes, options.architecture)) return undefined;
    const digest = createHash("sha256").update(helperBytes).digest("hex");
    return digest === manifest.sha256 ? helperPath : undefined;
  } catch {
    return undefined;
  }
}

function regularFile(path: string, maximumBytes: number): boolean {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximumBytes && realpathSync(path) === path;
}

function regularExecutableFile(path: string, maximumBytes: number): boolean {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 32 || info.size > maximumBytes ||
    realpathSync(path) !== path) return false;
  accessSync(path, fsConstants.X_OK);
  return true;
}

function isTargetMachOExecutable(bytes: Buffer, architecture: string): boolean {
  const cpu = architecture === "x64" ? 0x0100_0007 : architecture === "arm64" ? 0x0100_000c : undefined;
  if (cpu === undefined || bytes.length < 8) return false;
  const magic = bytes.subarray(0, 4).toString("hex");
  if (magic === "cffaedfe") return isThinMachOExecutable(bytes, cpu, "little");
  if (magic === "feedfacf") return isThinMachOExecutable(bytes, cpu, "big");
  const fat = magic === "cafebabe" ? { endian: "big" as const, entryBytes: 20 }
    : magic === "bebafeca" ? { endian: "little" as const, entryBytes: 20 }
      : magic === "cafebabf" ? { endian: "big" as const, entryBytes: 32 }
        : magic === "bfbafeca" ? { endian: "little" as const, entryBytes: 32 }
          : undefined;
  if (fat === undefined) return false;
  const count = readMachOUint32(bytes, 4, fat.endian);
  if (count === undefined || count < 1 || count > 16 || 8 + count * fat.entryBytes > bytes.length) return false;
  for (let index = 0; index < count; index += 1) {
    const entry = 8 + index * fat.entryBytes;
    if (readMachOUint32(bytes, entry, fat.endian) !== cpu) continue;
    const offset = fat.entryBytes === 20
      ? readMachOUint32(bytes, entry + 8, fat.endian)
      : readMachOUint64(bytes, entry + 8, fat.endian);
    const size = fat.entryBytes === 20
      ? readMachOUint32(bytes, entry + 12, fat.endian)
      : readMachOUint64(bytes, entry + 16, fat.endian);
    if (offset === undefined || size === undefined || size < 32 || offset > bytes.length - size) return false;
    if (isThinMachOExecutable(bytes.subarray(offset, offset + size), cpu)) return true;
  }
  return false;
}

function isThinMachOExecutable(
  bytes: Buffer,
  cpu: number,
  expectedEndian?: "little" | "big"
): boolean {
  if (bytes.length < 32) return false;
  const magic = bytes.subarray(0, 4).toString("hex");
  const endian = magic === "cffaedfe" ? "little" : magic === "feedfacf" ? "big" : undefined;
  if (endian === undefined || (expectedEndian !== undefined && endian !== expectedEndian)) return false;
  const declaredCpu = readMachOUint32(bytes, 4, endian);
  const fileType = readMachOUint32(bytes, 12, endian);
  const commandCount = readMachOUint32(bytes, 16, endian);
  const commandBytes = readMachOUint32(bytes, 20, endian);
  return declaredCpu === cpu && fileType === 2 && commandCount !== undefined && commandBytes !== undefined &&
    commandCount <= 16_384 && commandBytes <= bytes.length - 32;
}

function readMachOUint32(bytes: Buffer, offset: number, endian: "little" | "big"): number | undefined {
  if (offset < 0 || offset > bytes.length - 4) return undefined;
  return endian === "little" ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
}

function readMachOUint64(bytes: Buffer, offset: number, endian: "little" | "big"): number | undefined {
  if (offset < 0 || offset > bytes.length - 8) return undefined;
  const value = endian === "little" ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
