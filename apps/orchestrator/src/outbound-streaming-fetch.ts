import { createSocks5Dispatcher } from "@joko/outbound-network";
import { ProxyAgent, fetch as proxyFetch, type Dispatcher } from "undici";

export interface OutboundStreamingFetchOptions {
  readonly resolveProxy?: (target: string, options: { readonly signal?: AbortSignal }) => Promise<string | null | undefined> | string | null | undefined;
  readonly environmentProxyForTarget: (target: URL) => string | null | undefined;
}

/** A download keeps its proxy transport until its body is consumed or retired. */
export function createOutboundStreamingFetch(options: OutboundStreamingFetchOptions): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = input instanceof Request ? input.url : input.toString();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    const environmentProxy = options.environmentProxyForTarget(new URL(target));
    const proxy = environmentProxy === undefined
      ? await withAbort(options.resolveProxy?.(target, { ...(signal == null ? {} : { signal }) }), signal)
      : environmentProxy;
    signal?.throwIfAborted();
    if (proxy === undefined || proxy === null || proxy === "") return await fetch(input, init);
    const protocol = new URL(proxy).protocol;
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(protocol)) {
      throw new Error("The outbound proxy protocol is unsupported.");
    }
    const dispatcher: Dispatcher = protocol === "socks5:" || protocol === "socks5h:"
      ? createSocks5Dispatcher(proxy)
      : new ProxyAgent(proxy);
    let upstream: Awaited<ReturnType<typeof proxyFetch>>;
    try {
      upstream = await proxyFetch(input as Parameters<typeof proxyFetch>[0], {
        ...(init as Parameters<typeof proxyFetch>[1]), dispatcher
      });
    } catch (error) {
      await dispatcher.close().catch(() => undefined);
      throw error;
    }
    if (upstream.body === null) {
      await dispatcher.close().catch(() => undefined);
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers as unknown as HeadersInit });
    }
    const reader = upstream.body.getReader();
    let settled = false;
    const settle = async () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
      await dispatcher.close().catch(() => undefined);
    };
    const abort = () => { void reader.cancel(signal?.reason).catch(() => undefined).finally(settle); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (signal?.aborted) signal.throwIfAborted();
          if (chunk.done) { controller.close(); await settle(); }
          else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          await settle();
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
        await settle();
      }
    }, { highWaterMark: 0 });
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers as unknown as HeadersInit });
  }) as typeof fetch;
}

async function withAbort<T>(value: T | PromiseLike<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal == null) return await value;
  signal.throwIfAborted();
  let retire!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    retire = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Outbound proxy resolution was aborted."));
    signal.addEventListener("abort", retire, { once: true });
  });
  try { return await Promise.race([Promise.resolve(value), aborted]); }
  finally { signal.removeEventListener("abort", retire); }
}
