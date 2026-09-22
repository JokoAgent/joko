import { Worker } from "node:worker_threads";

import { weChatCancelled, weChatMalformed } from "./errors.js";

const DECODE_TIMEOUT_MS = 30_000;

export interface WeChatVoiceDecoderOptions {
  readonly createWorker?: (url: URL, options: ConstructorParameters<typeof Worker>[1]) => Worker;
  readonly timeoutMs?: number;
}

export async function decodeWeChatSilk(bytes: Uint8Array, signal: AbortSignal, options: WeChatVoiceDecoderOptions = {}): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (bytes.byteLength < 1 || bytes.byteLength > 5 * 1_024 * 1_024) throw weChatMalformed("WeChat voice size is invalid.", false);
  const sourceRuntime = import.meta.url.endsWith(".ts");
  const url = new URL(sourceRuntime ? "./silk-worker.ts" : "./silk-worker.js", import.meta.url);
  const createWorker = options.createWorker ?? ((target, input) => new Worker(target, input));
  const worker = createWorker(url, {
    execArgv: sourceRuntime ? ["--import", "tsx"] : [],
    resourceLimits: { maxOldGenerationSizeMb: 128 }
  });
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: Uint8Array | Error): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        worker.removeListener("message", onMessage);
        worker.removeListener("error", onError);
        worker.removeListener("exit", onExit);
        if (result instanceof Error) reject(result); else resolve(result);
      };
      const onAbort = (): void => finish(weChatCancelled());
      const onMessage = (response: unknown): void => {
        if (isSuccess(response)) finish(new Uint8Array(response.bytes));
        else finish(weChatMalformed("WeChat voice could not be decoded.", false));
      };
      const onError = (): void => finish(weChatMalformed("WeChat voice decoder failed.", false));
      const onExit = (): void => finish(weChatMalformed("WeChat voice decoder exited.", false));
      const timeout = options.timeoutMs ?? DECODE_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > DECODE_TIMEOUT_MS) {
        finish(weChatMalformed("WeChat voice decoder timeout is invalid.", false));
        return;
      }
      timer = setTimeout(() => finish(weChatMalformed("WeChat voice decoder timed out.", false)), timeout);
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", onExit);
      const copy = Uint8Array.from(bytes);
      worker.postMessage({ bytes: copy.buffer }, [copy.buffer]);
    });
  } finally {
    worker.unref();
    await worker.terminate().catch(() => undefined);
  }
}

function isSuccess(value: unknown): value is { readonly ok: true; readonly bytes: ArrayBuffer } {
  return value !== null && typeof value === "object" && "ok" in value && value.ok === true
    && "bytes" in value && value.bytes instanceof ArrayBuffer
    && value.bytes.byteLength >= 44 && value.bytes.byteLength <= 20 * 1_024 * 1_024;
}
