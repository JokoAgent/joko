import type { McpAppBrowserSurface } from "./model.js";
import { mountIsolatedSurface } from "./isolated-surface.js";

/** The trusted client owns the private transport; the opaque App receives only
 * standard MCP messages, its approved document and its resource policy. */
export function mountBrowserMcpSurface(frame: HTMLIFrameElement, opening: Promise<McpAppBrowserSurface>, options: {
  readonly signal: AbortSignal;
  readonly failed: () => void;
  readonly present: (message: { method?: string; params?: { height?: number; displayMode?: string } }) => void;
  readonly openLink: (url: string) => Promise<void>;
}): () => void {
  const owner = frame.ownerDocument.defaultView!;
  let surface: McpAppBrowserSurface | undefined, stopped = false, after = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const live = () => !stopped && !options.signal.aborted && frame.isConnected;
  const fail = () => { if (live()) options.failed(); };
  const presentation = (message: unknown, host: boolean) => {
    if (!live() || message === null || typeof message !== "object") return;
    const value = message as { method?: string; params?: { height?: number; displayMode?: string } };
    if (["ui/notifications/initialized", "ui/notifications/size-changed"].includes(value.method ?? "")
      || host && value.method === "ui/notifications/host-context-changed") options.present(value);
  };
  const onMessage = (event: MessageEvent) => {
    if (!live() || surface === undefined || event.source !== frame.contentWindow || event.origin !== "null") return;
    const message = event.data as { jsonrpc?: unknown; method?: unknown } | null;
    if (!message || message.jsonrpc !== "2.0" || typeof message.method === "string" && message.method.startsWith("ui/notifications/sandbox-")) return;
    presentation(message, false);
    void surface.invoke({ op: "message", message }).catch(fail);
  };
  owner.addEventListener("message", onMessage);
  const poll = async () => {
    while (live() && surface !== undefined) {
      const result = await surface.invoke({ op: "poll", after });
      if (!live()) return;
      if (!Array.isArray(result) || result.length > 4096) throw new Error("Invalid application events.");
      for (const event of result as Array<{ seq: number; message?: unknown; openLink?: { id: string; url: string } }>) {
        if (!live()) return;
        if (!Number.isSafeInteger(event.seq) || event.seq <= after) continue;
        after = event.seq;
        if (event.openLink) {
          const link = event.openLink;
          const start = performance.now();
          let success = false;
          try {
            const grant = await surface.invoke({ op: "open-link", linkId: link.id, url: link.url }) as { validForMs?: number; url?: string };
            if (live() && typeof grant.validForMs === "number" && performance.now() - start < grant.validForMs && grant.url === link.url) {
              await options.openLink(grant.url); success = true;
            }
          } catch { /* The original host receives a failed link receipt. */ }
          if (live()) await surface.invoke({ op: "link-result", linkId: link.id, success });
        } else {
          presentation(event.message, true);
          if (live()) frame.contentWindow?.postMessage(event.message, "*");
        }
      }
      if (!result.length && live()) await new Promise<void>(resolve => { timer = setTimeout(resolve, 250); });
    }
  };
  const loaded = opening.then(value => { if (!live()) throw new Error("Application surface retired."); surface = value; return { html: value.html, policy: value.policy }; });
  const disposeDocument = mountIsolatedSurface(frame, loaded, { signal: options.signal, failed: fail });
  void loaded.then(() => poll()).catch(fail);
  const dispose = () => { stopped = true; surface = undefined; if (timer !== undefined) clearTimeout(timer); disposeDocument(); owner.removeEventListener("message", onMessage); options.signal.removeEventListener("abort", dispose); };
  options.signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
