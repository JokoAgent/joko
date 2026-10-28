import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { app } from "electron";
import type { DesktopRemoteDesktopWindowsDiagnostic } from "@joko/contracts";
import { verifyPackagedDesktopRemoteDesktopWindowsHost } from "./remote-desktop-native-manifest.js";

const exec = promisify(execFile);
const requireNative = createRequire(import.meta.url);
const unavailable = (): Error => new Error("REMOTE_DESKTOP_SYSTEM_SERVICE_UNAVAILABLE");

export type DesktopRemoteDesktopWindowsSupport = "ready" | "missing" | "installRequired" | "unavailable";
export type DesktopRemoteDesktopWindowsInit = { readonly mode: "probe" | "input" }
  | { readonly mode: "capture"; readonly rect: readonly number[]; readonly cursorOverlay: boolean; readonly bitrate: number };
export interface DesktopRemoteDesktopWindowsConnection {
  readonly ready: boolean;
  request(line: string): Promise<string>;
  /** Resolves only after the authorized worker and its job have actually retired. */
  close(): Promise<void>;
}
export interface DesktopRemoteDesktopWindowsRuntime {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  resolve(): Promise<{ readonly service: string; readonly addon: string }>;
  execute(binary: string, args: readonly string[], timeout: number): Promise<string>;
  open(paths: { readonly service: string; readonly addon: string }, init: string): Promise<DesktopRemoteDesktopWindowsConnection>;
}

/** Main-only connection authority; the addon verifies the actual SCM/SYSTEM pipe peer. */
export class DesktopRemoteDesktopWindowsHost {
  readonly #runtime: DesktopRemoteDesktopWindowsRuntime;
  readonly #closing = new Set<DesktopRemoteDesktopWindowsConnection>();
  readonly #closePromises = new Map<DesktopRemoteDesktopWindowsConnection, Promise<void>>();
  #diagnostic: DesktopRemoteDesktopWindowsDiagnostic | undefined;
  #supportGeneration = 0;
  constructor(runtime: DesktopRemoteDesktopWindowsRuntime = windowsRuntime()) { this.#runtime = runtime; }

  get diagnostic(): DesktopRemoteDesktopWindowsDiagnostic | undefined { return this.#diagnostic; }

  async readSupport(signal?: AbortSignal): Promise<DesktopRemoteDesktopWindowsSupport | undefined> {
    if (this.#runtime.platform !== "win32") return undefined;
    const generation = ++this.#supportGeneration;
    check(signal);
    try {
      const paths = await this.#runtime.resolve();
      check(signal);
      const output = (await this.#runtime.execute(paths.service, ["--status"], 6_000)).trim();
      const status = output.split(" ", 1)[0];
      if (generation === this.#supportGeneration) {
        const diagnostic = parseDesktopRemoteDesktopWindowsDiagnostic(output);
        if (diagnostic !== undefined) this.#diagnostic = diagnostic;
      }
      check(signal);
      if (status === "ready") {
        try {
          const connection = await this.open({ mode: "probe" }, signal);
          await connection.close();
          check(signal);
          if (generation === this.#supportGeneration) this.#diagnostic = undefined;
        } catch { check(signal); return "missing"; }
      }
      return status === "ready" || status === "missing" || status === "installRequired" ? status : "unavailable";
    } catch (error) {
      check(signal);
      if (generation === this.#supportGeneration) this.#diagnostic = diagnosticFromError(error) ?? this.#diagnostic;
      return "unavailable";
    }
  }

  async configure(enabled: boolean): Promise<void> {
    if (this.#runtime.platform !== "win32") throw unavailable();
    ++this.#supportGeneration;
    try {
      await this.releasePending();
      const paths = await this.#runtime.resolve();
      await this.#runtime.execute(paths.service,
        enabled ? ["--elevate-install", String(process.pid), ...(this.#runtime.packaged ? [] : ["--development"])] : ["--elevate-uninstall"], 130_000);
      if (enabled && await this.readSupport() !== "ready") throw unavailable();
      if (!enabled) this.#diagnostic = undefined;
    } catch (error) {
      this.#diagnostic = diagnosticFromError(error) ?? this.#diagnostic;
      throw unavailable();
    }
  }

  async open(init: DesktopRemoteDesktopWindowsInit, signal?: AbortSignal): Promise<DesktopRemoteDesktopWindowsConnection> {
    if (this.#runtime.platform !== "win32") throw unavailable();
    check(signal);
    await this.releasePending();
    const paths = await this.#runtime.resolve();
    check(signal);
    let native: DesktopRemoteDesktopWindowsConnection;
    try { native = await this.#runtime.open(paths, JSON.stringify(init)); }
    catch { throw unavailable(); }
    if (native.ready !== true) { await this.#close(native); throw unavailable(); }
    let closing = false;
    const connection: DesktopRemoteDesktopWindowsConnection = {
      ready: true,
      request: async line => {
        if (closing || Buffer.byteLength(line, "utf8") > 32_767 || line.includes("\n") || line.includes("\r") || line.includes("\0")) throw unavailable();
        try {
          const response = await native.request(line);
          if (typeof response !== "string" || Buffer.byteLength(response, "utf8") > 1_750_000) throw unavailable();
          return response;
        } catch { throw unavailable(); }
      },
      close: () => { closing = true; return this.#close(native); }
    };
    if (signal?.aborted) { await connection.close(); check(signal); }
    return connection;
  }

  async releasePending(): Promise<void> { await Promise.all([...this.#closing].map(connection => this.#close(connection))); }
  #close(connection: DesktopRemoteDesktopWindowsConnection): Promise<void> {
    const pending = this.#closePromises.get(connection);
    if (pending !== undefined) return pending;
    this.#closing.add(connection);
    const promise = Promise.resolve().then(() => connection.close()).then(() => {
      this.#closing.delete(connection);
    }, () => { throw unavailable(); }).finally(() => { this.#closePromises.delete(connection); });
    this.#closePromises.set(connection, promise);
    return promise;
  }
}

export const desktopRemoteDesktopWindowsHost = new DesktopRemoteDesktopWindowsHost();

function windowsRuntime(): DesktopRemoteDesktopWindowsRuntime {
  return {
    get platform() { return process.platform; },
    get packaged() { return app.isPackaged; },
    resolve: async () => {
      // Both inputs are fixed Main-owned build locations, never renderer paths.
      // Source preparation already builds these helpers; setup runs no compiler.
      const directory = app.isPackaged ? join(process.resourcesPath, "native-remote-desktop")
        : fileURLToPath(new URL("../dist/native-remote-desktop/", import.meta.url));
      const paths = await verifyPackagedDesktopRemoteDesktopWindowsHost(directory, process.platform, process.arch);
      return app.isPackaged ? paths : { ...paths,
        addon: await prepareDevelopmentWindowsAddon(paths.addon, join(app.getPath("userData"), "remote-desktop-development", process.arch)) };
    },
    execute: async (binary, args, timeout) => (await exec(binary, [...args], { timeout, maxBuffer: 1_024, windowsHide: true })).stdout,
    open: (paths, init) => {
      const native = requireNative(paths.addon) as { DesktopConnection: { open(binary: string, init: string): Promise<DesktopRemoteDesktopWindowsConnection> } };
      return native.DesktopConnection.open(paths.service, init);
    }
  };
}

/** Versioned source-mode addons avoid replacing a .node still loaded by Main. */
export async function prepareDevelopmentWindowsAddon(source: string, directory: string): Promise<string> {
  const bytes = await readFile(source);
  try {
    const digest = createHash("sha256").update(bytes).digest("hex");
    await mkdir(directory, { recursive: true });
    const destination = join(directory, `${digest}.node`);
    try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const [metadata, canonical, copied] = await Promise.all([lstat(destination), realpath(destination), readFile(destination)]);
    try {
      if (!metadata.isFile() || metadata.isSymbolicLink() || canonical.toLowerCase() !== destination.toLowerCase()
        || createHash("sha256").update(copied).digest("hex") !== digest) throw unavailable();
    } finally { copied.fill(0); }
    return destination;
  } finally { bytes.fill(0); }
}

const SETUP_STEPS = new Set(["args", "service", "worker", "protected-root", "protected-open", "protected-reparse", "protected-owner",
  "protected-acl", "stage-prepare", "stage-read", "stage-write", "stage-remove", "stage-record", "scm-open", "service-create", "service-start",
  "service-ready", "service-stop", "service-delete", "authorize-connect", "authorize-identity", "authorize-reply", "client-identity",
  "elevate-launch", "elevate-timeout", "elevate-child"]);

export function parseDesktopRemoteDesktopWindowsDiagnostic(output: string): DesktopRemoteDesktopWindowsDiagnostic | undefined {
  const match = /^(?:error|installRequired) ([a-z-]+)(?:\/([a-z-]+))? (\d{1,8})$/u.exec(output.trim());
  if (match === null || !SETUP_STEPS.has(match[1]!) || (match[2] !== undefined && !SETUP_STEPS.has(match[2]))
    || Number(match[3]) > 0x00ff_ffff) return undefined;
  return Object.freeze({ step: match[1]!, ...(match[2] === undefined ? {} : { childStep: match[2] }), osError: Number(match[3]) });
}

function diagnosticFromError(error: unknown): DesktopRemoteDesktopWindowsDiagnostic | undefined {
  if (typeof error !== "object" || error === null || !("stdout" in error) || typeof error.stdout !== "string") return undefined;
  return error.stdout.length <= 1_024 ? parseDesktopRemoteDesktopWindowsDiagnostic(error.stdout) : undefined;
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? unavailable();
}
