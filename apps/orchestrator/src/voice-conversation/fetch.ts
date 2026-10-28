import { createSocks5Dispatcher } from '@joko/outbound-network';
import { ProxyAgent, fetch as proxyFetch, type Dispatcher } from 'undici';

/** Retain the original proxy dispatcher until this exact streaming response
 * reaches EOF or is cancelled. Credentials never follow redirects. */
export function createSpeechFetch(resolveProxy: (url: string, signal?: AbortSignal) => Promise<string | null | undefined>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString(), signal = init?.signal ?? undefined;
    const proxy = await abortable(resolveProxy(url, signal), signal); signal?.throwIfAborted();
    let dispatcher: Dispatcher | undefined;
    if (proxy) dispatcher = ['socks5:', 'socks5h:'].includes(new URL(proxy).protocol) ? createSocks5Dispatcher(proxy) : new ProxyAgent(proxy);
    let response: Response;
    try {
      response = dispatcher ? await proxyFetch(input as Parameters<typeof proxyFetch>[0], { ...(init as Parameters<typeof proxyFetch>[1]), redirect: 'error', dispatcher }) as unknown as Response
        : await fetch(input, { ...init, redirect: 'error' });
    } catch (error) { void dispatcher?.destroy().catch(() => undefined); throw error; }
    const reader = response.body?.getReader();
    let total = 0, closed = false;
    const close = (cancelled: boolean) => {
      if (closed) return; closed = true; signal?.removeEventListener('abort', abort);
      if (cancelled) { void reader?.cancel().catch(() => undefined); void dispatcher?.destroy().catch(() => undefined); }
      else { try { reader?.releaseLock(); } catch {} void dispatcher?.close().catch(() => undefined); }
    };
    const abort = () => close(true); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { close(true); signal.throwIfAborted(); }
    const maximum = 64 * 1024 * 1024, declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximum) { close(true); throw new Error('Speech response exceeded its limit.'); }
    if (!reader) { close(false); return response; }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal?.throwIfAborted(); const result = await reader.read(); signal?.throwIfAborted();
          if (result.done) { close(false); controller.close(); return; }
          total += result.value.byteLength;
          if (total > maximum || result.value.byteLength > 2 * 1024 * 1024) throw new Error('Speech response exceeded its limit.');
          controller.enqueue(result.value);
        } catch (error) { close(true); controller.error(error); }
      }, cancel: () => close(true)
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
}

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([work, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
