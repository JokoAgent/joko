import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { decodeMobileBase64 } from "./mobile-image-annotation";
import { inspectMobileImageGalleryBytes } from "./mobile-image-gallery";

export interface MobileConversationShareRendererHandle {
  exportPng(signal: AbortSignal): Promise<Uint8Array>;
}

export interface MobileConversationShareNativeRenderer {
  renderHtmlToPng(options: { readonly operationId: string; readonly html: string; readonly width: number; readonly scale: number }): Promise<unknown>;
  cancelRender(operationId: string): Promise<unknown>;
}

let sequence = 0;
export class MobileConversationShareHtmlRenderer {
  #pending?: object;
  constructor(
    private readonly native: MobileConversationShareNativeRenderer | null,
    private readonly platform: string,
    private readonly timeoutMs = 25_000
  ) {}
  get available(): boolean { return this.platform === "ios" && this.native !== null; }

  async renderHtml(html: string, width: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
    signal.throwIfAborted();
    if (!this.available) return undefined;
    if (this.#pending) throw new Error("A message image export is still active.");
    if (!Number.isFinite(width) || width < 280 || width > 720 || !html || html.length > 40 * 1_024 * 1_024) {
      throw new Error("The message image export is invalid.");
    }
    const token = {}; this.#pending = token;
    const operationId = "share-render-" + Date.now() + "-" + (++sequence);
    const retire = () => { if (this.#pending === token) this.#pending = undefined; };
    let raw: Promise<unknown>;
    try { raw = this.native!.renderHtmlToPng({ operationId, html, width, scale: 2 }); }
    catch (error) { retire(); throw error; }
    void raw.then(retire, retire);
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, bytes?: Uint8Array) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(bytes!);
      };
      const cancelNative = () => {
        try { void this.native!.cancelRender(operationId).then((ack) => { if (ack === true) retire(); }, () => {}); }
        catch { /* Keep the pending native operation fenced until it settles. */ }
      };
      const abort = () => { cancelNative(); finish(new Error("The message image export was cancelled.")); };
      const timeout = setTimeout(() => { cancelNative(); finish(new Error("The message image export timed out.")); }, this.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void raw.then((value) => {
        if (settled) return;
        try {
          signal.throwIfAborted();
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The native message image is invalid.");
          const result = value as Record<string, unknown>;
          if (Object.keys(result).length !== 2 || result["operationId"] !== operationId || typeof result["base64"] !== "string") {
            throw new Error("The native message image is invalid.");
          }
          const bytes = decodeMobileBase64(result["base64"], 20 * 1_024 * 1_024);
          const image = inspectMobileImageGalleryBytes(bytes, "image/png");
          if (image.width * image.height > 12_000_000) throw new Error("The selected messages are too large.");
          finish(undefined, bytes);
        } catch (error) { finish(error); }
      }, (error) => finish(error));
    });
  }
}

let native: MobileConversationShareNativeRenderer | null = null;
if (Platform.OS === "ios") {
  try { native = requireOptionalNativeModule<MobileConversationShareNativeRenderer>("JokoConversationShareRenderer"); }
  catch { /* Platforms without native HTML rendering use the SVG renderer. */ }
}
export const mobileConversationShareHtmlRenderer = new MobileConversationShareHtmlRenderer(native, Platform.OS);

export async function exportMobileConversationSharePng(input: {
  readonly renderer: MobileConversationShareHtmlRenderer;
  readonly html: () => string;
  readonly width: number;
  readonly fallback: (signal: AbortSignal) => Promise<Uint8Array>;
}, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (input.renderer.available) {
    try {
      const bytes = await input.renderer.renderHtml(input.html(), input.width, signal);
      signal.throwIfAborted();
      if (bytes) return bytes;
    } catch { signal.throwIfAborted(); }
  }
  signal.throwIfAborted();
  return input.fallback(signal);
}
