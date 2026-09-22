import { Worker, type WorkerOptions } from "node:worker_threads";

import {
  isContactSyncCipherChunkFrame,
  isContactSyncStateMessage,
  type ContactSyncCipherChunkFrame,
  type ContactSyncCodec,
  type ContactSyncDecodeOptions,
  type ContactSyncEncodeOptions,
  type ContactSyncStateMessage
} from "./contact-sync-wire.js";

export type ContactSyncCodecWorkerRequest =
  | { readonly id: number; readonly operation: "encode"; readonly options: ContactSyncEncodeOptions }
  | { readonly id: number; readonly operation: "decode"; readonly options: ContactSyncDecodeOptions };

export type ContactSyncCodecWorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: string };

interface PendingCall {
  readonly operation: "encode" | "decode";
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly removeAbortListener: () => void;
}

export class ContactSyncWorkerCodec implements ContactSyncCodec {
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
      throw new TypeError("Contacts sync codec timeout is invalid.");
    }
    this.#workerFactory = options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions));
  }

  async encode(options: ContactSyncEncodeOptions, signal?: AbortSignal): Promise<readonly ContactSyncCipherChunkFrame[]> {
    const value = await this.#call("encode", options, signal);
    if (!Array.isArray(value) || value.length < 1 || !value.every(isContactSyncCipherChunkFrame)) {
      this.reset();
      throw new Error("Contacts sync codec worker returned invalid frames.");
    }
    return value;
  }

  async decode(options: ContactSyncDecodeOptions, signal?: AbortSignal): Promise<ContactSyncStateMessage> {
    const value = await this.#call("decode", options, signal);
    if (!isContactSyncStateMessage(value)) {
      this.reset();
      throw new Error("Contacts sync codec worker returned an invalid payload.");
    }
    return value;
  }

  reset(): void {
    const worker = this.#worker;
    if (worker !== undefined) this.#retire(worker, new Error("Contacts sync codec authority was reset."));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const worker = this.#worker;
    if (worker !== undefined) this.#retire(worker, new Error("Contacts sync codec is closed."));
  }

  #call(operation: "encode" | "decode", options: ContactSyncEncodeOptions | ContactSyncDecodeOptions,
    signal: AbortSignal | undefined): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Contacts sync codec is closed."));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const worker = this.#ensureWorker();
    const id = this.#nextRequestId++;
    const request = { id, operation, options } as ContactSyncCodecWorkerRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        const error = new Error("Contacts sync codec exceeded its execution deadline.");
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
        this.#retire(worker, error instanceof Error ? error : new Error("Contacts sync codec request failed."));
      }
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker !== undefined) return this.#worker;
    const sourceRuntime = import.meta.url.endsWith(".ts");
    const url = new URL(sourceRuntime ? "./contact-sync-codec-worker.ts" : "./contact-sync-codec-worker.js", import.meta.url);
    const worker = this.#workerFactory(url, {
      execArgv: sourceRuntime ? ["--import", "tsx"] : [],
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    this.#worker = worker;
    worker.on("message", (value: unknown) => this.#receive(worker, value));
    worker.on("error", () => this.#retire(worker, new Error("Contacts sync codec worker failed.")));
    worker.on("exit", (code) => {
      if (this.#worker === worker) this.#retire(worker, new Error(code === 0
        ? "Contacts sync codec worker exited." : "Contacts sync codec worker exited unexpectedly."));
    });
    return worker;
  }

  #receive(worker: Worker, value: unknown): void {
    if (this.#worker !== worker || !isWorkerReply(value)) {
      this.#retire(worker, new Error("Contacts sync codec worker returned an invalid response."));
      return;
    }
    const pending = this.#pending.get(value.id);
    if (pending === undefined) return;
    this.#pending.delete(value.id);
    clearTimeout(pending.timer);
    pending.removeAbortListener();
    if (value.ok) pending.resolve(value.value);
    else pending.reject(new Error(value.error));
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

function isWorkerReply(value: unknown): value is ContactSyncCodecWorkerReply {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reply = value as Record<string, unknown>;
  return Number.isSafeInteger(reply["id"]) && (reply["id"] as number) >= 1 && typeof reply["ok"] === "boolean" &&
    (reply["ok"] === true ? Object.hasOwn(reply, "value") : typeof reply["error"] === "string" && reply["error"].length <= 4_096);
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Contacts sync codec was cancelled.");
}
