import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
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
  constructor(runtime: DesktopRemoteDesktopWindowsRuntime = windowsRuntime()) { this.#runtime = runtime; }

  async readSupport(signal?: AbortSignal): Promise<DesktopRemoteDesktopWindowsSupport | undefined> {
    if (this.#runtime.platform !== "win32") return undefined;
    if (!this.#runtime.packaged) return "installRequired";
    check(signal);
    try {
      const paths = await this.#runtime.resolve();
      check(signal);
      const status = (await this.#runtime.execute(paths.service, ["--status"], 6_000)).trim();
      check(signal);
      if (status === "ready") {
        try {
          const connection = await this.open({ mode: "probe" }, signal);
          await connection.close();
          check(signal);
        } catch { check(signal); return "missing"; }
      }
      return status === "ready" || status === "missing" || status === "installRequired" ? status : "unavailable";
    } catch { check(signal); return "unavailable"; }
  }

  async configure(enabled: boolean): Promise<void> {
    if (this.#runtime.platform !== "win32" || !this.#runtime.packaged) throw unavailable();
    try {
      await this.releasePending();
      const paths = await this.#runtime.resolve();
      await this.#runtime.execute(paths.service,
        enabled ? ["--elevate-install", String(process.pid)] : ["--elevate-uninstall"], 130_000);
      if (enabled && await this.readSupport() !== "ready") throw unavailable();
    } catch { throw unavailable(); }
  }

  async open(init: DesktopRemoteDesktopWindowsInit, signal?: AbortSignal): Promise<DesktopRemoteDesktopWindowsConnection> {
    if (this.#runtime.platform !== "win32" || !this.#runtime.packaged) throw unavailable();
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
    resolve: () => verifyPackagedDesktopRemoteDesktopWindowsHost(join(process.resourcesPath, "native-remote-desktop"), process.platform, process.arch),
    execute: async (binary, args, timeout) => (await exec(binary, [...args], { timeout, maxBuffer: 1_024, windowsHide: true })).stdout,
    open: (paths, init) => {
      const native = requireNative(paths.addon) as { DesktopConnection: { open(binary: string, init: string): Promise<DesktopRemoteDesktopWindowsConnection> } };
      return native.DesktopConnection.open(paths.service, init);
    }
  };
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? unavailable();
}
