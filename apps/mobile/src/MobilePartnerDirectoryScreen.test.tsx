// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MobilePartnerDirectoryScreen,
  type MobilePartnerDirectoryScreenProps
} from "./MobilePartnerDirectoryScreen";
import type {
  MobilePartnerCatalog,
  MobilePartnerDirectoryProfile,
  MobilePartnerDirectoryTransport
} from "./mobile-partner-directory";
import type { MobilePartnerInitializationTransport } from "./mobile-partner-initialization";
import type { MobilePartnerCreationTransport } from "./mobile-partner-creation";
import { create } from "@bufbuild/protobuf";
import { SessionState, SnapshotSchema } from "@joko/contracts";
import type { MobilePartnerDirectoryObservation } from "./mobile-partner-activity";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({ back: undefined as undefined | (() => boolean) }));
vi.mock("./MobilePartnerPresenceRing", async () => {
  const React = await import("react");
  return { MobilePartnerPresenceRing: ({ active }: { active: boolean }) => active
    ? React.createElement("span", { "data-testid": "partnerDirectory.presenceRing" }) : null };
});
vi.mock("./MobilePartnerCreateSheet", async () => {
  const React = await import("react");
  return { MobilePartnerCreateSheet: ({ visible }: { visible: boolean }) => visible ? React.createElement("div", { "data-testid": "partnerCreation.sheet" }) : null };
});

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ accessibilityLabel, accessibilityRole, accessibilityState,
    accessibilityHint: _accessibilityHint, accessible: _accessible, onPress, disabled, numberOfLines: _numberOfLines, testID, ...props }: Record<string, unknown> & {
      children?: React.ReactNode;
      accessibilityLabel?: string;
      accessibilityRole?: string;
      accessibilityHint?: string;
      accessibilityState?: { checked?: boolean; disabled?: boolean };
      onPress?: () => void;
      disabled?: boolean;
      numberOfLines?: number;
      testID?: string;
    }) => React.createElement(tag, {
      ...props,
      ...(accessibilityLabel ? { "aria-label": accessibilityLabel } : {}),
      ...(accessibilityRole ? { role: accessibilityRole } : {}),
      ...(accessibilityState?.checked === undefined ? {} : { "aria-checked": accessibilityState.checked }),
      ...(accessibilityState?.disabled === undefined ? {} : { "aria-disabled": accessibilityState.disabled }),
      ...(onPress ? { onClick: onPress } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(testID ? { "data-testid": testID } : {}),
      style: undefined
    }, props.children);
  return {
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    BackHandler: { addEventListener: (_name: string, handler: () => boolean) => {
      native.back = handler;
      return { remove: () => { if (native.back === handler) native.back = undefined; } };
    } },
    FlatList: ({ data, renderItem, ListEmptyComponent }: {
      data: readonly unknown[];
      renderItem: (value: { item: unknown; index: number }) => React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) => React.createElement("div", {}, data.length === 0 ? ListEmptyComponent
      : data.map((item, index) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index })))),
    Pressable: element("button"),
    RefreshControl: () => null,
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
    Text: element("span"),
    TextInput: ({ accessibilityLabel, onChangeText, value, testID, autoCorrect: _autoCorrect,
      clearButtonMode: _clearButtonMode, placeholderTextColor: _placeholderTextColor, ...props }: {
      accessibilityLabel?: string;
      onChangeText?: (value: string) => void;
      value?: string;
      testID?: string;
      autoCorrect?: boolean;
      clearButtonMode?: string;
      placeholderTextColor?: string;
    }) => React.createElement("input", { ...props, value, "aria-label": accessibilityLabel,
      "data-testid": testID, onChange: () => undefined,
      onInput: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
      style: undefined }),
    View: element("div")
  };
});

const colors: MobilePartnerDirectoryScreenProps["colors"] = {
  background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666",
  border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#fff0d0"
};

function profile(input: Partial<MobilePartnerDirectoryProfile> & Pick<MobilePartnerDirectoryProfile,
  "partnerId" | "displayName">): MobilePartnerDirectoryProfile {
  const { partnerId, displayName, ...overrides } = input;
  return {
    partnerId,
    revision: 2n,
    profileVersion: 3n,
    displayName,
    avatar: "orbit",
    identitySource: `${displayName} works across product surfaces.`,
    templateId: "general",
    lifecycle: "active",
    initializationState: "ready",
    invitationStage: "ready",
    homeTargetId: `target-${partnerId}`,
    canonicalSessionId: `session-${partnerId}`,
    capabilities: { modelChain: [{ backendId: "backend", providerId: "provider", modelId: "model", fastMode: false }],
      permissionMode: "ask", planMode: false },
    usesDirectoryDefaults: true,
    createdAt: 1_000,
    updatedAt: 2_000,
    activity: { partnerId, unreadReplyCount: 0, artifactCount: 1, activeDelegationCount: 0,
      readThroughCursor: 0n, readUpdatedAt: 1_000 },
    ...overrides
  };
}

const ada = profile({ partnerId: "ada", displayName: "Ada", activity: {
  partnerId: "ada", unreadReplyCount: 2, latestReplyCursor: 5n, latestReplyAt: 3_000,
  artifactCount: 3, activeDelegationCount: 1, readThroughCursor: 3n, readUpdatedAt: 2_000
} });
const pending = profile({ partnerId: "pending", displayName: "Pending", initializationState: "pending",
  invitationStage: "home", canonicalSessionId: undefined });
const archived = profile({ partnerId: "archived", displayName: "Archived", lifecycle: "archived" });
const catalog: MobilePartnerCatalog = {
  directory: { revision: 4n, activeCount: 2, archivedCount: 1, errorCount: 0, updatedAt: 4_000 },
  partners: [ada, pending, archived]
};

function transport(ownerKey = "owner-a"): MobilePartnerDirectoryTransport {
  return {
    ownerKey,
    list: vi.fn(async () => catalog),
    open: vi.fn(async () => ({ sessionId: "session-ada" }))
  };
}

let container: HTMLDivElement;
let root: Root;
const onBack = vi.fn();
const onOpenTask = vi.fn();

async function render(active?: MobilePartnerDirectoryTransport, initializationTransport?: MobilePartnerInitializationTransport,
  creationTransport?: MobilePartnerCreationTransport, observation?: MobilePartnerDirectoryObservation) {
  if (!root) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root.render(createElement(MobilePartnerDirectoryScreen, {
      colors, locale: "en", transport: active, initializationTransport, creationTransport, observation, onBack, onOpenTask
    }));
  });
}

async function press(label: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent === label);
  expect(button, `Missing accessible button ${label}`).toBeTruthy();
  await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
  native.back = undefined;
  onBack.mockReset();
  onOpenTask.mockReset();
});

describe("MobilePartnerDirectoryScreen", () => {
  it("offers creation through the matching node header and empty-state CTA without bypassing an offline owner", async () => {
    const active = transport(); vi.mocked(active.list).mockResolvedValue({ ...catalog, partners: [], directory: { ...catalog.directory, activeCount: 0 } });
    const creation = { ownerKey: active.ownerKey } as MobilePartnerCreationTransport;
    await render(active, undefined, creation);
    const header = container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.create"]')!;
    const empty = container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.emptyCreate"]')!;
    expect(header.disabled).toBe(false); expect(empty.disabled).toBe(false);
    await act(async () => empty.click()); expect(container.querySelector('[data-testid="partnerCreation.sheet"]')).not.toBeNull();
    await render(active, undefined, { ...creation, ownerKey: "other-owner" });
    expect(container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.create"]')!.disabled).toBe(true);
  });
  it("opens pending setup through the matching node owner and returns to the roster on Android back", async () => {
    const active = transport();
    const initialization: MobilePartnerInitializationTransport = { ownerKey: active.ownerKey,
      load: vi.fn(async () => pending), retry: vi.fn(async () => ada), open: vi.fn(async () => ({ sessionId: "session-ada" })) };
    await render(active, initialization); await press("View Pending's setup");
    expect(initialization.load).toHaveBeenCalledWith("pending", expect.any(AbortSignal));
    expect(container.textContent).toContain("Getting Pending ready"); expect(active.open).not.toHaveBeenCalled();
    await act(async () => { expect(native.back?.()).toBe(true); });
    expect(container.querySelector('[data-testid="partnerDirectory.item.ada"]')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled(); expect(onOpenTask).not.toHaveBeenCalled();
    await render(active, { ...initialization, ownerKey: "another-node" });
    expect((container.querySelector('[aria-label="Open Pending\'s task"]') as HTMLButtonElement).disabled).toBe(true);
  });
  it("shows activity, disables unavailable entries, searches and opens an exact Partner task", async () => {
    const active = transport();
    await render(active);
    expect(container.textContent).toContain("Ada");
    expect(container.textContent).toContain("Ada works across product surfaces.");
    expect((container.querySelector('[aria-label="Open Pending\'s task"]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[aria-label="Search Partners"]')).toBeTruthy();
    const input = container.querySelector('[aria-label="Search Partners"]') as HTMLInputElement;
    await act(async () => {
      input.value = "Pending";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="partnerDirectory.item.ada"]')).toBeNull();
    expect(container.querySelector('[data-testid="partnerDirectory.item.pending"]')).toBeTruthy();
    await press("Clear");
    await press("Open Ada's task");
    expect(active.open).toHaveBeenCalledWith(ada, expect.any(AbortSignal));
    expect(onOpenTask).toHaveBeenCalledWith("session-ada");
  });

  it("switches to archived state and retires a late directory from an old owner", async () => {
    let finish!: (value: MobilePartnerCatalog) => void;
    const old = transport("owner-old");
    vi.mocked(old.list).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(old);
    const next = transport("owner-new");
    vi.mocked(next.list).mockResolvedValue({ ...catalog, partners: [profile({ partnerId: "new", displayName: "New" })],
      directory: { ...catalog.directory, activeCount: 1, archivedCount: 0 } });
    await render(next);
    expect(container.textContent).toContain("New");
    await act(async () => finish(catalog));
    expect(container.textContent).not.toContain("Ada works");
    await render(transport());
    await press("Archived");
    expect(container.querySelector('[data-testid="partnerDirectory.item.archived"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="partnerDirectory.item.ada"]')).toBeNull();
  });

  it("shows the bounded offline state and handles Android back", async () => {
    await render(undefined);
    expect(container.textContent).toContain("Reconnect to view Partners");
    expect(native.back?.()).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows canonical working and waiting state, preserves the same owner's reply offline and retires it on owner loss", async () => {
    const active = transport();
    vi.mocked(active.list).mockResolvedValue({ ...catalog, partners: [{ ...ada,
      activity: { ...ada.activity, latestReplyPreview: "**Ready** [report](https://example.test)" } }] });
    const observation: MobilePartnerDirectoryObservation = { ownerKey: active.ownerKey, online: true,
      snapshot: create(SnapshotSchema, { sessions: [{ sessionId: ada.canonicalSessionId, targetId: ada.homeTargetId,
        backendId: "backend", state: SessionState.RUNNING, version: { generation: 1n } }] }) };
    await render(active, undefined, undefined, observation);
    expect(container.textContent).toContain("Thinking…");
    expect(container.querySelector('[data-testid="partnerDirectory.presenceRing"]')).not.toBeNull();
    observation.snapshot.sessions[0]!.state = SessionState.WAITING;
    await render(active, undefined, undefined, observation);
    expect(container.textContent).toContain("Waiting for your confirmation · Ready report");
    expect(container.querySelector('[data-testid="partnerDirectory.presenceRing"]')).toBeNull();
    await render(undefined, undefined, undefined, { ...observation, online: false });
    expect(container.textContent).toContain("Offline · Ready report");
    expect(container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.item.ada"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="partnerDirectory.refresh"]')!.disabled).toBe(true);
    expect(active.open).not.toHaveBeenCalled();
    await render(undefined);
    expect(container.textContent).not.toContain("Ready report");
  });

  it("polls without overlapping reads and stops after a read failure or offline transition", async () => {
    vi.useFakeTimers();
    try {
      const active = transport(); await render(active);
      let finish!: (value: MobilePartnerCatalog) => void;
      vi.mocked(active.list).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(active.list).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(7500); });
      expect(active.list).toHaveBeenCalledTimes(2);
      await act(async () => finish(catalog));
      vi.mocked(active.list).mockRejectedValueOnce(new Error("connection lost"));
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(container.textContent).toContain("The saved list may be out of date");
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(active.list).toHaveBeenCalledTimes(3);
      await render(undefined);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(active.list).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
