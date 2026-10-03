import { Worker, type WorkerOptions } from "node:worker_threads";

import { isNodeSyncCipherChunkFrame, type NodeSyncCipherChunkFrame } from "@joko/node-sync";

import {
  isVoiceDictionaryPeerMessage,
  VOICE_DICTIONARY_PEER_MAX_CHUNKS,
  VOICE_DICTIONARY_PEER_FRAME_BYTES,
  type VoiceDictionaryPeerCodec,
  type VoiceDictionaryPeerDecodeOptions,
  type VoiceDictionaryPeerEncodeOptions,
  type VoiceDictionaryPeerMessage
} from "./voice-dictionary-sync-wire.js";

export type VoiceDictionaryPeerCodecWorkerRequest =
  | { readonly id: number; readonly operation: "encode"; readonly options: VoiceDictionaryPeerEncodeOptions }
  | { readonly id: number; readonly operation: "decode"; readonly options: VoiceDictionaryPeerDecodeOptions };

export type VoiceDictionaryPeerCodecWorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

interface PendingCall {
  readonly operation: "encode" | "decode";
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbortListener: () => void;
}

export class VoiceDictionaryPeerWorkerCodec implements VoiceDictionaryPeerCodec {
  readonly #workerFactory: (url: URL, options: WorkerOptions) => Worker;
  readonly #timeoutMilliseconds: number;
  readonly #pending = new Map<number, PendingCall>();
  #worker?: Worker;
  #nextRequestId = 1;
  #closed = false;

  constructor(options: {
    readonly timeoutMilliseconds?: number;
    readonly workerFactory?: (url: URL, options: WorkerOptions) => Worker;
  } = {}) {
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds) || this.#timeoutMilliseconds < 1_000 || this.#timeoutMilliseconds > 120_000) {
      throw new TypeError("Voice dictionary peer codec timeout is invalid.");
    }
    this.#workerFactory = options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
  }

  async encode(options: VoiceDictionaryPeerEncodeOptions, signal?: AbortSignal): Promise<readonly NodeSyncCipherChunkFrame[]> {
    const value = await this.#call("encode", options, signal);
    if (!Array.isArray(value) || value.length < 1 || value.length > VOICE_DICTIONARY_PEER_MAX_CHUNKS || !value.every(isNodeSyncCipherChunkFrame) ||
      value.reduce((bytes, frame) => bytes + Buffer.byteLength(JSON.stringify(frame), "utf8"), 0) > VOICE_DICTIONARY_PEER_FRAME_BYTES) {
      this.reset();
      throw new Error("Voice dictionary peer codec worker returned invalid frames.");
    }
    return value;
  }

  async decode(options: VoiceDictionaryPeerDecodeOptions, signal?: AbortSignal): Promise<VoiceDictionaryPeerMessage> {
    const value = await this.#call("decode", options, signal);
    if (!isVoiceDictionaryPeerMessage(value)) {
      this.reset();
      throw new Error("Voice dictionary peer codec worker returned an invalid payload.");
    }
    return value;
  }

  reset(): void {
    const worker = this.#worker;
    if (worker !== undefined) this.#retire(worker, new Error("Voice dictionary peer codec authority was reset."));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const worker = this.#worker;
    if (worker !== undefined) this.#retire(worker, new Error("Voice dictionary peer codec is closed."));
  }

  #call(operation: "encode" | "decode", options: VoiceDictionaryPeerEncodeOptions | VoiceDictionaryPeerDecodeOptions,
    signal: AbortSignal | undefined): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Voice dictionary peer codec is closed."));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.#pending.size >= 16) return Promise.reject(new Error("Voice dictionary peer codec capacity is exhausted."));
    const worker = this.#ensureWorker();
    const id = this.#nextRequestId++;
    const request = { id, operation, options } as VoiceDictionaryPeerCodecWorkerRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        const error = new Error("Voice dictionary peer codec exceeded its execution deadline.");
        this.#retire(worker, error);
      }, this.#timeoutMilliseconds);
      timer.unref?.();
      const abort = (): void => this.#retire(worker, abortError(signal));
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        operation,
        resolve,
        reject,
        timer,
        removeAbortListener: () => signal?.removeEventListener("abort", abort)
      });
      try {
        worker.postMessage(request);
      } catch (error) {
        this.#retire(worker, error instanceof Error ? error : new Error("Voice dictionary peer codec request failed."));
      }
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    const sourceRuntime = import.meta.url.endsWith(".ts");
    const url = new URL(sourceRuntime ? "./voice-dictionary-sync-codec-worker.ts" : "./voice-dictionary-sync-codec-worker.js", import.meta.url);
    const worker = this.#workerFactory(url, {
      execArgv: sourceRuntime ? ["--import", "tsx"] : [],
      resourceLimits: { maxOldGenerationSizeMb: 128 }
    });
    this.#worker = worker;
    worker.on("message", (value: unknown) => this.#receive(worker, value));
    worker.on("error", () => this.#retire(worker, new Error("Voice dictionary peer codec worker failed.")));
    worker.on("exit", (code) => {
      if (this.#worker === worker) this.#retire(worker, new Error(code === 0
        ? "Voice dictionary peer codec worker exited." : "Voice dictionary peer codec worker exited unexpectedly."));
    });
    return worker;
  }

  #receive(worker: Worker, value: unknown): void {
    if (this.#worker !== worker || !isWorkerReply(value)) {
      this.#retire(worker, new Error("Voice dictionary peer codec worker returned an invalid response."));
      return;
    }
    const pending = this.#pending.get(value.id);
    if (pending === undefined) return;
    this.#pending.delete(value.id);
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    if (value.ok) pending.resolve(value.value);
    else pending.reject(new Error("Voice dictionary peer codec operation failed."));
  }

  #retire(worker: Worker, error: Error): void {
    if (this.#worker !== worker) return;
    this.#worker = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.#pending.clear();
    worker.unref();
    void worker.terminate().catch(() => undefined);
  }
}

function isWorkerReply(value: unknown): value is VoiceDictionaryPeerCodecWorkerReply {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reply = value as Record<string, unknown>;
  return Number.isSafeInteger(reply["id"]) && (reply["id"] as number) >= 1 && typeof reply["ok"] === "boolean" &&
    (reply["ok"] === true ? Object.hasOwn(reply, "value") : typeof reply["error"] === "string" && reply["error"].length <= 4_096);
}

function abortError(signal: AbortSignal | undefined): Error {
  return new Error("Voice dictionary peer codec was cancelled.");
}
