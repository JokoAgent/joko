// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MobilePendingSendBubble } from "./MobilePendingSendBubble";
import { plainTextMobileComposerDraft } from "./mobile-composer-document";
import type { MobilePendingSendProgress } from "./mobile-pending-send";
import type { MobileAttachmentFiles, MobileVerifiedOwnedBytes } from "./mobile-attachment-files";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, style, accessibilityLabel, source }: { children?: ReactNode; style?: unknown; accessibilityLabel?: string; source?: { uri: string } }) =>
    React.createElement(tag, { "aria-label": accessibilityLabel, ...(source ? { src: source.uri } : {}), style: Object.assign({}, ...[style].flat()) }, children);
  return { Text: element("span"), View: element("div"), Image: element("img"), ActivityIndicator: () => React.createElement("i", { "data-status": "busy" }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    AppState: { get currentState() { return native.state; }, addEventListener: (_type: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } } };
});
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(() => root!.unmount()); host?.remove(); root = undefined; native.state = "active"; native.listeners.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows the original body immediately, delays transient status and marks only the image whose upload failed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers(); vi.setSystemTime(2_000);
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const files: Pick<MobileAttachmentFiles, "readOwnedBytes"> = { readOwnedBytes: vi.fn(async () => ({ uri: "file:///private/original.png", byteSize: 1, sha256Hex: "a".repeat(64), bytes: Uint8Array.of(1) })) };
  const attachments = ["one", "two"].map(attachmentId => ({ attachmentId, state: "local" as const, kind: "image" as const,
    fileName: `${attachmentId}.png`, mediaType: "image/png", byteSize: 1, sha256Hex: "a".repeat(64), capturedAtUnixMs: 1_000 }));
  const progress: MobilePendingSendProgress = { phase: "preparing", sentAt: 2_000, input: { ...plainTextMobileComposerDraft("Original message"), attachments } };
  const render = (value: MobilePendingSendProgress) => act(() => root!.render(createElement(MobilePendingSendBubble, { progress: value,
    files, profileId: "original-profile", locale: "en", colors: { ink: "#111", muted: "#777", accent: "#f90", border: "#ddd", brandBackground: "#ffe", negative: "#bb0000" } })));
  await render(progress);
  expect(host.textContent).toContain("Original message"); expect(host.textContent).not.toContain("Preparing");
  expect(files.readOwnedBytes).toHaveBeenCalledWith("original-profile", "one", 1, "a".repeat(64));
  await act(() => vi.advanceTimersByTimeAsync(301)); expect(host.querySelector('[data-status="busy"]')).not.toBeNull();
  await render({ ...progress, phase: "failed", attachmentId: "two", error: "Upload unavailable" });
  const first = Array.from(host.querySelectorAll("span")).find(node => node.textContent === "one.png")!;
  const second = Array.from(host.querySelectorAll("span")).find(node => node.textContent === "two.png")!;
  expect(first.style.color).toBe("rgb(17, 17, 17)"); expect(second.style.color).toBe("rgb(187, 0, 0)");
  expect(second.parentElement?.textContent).toContain("Upload failed"); expect(first.parentElement?.textContent).not.toContain("Upload failed");
  expect(host.textContent).toContain("Upload unavailable");
});

it("does not materialize a late private image after the phone enters background", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  let finish!: (value: MobileVerifiedOwnedBytes) => void;
  const files: Pick<MobileAttachmentFiles, "readOwnedBytes"> = { readOwnedBytes: vi.fn(() => new Promise<MobileVerifiedOwnedBytes>(resolve => { finish = resolve; })) };
  const progress: MobilePendingSendProgress = { phase: "uploading", sentAt: Date.now(), attachmentId: "image", input: { ...plainTextMobileComposerDraft(""), attachments: [{
    attachmentId: "image", state: "local", kind: "image", fileName: "private.png", mediaType: "image/png", byteSize: 1, sha256Hex: "a".repeat(64), capturedAtUnixMs: 1_000 }] } };
  await act(() => root!.render(createElement(MobilePendingSendBubble, { progress, files, profileId: "original-profile", locale: "en",
    colors: { ink: "#111", muted: "#777", accent: "#f90", border: "#ddd", brandBackground: "#ffe", negative: "#b00" } })));
  await act(() => { native.state = "background"; native.listeners.forEach(listener => listener("background")); });
  await act(() => finish({ uri: "file:///private/late.png", byteSize: 1, sha256Hex: "a".repeat(64), bytes: Uint8Array.of(1) }));
  expect(host.querySelector("img")).toBeNull(); expect(host.textContent).toContain("private.png");
});
