// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sortableMock = vi.hoisted(() => {
  class MockSortable {
    static active: MockSortable | null = null;
    static readonly instances: MockSortable[] = [];
    readonly destroy = vi.fn();
    readonly option = vi.fn();
    constructor(readonly element: HTMLElement, readonly options: Record<string, unknown>) {}
    static create(element: HTMLElement, options: Record<string, unknown>): MockSortable {
      const instance = new MockSortable(element, options);
      MockSortable.instances.push(instance);
      return instance;
    }
  }
  return { MockSortable };
});

vi.mock("sortablejs", () => ({ default: sortableMock.MockSortable }));

import type { AppController } from "../controller.js";
import type { GamepadInspectorRequest } from "../gamepad-actions.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { readTerminalShellPreference, writeTerminalShellPreference } from "../terminal-preferences.js";
import { emptySnapshot, type BackendView, type BrowserView, type SessionView, type TerminalCapabilitiesView } from "../model.js";
import { Inspector } from "./Inspector.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => translate("en", key, values);
vi.mock("./InteractiveTerminalPanel.js", () => ({ InteractiveTerminalPanel: ({ terminalId }: { terminalId: string }) => <textarea aria-label={terminalId} className="xterm-helper-textarea" /> }));

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  document.documentElement.style.removeProperty("--inspector-width");
  sortableMock.MockSortable.instances.length = 0;
  sortableMock.MockSortable.active = null;
});

describe("Inspector menus", () => {
  it("uses the touch-capable sortable owner and commits tab order back through React", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const controller = {
      state: { preferences: DEFAULT_UI_PREFERENCES },
      releaseArtifactUrl: vi.fn()
    } as unknown as AppController;
    await act(async () => root.render(<Inspector
      controller={controller}
      snapshot={emptySnapshot()}
      session={session()}
      timeline={[]}
      open
      t={t}
      runAction={(_key, action) => { void action(); }}
      onClose={vi.fn()}
      onSelectionQuote={vi.fn()}
    />));
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`)!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent === t("nav.tools"))!.click());
    await settle();

    const sortable = sortableMock.MockSortable.instances[0]!;
    expect(sortable.options).toMatchObject({ forceFallback: true, fallbackTolerance: 4 });
    expect(sortable.options.filter).toContain(".inspector-tab__close");
    const moved = sortable.element.children[0] as HTMLElement;
    sortable.element.append(moved);
    await act(async () => (sortable.options.onEnd as (event: Record<string, unknown>) => void)({
      item: moved,
      from: sortable.element,
      oldIndex: 0,
      newIndex: 1
    }));
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((tab) => tab.id)).toEqual([
      "inspector-tab-tools",
      "inspector-tab-context"
    ]);
  });

  it("observes existing terminals while creation is unavailable and selects the session's automatic shell without changing the saved preference", async () => {
    const colors = vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: () => "#123456" } as unknown as CSSStyleDeclaration);
    writeTerminalShellPreference("powershell-local");
    let capability: TerminalCapabilitiesView = { support: "platformLimited", reason: "Remote host is disconnected.", shells: [], defaultShellId: "",
      maximumTerminals: 16, maximumInputBytes: 65_536, maximumColumns: 500, maximumRows: 200 };
    const record = (id: string) => ({ id, sessionId: "session-one", targetId: "target-one", generation: 1n, status: "running", exitConfirmed: false,
      shellId: "/bin/bash", shellLabel: "Bash", cwd: "/workspace", columns: 80, rows: 24, createdAt: 1, updatedAt: 1 });
    const records = [record("existing-terminal")];
    const listTerminals = vi.fn(async () => [...records]);
    const createTerminal = vi.fn(async () => { const value = record("new-terminal"); records.push(value); return value; });
    const api = { state: { connectionState: "connected", preferences: DEFAULT_UI_PREFERENCES },
      getTerminalCapabilities: vi.fn(async () => capability), listTerminals, createTerminal, setInspectorOpen: vi.fn(async () => undefined), releaseArtifactUrl: vi.fn()
    } as unknown as AppController;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host); roots.push(root);
    const render = async (connected = true) => act(async () => root.render(<Inspector controller={{ ...api, state: { ...api.state, connectionState: connected ? "connected" : "reconnecting" } }}
      snapshot={emptySnapshot()} session={session()} timeline={[]} open t={t} runAction={() => undefined} onClose={vi.fn()} onSelectionQuote={vi.fn()} />));
    const openMenu = async () => act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`)!.click());
    const createButton = () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === t("terminal.new"))!;
    await render();
    expect(listTerminals).toHaveBeenCalledOnce();
    const screen = host.querySelector('textarea[aria-label="existing-terminal"]');
    expect(screen).not.toBeNull();
    expect(host.textContent).toContain("Remote host is disconnected.");
    await openMenu();
    expect(createButton().disabled).toBe(true);
    await act(async () => createButton().click());
    expect(createTerminal).not.toHaveBeenCalled();
    await openMenu();
    capability = { ...capability, support: "supported", reason: undefined, shells: [{ id: "/bin/bash", label: "Bash" }], defaultShellId: "/bin/bash" };
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === t("common.retry"))!.click());
    expect(host.querySelector('textarea[aria-label="existing-terminal"]')).toBe(screen);
    expect(host.textContent).not.toContain("Remote host is disconnected.");
    await openMenu();
    await act(async () => createButton().click());
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith("session-one", expect.any(String), "auto", 80, 24, expect.anything());
    expect(readTerminalShellPreference()).toBe("powershell-local");
    capability = { ...capability, support: "platformLimited", reason: "Remote host is disconnected.", shells: [] };
    await render(false); await render(true);
    expect(listTerminals).toHaveBeenCalledTimes(3);
    expect(host.querySelectorAll('[data-tab-kind="terminal"]')).toHaveLength(2);
    expect(host.querySelector('textarea[aria-label="existing-terminal"]')).toBe(screen);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", key: "`", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(host.querySelector('[data-tab-kind="terminal"]:not([hidden])')?.id).toBe("inspector-panel-existing-terminal");
    expect(createTerminal).toHaveBeenCalledOnce();
    colors.mockRestore();
  });

  it("creates independent terminals, focuses an existing terminal by shortcut, and kills only an explicitly closed tab", async () => {
    writeTerminalShellPreference("shell");
    let color = "#123456";
    const colors = vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: () => color } as unknown as CSSStyleDeclaration);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const record = (id: string) => ({ id, sessionId: "session-one", targetId: "target-one", generation: 1n, status: "running", exitConfirmed: false, shellId: "shell", shellLabel: "Shell", cwd: "/workspace", columns: 80, rows: 24, createdAt: 1, updatedAt: 1 });
    const createTerminal = vi.fn().mockRejectedValueOnce(new Error("spawn unavailable")).mockResolvedValueOnce(record("pty-one")).mockResolvedValueOnce(record("pty-two"));
    const closeTerminal = vi.fn().mockRejectedValueOnce(new Error("close unavailable")).mockResolvedValue(undefined);
    const controller = {
      state: { connectionState: "connected", preferences: DEFAULT_UI_PREFERENCES },
      getTerminalCapabilities: vi.fn(async () => ({ support: "supported", shells: [{ id: "shell", label: "Shell" }], defaultShellId: "shell", maximumTerminals: 16, maximumInputBytes: 65536, maximumColumns: 500, maximumRows: 200 })),
      listTerminals: vi.fn(async () => []), createTerminal, closeTerminal, setInspectorOpen: vi.fn(async () => undefined), releaseArtifactUrl: vi.fn()
    } as unknown as AppController;
    const render = async (open: boolean) => act(async () => root.render(<Inspector controller={{ ...controller }} snapshot={{ ...emptySnapshot(), backends: [backend(false)] }} session={session()} timeline={[]} open={open} t={t} runAction={(_key, action) => { void action(); }} onClose={vi.fn()} onSelectionQuote={vi.fn()} />));
    const shortcut = async () => act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", key: "`", ctrlKey: true, bubbles: true, cancelable: true })));
    await render(true);
    await shortcut();
    expect(host.textContent).toContain("spawn unavailable");
    color = "#654321";
    writeTerminalShellPreference("auto");
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === t("common.retry"))!.click());
    await settle();
    expect(createTerminal.mock.calls[0]?.[1]).toBe(createTerminal.mock.calls[1]?.[1]);
    expect(createTerminal.mock.calls[0]?.[2]).toBe("shell");
    expect(createTerminal.mock.calls[1]?.[2]).toBe("shell");
    expect(createTerminal.mock.calls[0]?.[5]).toBe(createTerminal.mock.calls[1]?.[5]);
    expect(createTerminal.mock.calls[1]?.[5].foregroundRgb).toBe(0x123456);
    expect(host.querySelectorAll('[data-tab-kind="terminal"]')).toHaveLength(1);
    await shortcut();
    expect(createTerminal).toHaveBeenCalledTimes(2);
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`)!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((button) => button.textContent === t("terminal.new"))!.click());
    await settle();
    expect(host.querySelectorAll('[data-tab-kind="terminal"]')).toHaveLength(2);
    expect(createTerminal.mock.calls[2]?.[2]).toBe("auto");
    await render(false);
    expect(closeTerminal).not.toHaveBeenCalled();
    await render(true);
    await shortcut();
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    expect(host.querySelector('[data-tab-kind="terminal"]:not([hidden])')?.id).toBe("inspector-panel-pty-one");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("pty-one");
    expect(createTerminal).toHaveBeenCalledTimes(3);
    expect(controller.getTerminalCapabilities).toHaveBeenCalledTimes(1);
    const close = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("terminal.close")}"]`)!;
    await act(async () => close().click());
    expect(host.querySelectorAll('[data-tab-kind="terminal"]')).toHaveLength(2);
    expect(host.textContent).toContain("close unavailable");
    await act(async () => close().click());
    expect(closeTerminal).toHaveBeenLastCalledWith("session-one", "pty-one", 1n);
    expect(host.querySelectorAll('[data-tab-kind="terminal"]')).toHaveLength(1);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(closeTerminal).toHaveBeenCalledTimes(2);
    colors.mockRestore();
  });

  it("focuses menu items, supports arrow navigation, and restores focus on Escape", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const base = emptySnapshot();
    const controller = {
      state: { preferences: DEFAULT_UI_PREFERENCES },
      releaseArtifactUrl: vi.fn()
    } as unknown as AppController;
    await act(async () => root.render(<Inspector
      controller={controller}
      snapshot={{ ...base, browsers: [browser()] }}
      session={session()}
      timeline={[]}
      open
      t={t}
      runAction={(_key, action) => { void action(); }}
      onClose={vi.fn()}
      onSelectionQuote={vi.fn()}
    />));

    const trigger = host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`);
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    await settle();

    const items = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    expect(items.length).toBeGreaterThan(1);
    expect(document.activeElement).toBe(items[0]);

    await act(async () => items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(items[1]);

    await act(async () => items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("offers the runtime shell only while the owning Backend advertises it", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    const base = emptySnapshot();
    const controller = {
      state: { preferences: DEFAULT_UI_PREFERENCES },
      releaseArtifactUrl: vi.fn(),
      executeUserShell: vi.fn(),
      abortUserShell: vi.fn()
    } as unknown as AppController;
    const render = async (supported: boolean): Promise<void> => act(async () => root.render(<Inspector
      controller={controller}
      snapshot={{ ...base, backends: [backend(supported)] }}
      session={session()}
      timeline={[]}
      open
      t={t}
      runAction={(_key, action) => { void action(); }}
      onClose={vi.fn()}
      onSelectionQuote={vi.fn()}
    />));

    await render(true);
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`)?.click());
    const shellItem = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((candidate) => candidate.textContent?.includes(t("composer.shell")));
    expect(shellItem).not.toBeUndefined();
    await act(async () => shellItem?.click());
    expect(host.querySelector(".inspector-shell-panel textarea")).not.toBeNull();

    await render(false);
    expect(host.querySelector(".inspector-shell-panel textarea")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.addTab")}"]`)?.click());
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .some((candidate) => candidate.textContent?.includes(t("composer.shell")))).toBe(false);
  });

  it("binds gamepad terminal, browser and changes commands to the exact current task", async () => {
    const colors = vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: () => "#123456" } as unknown as CSSStyleDeclaration);
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host); roots.push(root);
    const base = emptySnapshot();
    const snapshot = { ...base, sessions: [session()], browsers: [browser()], backends: [{ ...backend(false), capabilities: new Map([
      ["workspace.diff.sources", { name: "workspace.diff.sources", supported: true, options: [] }]
    ]) }] };
    const record = { id: "terminal-one", sessionId: "session-one", targetId: "target-one", generation: 1n, status: "running" as const,
      exitConfirmed: false, shellId: "auto", shellLabel: "Shell", cwd: "/workspace", columns: 80, rows: 24, createdAt: 1, updatedAt: 1 };
    const createTerminal = vi.fn(async () => record);
    const openBrowserPage = vi.fn(async () => "page-one");
    const setInspectorOpen = vi.fn(async () => undefined);
    const consumed = vi.fn();
    const errors: unknown[] = [];
    const controller = { state: { connectionState: "connected", activeProfile: { id: "profile", serverId: "server" }, snapshot, preferences: DEFAULT_UI_PREFERENCES },
      getTerminalCapabilities: vi.fn(async () => ({ support: "supported", shells: [{ id: "auto", label: "Shell" }], defaultShellId: "auto", maximumTerminals: 16,
        maximumInputBytes: 65536, maximumColumns: 500, maximumRows: 200 })),
      listTerminals: vi.fn(async () => []), createTerminal, openBrowserPage, setInspectorOpen, releaseArtifactUrl: vi.fn()
    } as unknown as AppController;
    const request = (requestId: number, action: GamepadInspectorRequest["action"], sessionGeneration = 1n): GamepadInspectorRequest => ({
      requestId, action, sessionId: "session-one", sessionGeneration, connectionGeneration: snapshot.generation, profileId: "profile"
    });
    const render = async (gamepadRequest?: GamepadInspectorRequest): Promise<void> => act(async () => root.render(<Inspector
      controller={controller} snapshot={snapshot} session={session()} timeline={[]} open t={t} gamepadRequest={gamepadRequest}
      onGamepadRequestConsumed={consumed} runAction={(_key, action) => { void action().catch((error) => errors.push(error)); }}
      onClose={vi.fn()} onSelectionQuote={vi.fn()} />));
    await render(); await settle();
    await render(request(1, "open-terminal", 2n));
    expect(createTerminal).not.toHaveBeenCalled();
    await render(request(2, "open-terminal")); await settle();
    expect(createTerminal).toHaveBeenCalledExactlyOnceWith("session-one", expect.any(String), "auto", 80, 24, expect.anything());
    await render(request(3, "open-browser-tab")); await settle();
    expect(openBrowserPage).toHaveBeenCalledExactlyOnceWith("browser-one", "session-one", "about:blank");
    expect(host.querySelector('[data-tab-kind="browser"]:not([hidden])')).not.toBeNull();
    await render(request(4, "toggle-review-tab")); await settle();
    expect(host.querySelector('[data-tab-kind="changes"]:not([hidden])')).not.toBeNull();
    await render(request(5, "toggle-review-tab")); await settle();
    expect(host.querySelector('[data-tab-kind="changes"]')).toBeNull();
    expect(consumed.mock.calls.map(([id]) => id)).toEqual([1, 2, 3, 4, 5]);
    expect(errors).toEqual([]);
    colors.mockRestore();
  });
});

function session(): SessionView {
  return {
    id: "session-one",
    backendId: "backend-one",
    targetId: "target-one",
    name: "Task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1
  };
}

function browser(): BrowserView {
  return {
    id: "browser-one",
    name: "Browser",
    state: "ready",
    generation: 1n,
    pages: []
  };
}

function backend(shellSupported: boolean): BackendView {
  return {
    id: "backend-one",
    name: "Backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["runtime.user_shell", { name: "runtime.user_shell", supported: shellSupported, options: [] }]
    ])
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}
