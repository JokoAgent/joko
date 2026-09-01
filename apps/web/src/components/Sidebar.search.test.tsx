// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type SessionMessageSearchMatchView } from "../model.js";
import { Sidebar, type SidebarProps } from "./Sidebar.js";
import type { Translator } from "./types.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

const roots: Root[] = [];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (originalScrollIntoView === undefined) Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  else Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("Sidebar progressive conversation search", () => {
  it("shows keyword at 250ms and atomically upgrades to hybrid at 900ms", async () => {
    vi.useFakeTimers();
    const keyword = deferred<readonly SessionMessageSearchMatchView[]>();
    const hybrid = deferred<readonly SessionMessageSearchMatchView[]>();
    const calls: Array<{ readonly mode: "keyword" | "hybrid"; readonly filters: unknown; readonly signal: AbortSignal }> = [];
    const onSearchMessages: SidebarProps["onSearchMessages"] = (_query, mode, filters, signal) => {
      calls.push({ mode, filters, signal });
      return mode === "keyword" ? keyword.promise : hybrid.promise;
    };
    const { container } = await renderSidebar(onSearchMessages);
    await enterQuery(container, "needle");

    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(calls).toHaveLength(0);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(calls.map((call) => call.mode)).toEqual(["keyword"]);

    await act(async () => keyword.resolve([hit("keyword needle result", "keyword")]));
    expect(container.textContent).toContain("keyword needle result");
    await act(async () => vi.advanceTimersByTimeAsync(649));
    expect(calls.map((call) => call.mode)).toEqual(["keyword"]);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(calls.map((call) => call.mode)).toEqual(["keyword", "hybrid"]);
    expect(calls[0]?.filters).toEqual({});
    expect(calls[1]?.filters).toBe(calls[0]?.filters);

    await act(async () => hybrid.resolve([hit("hybrid needle result", "hybrid")]));
    expect(container.textContent).toContain("hybrid needle result");
    expect(container.textContent).not.toContain("keyword needle result");
  });

  it("keeps a successful keyword page when hybrid fails and aborts superseded generations", async () => {
    vi.useFakeTimers();
    const calls: Array<{ readonly query: string; readonly mode: "keyword" | "hybrid"; readonly signal: AbortSignal }> = [];
    const onSearchMessages: SidebarProps["onSearchMessages"] = (query, mode, _filters, signal) => {
      calls.push({ query, mode, signal });
      if (query === "first") return Promise.resolve([hit("first keyword page", "first")]);
      return mode === "keyword"
        ? Promise.resolve([hit("second keyword page", "second")])
        : Promise.reject(new Error("semantic provider unavailable"));
    };
    const { container } = await renderSidebar(onSearchMessages);
    await enterQuery(container, "first");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(container.textContent).toContain("first keyword page");
    const firstSignal = calls[0]?.signal;

    await enterQuery(container, "second");
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(container.textContent).toContain("second keyword page");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(calls.filter((call) => call.query === "second").map((call) => call.mode))
      .toEqual(["keyword", "hybrid"]);
    expect(container.textContent).toContain("second keyword page");
    expect(container.textContent).not.toContain("nav.messageSearchFailed");
  });

  it("sends one stable typed filter snapshot to both stages and restarts when a filter changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const calls: Array<{
      readonly filters: Parameters<SidebarProps["onSearchMessages"]>[2];
      readonly signal: AbortSignal;
    }> = [];
    const onSearchMessages: SidebarProps["onSearchMessages"] = async (_query, _mode, filters, signal) => {
      calls.push({ filters, signal });
      return [];
    };
    const { container } = await renderSidebar(onSearchMessages);
    await changeSelect(container, "archived");
    await changeSelect(container, "backend");
    await changeSelect(container, "7d");
    const targetCheckboxes = container.querySelectorAll<HTMLInputElement>(".conversation-search-filter__projects input[type=checkbox]");
    await act(async () => targetCheckboxes[1]?.click());
    await enterQuery(container, "needle");

    await act(async () => vi.advanceTimersByTimeAsync(900));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.filters).toEqual({
      targetIds: ["target-a"],
      backendIds: ["backend"],
      sessionStatus: "archived",
      sessionActivityFrom: Date.parse("2026-08-17T12:00:00.000Z")
    });
    expect(calls[1]?.filters).toBe(calls[0]?.filters);
    const firstSignal = calls[0]?.signal;

    await changeSelect(container, "active");
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(calls[2]?.filters).toEqual(expect.objectContaining({ sessionStatus: "active" }));
  });

  it("renders a live remote message result and activates its profile-qualified jump", async () => {
    vi.useFakeTimers();
    const openRemoteMessage = vi.fn();
    const remoteMatch = {
      profileId: "remote-east",
      serverId: "server-east",
      source: "live" as const,
      reachable: true as const,
      match: hit("deployment needle", "remote-event")
    };
    const { container } = await renderSidebar(async () => [], {
      onSearchRemoteMessages: async () => [remoteMatch],
      machineControl: {
        profiles: [
          { id: "local", deviceId: "device-test", serverId: "server-local", name: "Local", origin: "http://127.0.0.1:4318"  },
          { id: "remote-east", deviceId: "device-test", serverId: "server-east", name: "East", origin: "https://east.example.test"  }
        ],
        activeProfile: { id: "local", deviceId: "device-test", serverId: "server-local", name: "Local", origin: "http://127.0.0.1:4318"  },
        presenceByProfile: { local: "current", "remote-east": "online" },
        caches: [{
          profileId: "remote-east",
          serverId: "server-east",
          name: "East",
          origin: "https://east.example.test",
          updatedAt: 1,
          sessions: [{ id: "session-a", name: "Remote task", state: "idle", pinned: false, archived: false, lastActivityAt: 1 }]
        }],
        selection: "all",
        onSelectionChange: vi.fn(),
        onRefresh: vi.fn(),
        onSwitch: vi.fn(),
        onOpenCachedSession: vi.fn(),
        onOpenMessageMatch: openRemoteMessage
      }
    });
    await enterQuery(container, "needle");
    await act(async () => vi.advanceTimersByTimeAsync(250));

    const result = [...container.querySelectorAll<HTMLButtonElement>(".conversation-search-result--remote button")]
      .find((button) => button.textContent?.includes("deployment needle") === true);
    expect(result).toBeDefined();
    expect(result?.textContent).toContain("machine.searchLive");
    await act(async () => result?.click());
    expect(openRemoteMessage).toHaveBeenCalledWith("remote-east", remoteMatch.match);
  });

  it("restores a late remote keyword page when hybrid has already started and then fails", async () => {
    vi.useFakeTimers();
    const keyword = deferred<readonly {
      readonly profileId: string;
      readonly serverId: string;
      readonly source: "live";
      readonly reachable: true;
      readonly match: SessionMessageSearchMatchView;
    }[]>();
    const hybrid = deferred<readonly never[]>();
    const remoteMatch = {
      profileId: "remote-east",
      serverId: "server-east",
      source: "live" as const,
      reachable: true as const,
      match: hit("late keyword needle", "late-keyword")
    };
    const { container } = await renderSidebar(async () => [], {
      onSearchRemoteMessages: (_query, mode) => mode === "keyword" ? keyword.promise : hybrid.promise,
      machineControl: remoteMachineControl()
    });
    await enterQuery(container, "needle");
    await act(async () => vi.advanceTimersByTimeAsync(900));
    await act(async () => keyword.resolve([remoteMatch]));
    await act(async () => hybrid.reject(new Error("semantic provider unavailable")));

    expect(container.textContent).toContain("late keyword needle");
    expect(container.textContent).not.toContain("nav.remoteMessageSearchFailed");
  });

  it("renders a live remote task that is not present in the last machine cache", async () => {
    vi.useFakeTimers();
    const match = {
      profileId: "remote-east",
      serverId: "server-east",
      source: "live" as const,
      reachable: true as const,
      match: { ...hit("needle from uncached task", "uncached-event"), sessionId: "uncached-session" }
    };
    const control = remoteMachineControl();
    const { container } = await renderSidebar(async () => [], {
      onSearchRemoteMessages: async () => [match],
      machineControl: { ...control, caches: [] }
    });
    await enterQuery(container, "needle");
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(container.textContent).toContain("needle from uncached task");
    expect(container.textContent).toContain("uncached-session");
  });

  it("portals the organizer menu from both its button and sidebar blank-space context menu", async () => {
    const { container } = await renderSidebar(async () => []);
    const trigger = container.querySelector<HTMLButtonElement>(".sidebar-list-settings > button[aria-haspopup='menu']");
    if (trigger === null) throw new Error("Sidebar organizer trigger was not rendered.");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      x: 220, y: 125, width: 28, height: 28, top: 125, right: 248, bottom: 153, left: 220,
      toJSON: () => ({})
    });

    await act(async () => trigger.click());
    let menu = document.body.querySelector<HTMLElement>(".sidebar-list-settings__menu");
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);

    await act(async () => menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.activeElement).toBe(trigger);
    expect(document.body.querySelector(".sidebar-list-settings__menu")).toBeNull();

    const scrollport = container.querySelector<HTMLElement>(".sidebar__sessions");
    if (scrollport === null) throw new Error("Sidebar session scrollport was not rendered.");
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 470 });
    await act(async () => scrollport.dispatchEvent(contextMenu));
    menu = document.body.querySelector<HTMLElement>(".sidebar-list-settings__menu");
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
  });
});

async function renderSidebar(
  onSearchMessages: SidebarProps["onSearchMessages"],
  overrides: Partial<Pick<SidebarProps, "machineControl" | "onSearchRemoteMessages">> = {}
): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const snapshot = {
    ...emptySnapshot(),
    revision: 1n,
    server: { name: "Orchestrator", version: "test", health: "healthy" as const },
    backends: [{
      id: "backend",
      name: "Backend",
      version: "1",
      health: "healthy" as const,
      capabilities: new Map()
    }],
    targets: [{
      id: "target-a",
      backendId: "backend",
      name: "Project A",
      workspaceId: "workspace-a",
      workspaceName: "Project A",
      trusted: true,
      pinned: false,
      archived: false
    }],
    sessions: [{
      id: "session-a",
      backendId: "backend",
      targetId: "target-a",
      name: "Release task",
      state: "idle" as const,
      permissionMode: "ask" as const,
      planMode: false,
      fastMode: false,
      pinned: false,
      archived: false,
      generation: 0n,
      updatedAt: 1
    }]
  };
  const noop = vi.fn();
  await act(async () => root.render(<Sidebar
    snapshot={snapshot}
    route={{ kind: "session" }}
    locale="en"
    messageSearchSort="relevance"
    sidebarOwnerId="owner"
    sidebarDisplayPreferences={DEFAULT_UI_PREFERENCES.sidebarDisplayPreferences}
    sidebarOwnerLayouts={DEFAULT_UI_PREFERENCES.sidebarOwnerLayouts}
    open
    mode="expanded"
    width={320}
    searchInputRef={createRef<HTMLInputElement>()}
    t={((key: string) => key) as Translator}
    probeRuntimeActivity={async () => false}
    onNavigate={noop}
    onNewTask={noop}
    onRename={noop}
    onPin={noop}
    onPinTarget={noop}
    onArchive={noop}
    onDelete={noop}
    onSearchMessages={onSearchMessages}
    {...overrides}
    onMessageSearchSortChange={noop}
    onSidebarDisplayPreferencesChange={noop}
    onSidebarOwnerLayoutChange={noop}
    onOpenMessageMatch={noop}
    onClose={noop}
    onHide={noop}
    onCollapse={noop}
    onExpand={noop}
    onResizePointerDown={noop}
    onResizePointerMove={noop}
    onResizePointerUp={noop}
    onResizePointerCancel={noop}
    onResizeKeyDown={noop}
    onResetWidth={noop}
    onDisconnect={noop}
  />));
  return { container };
}

async function enterQuery(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#conversation-search-input");
  if (input === null) throw new Error("Conversation search input was not rendered.");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTML input value setter is unavailable.");
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function changeSelect(container: HTMLElement, value: string): Promise<void> {
  const select = [...container.querySelectorAll<HTMLSelectElement>("select")]
    .find((candidate) => [...candidate.options].some((option) => option.value === value));
  if (select === undefined) throw new Error(`Select option ${value} was not rendered.`);
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTML select value setter is unavailable.");
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function hit(snippet: string, eventId: string): SessionMessageSearchMatchView {
  return {
    sessionId: "session-a",
    eventId,
    timelineItemId: `item-${eventId}`,
    role: "assistant",
    kind: "textMessage",
    snippet,
    score: 1,
    createdAt: 1
  };
}

function remoteMachineControl(): NonNullable<SidebarProps["machineControl"]> {
  return {
    profiles: [
      { id: "local", deviceId: "device-test", serverId: "server-local", name: "Local", origin: "http://127.0.0.1:4318"  },
      { id: "remote-east", deviceId: "device-test", serverId: "server-east", name: "East", origin: "https://east.example.test"  }
    ],
    activeProfile: { id: "local", deviceId: "device-test", serverId: "server-local", name: "Local", origin: "http://127.0.0.1:4318"  },
    presenceByProfile: { local: "current", "remote-east": "online" },
    caches: [{
      profileId: "remote-east",
      serverId: "server-east",
      name: "East",
      origin: "https://east.example.test",
      updatedAt: 1,
      sessions: [{ id: "session-a", name: "Remote task", state: "idle", pinned: false, archived: false, lastActivityAt: 1 }]
    }],
    selection: "all",
    onSelectionChange: vi.fn(),
    onRefresh: vi.fn(),
    onSwitch: vi.fn(),
    onOpenCachedSession: vi.fn(),
    onOpenMessageMatch: vi.fn()
  };
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
