// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileClient } from "./mobile-client";
import type { MobileFilePreview } from "./workspace-files";
const native = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: (_name: string, listener: (state: string) => void) => {
  native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
} } }));
import { useMobileAudioArtwork } from "./use-mobile-audio-artwork";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; native.listeners.clear(); vi.useRealTimers(); });
describe("independent mobile audio artwork reads", () => {
  it("retires late cover reads on source/background, restores independently and bounds a hanging read", async () => {
    vi.useFakeTimers();
    const preview = { kind: "media", mediaKind: "audio", leaseId: "audio", audioMetadata: { kind: "music", title: "Track", description: "",
      artwork: { blob: { blobId: "cover", byteSize: 4n, mediaType: "image/png", sha256Hex: "a".repeat(64), fileName: "cover.png" }, width: 3, height: 2, alt: "Cover" } } } as Extract<MobileFilePreview, { kind: "media" }>;
    let owner = "one";
    const requests: { signal: AbortSignal; resolve: (value: { uri: string; width: number; height: number }) => void }[] = [];
    const client = { audioPreviewOwnerKey: () => owner, readAudioArtwork: vi.fn((_preview, signal: AbortSignal) =>
      new Promise<{ uri: string; width: number; height: number }>((resolve) => requests.push({ signal, resolve }))) } as unknown as MobileClient;
    let result!: ReturnType<typeof useMobileAudioArtwork>;
    function Surface() { result = useMobileAudioArtwork(client, preview); return createElement("span", {}, result.artwork.state); }
    root = createRoot(document.createElement("div"));
    await act(async () => { root!.render(createElement(Surface)); });
    expect(result.artwork.state).toBe("loading");
    owner = "two"; await act(async () => { root!.render(createElement(Surface)); });
    expect(requests[0]!.signal.aborted).toBe(true);
    await act(async () => { requests[0]!.resolve({ uri: "stale", width: 3, height: 2 }); });
    expect(result.artwork.state).toBe("loading");
    await act(async () => { requests[1]!.resolve({ uri: "current", width: 3, height: 2 }); });
    expect(result.artwork).toMatchObject({ state: "ready", uri: "current" });
    act(() => { for (const listener of native.listeners) listener("background"); });
    expect(result.artwork.state).toBe("placeholder"); expect(requests[1]!.signal.aborted).toBe(true);
    act(() => { for (const listener of native.listeners) listener("active"); });
    expect(requests).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(result.artwork.state).toBe("error"); expect(requests[2]!.signal.aborted).toBe(true);
    await act(async () => { requests[2]!.resolve({ uri: "too-late", width: 3, height: 2 }); });
    expect(result.artwork.state).toBe("error");
    expect(client.readAudioArtwork).toHaveBeenCalledTimes(3);
  });
});
