// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { BlobRefSchema } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileAudioMetadataView } from "./mobile-audio-metadata";

interface NativeImageProps {
  readonly source: { readonly uri: string };
  readonly onLoad?: (event: { readonly nativeEvent: { readonly source: { readonly width: number; readonly height: number } } }) => void;
  readonly onError?: () => void;
  readonly accessibilityLabel?: string;
}
const native = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>(), images: [] as NativeImageProps[] }));
vi.mock("react-native", () => ({
  View: ({ children, accessibilityLabel, accessibilityRole, accessibilityState }: { children?: ReactNode; accessibilityLabel?: string;
    accessibilityRole?: string; accessibilityState?: { busy?: boolean } }) => createElement("div", { "aria-label": accessibilityLabel,
      role: accessibilityRole === "image" ? "img" : undefined, "aria-busy": accessibilityState?.busy }, children),
  Text: ({ children, selectable, numberOfLines, accessibilityRole }: { children?: ReactNode; selectable?: boolean;
    numberOfLines?: number; accessibilityRole?: string }) => createElement("span", { "data-selectable": selectable,
      "data-lines": numberOfLines, role: accessibilityRole === "alert" ? "alert" : undefined }, children),
  Pressable: ({ children, onPress, accessibilityLabel, accessibilityState, disabled, style }: { children?: ReactNode;
    onPress?: () => void; accessibilityLabel?: string; accessibilityState?: { busy?: boolean }; disabled?: boolean; style?: unknown }) =>
    createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, "aria-busy": accessibilityState?.busy,
      disabled, "data-native-style": JSON.stringify(style) }, children),
  Image: (props: NativeImageProps) => { native.images.push(props); return createElement("img", { src: props.source.uri, alt: props.accessibilityLabel }); },
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { currentState: "active", addEventListener: (_name: string, listener: (state: string) => void) => {
    native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
  } }
}));
import { MobileAudioMetadataCard, type MobileAudioMetadataCardProps } from "./MobileAudioMetadataCard";

const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df" };
const description = `  Start\n${"Full canonical description. ".repeat(500)}\nFinal text.  `;
const metadata: MobileAudioMetadataView = { kind: "music", title: "A complete track title", description, durationSeconds: 89,
  artwork: { blob: create(BlobRefSchema, { blobId: "cover", mediaType: "image/png", fileName: "cover.png", byteSize: 104n, sha256Hex: "a".repeat(64) }),
    width: 16, height: 16, alt: "Canonical cover" } };
let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); native.listeners.clear(); native.images.length = 0;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
function props(values: Partial<MobileAudioMetadataCardProps> = {}): MobileAudioMetadataCardProps {
  return { metadata, ownerKey: "owner", colors, locale: "en", enabled: true, artwork: { state: "placeholder" },
    onCopyDescription: vi.fn(async () => {}), ...values };
}
async function render(value: MobileAudioMetadataCardProps) {
  await act(async () => root.render(createElement(MobileAudioMetadataCard, value)));
}
async function click(label = "Copy description") {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button, label).not.toBeNull(); await act(async () => button!.click());
}
async function appState(state: string) {
  await act(async () => { for (const listener of [...native.listeners]) listener(state); });
}
const loaded = (width = 16, height = 16) => ({ nativeEvent: { source: { width, height } } });

describe("native audio metadata card", () => {
  it("shows complete selectable music information, explicitly copies exact text and keeps artwork feedback independent of measured duration", async () => {
    const copied = vi.fn(async () => {}); const decoded = vi.fn(); const failed = vi.fn();
    const value = props({ onCopyDescription: copied, onArtworkDecoded: decoded, onArtworkError: failed });
    await render(value);
    expect(host.textContent).toContain(metadata.title); expect(host.textContent).toContain("Music"); expect(host.textContent).toContain("Duration 1:29");
    const full = Array.from(host.querySelectorAll("span")).find((node) => node.textContent === description);
    expect(full?.getAttribute("data-selectable")).toBe("true"); expect(full?.hasAttribute("data-lines")).toBe(false);
    expect(host.querySelector('button[aria-label="Copy description"]')?.getAttribute("data-native-style")).toContain('"minHeight":44');
    expect(host.querySelector('[aria-label="No cover artwork"]')).not.toBeNull();
    await click(); expect(copied).toHaveBeenCalledWith(description, expect.any(AbortSignal)); expect(host.textContent).toContain("Description copied");
    await render({ ...value, actualDuration: 120.9, artwork: { state: "loading" } });
    expect(host.textContent).toContain("Duration 2:00"); expect(host.querySelector('[aria-label="Loading cover artwork"]')?.getAttribute("aria-busy")).toBe("true");
    await render({ ...value, actualDuration: 120.9, artwork: { state: "error" } });
    expect(host.querySelector('[aria-label="Cover artwork unavailable"]')).not.toBeNull();
    expect(host.textContent).toContain(description); expect(host.textContent).toContain("Duration 2:00");
    await render({ ...value, actualDuration: 120.9, artwork: { state: "ready", uri: "file:///owned/cover.png", sourceKey: "cover-one" } });
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("Canonical cover");
    const image = native.images.at(-1)!;
    await act(async () => image.onLoad?.(loaded())); expect(decoded).toHaveBeenCalledWith("cover-one", 16, 16);
    await act(async () => image.onError?.()); expect(failed).toHaveBeenCalledWith("cover-one");
    await act(async () => image.onLoad?.(loaded())); expect(decoded).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-label="Cover artwork unavailable"]')).not.toBeNull(); expect(host.textContent).toContain("Duration 2:00");
    expect(host.querySelector("audio,video,iframe")).toBeNull();
  });

  it("bounds explicit copy to the exact metadata and owner, cancels hidden or unmounted requests and exposes known failure for a new explicit attempt", async () => {
    let finish!: () => void; let signal!: AbortSignal;
    const pending = vi.fn((_text: string, active: AbortSignal) => { signal = active; return new Promise<void>((resolve) => { finish = resolve; }); });
    const value = props({ onCopyDescription: pending });
    await render(value); await click(); await click(); expect(pending).toHaveBeenCalledOnce();
    expect(host.querySelector("button")?.disabled).toBe(true); expect(host.textContent).toContain("Copying description…");
    await render({ ...value, metadata: { ...metadata, description: "New description" } }); expect(signal.aborted).toBe(true);
    await act(async () => finish()); expect(host.textContent).not.toContain("Description copied");
    const failure = vi.fn(async () => { throw new Error("Clipboard refused"); });
    const changed = { ...value, metadata: { ...metadata, description: "New description" }, onCopyDescription: failure };
    await render(changed); await click(); expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not copy description");
    const success = vi.fn(async () => {}); await render({ ...changed, onCopyDescription: success }); await click();
    expect(success).toHaveBeenCalledOnce(); expect(host.textContent).toContain("Description copied");
    await render(value); await click(); const ownerSignal = signal; const finishOwner = finish;
    await render({ ...value, ownerKey: "other-owner" }); expect(ownerSignal.aborted).toBe(true);
    await act(async () => finishOwner()); expect(host.textContent).not.toContain("Description copied");
    await click(); await appState("background"); expect(signal.aborted).toBe(true); expect(host.querySelector("button")?.disabled).toBe(true);
    await act(async () => finish()); expect(host.textContent).not.toContain("Description copied");
    await appState("active"); await click(); const unmountSignal = signal; const finishUnmount = finish;
    await act(async () => root.render(null)); expect(unmountSignal.aborted).toBe(true); expect(native.listeners.size).toBe(0);
    await act(async () => finishUnmount()); expect(host.textContent).toBe("");
  });

  it("rejects late native cover callbacks after owner, metadata or foreground retirement and reports invalid native dimensions as artwork failure", async () => {
    const decoded = vi.fn(); const failed = vi.fn();
    const value = props({ artwork: { state: "ready", uri: "file:///owned/cover.png", sourceKey: "cover-one" },
      onArtworkDecoded: decoded, onArtworkError: failed });
    await render(value); const oldOwner = native.images.at(-1)!;
    await render({ ...value, ownerKey: "other-owner" });
    await act(async () => { oldOwner.onLoad?.(loaded()); oldOwner.onError?.(); }); expect(decoded).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    const oldMetadata = native.images.at(-1)!;
    const changed = { ...value, ownerKey: "other-owner", metadata: { ...metadata, title: "Changed title" } };
    await render(changed); await act(async () => oldMetadata.onLoad?.(loaded())); expect(decoded).not.toHaveBeenCalled();
    const background = native.images.at(-1)!; await appState("background");
    await act(async () => { background.onLoad?.(loaded()); background.onError?.(); }); expect(decoded).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    expect(host.querySelector("img")).toBeNull(); await appState("active");
    const invalid = native.images.at(-1)!; await act(async () => invalid.onLoad?.(loaded(0, 16)));
    expect(decoded).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledWith("cover-one");
    expect(host.querySelector('[aria-label="Cover artwork unavailable"]')).not.toBeNull();
  });

  it("renders the fixed sound-effect distinction and provides native kind, duration and copy labels in all supported locales", async () => {
    const value = props();
    await render(props({ metadata: { ...metadata, kind: "sound_effect", title: "Door closes" },
      artwork: { state: "ready", uri: "file:///owned/cover.png", sourceKey: "cover-one" } }));
    expect(host.textContent).toContain("Sound effect"); expect(host.textContent).toContain("Door closes"); expect(host.textContent).toContain("Duration 1:29");
    expect(host.textContent).not.toContain(description); expect(host.querySelector("img,button")).toBeNull();
    for (const [locale, kind, copy, duration] of [["en", "Music", "Copy description", "Duration 1:29"],
      ["zh-CN", "音乐", "复制说明", "时长 1:29"], ["zh-TW", "音樂", "複製說明", "長度 1:29"],
      ["ja", "音楽", "説明をコピー", "長さ 1:29"], ["ko", "음악", "설명 복사", "길이 1:29"]] as const) {
      await render({ ...value, locale }); expect(host.textContent).toContain(kind); expect(host.textContent).toContain(duration);
      expect(host.querySelector(`button[aria-label="${copy}"]`)).not.toBeNull();
    }
    await render(props({ metadata: { ...metadata, kind: "generic", description: "", artwork: undefined } }));
    expect(host.textContent).toContain("Audio"); expect(host.querySelector("button")).toBeNull();
  });
});
