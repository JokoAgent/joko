// @vitest-environment jsdom
import { act, createElement, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useMobileConversationShare } from "./use-mobile-conversation-share";
import { MobileConversationShareBar } from "./MobileConversationShareBar";
import type { MobileConversationShareSnapshot } from "./mobile-conversation-share";
import type { TimelineRow } from "./timeline";

vi.mock("./mobile-image-output", () => ({ mobileImageOutput: { perform: vi.fn() } }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  BackHandler: { addEventListener: () => ({ remove() {} }) }, Keyboard: { dismiss: vi.fn() },
  StyleSheet: { create: (value: unknown) => value },
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
  Pressable: ({ children, onPress, disabled }: { children?: ReactNode; onPress: () => void; disabled?: boolean }) =>
    createElement("button", { onClick: onPress, disabled }, children)
}));

const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
const rows: TimelineRow[] = ["a", "b"].map((id, index) => ({ id, eventId: id, kind: "assistant", completed: true, label: "Assistant", text: id, sequence: BigInt(index) }));
const colors = { surface: "#ffffff", ink: "#111111", muted: "#888888", border: "#cccccc", accent: "#ff9800" };

function fixture(exportPng: (signal: AbortSignal) => Promise<Uint8Array>, nativeFailure = false) {
  const api = {
    conversationShareOwnerKey: () => "owner",
    prepareConversationShare: vi.fn(async (ids: readonly string[]): Promise<MobileConversationShareSnapshot> => ({ leaseId: "lease", allShareableIds: ["a", "b"],
      messages: ids.map((id) => ({ clientId: id, kind: "assistant", body: id, bodyParts: [{ kind: "text", text: id }], attachments: [] })) })),
    assertConversationShareCurrent: vi.fn(), revalidateConversationShare: vi.fn(async () => undefined), releaseConversationShare: vi.fn(),
    subscribe: () => () => {}
  };
  const output = { perform: vi.fn(async (_action, _source, _rendered, _signal, beforeDispatch) => {
    await beforeDispatch?.(); if (nativeFailure) throw new Error("native response lost");
  }) };
  function Renderer({ attach }: { readonly attach: (handle: { exportPng: typeof exportPng } | null) => void }) {
    const handle = useMemo(() => ({ exportPng }), []);
    return createElement("div", { ref: (node) => attach(node ? handle : null) });
  }
  function Screen() {
    const share = useMobileConversationShare({ client: api, rows, locale: "en", onNativeActivityChange: vi.fn(), output });
    return createElement("div", {}, createElement("button", { onClick: () => share.enter("a") }, "Select"),
      createElement("button", { onClick: () => share.enterVisible("owner", ["a", "b"]) }, "Screenshot"),
      share.active && createElement(MobileConversationShareBar, { count: share.selectedIds.length, allSelected: share.allSelected, busy: share.busy,
        colors, locale: "en", screenshotTriggered: share.screenshotTriggered,
        onCancel: share.cancel, onToggleAll: share.toggleAll, onShare: () => { void share.share(); } }),
      share.snapshot && createElement(Renderer, { attach: share.rendererRef }), createElement("span", {}, share.notice));
  }
  const container = document.createElement("div"); const root = createRoot(container);
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label);
    expect(button).toBeDefined(); await act(async () => { button!.click(); });
  };
  return { api, output, container, root, Screen, click };
}

describe("conversation sharing interaction", () => {
  it("a screenshot enters the visible selection with a hint and generates nothing until Share", async () => {
    const capture = vi.fn(async () => png); const f = fixture(capture);
    await act(async () => f.root.render(createElement(f.Screen)));
    await f.click("Screenshot");
    expect(f.container.textContent).toContain("2 selected");
    expect(f.container.textContent).toContain("a clearer image");
    expect(capture).not.toHaveBeenCalled(); expect(f.output.perform).not.toHaveBeenCalled();
    await f.click("Cancel"); expect(f.container.textContent).not.toContain("a clearer image");
    await act(async () => f.root.unmount());
  });
  it("generates only after Share, restores select-all and does not replay an unknown native result", async () => {
    const capture = vi.fn(async () => png); const f = fixture(capture, true);
    await act(async () => f.root.render(createElement(f.Screen)));
    await f.click("Select"); await f.click("Select all");
    expect(f.container.textContent).toContain("2 selected");
    await f.click("Restore selection"); expect(f.container.textContent).toContain("1 selected");
    expect(capture).not.toHaveBeenCalled(); expect(f.output.perform).not.toHaveBeenCalled();
    await f.click("Share as image");
    await vi.waitFor(() => expect(f.output.perform).toHaveBeenCalledTimes(1));
    expect(f.api.revalidateConversationShare).toHaveBeenCalledTimes(1); expect(capture).toHaveBeenCalledTimes(1);
    expect(f.container.textContent).toContain("its result could not be confirmed");
    expect(f.container.textContent).not.toContain("selected");
    await act(async () => f.root.unmount());
  });

  it("discards a capture arriving after Cancel before any system output", async () => {
    let finish!: (bytes: Uint8Array) => void;
    const capture = vi.fn(() => new Promise<Uint8Array>((resolve) => { finish = resolve; }));
    const f = fixture(capture);
    await act(async () => f.root.render(createElement(f.Screen)));
    await f.click("Select"); await f.click("Share as image");
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    await f.click("Cancel");
    await act(async () => finish(png));
    expect(f.output.perform).not.toHaveBeenCalled(); expect(f.api.revalidateConversationShare).not.toHaveBeenCalled();
    expect(f.api.releaseConversationShare).toHaveBeenCalledWith("lease");
    await act(async () => f.root.unmount());
  });
});
