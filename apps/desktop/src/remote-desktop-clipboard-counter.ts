import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isRemoteDesktopClipboardVersion } from "@joko/contracts";
import { desktopRemoteDesktopLinuxClipboard } from "./remote-desktop-linux-clipboard.js";

import { resolveDesktopRemoteDesktopInputBinary } from "./remote-desktop-input.js";

export interface DesktopRemoteDesktopClipboardCounterRuntime {
  readonly platform: NodeJS.Platform;
  resolveBinary(): Promise<string>;
  spawn(binary: string): ChildProcessWithoutNullStreams;
}
export interface DesktopRemoteDesktopLinuxClipboardVersionPort {
  supports(): boolean;
  version(current: () => boolean, signal: AbortSignal): Promise<string>;
}

interface Pending {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cancel(): void;
}
interface Session {
  ready: Promise<void>;
  child?: ChildProcessWithoutNullStreams;
  pending: Map<number, Pending>;
  buffer: string;
  idle?: ReturnType<typeof setTimeout>;
}
const unavailable = (): Error => new Error("REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE");

/** One owner's version reader. Linux fingerprints system content; other platforms use counters. */
export class DesktopRemoteDesktopClipboardCounter {
  readonly #runtime: DesktopRemoteDesktopClipboardCounterRuntime;
  readonly #linux: DesktopRemoteDesktopLinuxClipboardVersionPort;
  readonly #linuxReads = new Set<AbortController>();
  #linuxGeneration = 0;
  #session: Session | undefined;
  #sequence = 0;

  constructor(runtime: DesktopRemoteDesktopClipboardCounterRuntime = {
    platform: process.platform,
    resolveBinary: resolveDesktopRemoteDesktopInputBinary,
    spawn: (binary) => spawn(binary, ["--clipboard-counter"], { stdio: "pipe", windowsHide: true })
  }, linux: DesktopRemoteDesktopLinuxClipboardVersionPort = desktopRemoteDesktopLinuxClipboard) {
    this.#runtime = runtime;
    this.#linux = linux;
  }

  stop(): void {
    ++this.#linuxGeneration;
    for (const controller of this.#linuxReads) controller.abort(new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED"));
    if (this.#session !== undefined) this.#retire(this.#session);
  }

  #retire(session: Session): void {
    if (this.#session === session) this.#session = undefined;
    clearTimeout(session.idle);
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.cancel();
      pending.reject(unavailable());
    }
    session.pending.clear();
    session.child?.stdin.destroy();
    try { session.child?.kill("SIGKILL"); } catch { /* Captured process already exited. */ }
  }

  #idle(session: Session): void {
    clearTimeout(session.idle);
    if (session.pending.size === 0 && this.#session === session) {
      session.idle = setTimeout(() => this.#retire(session), 4_000);
      session.idle.unref?.();
    }
  }

  #start(): Session {
    const session: Session = { ready: Promise.resolve(), pending: new Map(), buffer: "" };
    this.#session = session;
    session.ready = this.#runtime.resolveBinary().then((binary) => {
      if (this.#session !== session) throw unavailable();
      const child = this.#runtime.spawn(binary);
      session.child = child;
      child.stderr.resume();
      child.once("error", () => this.#retire(session));
      child.once("exit", () => this.#retire(session));
      child.stdin.on("error", () => this.#retire(session));
      child.stdout.on("error", () => this.#retire(session));
      child.stderr.on("error", () => this.#retire(session));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.#session !== session) return;
        session.buffer += chunk;
        if (session.buffer.length > 4_096) return this.#retire(session);
        let end: number;
        while ((end = session.buffer.indexOf("\n")) !== -1) {
          const line = session.buffer.slice(0, end);
          session.buffer = session.buffer.slice(end + 1);
          const match = /^(\d{1,16}) (\d{1,128}|unavailable|unsupported)$/u.exec(line);
          if (match === null) return this.#retire(session);
          const pending = session.pending.get(Number(match[1]));
          if (pending === undefined) return this.#retire(session);
          session.pending.delete(Number(match[1]));
          clearTimeout(pending.timer);
          pending.cancel();
          if (match[2] === "unsupported") pending.reject(new Error("REMOTE_DESKTOP_CLIPBOARD_UNSUPPORTED"));
          else if (match[2] === "unavailable") pending.reject(unavailable());
          else pending.resolve(match[2]!);
        }
        this.#idle(session);
      });
    });
    return session;
  }

  async read(portable: boolean, signal: AbortSignal, current: () => boolean = () => true): Promise<string> {
    if (signal.aborted) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
    if (this.#runtime.platform === "linux") {
      if (!this.#linux.supports() || this.#linuxReads.size >= 32) throw unavailable();
      const generation = this.#linuxGeneration;
      const controller = new AbortController();
      const aborted = (): void => { controller.abort(signal.reason); };
      signal.addEventListener("abort", aborted, { once: true });
      this.#linuxReads.add(controller);
      const valid = (): boolean => generation === this.#linuxGeneration && !signal.aborted
        && !controller.signal.aborted && current();
      try {
        if (!valid()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
        const value = await this.#linux.version(valid, controller.signal);
        if (!valid()) throw new Error("REMOTE_DESKTOP_CLIPBOARD_EXPIRED");
        if (!isRemoteDesktopClipboardVersion(value)) throw unavailable();
        return value;
      } finally {
        signal.removeEventListener("abort", aborted);
        this.#linuxReads.delete(controller);
      }
    }
    if (this.#runtime.platform !== "darwin" && this.#runtime.platform !== "win32") throw unavailable();
    const session = this.#session ?? this.#start();
    if (session.pending.size >= 32 || this.#sequence >= Number.MAX_SAFE_INTEGER) throw unavailable();
    clearTimeout(session.idle);
    const id = ++this.#sequence;
    return new Promise<string>((resolve, reject) => {
      const aborted = (): void => this.#retire(session);
      const pending: Pending = {
        resolve, reject,
        timer: setTimeout(() => this.#retire(session), 125_000),
        cancel: () => signal.removeEventListener("abort", aborted)
      };
      session.pending.set(id, pending);
      signal.addEventListener("abort", aborted, { once: true });
      void session.ready.then(() => {
        if (this.#session !== session || !session.pending.has(id)) throw unavailable();
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => this.#retire(session), 2_000);
        session.child!.stdin.write(`${id} ${portable ? 1 : 0}\n`, (error) => {
          if (error !== undefined && error !== null) this.#retire(session);
        });
      }).catch(() => this.#retire(session));
    });
  }
}
