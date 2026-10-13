import { screen } from "electron";
import type { RemoteDesktopInput } from "@joko/device-peer";
import { DesktopRemoteDesktopInput } from "./remote-desktop-input.js";
import { desktopRemoteDesktopWindowsHost, type DesktopRemoteDesktopWindowsConnection } from "./remote-desktop-windows-host.js";

export interface DesktopRemoteDesktopWindowsInputRuntime {
  supported(signal: AbortSignal): Promise<boolean>;
  open(signal: AbortSignal): Promise<DesktopRemoteDesktopWindowsConnection>;
  project(displayId: string, x: number, y: number): { readonly x: number; readonly y: number };
}

/** Uses the authorized SYSTEM input worker, with the ordinary user route as fallback. */
export class DesktopRemoteDesktopWindowsInput {
  readonly #fallback: DesktopRemoteDesktopInput;
  readonly #runtime: DesktopRemoteDesktopWindowsInputRuntime;
  readonly #failed: () => void;
  readonly #releases = new Set<DesktopRemoteDesktopWindowsConnection>();
  readonly #starts = new Set<Promise<void>>();
  #connection: DesktopRemoteDesktopWindowsConnection | undefined;
  #displayId = "";
  #generation = 0;
  #queuedBytes = 0;
  #writing = Promise.resolve();
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #retired = false;
  #paused = false;

  constructor(failed: () => void, fallback = new DesktopRemoteDesktopInput(failed), runtime: DesktopRemoteDesktopWindowsInputRuntime = {
    supported: async signal => await desktopRemoteDesktopWindowsHost.readSupport(signal) === "ready",
    open: signal => desktopRemoteDesktopWindowsHost.open({ mode: "input" }, signal),
    project: (displayId, x, y) => {
      const display = screen.getAllDisplays().find(item => String(item.id) === displayId);
      if (display === undefined) throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
      return screen.dipToScreenPoint({ x: Math.round(display.bounds.x + x * (display.bounds.width - 1)),
        y: Math.round(display.bounds.y + y * (display.bounds.height - 1)) });
    }
  }) { this.#failed = failed; this.#fallback = fallback; this.#runtime = runtime; }

  async start(displayId: string, signal: AbortSignal): Promise<void> {
    const promise = this.#start(displayId, signal);
    this.#starts.add(promise);
    try { await promise; } finally { this.#starts.delete(promise); }
  }

  async #start(displayId: string, signal: AbortSignal): Promise<void> {
    if (this.#retired) throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    this.stop();
    const generation = this.#generation;
    await this.#join();
    await this.#fallback.release();
    const current = (): void => {
      if (signal.aborted || generation !== this.#generation) throw new Error("REMOTE_DESKTOP_LEASE_EXPIRED");
    };
    current();
    if (!await this.#runtime.supported(signal)) { current(); await this.#fallback.start(displayId, signal); return; }
    current();
    const connection = await this.#runtime.open(signal);
    if (signal.aborted || generation !== this.#generation) {
      this.#release(connection);
      await this.#join();
      current();
    }
    this.#connection = connection;
    this.#displayId = displayId;
    this.#paused = false;
    this.#heartbeat = setInterval(() => this.#write([]), 2_000);
    this.#heartbeat.unref?.();
  }

  send(events: readonly RemoteDesktopInput[]): void {
    if (this.#paused) return;
    if (this.#connection === undefined) { this.#fallback.send(events); return; }
    const projected = events.flatMap(event => {
      if (event.kind === "move" || event.kind === "button") return [{ ...event, ...this.#runtime.project(this.#displayId, event.x, event.y) }];
      if (event.kind !== "text") return [event];
      const scalars = Array.from(event.text); const pieces: RemoteDesktopInput[] = [];
      for (let index = 0; index < scalars.length; index += 256) pieces.push({ kind: "text", text: scalars.slice(index, index + 256).join("") });
      return pieces;
    });
    for (let index = 0; index < projected.length; index += 64) this.#write(projected.slice(index, index + 64));
  }

  #write(events: readonly RemoteDesktopInput[]): void {
    const connection = this.#connection;
    if (connection === undefined) return;
    const line = JSON.stringify(events);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > 32_767 || this.#queuedBytes + bytes > 32_768) { this.#fail(); return; }
    const generation = this.#generation;
    this.#queuedBytes += bytes;
    this.#writing = this.#writing.then(async () => {
      if (generation !== this.#generation || this.#connection !== connection) return;
      if (await connection.request(line) !== "ok\n") throw new Error("REMOTE_DESKTOP_INPUT_UNAVAILABLE");
    }).catch(() => { if (generation === this.#generation && this.#connection === connection) this.#fail(); })
      .finally(() => { this.#queuedBytes -= bytes; });
  }
  #fail(): void { this.stop(); this.#failed(); }

  stop(): void {
    ++this.#generation;
    clearInterval(this.#heartbeat); this.#heartbeat = undefined;
    this.#paused = false;
    this.#fallback.stop();
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection !== undefined) this.#release(connection);
  }
  #release(connection: DesktopRemoteDesktopWindowsConnection): void {
    this.#releases.add(connection);
    void connection.close().then(() => { this.#releases.delete(connection); }, () => { /* Retain actual-release responsibility for the next join. */ });
  }
  async #join(): Promise<void> {
    await Promise.all([...this.#releases].map(async connection => {
      await connection.close(); this.#releases.delete(connection);
    }));
  }
  async release(): Promise<void> {
    this.stop(); await Promise.allSettled([...this.#starts]);
    await Promise.all([this.#join(), this.#fallback.release()]);
  }
  async retire(): Promise<void> {
    this.#retired = true; this.stop(); await Promise.allSettled([...this.#starts]);
    await Promise.all([this.#join(), this.#fallback.retire()]);
  }

  async pauseForPrivacy(current: () => boolean, signal: AbortSignal): Promise<() => Promise<void>> {
    if (this.#connection === undefined) return this.#fallback.pauseForPrivacy(current, signal);
    const displayId = this.#displayId;
    if (!current() || signal.aborted) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    await this.release();
    this.#paused = true;
    const generation = this.#generation;
    return async () => {
      if (generation !== this.#generation || !current() || signal.aborted) return;
      await this.start(displayId, signal);
      if (!current() || signal.aborted) { await this.release(); throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED"); }
    };
  }
  async resumeAfterPrivacy(displayId: string, current: () => boolean, signal: AbortSignal): Promise<void> {
    if (!this.#paused) return this.#fallback.resumeAfterPrivacy(displayId, current, signal);
    if (!current() || signal.aborted) throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED");
    await this.start(displayId, signal);
    if (!current() || signal.aborted) { await this.release(); throw new Error("REMOTE_DESKTOP_PRIVACY_EXPIRED"); }
  }
}
