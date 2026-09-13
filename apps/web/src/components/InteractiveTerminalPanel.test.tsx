// @vitest-environment jsdom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { TerminalAppearanceView, TerminalCapabilitiesView, TerminalUpdateView, TerminalView } from "../model.js";
import { InteractiveTerminalPanel } from "./InteractiveTerminalPanel.js";

const mocks = vi.hoisted(() => ({ terminals: [] as any[], fit: vi.fn(), links: [] as ((event: MouseEvent, uri: string) => void)[] }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options: any; cols = 90; rows = 30; input = (_data: string) => {}; key = (_event: KeyboardEvent) => true;
  selection = ""; write = vi.fn((_data: string, parsed?: () => void) => parsed?.()); reset = vi.fn(); dispose = vi.fn(); focus = vi.fn(() => this.element?.querySelector("textarea")?.focus()); element: HTMLElement | undefined; resize = vi.fn();
  parser = { registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })), registerDcsHandler: vi.fn(() => ({ dispose: vi.fn() })), registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
  constructor(options: any) { this.options = options; mocks.terminals.push(this); }
  open(slot: HTMLElement) { this.element = slot; slot.appendChild(slot.ownerDocument.createElement("textarea")).className = "xterm-helper-textarea"; }
  loadAddon() {} attachCustomKeyEventHandler(handler: typeof this.key) { this.key = handler; }
  onData(handler: typeof this.input) { this.input = handler; return { dispose: vi.fn() }; }
  hasSelection() { return this.selection !== ""; } getSelection() { return this.selection; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = mocks.fit; } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class { constructor(handler: (event: MouseEvent, uri: string) => void) { mocks.links.push(handler); } } }));

let root: Root | undefined;
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  mocks.terminals.splice(0); mocks.links.splice(0); mocks.fit.mockClear();
});

const capabilities: TerminalCapabilitiesView = { support: "supported", shells: [{ id: "shell", label: "Shell" }], defaultShellId: "shell", maximumTerminals: 16, maximumInputBytes: 5, maximumColumns: 500, maximumRows: 200 };
const initial: TerminalView = { id: "terminal-one", sessionId: "session-one", targetId: "target-one", generation: 1n, status: "running", exitConfirmed: false, shellId: "shell", shellLabel: "Shell", cwd: "/workspace", columns: 80, rows: 24, createdAt: 1, updatedAt: 1 };
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate("en", key, values);

it("waits for the live appearance acknowledgement, replays current overrides after queued theme changes and retires old connections", async () => {
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn(); });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  let color = "#123456";
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: () => color, fontFamily: "monospace", fontSize: "14px" } as unknown as CSSStyleDeclaration);
  const watches: { update: (frame: TerminalUpdateView) => Promise<void>; signal: AbortSignal; appearance: TerminalAppearanceView }[] = [];
  let acceptFirst!: () => void;
  const updateAppearance = vi.fn(async (_session: string, _id: string, _generation: bigint, appearance: TerminalAppearanceView, _claim: boolean, expected: bigint) => {
    const first = updateAppearance.mock.calls.length === 1;
    if (first) await new Promise<void>((resolve) => { acceptFirst = resolve; });
    return { accepted: !first, acceptedViewRevision: first ? 1n : appearance.viewRevision, appearanceRevision: first ? 3n : expected + 1n, ownsDefaults: !first };
  });
  const api = {
    getTerminal: vi.fn(async () => initial),
    watchTerminal: vi.fn(async (_session: string, _id: string, _generation: bigint, appearance: TerminalAppearanceView, update: (frame: TerminalUpdateView) => Promise<void>, _cursor: bigint | undefined, signal: AbortSignal) => {
      watches.push({ update, signal, appearance });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }),
    updateTerminalAppearance: updateAppearance, writeTerminal: vi.fn(async () => undefined), resizeTerminal: vi.fn(async () => undefined),
    openHttpLink: vi.fn(async () => undefined)
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const render = async (methods = api, currentCapabilities = capabilities) => act(async () => root!.render(<InteractiveTerminalPanel controller={{ ...methods, state: { connectionState: "connected", activeProfile: { id: "profile", serverId: "server" } } } as unknown as AppController} sessionId="session-one" terminalId="terminal-one" active capabilities={currentCapabilities} t={t} onState={vi.fn()} />));
  await render();
  const terminal = mocks.terminals[0]!;
  expect(watches[0]!.appearance.palette.foregroundRgb).toBe(0x123456);
  expect(terminal.options.disableStdin).toBe(true);
  let first!: Promise<void>;
  await act(async () => { first = watches[0]!.update({ kind: "reset", terminal: initial, sequence: 1n, appearanceRevision: 1n, activeColorOverrides: "", data: "screen" }); });
  expect(updateAppearance).toHaveBeenCalledTimes(1);
  await act(async () => terminal.input("before ack"));
  expect(api.writeTerminal).not.toHaveBeenCalled();
  await act(async () => { acceptFirst(); await first; });
  expect(terminal.options.disableStdin).toBe(false);
  expect(updateAppearance.mock.calls[0]?.[3].viewRevision).toBe(updateAppearance.mock.calls[1]?.[3].viewRevision);
  expect(updateAppearance.mock.calls[1]?.[5]).toBe(3n);
  const readOnlyCapabilities: TerminalCapabilitiesView = { ...capabilities, support: "disabledByPolicy", reason: "This task only permits review reads." };
  await render(api, readOnlyCapabilities);
  expect(terminal.options.disableStdin).toBe(true);
  expect(host.textContent).toContain(readOnlyCapabilities.reason);
  await act(async () => terminal.input("read-only input"));
  await act(async () => watches[0]!.update({ kind: "state", terminal: initial, sequence: 2n, appearanceRevision: 1n, data: "" }));
  expect(terminal.options.disableStdin).toBe(true);
  expect(api.writeTerminal).not.toHaveBeenCalled();
  expect(terminal.dispose).not.toHaveBeenCalled();
  await render();
  expect(terminal.options.disableStdin).toBe(false);
  const override = "\x1b]11;rgb:1111/2222/3333\x1b\\";
  let parsed!: () => void;
  terminal.write.mockImplementationOnce((_data: string, done: () => void) => { parsed = done; });
  let output!: Promise<void>;
  await act(async () => { output = watches[0]!.update({ kind: "output", sequence: 2n, appearanceRevision: 2n, activeColorOverrides: override, data: override }); });
  color = "#654321";
  await act(async () => document.documentElement.setAttribute("data-theme", "dark"));
  expect(terminal.options.theme.background).toBe("#123456");
  await act(async () => { parsed(); await output; });
  expect(terminal.options.theme.background).toBe("#654321");
  expect(terminal.write).toHaveBeenLastCalledWith(override, expect.any(Function));
  expect(updateAppearance.mock.calls.at(-1)?.[4]).toBe(false);
  expect(updateAppearance.mock.calls.at(-1)?.[3].palette.foregroundRgb).toBe(0x654321);
  let releaseBackground!: () => void;
  updateAppearance.mockImplementationOnce(async (_session, _id, _generation, appearance) => new Promise((resolve) => {
    releaseBackground = () => resolve({ accepted: true, acceptedViewRevision: appearance.viewRevision, appearanceRevision: 90n, ownsDefaults: false });
  }));
  color = "#102030";
  await act(async () => document.documentElement.setAttribute("data-theme", "queued"));
  await act(async () => terminal.input("retired focus input"));
  const outside = document.body.appendChild(document.createElement("button"));
  await act(async () => outside.focus());
  await act(async () => terminal.focus());
  const beforeClaim = updateAppearance.mock.calls.length;
  await act(async () => releaseBackground());
  expect(updateAppearance.mock.calls.length).toBe(beforeClaim + 1);
  expect(api.writeTerminal).not.toHaveBeenCalled();
  await act(async () => terminal.input("ok"));
  expect(api.writeTerminal).toHaveBeenCalledWith("session-one", "terminal-one", 1n, expect.any(String), 1n, "ok", expect.any(AbortSignal));
  let rejectOld!: (reason: Error) => void;
  updateAppearance.mockImplementationOnce(async () => new Promise((_, reject) => { rejectOld = reject; }));
  color = "#abcdef";
  await act(async () => document.documentElement.setAttribute("data-theme", "light"));
  expect(terminal.options.disableStdin).toBe(true);
  const other = { ...api, watchTerminal: vi.fn(api.watchTerminal.getMockImplementation()!) };
  await render(other);
  expect(watches[0]!.signal.aborted).toBe(true);
  expect(watches[1]!.appearance.viewId).not.toBe(watches[0]!.appearance.viewId);
  await act(async () => rejectOld(new Error("old appearance failure")));
  expect(host.textContent).not.toContain("old appearance failure");
  expect(mocks.terminals[1]!.options.disableStdin).toBe(true);
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(watches[1]!.signal.aborted).toBe(true);
  await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  expect(watches).toHaveLength(3);
  expect(watches[2]!.appearance.viewId).not.toBe(watches[1]!.appearance.viewId);
  const ended = { ...initial, status: "exited" as const, exitConfirmed: true, exitCode: 0 };
  const beforeEnded = updateAppearance.mock.calls.length;
  await act(async () => watches[2]!.update({ kind: "reset", terminal: ended, sequence: 3n, appearanceRevision: 3n, activeColorOverrides: "", data: "finished" }));
  expect(updateAppearance.mock.calls).toHaveLength(beforeEnded);
  expect(host.textContent).toContain(t("terminal.restart"));
  await render(other, readOnlyCapabilities);
  expect([...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.restart")))?.disabled).toBe(true);
  await render(other);
  expect([...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.restart")))?.disabled).toBe(false);
  expect(host.textContent).not.toContain("Terminal view retired");
  expect(mocks.terminals[1]!.options.disableStdin).toBe(true);
  const readOnlyConnection = { ...api, watchTerminal: vi.fn(api.watchTerminal.getMockImplementation()!) };
  const appearanceCalls = updateAppearance.mock.calls.length;
  await render(readOnlyConnection, readOnlyCapabilities);
  await act(async () => watches.at(-1)!.update({ kind: "reset", terminal: initial, sequence: 4n, appearanceRevision: 3n, activeColorOverrides: "", data: "read-only checkpoint" }));
  expect(mocks.terminals.at(-1)!.write).toHaveBeenCalledWith("read-only checkpoint", expect.any(Function));
  expect(mocks.terminals.at(-1)!.options.disableStdin).toBe(true);
  expect(updateAppearance).toHaveBeenCalledTimes(appearanceCalls);
  expect(host.textContent).toContain(readOnlyCapabilities.reason);
  expect(host.textContent).not.toContain(t("terminal.reconnecting"));
  await render(readOnlyConnection);
  expect(mocks.terminals.at(-1)!.options.disableStdin).toBe(false);
  document.documentElement.removeAttribute("data-theme");
});

it("owns the emulator, ordered input and recovery while hidden, reattached or restarted without closing the process", async () => {
  const observe = vi.fn();
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({ getPropertyValue: (name: string) => (element as HTMLElement).style.getPropertyValue(name) || "#123456", fontFamily: "monospace", fontSize: "14px" }) as CSSStyleDeclaration);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class { observe = observe; disconnect = vi.fn(); });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(720);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(420);
  const clipboard = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: clipboard });
  const watches: { update: (value: TerminalUpdateView) => void; fail: (reason: Error) => void; signal: AbortSignal; after?: bigint }[] = [];
  let descriptor = initial;
  const restartedRequests = new Set<string>();
  let restartSpawns = 0;
  let loseNextRestartAcknowledgement = true;
  let finishFirst!: () => void;
  const writeTerminal = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; })).mockResolvedValue(undefined);
  const methods = {
    getTerminal: vi.fn(async () => descriptor),
    watchTerminal: vi.fn(async (_session: string, _id: string, _generation: bigint, _appearance: TerminalAppearanceView, update: (value: TerminalUpdateView) => void, after: bigint | undefined, signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        watches.push({ update, fail: reject, signal, ...(after === undefined ? {} : { after }) });
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    updateTerminalAppearance: vi.fn(async (_session: string, _id: string, _generation: bigint, appearance: TerminalAppearanceView) => ({ accepted: true, acceptedViewRevision: appearance.viewRevision, appearanceRevision: 1n, ownsDefaults: true })),
    writeTerminal, resizeTerminal: vi.fn(async () => undefined), closeTerminal: vi.fn(),
    restartTerminal: vi.fn(async (_session: string, _id: string, generation: bigint, requestId: string) => {
      if (restartedRequests.has(requestId)) return descriptor;
      if (generation !== descriptor.generation) throw new Error("terminal generation changed");
      restartedRequests.add(requestId);
      restartSpawns += 1;
      descriptor = { ...initial, generation: generation + 1n };
      if (loseNextRestartAcknowledgement) {
        loseNextRestartAcknowledgement = false;
        throw new Error("restart acknowledgement lost");
      }
      return descriptor;
    }),
    openHttpLink: vi.fn(async () => undefined)
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  let detachedDocument: Document | undefined;
  const render = async (active = true, connected = true, mount = "main") => act(async () => {
    const panel = <InteractiveTerminalPanel key={mount} controller={{ ...methods, state: { connectionState: connected ? "connected" : "reconnecting", activeProfile: { id: "profile", serverId: "server" } } } as unknown as AppController} sessionId="session-one" terminalId="terminal-one" active={active} capabilities={capabilities} t={t} onState={vi.fn()} />;
    root!.render(detachedDocument === undefined ? panel : createPortal(panel, detachedDocument.body));
  });
  await render();
  const terminal = mocks.terminals[0];
  expect(watches[0]?.after).toBeUndefined();
  await act(async () => watches[0]!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "reset", terminal: initial, sequence: 8n, data: "\x1b[31mprior screen" }));
  expect(terminal.reset).toHaveBeenCalledTimes(1);
  expect(terminal.resize).toHaveBeenCalledWith(80, 24);
  expect(terminal.resize.mock.invocationCallOrder[0]).toBeLessThan(terminal.reset.mock.invocationCallOrder[0]);
  expect(terminal.reset.mock.invocationCallOrder[0]).toBeLessThan(terminal.write.mock.invocationCallOrder[0]);
  expect(terminal.write).toHaveBeenCalledWith("\x1b[31mprior screen", expect.any(Function));
  await act(async () => watches[0]!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "output", sequence: 9n, data: "live output" }));
  expect(terminal.write).toHaveBeenLastCalledWith("live output", expect.any(Function));
  await act(async () => terminal.input("a😀b"));
  expect(writeTerminal.mock.calls.map((call) => [call[4], call[5]])).toEqual([[1n, "a😀"]]);
  await act(async () => finishFirst());
  expect(writeTerminal.mock.calls.map((call) => [call[4], call[5]])).toEqual([[1n, "a😀"], [2n, "b"]]);
  expect(writeTerminal.mock.calls[0]?.[3]).toBe(writeTerminal.mock.calls[1]?.[3]);
  terminal.selection = "selected output";
  const copy = new KeyboardEvent("keydown", { code: "KeyC", ctrlKey: true, cancelable: true });
  expect(terminal.key(copy)).toBe(false);
  expect(copy.defaultPrevented).toBe(true);
  expect(clipboard.writeText).toHaveBeenCalledWith("selected output");
  terminal.selection = "";
  expect(terminal.key(new KeyboardEvent("keydown", { code: "KeyC", ctrlKey: true }))).toBe(true);
  terminal.options.linkHandler.activate(new MouseEvent("click"), "https://example.org/osc-link");
  mocks.links[0]!(new MouseEvent("click"), "https://example.org/bare-link");
  expect(methods.openHttpLink).toHaveBeenCalledWith("https://example.org/osc-link", { forceExternal: true });
  expect(methods.openHttpLink).toHaveBeenCalledWith("https://example.org/bare-link", { forceExternal: true });
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
  expect(methods.resizeTerminal).toHaveBeenCalledWith("session-one", "terminal-one", 1n, 90, 30);
  await render(false);
  await act(async () => terminal.input("hidden"));
  expect(writeTerminal).toHaveBeenCalledTimes(2);
  expect(terminal.dispose).not.toHaveBeenCalled();
  await render();
  expect(mocks.terminals).toHaveLength(1);
  expect(methods.watchTerminal).toHaveBeenCalledTimes(1);
  let finishOutput!: () => void;
  terminal.write.mockImplementationOnce((_data: string, parsed: () => void) => { finishOutput = parsed; });
  await act(async () => { void watches[0]!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "output", sequence: 10n, data: "pending parse" }); });
  await render(true, false);
  expect(watches[0]!.signal.aborted).toBe(true);
  await render();
  expect(methods.getTerminal).toHaveBeenCalledTimes(1);
  await act(async () => finishOutput());
  expect(watches[1]!.after).toBe(10n);
  const screen = host.querySelector<HTMLElement>(".interactive-terminal__screen")!;
  screen.style.setProperty("--surface", "#f4f4f4");
  screen.style.setProperty("--red", "#b33a32");
  terminal.options.theme = { background: "#112233", red: "#445566" };
  terminal.write.mockImplementationOnce((_data: string, parsed: () => void) => {
    expect(terminal.options.theme).toMatchObject({ background: "#f4f4f4", red: "#b33a32" });
    parsed();
  });
  await act(async () => watches[1]!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "reset", terminal: initial, sequence: 11n, data: "checkpoint after colors reset while offline" }));
  writeTerminal.mockRejectedValueOnce(new Error("input acknowledgement lost"));
  await act(async () => terminal.input("x"));
  expect(host.textContent).toContain(t("terminal.inputUncertain"));
  await act(async () => terminal.input("do not replay"));
  expect(writeTerminal).toHaveBeenCalledTimes(3);
  terminal.focus.mockClear();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.reconnect")))!.click());
  expect(terminal.options.disableStdin).toBe(true);
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, kind: "state", terminal: initial, sequence: 12n, data: "" }));
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
  expect(terminal.focus).toHaveBeenCalledTimes(1);
  await act(async () => terminal.input("z"));
  expect(writeTerminal.mock.calls.at(-1)?.[4]).toBe(1n);
  expect(writeTerminal.mock.calls.at(-1)?.[3]).not.toBe(writeTerminal.mock.calls[0]?.[3]);
  let rejectOldInput!: (reason: Error) => void;
  writeTerminal.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOldInput = reject; }));
  await act(async () => terminal.input("old"));
  const oldWriter = writeTerminal.mock.calls.at(-1)?.[3];
  await act(async () => watches.at(-1)!.fail(new Error("stream disconnected")));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.reconnect")))!.click());
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, kind: "state", terminal: initial, sequence: 13n, data: "" }));
  await act(async () => terminal.input("fresh"));
  const freshWriter = writeTerminal.mock.calls.at(-1)?.[3];
  expect(freshWriter).not.toBe(oldWriter);
  expect(writeTerminal.mock.calls.at(-1)?.slice(4, 6)).toEqual([1n, "fresh"]);
  await act(async () => rejectOldInput(new Error("old input acknowledgement lost")));
  expect(host.textContent).not.toContain(t("terminal.inputUncertain"));
  expect(terminal.options.disableStdin).toBe(false);
  await act(async () => terminal.input("next"));
  expect(writeTerminal.mock.calls.at(-1)?.slice(3, 6)).toEqual([freshWriter, 2n, "next"]);
  const sentBeforeUnknown = writeTerminal.mock.calls.length;
  descriptor = { ...initial, status: "failed", failureCode: "TERMINAL_UNKNOWN", exitConfirmed: false };
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "state", terminal: descriptor, sequence: 14n, data: "" }));
  expect(host.textContent).toContain(t("terminal.stateUnknown"));
  expect(host.textContent).toContain(t("terminal.transportUnconfirmed"));
  expect(host.textContent).not.toContain("TERMINAL_UNKNOWN");
  expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes(t("terminal.restart")))).toBe(false);
  expect(terminal.options.disableStdin).toBe(true);
  await act(async () => terminal.input("must not be sent"));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.reconnect")))!.click());
  expect(methods.restartTerminal).not.toHaveBeenCalled();
  expect(writeTerminal).toHaveBeenCalledTimes(sentBeforeUnknown);
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "state", terminal: descriptor, sequence: 15n, data: "" }));
  expect(host.textContent).toContain(t("terminal.stateUnknown"));
  descriptor = { ...descriptor, failureCode: "unrecognized-runtime-code" };
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "state", terminal: descriptor, sequence: 16n, data: "" }));
  expect(host.textContent).toContain(t("terminal.failed"));
  expect(host.textContent).toContain(t("terminal.exitUnconfirmed"));
  expect(host.textContent).not.toContain("unrecognized-runtime-code");
  const exited = { ...initial, status: "exited" as const, exitConfirmed: true, exitCode: 7 };
  descriptor = exited;
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "state", terminal: exited, sequence: 12n, data: "" }));
  expect(host.textContent).toContain(t("terminal.exited", { code: 7 }));
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "state", terminal: { ...exited, exitSignal: 15 }, sequence: 13n, data: "" }));
  expect(host.textContent).toContain(t("terminal.signalled", { signal: 15 }));
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.restart")))!.click());
  expect(host.textContent).toContain("restart acknowledgement lost");
  expect(host.textContent).toContain(t("terminal.signalled", { signal: 15 }));
  expect(terminal.options.disableStdin).toBe(true);
  await render();
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.restart")))!.click());
  expect(methods.restartTerminal.mock.calls[1]?.[3]).toBe(methods.restartTerminal.mock.calls[0]?.[3]);
  expect(restartSpawns).toBe(1);
  expect(methods.restartTerminal).toHaveBeenCalledWith("session-one", "terminal-one", 1n, expect.any(String));
  expect(watches.at(-1)!.after).toBeUndefined();
  terminal.focus.mockClear();
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "reset", terminal: descriptor, sequence: 11n, data: "new shell" }));
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
  expect(terminal.focus).toHaveBeenCalledTimes(1);
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "output", sequence: 12n, data: "later output" }));
  await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
  expect(terminal.focus).toHaveBeenCalledTimes(1);
  descriptor = { ...descriptor, status: "exited", exitConfirmed: true, exitCode: 0 };
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "state", terminal: descriptor, sequence: 13n, data: "" }));
  loseNextRestartAcknowledgement = true;
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.restart")))!.click());
  expect(methods.restartTerminal.mock.calls[2]?.[3]).not.toBe(methods.restartTerminal.mock.calls[0]?.[3]);
  expect(host.textContent).toContain("restart acknowledgement lost");
  const inputCountBeforeRefresh = writeTerminal.mock.calls.length;
  await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.reconnect")))!.click());
  expect(methods.restartTerminal).toHaveBeenCalledTimes(3);
  expect(restartSpawns).toBe(2);
  expect(watches.at(-1)!.after).toBeUndefined();
  await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "reset", terminal: descriptor, sequence: 14n, data: "already restarted shell" }));
  expect(host.textContent).toContain(t("terminal.running"));
  expect(host.textContent).not.toContain("restart acknowledgement lost");
  expect(terminal.options.disableStdin).toBe(false);
  expect(writeTerminal).toHaveBeenCalledTimes(inputCountBeforeRefresh);
  const restartImplementation = methods.restartTerminal.getMockImplementation()!;
  for (const outcome of ["rejected", "resolved"] as const) {
    descriptor = { ...descriptor, status: "exited", exitConfirmed: true, exitCode: 0 };
    await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "state", terminal: descriptor, sequence: 15n, data: "" }));
    let settleObservedRestart!: () => void;
    methods.restartTerminal.mockImplementationOnce(async (...parameters) => {
      const restarted = await restartImplementation(...parameters);
      return new Promise<TerminalView>((resolve, reject) => {
        settleObservedRestart = () => outcome === "rejected" ? reject(new Error("late restart failure")) : resolve(restarted);
      });
    });
    await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(t("terminal.restart")))!.click());
    await render(true, false);
    await render();
    expect(watches.at(-1)!.after).toBeUndefined();
    await act(async () => watches.at(-1)!.update({ appearanceRevision: 1n, activeColorOverrides: "", kind: "reset", terminal: descriptor, sequence: 16n, data: "observed current shell" }));
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    const currentWatchCount = watches.length;
    terminal.focus.mockClear();
    await act(async () => settleObservedRestart());
    await act(async () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
    expect(watches).toHaveLength(currentWatchCount);
    expect(terminal.focus).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("late restart failure");
    expect(terminal.options.disableStdin).toBe(false);
    expect(writeTerminal).toHaveBeenCalledTimes(inputCountBeforeRefresh);
  }
  const frame = document.body.appendChild(document.createElement("iframe"));
  detachedDocument = frame.contentDocument!;
  const detachedWindow = frame.contentWindow!;
  vi.spyOn(detachedWindow, "getComputedStyle").mockReturnValue({ getPropertyValue: () => "#654321" } as unknown as CSSStyleDeclaration);
  const detachedObserve = vi.fn();
  Object.defineProperty(detachedWindow, "ResizeObserver", { value: class { observe = detachedObserve; disconnect = vi.fn(); } });
  Object.defineProperty(detachedWindow, "requestAnimationFrame", { value: window.requestAnimationFrame.bind(window) });
  Object.defineProperty(detachedWindow, "cancelAnimationFrame", { value: window.cancelAnimationFrame.bind(window) });
  const detachedClipboard = { writeText: vi.fn(async () => undefined) };
  Object.defineProperty(detachedWindow.navigator, "clipboard", { value: detachedClipboard });
  await render(true, true, "detached");
  expect(terminal.dispose).toHaveBeenCalledTimes(1);
  expect(watches.at(-1)!.after).toBeUndefined();
  expect(detachedObserve.mock.calls[0]?.[0].ownerDocument).toBe(detachedDocument);
  expect(detachedDocument.querySelector("textarea")).not.toBeNull();
  mocks.terminals.at(-1)!.selection = "detached selection";
  mocks.terminals.at(-1)!.key(new KeyboardEvent("keydown", { code: "KeyC", ctrlKey: true }));
  expect(detachedClipboard.writeText).toHaveBeenCalledWith("detached selection");
  expect(methods.closeTerminal).not.toHaveBeenCalled();
  await act(async () => root!.unmount());
  root = undefined;
  expect(watches.at(-1)!.signal.aborted).toBe(true);
  expect(methods.closeTerminal).not.toHaveBeenCalled();
});
