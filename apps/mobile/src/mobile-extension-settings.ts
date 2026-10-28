import { parseExtensionSettingsBridgeRequest, type ExtensionSettingsHost, type ExtensionSettingsCall } from "@joko/contracts";
import type { MobileExtensionMainViewSurface, MobileExtensionTransport } from "./mobile-extensions";

export type MobileExtensionSettingsHost = ExtensionSettingsHost;

/** One document occurrence owns all requests; an unknown effect faults this
 * bridge until the user checks its original operation in the native UI. */
export class MobileExtensionSettingsBridge {
  readonly #seen = new Set<string>();
  readonly #pending = new Set<AbortController>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #faulted = false;
  constructor(private readonly options: { readonly surface: MobileExtensionMainViewSurface; readonly frameId: string;
    readonly documentUrl: string; readonly transport: MobileExtensionTransport; readonly host: MobileExtensionSettingsHost;
    readonly current: () => boolean; readonly foreground: () => boolean; readonly send: (message: string) => void }) {}
  receive(raw: string, url: string): void {
    if (this.#closed || !this.options.current() || !this.options.foreground() || raw.length > 96 * 1024) return;
    try { const candidate = new URL(url); candidate.hash = ""; if (candidate.href !== this.options.documentUrl) return; } catch { return; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const wrapper = value as Record<string, unknown>;
    if (Object.keys(wrapper).length !== 3 || wrapper.frameId !== this.options.frameId || wrapper.surfaceId !== this.options.surface.surfaceId) return;
    const request = parseExtensionSettingsBridgeRequest(wrapper.request);
    if (!request || this.#seen.has(request.id) || this.#seen.size >= 4096 || this.#pending.size >= 16) return;
    this.#seen.add(request.id);
    const send = (result: unknown, ok: boolean) => {
      if (this.#closed || !this.options.current() || !this.options.foreground()) return;
      const reply = JSON.stringify({ frameId: this.options.frameId, surfaceId: this.options.surface.surfaceId,
        response: { type: "joko:extension-settings-response", version: 1, id: request.id, ok,
          ...(ok ? { result } : { message: "Settings request could not be confirmed. Check its original operation before retrying." }) } },
      (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
      if (reply.length > 192 * 1024) throw new Error("Settings response exceeds its limit.");
      this.options.send(reply);
    };
    if (this.#faulted) { send(undefined, false); return; }
    const abort = new AbortController(); this.#pending.add(abort);
    const timer = setTimeout(() => abort.abort(), request.command.kind === "oauth.connect" ? 310_000 : 60_000);
    let dispatched = false;
    const work = this.#queue.then(async () => {
      abort.signal.throwIfAborted();
      if (this.#closed || this.#faulted || !this.options.current() || !this.options.foreground() || !this.options.transport.callSettings) throw new Error("Settings retired.");
      dispatched = true;
      return this.options.transport.callSettings(this.options.surface, request.command, this.options.host, abort.signal);
    });
    const stopped = new Promise<never>((_resolve, reject) => abort.signal.addEventListener("abort", () => reject(new Error("Settings request retired.")), { once: true }));
    const completion = Promise.race([work, stopped]); this.#queue = completion.catch(() => undefined);
    void completion.then(result => send(result, true), () => {
      // Reads and validation have no product effects and remain retryable.
      if (dispatched && !["routing.get", "setup.get", "oauth.get", "connections.get", "secret.check", "library.open"].includes(request.command.kind)) this.#faulted = true;
      send(undefined, false);
    }).catch(() => { this.#faulted = true; }).finally(() => { clearTimeout(timer); abort.abort(); this.#pending.delete(abort); });
  }
  dispose(): void { this.#closed = true; for (const request of this.#pending) request.abort(); this.#pending.clear(); }
}

const BOOTSTRAP = String.raw`function(frameId, surfaceId) {
  var marker = Symbol.for("joko.extension-settings-mobile.transport");
  if (window !== window.top || !window.ReactNativeWebView || window[marker]) return;
  Object.defineProperty(window, marker, { value: true });
  var seen = new Set(), closed = false;
  function receive(event) {
    if (closed || typeof event.data !== "string" || event.data.length > 196608) return;
    var value; try { value = JSON.parse(event.data); } catch (_) { return; }
    if (!value || value.frameId !== frameId || value.surfaceId !== surfaceId || !value.response
      || value.response.type !== "joko:extension-settings-response" || value.response.version !== 1 || typeof value.response.id !== "string" || seen.has(value.response.id)) return;
    seen.add(value.response.id);
    window.dispatchEvent(new MessageEvent("message", { data: value.response, source: window, origin: location.origin }));
  }
  function forward(event) {
    var request = event.data;
    if (closed || event.source !== window || event.origin !== location.origin || !request
      || request.type !== "joko:extension-settings-request" || request.version !== 1) return;
    var json = JSON.stringify({ frameId: frameId, surfaceId: surfaceId, request: request });
    if (json.length <= 98304) window.ReactNativeWebView.postMessage(json);
  }
  addEventListener("message", receive); document.addEventListener("message", receive); addEventListener("message", forward);
  addEventListener("pagehide", function() { closed = true; seen.clear(); removeEventListener("message", receive); document.removeEventListener("message", receive); removeEventListener("message", forward); }, { once: true });
  dispatchEvent(new Event("joko:extension-settings-ready"));
}`;
export function mobileExtensionSettingsBootstrap(frameId: string, surfaceId: string): string {
  return `(${BOOTSTRAP})(${JSON.stringify(frameId)},${JSON.stringify(surfaceId)});true;`;
}

export type { ExtensionSettingsCall };
