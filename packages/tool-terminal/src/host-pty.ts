import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IPtyForkOptions, IWindowsPtyForkOptions } from "node-pty";
import type { TerminalPty } from "./provider.js";
import { terminalEnvironment } from "./shells.js";
import { TerminalError } from "./types.js";

const MAXIMUM_IPC_BYTES = 1024 * 1024;
const MAXIMUM_COMMANDS = 128;
const COMMAND_TIMEOUT_MS = 5000;
const HOST_TIMEOUT_MS = 8000;
type Exit = { exitCode: number; signal?: number; failureCode?: string; processExitConfirmed?: boolean };
type Pending = { resolve: () => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout>; bytes: number };

/** One child owns one native PTY. Native exit is not complete until its host has closed. */
export async function spawnTerminalHost(executable: string, args: string[], options: IPtyForkOptions | IWindowsPtyForkOptions, signal?: AbortSignal): Promise<TerminalPty> {
  signal?.throwIfAborted();
  const environment = terminalEnvironment();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./terminal-host.mjs", import.meta.url))], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json",
    env: { ...environment, ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }) }
  });
  const proxy = new HostedPty(child);
  await proxy.initialize({ type: "init", executable, args, cwd: options.cwd, cols: options.cols, rows: options.rows, env: options.env }, signal);
  return proxy;
}

class HostedPty implements TerminalPty {
  pid = 0;
  readonly #child: ChildProcess;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: Exit) => void>();
  readonly #pending = new Map<number, Pending>();
  readonly #closed: Promise<void>;
  readonly #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  #resolveClosed!: () => void;
  #nextId = 0;
  #pendingBytes = 0;
  #started = false;
  #stopping = false;
  #ended = false;
  #nativeExit: Exit | undefined;
  #notStarted = false;
  #failureCode: string | undefined;
  #finalExit: Exit | undefined;
  #stopTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(child: ChildProcess) {
    this.#child = child;
    this.#closed = new Promise((done) => { this.#resolveClosed = done; });
    this.#ready = new Promise((done, reject) => { this.#resolveReady = done; this.#rejectReady = reject; });
    child.on("message", (message: unknown) => this.#message(message));
    child.on("error", () => this.#stop("HOST_TRANSPORT_FAILED"));
    child.once("close", (code) => {
      this.#ended = true;
      if (this.#stopTimer !== undefined) clearTimeout(this.#stopTimer);
      this.#finalExit = code === 0 && this.#nativeExit !== undefined && this.#failureCode === undefined
        ? { ...this.#nativeExit, processExitConfirmed: true }
        : { exitCode: -1, failureCode: this.#failureCode ?? "HOST_EXITED", processExitConfirmed: this.#nativeExit !== undefined };
      this.#rejectReady(new TerminalError("SPAWN_FAILED", "The terminal host closed before startup completed."));
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new TerminalError("INPUT_UNKNOWN", "The terminal command outcome could not be confirmed.", true));
      }
      this.#pending.clear(); this.#pendingBytes = 0;
      this.#resolveClosed();
      for (const listener of this.#exit) listener(this.#finalExit);
    });
  }

  async initialize(message: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    const abort = () => this.#stop("START_CANCELLED");
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => this.#stop("START_TIMEOUT"), HOST_TIMEOUT_MS);
    try {
      if (signal?.aborted) abort();
      else this.#send(message);
      await this.#ready;
      signal?.throwIfAborted();
      if (this.#stopping) throw new TerminalError("SPAWN_FAILED", "The terminal host stopped during startup.");
    } catch (error) {
      this.#stop("START_FAILED");
      await this.#closed;
      if (!this.#notStarted && this.#nativeExit === undefined) throw new TerminalError("CLEANUP_UNKNOWN", "The terminal host closed without confirming the native process exit.", true);
      signal?.throwIfAborted();
      if (error instanceof TerminalError) throw new TerminalError(error.code, error.message, !this.#notStarted && this.#nativeExit === undefined);
      throw new TerminalError("SPAWN_FAILED", "The terminal host could not finish startup.", !this.#notStarted && this.#nativeExit === undefined);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  onData = (listener: (data: string) => void) => { this.#data.add(listener); return { dispose: () => { this.#data.delete(listener); } }; };
  onExit = (listener: (event: Exit) => void) => {
    this.#exit.add(listener);
    if (!this.#started && !this.#ended) { this.#started = true; this.#send({ type: "start" }); }
    if (this.#finalExit !== undefined) queueMicrotask(() => { if (this.#exit.has(listener)) listener(this.#finalExit!); });
    return { dispose: () => { this.#exit.delete(listener); } };
  };

  write(data: string): Promise<void> { return this.#command("write", { data }, Buffer.byteLength(data)); }
  resize(cols: number, rows: number): Promise<void> { return this.#command("resize", { cols, rows }, 0); }
  pause(): void { if (!this.#stopping) this.#send({ type: "pause" }); }
  resume(): void { if (!this.#stopping) this.#send({ type: "resume" }); }
  async kill(): Promise<void> {
    this.#stop(); await this.#closed;
    if (this.#nativeExit === undefined && !this.#notStarted) throw new TerminalError("CLEANUP_UNKNOWN", "The native terminal process did not confirm exit.", true);
  }

  #command(type: "write" | "resize", fields: Record<string, unknown>, bytes: number): Promise<void> {
    if (this.#stopping || this.#ended || this.#nativeExit !== undefined) return Promise.reject(new TerminalError("TERMINAL_EXITED", "The terminal host no longer accepts commands."));
    if (this.#pending.size >= MAXIMUM_COMMANDS || this.#pendingBytes + bytes > MAXIMUM_IPC_BYTES) return Promise.reject(new TerminalError("INPUT_LIMIT", "Terminal command capacity is exhausted."));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id); this.#pendingBytes -= bytes;
        reject(new TerminalError("INPUT_UNKNOWN", "The terminal host did not confirm the command.", true));
        this.#stop("COMMAND_TIMEOUT");
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer, bytes }); this.#pendingBytes += bytes;
      this.#send({ type, id, ...fields });
    });
  }

  #send(message: Record<string, unknown>): void {
    if (this.#ended) return;
    try { this.#child.send(message, (error) => { if (error) this.#stop("HOST_TRANSPORT_FAILED"); }); }
    catch { this.#stop("HOST_TRANSPORT_FAILED"); }
  }

  #stop(failureCode?: string): void {
    if (this.#ended || this.#stopping) return;
    this.#stopping = true;
    if (failureCode !== undefined) this.#failureCode = failureCode;
    this.#stopTimer = setTimeout(() => { if (!this.#ended) this.#child.kill(); }, HOST_TIMEOUT_MS);
    if (!this.#child.connected) { this.#child.kill(); return; }
    this.#send({ type: "kill" });
  }

  #message(value: unknown): void {
    if (!isObject(value)) { this.#stop("HOST_PROTOCOL_FAILED"); return; }
    if (value.type === "ready" && exact(value, ["type", "pid"]) && integer(value.pid, 1, 2 ** 32) && this.pid === 0) { this.pid = value.pid; this.#resolveReady(); return; }
    if (value.type === "data" && exact(value, ["type", "data"]) && typeof value.data === "string" && Buffer.byteLength(value.data) <= 64 * 1024 && this.#started) {
      for (const listener of this.#data) listener(value.data);
      return;
    }
    if (value.type === "ack" && exact(value, ["type", "id", "ok"]) && integer(value.id, 1, Number.MAX_SAFE_INTEGER) && typeof value.ok === "boolean") {
      const pending = this.#pending.get(value.id);
      if (pending === undefined) { if (!this.#stopping) this.#stop("HOST_PROTOCOL_FAILED"); return; }
      this.#pending.delete(value.id); this.#pendingBytes -= pending.bytes; clearTimeout(pending.timer);
      if (value.ok) pending.resolve();
      else pending.reject(new TerminalError("INPUT_UNKNOWN", "The native terminal command outcome could not be confirmed.", true));
      return;
    }
    if (value.type === "exit" && exact(value, ["type", "exitCode", "signal"]) && this.#nativeExit === undefined && integer(value.exitCode, -(2 ** 31), 2 ** 32) && (value.signal === null || integer(value.signal, 0, 255))) {
      this.#nativeExit = { exitCode: value.exitCode, ...(value.signal === null ? {} : { signal: value.signal }) };
      return;
    }
    if (value.type === "fatal" && exact(value, ["type"])) { this.#stop("HOST_FAILED"); return; }
    if (value.type === "not-started" && exact(value, ["type"]) && this.pid === 0 && this.#nativeExit === undefined) { this.#notStarted = true; return; }
    this.#stop("HOST_PROTOCOL_FAILED");
  }
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
