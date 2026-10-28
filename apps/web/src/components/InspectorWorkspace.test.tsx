// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AppSnapshot, type SessionView, type TerminalView, type TerminalPaletteView } from "../model.js";
import { InspectorWorkspace } from "./InspectorWorkspace.js";
import type { Translator } from "./types.js";

vi.mock("./InteractiveTerminalPanel.js", () => ({ InteractiveTerminalPanel: ({ terminalId }: { terminalId: string }) => <input aria-label={`buffer-${terminalId}`} defaultValue="initial" /> }));
vi.mock("../terminal-appearance.js", () => ({ readTerminalAppearance: () => ({ palette: { ansiRgb: Array(16).fill(0), foregroundRgb: 1, backgroundRgb: 0, cursorRgb: 1 }, theme: {} }) }));
const roots: Root[] = [];
const t: Translator = (key, values) => translate("en", key, values);
beforeAll(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren(); window.localStorage.clear(); Reflect.deleteProperty(window, "jokoDesktop"); vi.restoreAllMocks();
});

describe("Inspector workspace production integration", () => {
  it("keeps native window subscriptions behind the advertised Inspector capabilities", async () => {
    const h = await fixture([], ["navigation.deepLinks"]);
    expect(h.onClosed).not.toHaveBeenCalled();
    expect([...h.host.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === t("context.title"))).toBe(true);
    await click(h.host, `button[aria-label="${t("a11y.inspectorTabActions")}"]`);
    expect([...h.host.querySelectorAll('[role="menuitem"]')].some(item => item.textContent === t("inspector.detachTab"))).toBe(false);
  });

  it("moves a terminal between four-edge groups without losing its mounted buffer, then creates in that group", async () => {
    const h = await fixture();
    const buffer = h.host.querySelector<HTMLInputElement>('[aria-label="buffer-terminal-one"]')!; buffer.value = "unsent local buffer";
    await click(h.host, "[role=tab]", "Shell one");
    await menu(h.host, t("inspector.group.bottom"));
    const bottom = h.host.querySelector<HTMLElement>('[data-edge="bottom"]')!;
    expect(bottom.querySelector('[aria-label="buffer-terminal-one"]')).toBe(buffer); expect(buffer.value).toBe("unsent local buffer");
    await click(bottom, `button[aria-label="${t("inspector.addTab")}"]`);
    await click(bottom, "[role=menuitem]", t("terminal.new")); await settle();
    expect(h.createTerminal).toHaveBeenCalledWith("one", expect.any(String), "auto", 80, 24, expect.any(Object));
    expect(bottom.querySelector('[aria-label="buffer-terminal-created"]')).not.toBeNull();
  });

  it("retains the original task across selection changes, merges two tabs, and keeps failed closes in their window", async () => {
    const first = child("1"), second = child("2"), h = await fixture([first, second]);
    await click(h.host, "[role=tab]", "Shell one"); await menu(h.host, t("inspector.detachTab")); await settle();
    expect(first.ready).toHaveBeenCalledOnce();
    const originalBuffer = first.document.querySelector<HTMLInputElement>('[aria-label="buffer-terminal-one"]')!; originalBuffer.value = "kept across owner switch";
    await click(h.host, "[role=tab]", t("context.title")); await menu(h.host, t("inspector.detachTab")); await settle();
    expect(second.ready).toHaveBeenCalledOnce();
    await menu(first.document.body, t("inspector.moveToWindow", { name: t("context.title") })); await settle();
    expect(second.document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(second.document.querySelector('[aria-label="buffer-terminal-one"]')).toBe(originalBuffer);
    expect(originalBuffer.value).toBe("kept across owner switch");
    await h.render("two");
    expect(second.document.querySelector('[aria-label="buffer-terminal-one"]')).toBe(originalBuffer);
    h.closeTerminal.mockRejectedValueOnce(new Error("close result unknown"));
    await act(async () => { second.requestClose(); }); await settle();
    expect(h.closeTerminal).toHaveBeenCalledWith("one", "terminal-one", 1n);
    expect(second.close).not.toHaveBeenCalled();
    expect(second.document.querySelector('[role="alert"]')?.textContent).toContain("close result unknown");
    await act(async () => { second.requestClose(); }); await settle();
    expect(second.close).toHaveBeenCalledWith("user");
    expect(h.host.querySelector('[aria-label="buffer-terminal-two"]')).not.toBeNull();
  });

  it("returns crashed child tabs only to the same source and retires them when that source generation changes", async () => {
    const window = child("3"), replacement = child("4"), h = await fixture([window, replacement]);
    await menu(h.host, t("inspector.detachGroup")); await settle();
    await act(async () => { h.notifyClosed(window.occurrence, "child-failure"); }); await settle();
    expect(h.host.querySelector('[aria-label="buffer-terminal-one"]')).not.toBeNull();
    await menu(h.host, t("inspector.detachGroup")); await settle();
    // A new native generation may not inherit the old window's mounts.
    h.snapshot.sessions = h.snapshot.sessions.map(session => session.id === "one" ? { ...session, generation: 2n } : session);
    await h.render("two"); await settle();
    expect(replacement.close).toHaveBeenCalledWith("passive");
    expect(h.host.querySelector('[aria-label="buffer-terminal-two"]')).not.toBeNull();
    expect(h.host.querySelector('[aria-label="buffer-terminal-one"]')).toBeNull();
  });
});

function task(id: string): SessionView { return { id, backendId: "backend", targetId: "target", name: id, state: "idle", pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1 }; }
function terminal(sessionId: string, suffix = sessionId): TerminalView { return { id: `terminal-${suffix}`, sessionId, targetId: "target", generation: 1n, status: "running", exitConfirmed: false, shellId: "auto", shellLabel: `Shell ${suffix}`, cwd: "D:/project", columns: 80, rows: 24, createdAt: 1, updatedAt: 1 }; }
function child(index: string) {
  const frame = document.body.appendChild(document.createElement("iframe")), window = frame.contentWindow!, occurrence = `${index.repeat(8)}-${index.repeat(4)}-4${index.repeat(3)}-8${index.repeat(3)}-${index.repeat(12)}`;
  let requestClose = (): void => undefined;
  const ready = vi.fn(async () => undefined), close = vi.fn(async () => undefined);
  Object.defineProperty(window, "jokoInspectorDesktop", { configurable: true, value: { platform: "win32", window: {
    identity: async () => occurrence, ready, close, minimize: async () => undefined, toggleMaximize: async () => false,
    onCloseRequested: (callback: () => void) => { requestClose = callback; return () => { requestClose = () => undefined; }; }
  }, selectionContextMenu: { onAddToChat: () => () => undefined } } satisfies JokoInspectorDesktopApi });
  return { window, document: window.document, occurrence, ready, close, requestClose: () => requestClose() };
}
async function fixture(children: readonly ReturnType<typeof child>[] = [], capabilities: readonly string[] = ["inspector.detach", "inspector.tabs"]) {
  const snapshot = { ...emptySnapshot(), sessions: [task("one"), task("two")] } as AppSnapshot & { sessions: SessionView[] };
  const state = { activeProfile: { id: "profile", deviceId: "device", serverId: "node", name: "Node", origin: "http://127.0.0.1:4315" }, connectionGeneration: 1,
    ready: false, connectionState: "connected", preferences: DEFAULT_UI_PREFERENCES, effectiveLocale: "en", snapshot, route: { kind: "session", sessionId: "one" } };
  const createTerminal = vi.fn(async (sessionId: string, _requestId: string, _shellId: string, _columns: number, _rows: number, _palette: TerminalPaletteView) => terminal(sessionId, "created")),
    closeTerminal = vi.fn(async (_sessionId: string, _terminalId: string, _generation: bigint) => undefined);
  const controller = { state, createTerminal, closeTerminal, setInspectorOpen: vi.fn(async () => undefined), releaseArtifactUrl: vi.fn(),
    getTerminalCapabilities: vi.fn(async () => ({ support: "supported", shells: [{ id: "auto", label: "Auto" }], defaultShellId: "auto", maximumTerminals: 8, maximumInputBytes: 32_768, maximumColumns: 500, maximumRows: 300 })),
    listTerminals: vi.fn(async (sessionId: string) => [terminal(sessionId)]), getTerminal: vi.fn(async (sessionId: string) => terminal(sessionId)) } as unknown as AppController;
  const listeners = new Set<(event: { occurrence: string; reason: "user" | "child-failure" }) => void>();
  const onClosed = vi.fn((listener: (event: { occurrence: string; reason: "user" | "child-failure" }) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { capabilities, inspectorWindow: { activate: vi.fn(async () => true), onClosed } } });
  const queue = [...children]; vi.spyOn(window, "open").mockImplementation(() => queue.shift()?.window ?? null);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  const host = document.body.appendChild(document.createElement("div")); host.className = "app";
  const root = createRoot(host); roots.push(root);
  const render = async (id: string): Promise<void> => { state.route.sessionId = id; await act(async () => root.render(<InspectorWorkspace controller={controller} snapshot={snapshot} session={snapshot.sessions.find(session => session.id === id)} timeline={[]} open t={t} runAction={(_key, action) => { void action().catch(() => undefined); }} onClose={() => undefined} onSelectionQuote={() => undefined} />)); await settle(); };
  await render("one");
  return { host, render, snapshot, createTerminal, closeTerminal, onClosed, notifyClosed: (occurrence: string, reason: "user" | "child-failure") => { for (const listener of listeners) listener({ occurrence, reason }); } };
}
async function click(root: ParentNode, selector: string, text?: string): Promise<void> {
  const button = [...root.querySelectorAll<HTMLButtonElement>(selector)].find(candidate => text === undefined || candidate.textContent === text);
  expect(button, `${selector}: ${text ?? ""}`).toBeDefined(); await act(async () => button!.click());
}
async function menu(root: ParentNode, item: string): Promise<void> { await click(root, `button[aria-label="${t("a11y.inspectorTabActions")}"]`); await click(root, '[role="menuitem"]', item); }
async function settle(): Promise<void> { await act(async () => { for (let index = 0; index < 24; index++) await Promise.resolve(); }); }
