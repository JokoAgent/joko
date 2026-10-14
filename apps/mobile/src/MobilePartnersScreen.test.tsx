// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobilePartnerPrivateState } from "./mobile-partner-private";
import { MobilePartnersScreen, type MobilePartnersScreenProps } from "./MobilePartnersScreen";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  width: 390,
  viewable: undefined as undefined | ((event: { viewableItems: readonly unknown[] }) => void),
  pull: undefined as undefined | (() => void),
  pulling: false,
  back: undefined as undefined | (() => boolean)
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState,
    onPress, disabled, numberOfLines: _numberOfLines, selectable: _selectable,
    contentContainerStyle: _contentContainerStyle, testID, accessible: _accessible, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityState?: { selected?: boolean; disabled?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      numberOfLines?: number;
      selectable?: boolean;
      contentContainerStyle?: unknown;
      testID?: string;
    }) => React.createElement(tag, {
      ...props,
      ...(testID ? { "data-testid": testID } : {}),
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.selected === undefined ? {} : { "aria-selected": accessibilityState.selected }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      style: undefined
    }, props.children);
  return {
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    BackHandler: { addEventListener: (_name: string, handler: () => boolean) => {
      native.back = handler;
      return { remove: () => { if (native.back === handler) native.back = undefined; } };
    } },
    FlatList: ({ data, renderItem, onViewableItemsChanged, refreshControl, ListEmptyComponent, ListFooterComponent }: {
      data: readonly unknown[];
      renderItem: (value: { item: unknown; index: number }) => React.ReactNode;
      onViewableItemsChanged: (event: { viewableItems: readonly unknown[] }) => void;
      refreshControl?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    }) => {
      native.viewable = onViewableItemsChanged;
      return React.createElement("div", { "data-message-list": true },
        refreshControl, data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index })))
          : ListEmptyComponent, ListFooterComponent);
    },
    RefreshControl: ({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) => {
      native.pull = onRefresh; native.pulling = refreshing;
      return React.createElement("span", { "data-refreshing": refreshing });
    },
    Pressable: element("button"),
    ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Text: element("span"),
    View: element("div"),
    useWindowDimensions: () => ({ width: native.width, height: 844, scale: 1, fontScale: 1 })
  };
});

const colors: MobilePartnersScreenProps["colors"] = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666",
  border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};

const partners = [
  { partnerId: "alpha", revision: 2n, displayName: "Ada", avatar: "A", lifecycle: "active" as const,
    initializationState: "ready" as const, profileVersion: 1 },
  { partnerId: "beta", revision: 2n, displayName: "Bo", avatar: "B", lifecycle: "active" as const,
    initializationState: "ready" as const, profileVersion: 1 }
];
const thread = {
  threadId: "thread-1", firstPartnerId: "alpha", secondPartnerId: "beta", otherPartnerId: "beta",
  status: "closed" as const, closeReason: "messageLimit" as const,
  messageCount: 3, maxMessages: 12, createdAt: 1_000, updatedAt: 3_000,
  expiresAt: 100_000, blockedUntil: 200_000, closedAt: 3_000
};
const messages = [
  { messageId: "m1", threadId: "thread-1", sequence: 1, senderPartnerId: "beta", recipientPartnerId: "alpha",
    content: "First private body", deliveryStatus: "delivered" as const, createdAt: 1_000, deliveredAt: 1_100 },
  { messageId: "m2", threadId: "thread-1", sequence: 2, senderPartnerId: "alpha", recipientPartnerId: "beta",
    content: "Second private body", deliveryStatus: "delivered" as const, createdAt: 2_000, deliveredAt: 2_100 },
  { messageId: "m3", threadId: "thread-1", sequence: 3, senderPartnerId: "beta", recipientPartnerId: "alpha",
    content: "Third private body", deliveryStatus: "pending" as const, createdAt: 3_000 }
];

function state(patch: Partial<MobilePartnerPrivateState> = {}): MobilePartnerPrivateState {
  return {
    open: true, status: "ready", partners, threads: [], detailStatus: "idle", ...patch
  };
}

const callbacks = {
  onBack: vi.fn(), onOpenPartner: vi.fn(), onClosePartner: vi.fn(),
  onOpenThread: vi.fn(), onCloseThread: vi.fn(), onRefresh: vi.fn(), onDetailVisible: vi.fn()
};

let container: HTMLDivElement;
let root: Root;

function render(view: MobilePartnerPrivateState, locale: MobilePartnersScreenProps["locale"] = "en") {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root.render(createElement(MobilePartnersScreen, { colors, locale, view, ...callbacks })));
}

function press(label: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  expect(button, `Missing accessible button ${label}`).toBeTruthy();
  act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
  native.width = 390;
  native.viewable = undefined;
  native.pull = undefined; native.pulling = false;
  native.back = undefined;
  Object.values(callbacks).forEach((callback) => callback.mockReset());
  vi.useRealTimers();
});

describe("MobilePartnersScreen", () => {
  it("navigates directory, threads and detail; only reports messages confirmed visible", () => {
    render(state());
    expect(container.textContent).toContain("Partner chats");
    press("View Ada's conversations");
    expect(callbacks.onOpenPartner).toHaveBeenCalledWith("alpha");
    expect(container.textContent).toContain("Loading conversations");

    render(state({ selectedPartnerId: "alpha", threads: [thread] }));
    expect(container.textContent).toContain("Closed · message limit reached");
    press("Read conversation between Ada and Bo");
    expect(callbacks.onOpenThread).toHaveBeenCalledWith("alpha", "thread-1");
    expect(callbacks.onDetailVisible).not.toHaveBeenCalled();

    render(state({ selectedPartnerId: "alpha", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "loading" }));
    expect(container.textContent).toContain("Loading conversation");
    expect(container.textContent).not.toContain("First private body");
    expect(callbacks.onDetailVisible).not.toHaveBeenCalled();

    render(state({ selectedPartnerId: "alpha", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "ready", detail: { thread, messages, readState: {
        threadId: "thread-1", partnerId: "alpha", throughSequence: 1, updatedAt: 3_000
      } } }));
    expect(container.textContent).toContain("First private body");
    expect(container.textContent).toContain("Blocked until");
    expect(container.textContent).toContain("Ada read through message 1");
    expect(container.textContent).toContain("Pending delivery");
    expect(callbacks.onDetailVisible).not.toHaveBeenCalled();

    act(() => native.viewable?.({ viewableItems: [
      { item: messages[0], isViewable: true },
      { item: messages[1], isViewable: true },
      { item: messages[2], isViewable: false }
    ] }));
    expect(callbacks.onDetailVisible).toHaveBeenCalledExactlyOnceWith("alpha", "thread-1", 2);

    const lateViewability = native.viewable;
    press("Back to conversations");
    expect(callbacks.onCloseThread).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("First private body");
    act(() => lateViewability?.({ viewableItems: [{ item: messages[2], isViewable: true }] }));
    expect(callbacks.onDetailVisible).toHaveBeenCalledTimes(1);
    press("Back to Partners");
    expect(callbacks.onClosePartner).toHaveBeenCalledOnce();
  });

  it("does not show retained private content while offline or after a failed detail", () => {
    render(state({ status: "offline", selectedPartnerId: "alpha", selectedThreadId: "thread-1",
      threads: [thread], detailStatus: "offline", detail: { thread, messages } }));
    expect(container.textContent).toContain("Private message content is not saved offline");
    expect(container.textContent).not.toContain("First private body");
    expect(native.viewable).toBeUndefined();
    press("Retry");
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();

    render(state({ status: "ready", selectedPartnerId: "alpha", selectedThreadId: "thread-1",
      threads: [thread], detailStatus: "error", detailError: "untrusted detail", detail: { thread, messages } }));
    expect(container.textContent).toContain("Partner chats could not be loaded");
    expect(container.textContent).not.toContain("First private body");
    expect(container.textContent).not.toContain("untrusted detail");
    press("Retry");
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(2);
  });

  it("shows a retry for failed read status while preserving the visible conversation", () => {
    render(state({ selectedPartnerId: "alpha", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "ready", detailError: "read request failed", detail: { thread, messages } }));
    expect(container.textContent).toContain("First private body");
    expect(container.textContent).toContain("Read status could not be updated");
    expect(container.textContent).not.toContain("read request failed");
    press("Retry");
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
  });

  it("uses Android back to unwind detail, partner and screen", () => {
    render(state({ selectedPartnerId: "alpha", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "ready", detail: { thread, messages } }));
    act(() => expect(native.back?.()).toBe(true));
    expect(callbacks.onCloseThread).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("First private body");
    act(() => expect(native.back?.()).toBe(true));
    expect(callbacks.onClosePartner).toHaveBeenCalledOnce();
    act(() => expect(native.back?.()).toBe(true));
    expect(callbacks.onBack).toHaveBeenCalledOnce();
  });

  it("shows directory, thread list and read-only detail together on wide layouts", () => {
    native.width = 920;
    render(state({ selectedPartnerId: "alpha", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "ready", detail: { thread, messages } }), "zh-CN");
    expect(container.textContent).toContain("伙伴私聊");
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).toContain("Bo");
    expect(container.textContent).toContain("Third private body");
    expect(container.querySelectorAll("[data-message-list]")).toHaveLength(1);
  });

  it("uses the viewing Partner for sender sides and keeps an empty limited thread refreshable", () => {
    render(state({ selectedPartnerId: "beta", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "ready", detail: { thread, messages } }));
    const own = container.querySelectorAll('[data-testid="partner.privateMessage.own"]');
    expect(own).toHaveLength(2);
    expect(own[0]?.textContent).toContain("Bo");
    expect(own[0]?.textContent).toContain("First private body");
    expect(own[0]?.querySelector('[data-testid="partner.avatar.B"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="partner.privateMessage.peer"]')?.textContent)
      .toContain("Second private body");
    render(state({ selectedPartnerId: "beta", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "ready", detail: { thread, messages: [] } }));
    expect(container.textContent).toContain("No messages in this conversation.");
    expect(container.querySelector('[data-testid="partner.privateMessage.limit"]')).toBeTruthy();
    expect(native.pull).toBeTypeOf("function");
  });

  it("coalesces pull refresh and ends the spinner on settlement or a bounded fallback", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    callbacks.onRefresh.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    render(state({ selectedPartnerId: "alpha", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "ready", detail: { thread, messages } }));
    act(() => { native.pull?.(); native.pull?.(); });
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
    expect(native.pulling).toBe(true);
    await act(async () => { resolve(); await Promise.resolve(); });
    expect(native.pulling).toBe(false);
    callbacks.onRefresh.mockImplementation(() => new Promise<void>(() => undefined));
    act(() => native.pull?.());
    expect(native.pulling).toBe(true);
    act(() => vi.advanceTimersByTime(8000));
    expect(native.pulling).toBe(false);
    act(() => native.pull?.());
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(2);
  });

  it("retires a pull when leaving and ignores its late completion after reentering", async () => {
    const done: (() => void)[] = [];
    callbacks.onRefresh.mockImplementation(() => new Promise<void>(resolve => { done.push(resolve); }));
    render(state({ selectedPartnerId: "alpha", selectedThreadId: "thread-1", threads: [thread],
      detailStatus: "ready", detail: { thread, messages } }));
    const oldPull = native.pull;
    act(() => native.pull?.());
    press("Back to conversations");
    act(() => oldPull?.());
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
    press("Read conversation between Ada and Bo");
    act(() => native.pull?.());
    expect(callbacks.onRefresh).toHaveBeenCalledTimes(2);
    await act(async () => { done[0]?.(); await Promise.resolve(); });
    expect(native.pulling).toBe(true);
    await act(async () => { done[1]?.(); await Promise.resolve(); });
    expect(native.pulling).toBe(false);
  });
});
