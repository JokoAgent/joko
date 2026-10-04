import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileConversationShareHtmlRenderer, exportMobileConversationSharePng, type MobileConversationShareNativeRenderer } from "./mobile-conversation-share-export";

vi.mock("expo", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const png = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("native rich conversation image rendering", () => {
  it("correlates and validates a native PNG, and uses SVG only when HTML rendering is unavailable or fails", async () => {
    const native = { renderHtmlToPng: vi.fn(async ({ operationId }) => ({ operationId, base64 })), cancelRender: vi.fn(async () => true) } satisfies MobileConversationShareNativeRenderer;
    const renderer = new MobileConversationShareHtmlRenderer(native, "ios");
    const fallback = vi.fn(async () => png); const html = vi.fn(() => "<html>message</html>");
    await expect(exportMobileConversationSharePng({ renderer, html, width: 390, fallback }, signal())).resolves.toEqual(png);
    expect(fallback).not.toHaveBeenCalled(); expect(native.renderHtmlToPng).toHaveBeenCalledTimes(1);
    native.renderHtmlToPng.mockRejectedValueOnce(new Error("web content process ended"));
    await expect(exportMobileConversationSharePng({ renderer, html, width: 390, fallback }, signal())).resolves.toEqual(png);
    expect(fallback).toHaveBeenCalledTimes(1);
    html.mockClear();
    await exportMobileConversationSharePng({ renderer: new MobileConversationShareHtmlRenderer(native, "android"), html, width: 390, fallback }, signal());
    expect(html).not.toHaveBeenCalled(); expect(native.renderHtmlToPng).toHaveBeenCalledTimes(2);
  });

  it("keeps a cancelled native operation fenced until completion or a cancellation acknowledgement, ignoring late pixels", async () => {
    let finish!: (value: unknown) => void; let id = "";
    const native = { renderHtmlToPng: vi.fn(({ operationId }) => { id = operationId; return new Promise((resolve) => { finish = resolve; }); }),
      cancelRender: vi.fn(async () => false) } satisfies MobileConversationShareNativeRenderer;
    const renderer = new MobileConversationShareHtmlRenderer(native, "ios"); const controller = new AbortController();
    const fallback = vi.fn(async () => png);
    const work = exportMobileConversationSharePng({ renderer, html: () => "<html/>", width: 390, fallback }, controller.signal);
    const failure = expect(work).rejects.toThrow(); controller.abort(); await failure;
    expect(native.cancelRender).toHaveBeenCalledWith(id); expect(fallback).not.toHaveBeenCalled();
    await expect(renderer.renderHtml("<html/>", 390, signal())).rejects.toThrow(/still active/u);
    finish({ operationId: id, base64 }); await Promise.resolve(); await Promise.resolve();
    expect(fallback).not.toHaveBeenCalled(); expect(native.renderHtmlToPng).toHaveBeenCalledTimes(1);
    native.renderHtmlToPng.mockImplementationOnce(async ({ operationId }) => ({ operationId, base64 }));
    await expect(renderer.renderHtml("<html/>", 390, signal())).resolves.toEqual(png);
  });

  it("requests native cleanup after a deadline and falls back once without waiting for a lost native response", async () => {
    vi.useFakeTimers();
    const native = { renderHtmlToPng: vi.fn<MobileConversationShareNativeRenderer["renderHtmlToPng"]>(() => new Promise(() => {})), cancelRender: vi.fn(async () => true) } satisfies MobileConversationShareNativeRenderer;
    const renderer = new MobileConversationShareHtmlRenderer(native, "ios", 100);
    const fallback = vi.fn(async () => png);
    const work = exportMobileConversationSharePng({ renderer, html: () => "<html/>", width: 390, fallback }, signal());
    await vi.advanceTimersByTimeAsync(101);
    await expect(work).resolves.toEqual(png); expect(fallback).toHaveBeenCalledTimes(1);
    expect(native.cancelRender).toHaveBeenCalledTimes(1);
    native.renderHtmlToPng.mockImplementationOnce(async ({ operationId }) => ({ operationId, base64 }));
    await expect(renderer.renderHtml("<html/>", 390, signal())).resolves.toEqual(png);
  });

  it.each(["wrong operation", "malformed PNG", "additional response fields"])("rejects %s before publishing any image", async (kind) => {
    const native: MobileConversationShareNativeRenderer = { renderHtmlToPng: async ({ operationId }) =>
      kind === "wrong operation" ? { operationId: "other", base64 } : kind === "malformed PNG" ? { operationId, base64: "AAAA" } : { operationId, base64, extra: true },
      cancelRender: async () => true };
    await expect(new MobileConversationShareHtmlRenderer(native, "ios").renderHtml("<html/>", 390, signal())).rejects.toThrow(/invalid/u);
  });
});
