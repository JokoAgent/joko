import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { app, screen } from "electron";
import type { RemoteDesktopDisplay, RemoteDesktopInput } from "@joko/device-peer";

import type { DesktopRemoteDesktopInputPort } from "./remote-desktop-host.js";

const exec = promisify(execFile);
const MAXIMUM_QUEUE_BYTES = 32_768;
const HELPER_READY_MS = 8_000;
const HELPER_STOP_MS = 1_500;
const MAXIMUM_HELPER_BYTES = 16 * 1024 * 1024;

export interface DesktopRemoteDesktopInputRuntime {
  readonly platform: NodeJS.Platform;
  resolveBinary(prepare?: boolean): Promise<string>;
  spawn(binary: string): ChildProcessWithoutNullStreams;
  display(displayId: string): RemoteDesktopDisplay & {
    readonly x: number;
    readonly y: number;
  } | undefined;
  toPhysicalPoint(point: { readonly x: number; readonly y: number }): {
    readonly x: number;
    readonly y: number;
  };
}

export class DesktopRemoteDesktopInput implements DesktopRemoteDesktopInputPort {
  readonly #onFailure: () => void;
  readonly #runtime: DesktopRemoteDesktopInputRuntime;
  #child: ChildProcessWithoutNullStreams | undefined;
  #displayId = "";
  #generation = 0;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #stopping: Promise<void> = Promise.resolve();
  #retired = false;

  constructor(onFailure: () => void, runtime: DesktopRemoteDesktopInputRuntime = electronInputRuntime()) {
    this.#onFailure = onFailure;
    this.#runtime = runtime;
  }

  async start(displayId: string, signal: AbortSignal): Promise<void> {
    if (this.#retired) throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    this.stop();
    if (this.#runtime.platform !== "darwin" && this.#runtime.platform !== "win32") {
      throw new Error("REMOTE_DESKTOP_INPUT_UNSUPPORTED");
    }
    const generation = this.#generation;
    await this.#stopping;
    throwIfAborted(signal);
    if (generation !== this.#generation) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    const binary = await this.#runtime.resolveBinary();
    throwIfAborted(signal);
    if (generation !== this.#generation) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    const child = this.#runtime.spawn(binary);
    this.#child = child;
    this.#displayId = displayId;
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (this.#child === child) this.#failed();
    });
    child.on("exit", () => {
      if (this.#child === child) this.#failed();
    });
    try {
      await Promise.race([
        new Promise<void>((resolveReady, rejectReady) => {
          const timer = setTimeout(() => finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE")), HELPER_READY_MS);
          let bytes = 0;
          let text = "";
          const receive = (chunk: Buffer): void => {
            bytes += chunk.byteLength;
            if (bytes > 1_024) {
              finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE"));
              return;
            }
            text += chunk.toString("utf8");
            const newline = text.indexOf("\n");
            if (newline < 0) return;
            const status = text.slice(0, newline).trim();
            finish(status === "ready"
              ? undefined
              : new Error(status === "permission"
                ? "REMOTE_DESKTOP_ACCESSIBILITY_PERMISSION_REQUIRED"
                : status === "locked"
                  ? "REMOTE_DESKTOP_LOCKED_SESSION_UNSUPPORTED"
                  : "REMOTE_DESKTOP_INPUT_UNAVAILABLE"));
          };
          const failed = (): void => finish(new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE"));
          const finish = (error?: Error): void => {
            clearTimeout(timer);
            child.stdout.off("data", receive);
            child.off("error", failed);
            child.off("exit", failed);
            if (error === undefined) resolveReady();
            else rejectReady(error);
          };
          child.stdout.on("data", receive);
          child.once("error", failed);
          child.once("exit", failed);
        }),
        abortPromise(signal)
      ]);
      if (generation !== this.#generation || this.#child !== child) {
        throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
      }
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.#child === child && chunk.byteLength > 0) this.#failed();
      });
      this.#heartbeat = setInterval(() => this.#write([]), 2_000);
      this.#heartbeat.unref?.();
    } catch (error) {
      if (generation === this.#generation) this.stop();
      throw error;
    }
  }

  send(events: readonly RemoteDesktopInput[]): void {
    const display = this.#runtime.display(this.#displayId);
    if (display === undefined || this.#child === undefined) {
      throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }
    const projected = events.map((event) => {
      if (event.kind !== "move" && event.kind !== "button") return event;
      const point = this.#runtime.toPhysicalPoint({
        x: Math.round(display.x + event.x * (display.width - 1)),
        y: Math.round(display.y + event.y * (display.height - 1))
      });
      return Object.freeze({ ...event, x: point.x, y: point.y });
    });
    this.#write(projected);
  }

  stop(): void {
    this.#generation += 1;
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    const child = this.#child;
    this.#child = undefined;
    this.#displayId = "";
    if (child === undefined) return;
    this.#stopping = new Promise<void>((resolveStopped) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolveStopped();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* Process already retired. */ }
        finish();
      }, HELPER_STOP_MS);
      timer.unref?.();
      child.once("close", finish);
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) finish();
      else {
        try { child.stdin.end('[{"kind":"release"}]\n'); }
        catch { finish(); }
      }
    });
  }

  async retire(): Promise<void> {
    if (this.#retired) return;
    this.#retired = true;
    this.stop();
    await this.#stopping;
  }

  #write(events: readonly unknown[]): void {
    const child = this.#child;
    if (child === undefined) throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    const line = `${JSON.stringify(events)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAXIMUM_QUEUE_BYTES
      || child.stdin.destroyed
      || child.stdin.writableLength + Buffer.byteLength(line, "utf8") > MAXIMUM_QUEUE_BYTES) {
      this.#failed();
      throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }
    if (!child.stdin.write(line)) {
      this.#failed();
      throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }
  }

  #failed(): void {
    this.stop();
    this.#onFailure();
  }
}

export async function readDesktopRemoteDesktopInputPermission(
  resolveBinary: (prepare?: boolean) => Promise<string> = resolveDesktopRemoteDesktopInputBinary
): Promise<"granted" | "missing" | "unknown" | "notRequired"> {
  if (process.platform !== "darwin") return "notRequired";
  try {
    const { stdout } = await exec(await resolveBinary(false), ["--check"], {
      timeout: 5_000,
      maxBuffer: 1_024,
      windowsHide: true
    });
    const value = stdout.trim();
    return value === "ready" ? "granted" : value === "permission" ? "missing" : "unknown";
  } catch {
    return "unknown";
  }
}

let inputBuild: Promise<string> | undefined;

export async function resolveDesktopRemoteDesktopInputBinary(prepare = true): Promise<string> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("REMOTE_DESKTOP_INPUT_UNSUPPORTED");
  }
  const binaryName = platform === "darwin"
    ? "joko-macos-remote-desktop-input"
    : "joko-windows-remote-desktop-input.exe";
  if (app.isPackaged) {
    return verifyPackagedDesktopRemoteDesktopInputBinary(
      join(process.resourcesPath, "native-remote-desktop"),
      binaryName,
      platform,
      process.arch
    );
  }
  if (inputBuild !== undefined && prepare) return inputBuild;
  const build = async (): Promise<string> => {
    const sourceRoot = join(app.getAppPath(), "native", "remote-desktop");
    const source = platform === "darwin"
      ? join(sourceRoot, "macos-input.swift")
      : join(sourceRoot, "windows-input", "src", "main.rs");
    const digest = createHash("sha256").update(await readFile(source)).update(process.arch).update("v1-O");
    if (platform === "darwin") {
      digest.update(await readFile(join(sourceRoot, "macos-caller.swift")));
    } else {
      for (const file of [
        join(sourceRoot, "windows-input", "src", "desktop.rs"),
        join(sourceRoot, "windows-input", "Cargo.toml"),
        join(sourceRoot, "windows-input", "Cargo.lock")
      ]) digest.update(await readFile(file));
    }
    const directory = join(app.getPath("userData"), "remote-desktop", "native", digest.digest("hex"));
    const binary = join(directory, binaryName);
    try {
      await access(binary);
      return binary;
    } catch {
      if (!prepare) throw new Error("REMOTE_DESKTOP_INPUT_NOT_PREPARED");
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${binary}.${process.pid}.tmp`;
    try {
      if (platform === "darwin") {
        const buildDirectory = await mkdtemp(join(directory, "compile-"));
        try {
          const main = join(buildDirectory, "main.swift");
          const caller = await readFile(join(sourceRoot, "macos-caller.swift"), "utf8");
          const body = await readFile(source, "utf8");
          const program = `${caller}\n${body}`.replace(
            "REMOTE_DESKTOP_INPUT_DEVELOPMENT_EXECUTABLE",
            Buffer.from(process.execPath).toString("base64")
          );
          await writeFile(main, program, { mode: 0o600 });
          await exec("xcrun", ["--sdk", "macosx", "swiftc", "-D", "REMOTE_DESKTOP_INPUT_DEVELOPMENT",
            main, "-O", "-framework", "ApplicationServices", "-framework", "AppKit", "-framework", "Security",
            "-o", temporary], { timeout: 120_000, windowsHide: true });
        } finally {
          await rm(buildDirectory, { recursive: true, force: true });
        }
      } else {
        const manifest = join(sourceRoot, "windows-input", "Cargo.toml");
        const buildDirectory = join(directory, "build");
        const portableCargo = resolve(app.getAppPath(), "..", "..", ".runtime", "rust-toolchain", "bin", "cargo.exe");
        const cargo = process.env.JOKO_CARGO_EXECUTABLE
          ?? await access(portableCargo).then(() => portableCargo, () => "cargo");
        const target = process.arch === "x64"
          ? "x86_64-pc-windows-msvc"
          : process.arch === "arm64"
            ? "aarch64-pc-windows-msvc"
            : undefined;
        if (target === undefined) throw new Error("REMOTE_DESKTOP_INPUT_UNSUPPORTED");
        await exec(cargo, ["build", "--release", "--locked", "--manifest-path", manifest,
          "--target", target, "--target-dir", buildDirectory], {
          timeout: 180_000,
          windowsHide: true,
          env: {
            ...process.env,
            PATH: `${dirname(cargo)};${process.env.PATH ?? process.env.Path ?? ""}`
          }
        });
        await copyFile(join(buildDirectory, target, "release", binaryName), temporary);
      }
      await rename(temporary, binary);
    } finally {
      await rm(temporary, { force: true });
    }
    return binary;
  };
  if (!prepare) return build();
  inputBuild = build().finally(() => { inputBuild = undefined; });
  return inputBuild;
}

async function verifyPackagedDesktopRemoteDesktopInputBinary(
  directory: string,
  binaryName: string,
  platform: NodeJS.Platform,
  architecture: string
): Promise<string> {
  const manifestPath = join(directory, "manifest.json");
  const [directoryPath, manifestMetadata, manifestBytes] = await Promise.all([
    realpath(directory),
    lstat(manifestPath),
    readFile(manifestPath)
  ]);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestBytes.byteLength > 4_096) {
    throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
  }
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  finally { manifestBytes.fill(0); }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(",") !== "architecture,helper,platform,protocolVersion,sha256") {
    throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
  }
  const record = manifest as Record<string, unknown>;
  if (record["protocolVersion"] !== 1 || record["platform"] !== platform
    || record["architecture"] !== architecture || record["helper"] !== binaryName
    || typeof record["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["sha256"])) {
    throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
  }
  const binary = join(directoryPath, binaryName);
  const [binaryPath, metadata, bytes] = await Promise.all([realpath(binary), lstat(binary), readFile(binary)]);
  try {
    if (!binaryPath.startsWith(`${directoryPath}${sep}`) || !metadata.isFile() || metadata.isSymbolicLink()
      || bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_HELPER_BYTES) {
      throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }
    const actual = Buffer.from(createHash("sha256").update(bytes).digest("hex"), "utf8");
    const expected = Buffer.from(record["sha256"], "utf8");
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
      throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }
    return binaryPath;
  } finally {
    bytes.fill(0);
  }
}

function electronInputRuntime(): DesktopRemoteDesktopInputRuntime {
  return {
    platform: process.platform,
    resolveBinary: resolveDesktopRemoteDesktopInputBinary,
    spawn: (binary) => spawn(binary, [], { stdio: "pipe", windowsHide: true }),
    display: (displayId) => {
      const display = screen.getAllDisplays().find((item) => String(item.id) === displayId);
      return display === undefined ? undefined : Object.freeze({
        id: String(display.id),
        name: display.label || `Display ${displayId}`,
        width: display.bounds.width,
        height: display.bounds.height,
        x: display.bounds.x,
        y: display.bounds.y
      });
    },
    toPhysicalPoint: (point) => process.platform === "win32" ? screen.dipToScreenPoint(point) : point
  };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Remote Desktop input was aborted.");
}
