import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import type { Client, ClientChannel } from "ssh2";
import { RemoteSshError } from "./errors.js";
import type { RemoteTerminalExit, RemoteTerminalHandle, RemoteTerminalStartRequest } from "./types.js";

const MAXIMUM_PENDING_OUTPUT_BYTES = 1_024 * 1_024;
const MAXIMUM_PENDING_INPUT_BYTES = 256 * 1_024;
const OUTPUT_CHUNK_BYTES = 32 * 1_024;

export interface Ssh2TerminalTimeouts {
  readonly open: number;
  readonly operation: number;
  readonly stop: number;
  readonly drain: number;
}

export function terminalUnknown(): RemoteSshError {
  return new RemoteSshError("TERMINAL_UNKNOWN", "The remote terminal outcome could not be confirmed. Check the remote process before trying again.", false,
    { stateMayHaveChanged: true });
}

function terminalUnavailable(): RemoteSshError {
  return new RemoteSshError("TERMINAL_UNAVAILABLE", "The remote terminal is no longer available.", false);
}

function validateSize(cols: number, rows: number): void {
  if (![cols, rows].every((value) => Number.isInteger(value) && value >= 1 && value <= 1_000)) {
    throw new RemoteSshError("INVALID_ARGUMENT", "The terminal dimensions must be between 1 and 1000.", false);
  }
}

/** The SSH exec request owns no local environment and carries no long-lived cancellation. */
export async function openSsh2Terminal(
  client: Client,
  command: string,
  request: RemoteTerminalStartRequest,
  timeouts: Ssh2TerminalTimeouts
): Promise<RemoteTerminalHandle> {
  validateSize(request.cols, request.rows);
  const signal = request.signal;
  if (signal?.aborted === true) throw new RemoteSshError("ABORTED", "Remote terminal creation was cancelled.", true);
  return new Promise<RemoteTerminalHandle>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      client.removeListener("close", onFailure);
      client.removeListener("error", onFailure);
    };
    const fail = (error: RemoteSshError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => fail(terminalUnknown());
    const onFailure = (): void => fail(terminalUnknown());
    const timer = setTimeout(onFailure, timeouts.open);
    signal?.addEventListener("abort", onAbort, { once: true });
    client.once("close", onFailure);
    client.once("error", onFailure);
    try {
      client.exec(command, { pty: { term: "xterm-256color", cols: request.cols, rows: request.rows, width: 0, height: 0 } }, (error, channel) => {
        if (channel === undefined || error) {
          // The exec request may already have reached the peer before transport failure.
          fail(terminalUnknown());
          return;
        }
        const handle = new Ssh2TerminalHandle(client, channel, timeouts);
        if (settled || signal?.aborted === true) {
          void handle.kill().catch(() => undefined);
          fail(terminalUnknown());
          return;
        }
        settled = true;
        cleanup();
        resolve(handle);
      });
    } catch {
      fail(terminalUnknown());
    }
  });
}

class Ssh2TerminalHandle implements RemoteTerminalHandle {
  readonly #channel: ClientChannel;
  readonly #client: Client;
  readonly #timeouts: Ssh2TerminalTimeouts;
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: RemoteTerminalExit) => void>();
  readonly #pendingOperations = new Set<() => void>();
  readonly #stdoutDecoder = new StringDecoder("utf8");
  readonly #stderrDecoder = new StringDecoder("utf8");
  readonly #output: string[] = [];
  #outputBytes = 0;
  #inputBytes = 0;
  #paused = false;
  #flushing = false;
  #receiving = 0;
  #stdoutEnded = false;
  #stderrEnded = false;
  #channelClosed = false;
  #decodersEnded = false;
  #endingDecoders = false;
  #drainTimer: ReturnType<typeof setTimeout> | undefined;
  #exit: RemoteTerminalExit | undefined;
  #remoteExit: RemoteTerminalExit | undefined;
  #stopping: Promise<void> | undefined;

  constructor(client: Client, channel: ClientChannel, timeouts: Ssh2TerminalTimeouts) {
    this.#client = client;
    this.#channel = channel;
    this.#timeouts = timeouts;
    channel.on("data", this.onStdout);
    channel.stderr.on("data", this.onStderr);
    channel.on("error", this.onFailure);
    channel.stderr.on("error", this.onFailure);
    channel.once("end", () => { this.#stdoutEnded = true; this.maybeFinish(); });
    channel.stderr.once("end", () => { this.#stderrEnded = true; this.maybeFinish(); });
    channel.once("close", () => { this.#channelClosed = true; this.maybeFinish(); if (this.#exit !== undefined) this.closeChannel(); });
    channel.once("exit", (code: number | null, signal?: string) => {
      if (this.#exit?.processExitConfirmed === true) return;
      if (Number.isInteger(code) && code !== null && code >= 0) {
        this.#remoteExit = { exitCode: code, processExitConfirmed: true };
      } else if (typeof signal === "string" && signal.length > 0 && signal.length <= 64) {
        const number = constants.signals[signal as NodeJS.Signals];
        this.#remoteExit = { exitCode: number === undefined ? 1 : 128 + number,
          ...(number === undefined ? {} : { signal: number }), processExitConfirmed: true };
      } else {
        this.onFailure();
      }
      // SSH exit-status/exit-signal confirms the process, not EOF. The peer may
      // still send output, and only the consumer may release its backpressure.
      if (this.#remoteExit !== undefined) {
        if (this.#exit !== undefined) {
          this.finish({ ...this.#exit, ...this.#remoteExit });
          return;
        }
        this.#drainTimer = setTimeout(this.onFailure, timeouts.drain);
        this.maybeFinish();
      }
    });
    client.once("close", this.onTransportFailure);
    client.once("error", this.onTransportFailure);
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.add(listener);
    this.flush();
    return { dispose: () => { this.#dataListeners.delete(listener); } };
  }

  onExit(listener: (event: RemoteTerminalExit) => void): { dispose(): void } {
    this.#exitListeners.add(listener);
    const exit = this.#exit;
    if (exit !== undefined) queueMicrotask(() => { if (this.#exit === exit && this.#exitListeners.has(listener)) listener(exit); });
    return { dispose: () => { this.#exitListeners.delete(listener); } };
  }

  async write(data: string): Promise<void> {
    this.assertActive();
    if (typeof data !== "string" || Buffer.byteLength(data, "utf8") + this.#inputBytes > MAXIMUM_PENDING_INPUT_BYTES) {
      throw new RemoteSshError("INVALID_ARGUMENT", "The pending terminal input exceeds its limit.", false);
    }
    const bytes = Buffer.byteLength(data, "utf8");
    this.#inputBytes += bytes;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: RemoteSshError): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#pendingOperations.delete(onFailure);
          if (error) reject(error);
          else resolve();
        };
        const onFailure = (): void => finish(terminalUnknown());
        const timer = setTimeout(() => { this.onFailure(); onFailure(); }, this.#timeouts.operation);
        this.#pendingOperations.add(onFailure);
        try { this.#channel.write(data, "utf8", (error?: Error | null) => finish(error ? terminalUnknown() : undefined)); }
        catch { finish(terminalUnknown()); }
      });
    } finally {
      this.#inputBytes -= bytes;
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.assertActive();
    validateSize(cols, rows);
    try { this.#channel.setWindow(rows, cols, 0, 0); }
    catch { throw terminalUnknown(); }
  }

  async kill(): Promise<void> {
    if (this.#exit !== undefined) {
      if (this.#exit.processExitConfirmed === true) return;
      throw terminalUnknown();
    }
    if (this.#stopping !== undefined) return this.#stopping;
    this.#stopping = new Promise<void>((resolve, reject) => {
      const subscription = this.onExit((exit) => {
        clearTimeout(timer);
        subscription.dispose();
        if (exit.processExitConfirmed === true) resolve();
        else reject(terminalUnknown());
      });
      const timer = setTimeout(() => this.onFailure(), this.#timeouts.stop);
      try { if (this.#remoteExit === undefined) this.#channel.signal("TERM"); }
      catch { this.onFailure(); }
    });
    return this.#stopping;
  }

  pause(): void {
    this.#paused = true;
    this.#channel.pause();
    this.#channel.stderr.pause();
  }

  resume(): void {
    if (this.#exit !== undefined) return;
    this.#paused = false;
    this.flush();
    if (this.#exit === undefined && !this.#paused) {
      this.#channel.resume();
      this.#channel.stderr.resume();
    }
  }

  private assertActive(): void {
    if (this.#exit !== undefined || this.#remoteExit !== undefined || this.#stopping !== undefined) throw terminalUnavailable();
  }

  private readonly onStdout = (chunk: Buffer): void => this.receive(chunk, this.#stdoutDecoder);
  private readonly onStderr = (chunk: Buffer): void => this.receive(chunk, this.#stderrDecoder);
  private readonly onFailure = (): void => {
    if (this.#exit !== undefined) return;
    this.finish(this.#remoteExit === undefined
      ? { exitCode: 1, failureCode: "TERMINAL_UNKNOWN", processExitConfirmed: false }
      : { ...this.#remoteExit, failureCode: "TERMINAL_FAILED" });
  };
  private readonly onTransportFailure = (): void => { this.onFailure(); this.closeChannel(); };

  private receive(chunk: Buffer, decoder: StringDecoder): void {
    if (this.#exit !== undefined) return;
    this.#receiving += 1;
    try {
      for (let offset = 0; offset < chunk.length && this.#exit === undefined; offset += OUTPUT_CHUNK_BYTES) {
        this.enqueue(decoder.write(chunk.subarray(offset, offset + OUTPUT_CHUNK_BYTES)));
      }
    } finally { this.#receiving -= 1; this.maybeFinish(); }
  }

  private enqueue(data: string): void {
    if (this.#exit !== undefined || data.length === 0) return;
    const bytes = Buffer.byteLength(data, "utf8");
    if (this.#outputBytes + bytes > MAXIMUM_PENDING_OUTPUT_BYTES) { this.onFailure(); return; }
    this.#output.push(data);
    this.#outputBytes += bytes;
    this.flush();
  }

  private flush(): void {
    if (this.#flushing || this.#exit !== undefined) return;
    this.#flushing = true;
    try {
      while (!this.#paused && this.#dataListeners.size > 0 && this.#output.length > 0) {
        const data = this.#output.shift()!;
        this.#outputBytes -= Buffer.byteLength(data, "utf8");
        for (const listener of this.#dataListeners) listener(data);
      }
    } finally { this.#flushing = false; this.maybeFinish(); }
  }

  private maybeFinish(): void {
    if (this.#exit !== undefined || this.#endingDecoders || this.#flushing || this.#receiving > 0) return;
    if (this.#remoteExit === undefined) {
      if (this.#channelClosed) this.onFailure();
      return;
    }
    const outputEnded = (this.#stdoutEnded && this.#stderrEnded) ||
      (this.#channelClosed && this.#channel.readableLength === 0 && this.#channel.stderr.readableLength === 0);
    if (!outputEnded) return;
    if (!this.#decodersEnded) {
      this.#decodersEnded = true;
      this.#endingDecoders = true;
      try {
        this.enqueue(this.#stdoutDecoder.end());
        this.enqueue(this.#stderrDecoder.end());
      } finally { this.#endingDecoders = false; }
    }
    if (this.#output.length === 0) this.finish(this.#remoteExit);
  }

  private finish(exit: RemoteTerminalExit): void {
    if (this.#exit !== undefined && (this.#exit.processExitConfirmed === true || exit.processExitConfirmed !== true)) return;
    this.#exit = Object.freeze(exit);
    clearTimeout(this.#drainTimer);
    this.#output.length = 0;
    this.#outputBytes = 0;
    this.#channel.removeListener("data", this.onStdout);
    this.#channel.stderr.removeListener("data", this.onStderr);
    for (const fail of this.#pendingOperations) fail();
    for (const listener of this.#exitListeners) listener(this.#exit);
    if (this.#remoteExit === undefined) {
      try { this.#channel.signal("KILL"); } catch { /* The connection may already be gone. */ }
    }
    if (exit.processExitConfirmed !== true && !this.#channelClosed) {
      // Keep this exact channel available for a late exit-status. Its screen is
      // already incomplete; discard later output without retaining buffered data.
      this.#channel.resume();
      this.#channel.stderr.resume();
      return;
    }
    this.closeChannel();
  }

  private closeChannel(): void {
    this.#client.removeListener("close", this.onTransportFailure);
    this.#client.removeListener("error", this.onTransportFailure);
    try { this.#channel.close(); } catch { /* Cleanup cannot confirm remote exit. */ }
    this.#channel.destroy();
  }
}
