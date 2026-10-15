// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDesktopService, RemoteDesktopFailureReason, type DesktopRemoteDesktopViewerApi,
  type DesktopRemoteDesktopViewerState } from "@joko/contracts";
import { DesktopRemoteDesktopViewerWindow } from "./DesktopRemoteDesktopViewerWindow.js";

const runtime = vi.hoisted(() => ({ owners: [] as {
  root: HTMLElement; post(message: Record<string, unknown>): void; receive: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>
}[] }));
vi.mock("../remote-desktop-viewer-runtime.js", () => ({
  mountRemoteDesktopViewer: (root: HTMLElement, post: (message: Record<string, unknown>) => void) => {
    const owner = { root, post, receive: vi.fn(), dispose: vi.fn() }; runtime.owners.push(owner); return owner;
  }
}));

const roots: Root[] = [];
const quiet: DesktopRemoteDesktopViewerState = { generation: 1, active: false,
  target: { deviceId: "peer", name: "Remote desk" }, locale: "en", audio: true, hostMute: false, lockOnExit: false,
  clipboardSync: false, privacyScreen: false, clipboardSyncState: { available: false, active: false, pending: false } };
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function fixture(generation: number, blockedStart: boolean, target: DesktopRemoteDesktopViewerState["target"] = quiet.target) {
  let scope = { ...quiet, generation, target };
  const listeners = new Set<(value: DesktopRemoteDesktopViewerState) => void>();
  const closeListeners = new Set<(generation: number) => void>();
  let allowCapabilities!: () => void, allowStart!: () => void;
  const capabilitiesGate = new Promise<void>(resolve => { allowCapabilities = resolve; });
  const startGate = blockedStart ? new Promise<void>(resolve => { allowStart = resolve; }) : Promise.resolve();
  const requests: { generation: number; name: string; input: Record<string, unknown> }[] = [];
  const readyViews: { connected: boolean; status: string | null; requests: number }[] = [];
  const api: DesktopRemoteDesktopViewerApi = {
    platform: "win32", state: vi.fn(async () => scope),
    ready: vi.fn(async current => {
      readyViews.push({ connected: document.querySelector(".remote-viewer-content")?.isConnected === true,
        status: document.querySelector(".remote-viewer-connection")?.textContent ?? null, requests: requests.length });
      for (const listener of listeners) listener({ ...scope, generation: current, active: scope.target !== null });
    }),
    onState: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onCloseRequested: listener => { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
    inputFocus: vi.fn(async () => undefined),
    request: vi.fn(async (current, name, bytes) => {
      const method = RemoteDesktopService.methods.find(value => value.localName === name)!;
      const input = fromBinary(method.input, bytes) as unknown as Record<string, unknown>;
      requests.push({ generation: current, name, input });
      if (name === "getRemoteDesktopCapabilities") await capabilitiesGate;
      if (name === "startRemoteDesktop") await startGate;
      if (name === "getRemoteDesktopFrame") return { ok: false as const, code: Code.FailedPrecondition,
        reason: RemoteDesktopFailureReason.CAPTURE_PENDING };
      const output = name === "getRemoteDesktopCapabilities" ? { capabilities: { protocolVersion: 1, enabled: true,
        canControl: true, platform: "win32", displays: [{ displayId: "one", name: "One", width: 1200, height: 800 }], jpegFallback: true } }
        : name === "startRemoteDesktop" ? { lease: { leaseId: `lease-${current}`, display: { displayId: "one", width: 1200, height: 800 },
          controlling: false, controlGeneration: 1n } }
          : name === "setRemoteDesktopControl" ? { state: { controlling: input["enabled"], controlGeneration: 2n } } : {};
      return { ok: true as const, bytes: toBinary(method.output, create(method.output, output as MessageInitShape<typeof method.output>)) };
    }),
    retryClipboardSync: vi.fn(async () => undefined), clipboard: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    minimize: vi.fn(async () => undefined), fullscreen: vi.fn(async () => true), resize: vi.fn(async () => undefined),
    credential: vi.fn(async () => ({ ok: true as const, authenticated: false, state: { available: false, autoUnlock: false,
      biometricAvailable: false, biometricVerification: false } })),
    preferences: vi.fn(async () => ({ audio: true, hostMute: false, lockOnExit: false, clipboardSync: false, privacyScreen: false }))
  };
  return { api, requests, readyViews, listeners, closeListeners, allowCapabilities, allowStart,
    bind(current: number, target: NonNullable<DesktopRemoteDesktopViewerState["target"]>) {
      scope = { ...quiet, generation: current, target }; for (const listener of listeners) listener(scope);
    } };
}
async function render(api: DesktopRemoteDesktopViewerApi) {
  Object.defineProperty(window, "jokoRemoteDesktopViewer", { configurable: true, value: api });
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => { root.render(createElement(DesktopRemoteDesktopViewerWindow)); await flush(); });
  return { root, container };
}
beforeEach(() => {
  vi.useFakeTimers(); runtime.owners.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren(); Reflect.deleteProperty(window, "jokoRemoteDesktopViewer");
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("actual standalone Desktop viewer quiet shell", () => {
  it("reports remote keyboard focus and restores native menus on local focus, blur, and retirement", async () => {
    const value = fixture(1, false), shell = await render(value.api);
    const input = shell.container.querySelector<HTMLTextAreaElement>("#keyboard-input")!;
    const localButton = shell.container.querySelector<HTMLButtonElement>('[aria-label="Display settings"]')
      ?? shell.container.querySelector<HTMLButtonElement>(".remote-viewer-tool")!;
    await act(async () => { input.focus(); await flush(); });
    expect(value.api.inputFocus).toHaveBeenLastCalledWith(1, true);
    await act(async () => { localButton.focus(); await flush(); });
    expect(value.api.inputFocus).toHaveBeenLastCalledWith(1, false);
    await act(async () => { input.focus(); input.blur(); await flush(); });
    expect(value.api.inputFocus).toHaveBeenLastCalledWith(1, false);
    await act(async () => { input.focus(); window.dispatchEvent(new Event("blur")); await flush(); });
    expect(value.api.inputFocus).toHaveBeenLastCalledWith(1, false);
    await act(async () => { value.bind(2, { deviceId: "peer", name: "New occurrence" }); await flush(); });
    await act(async () => {
      for (const listener of value.listeners) listener({ ...quiet, generation: 1, active: false });
      input.blur(); input.focus(); await flush();
    });
    expect(value.api.inputFocus).toHaveBeenLastCalledWith(2, true);
    await act(async () => shell.root.unmount()); roots.splice(roots.indexOf(shell.root), 1);
    expect(value.api.inputFocus).toHaveBeenLastCalledWith(2, false);
    const calls = vi.mocked(value.api.inputFocus).mock.calls.length;
    document.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); window.dispatchEvent(new Event("blur"));
    expect(value.api.inputFocus).toHaveBeenCalledTimes(calls);
  });

  it("confirms an exact native close request before dispatching the safe exit", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true,
      value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
    try {
      const value = fixture(1, false), shell = await render(value.api);
      await act(async () => { value.allowCapabilities(); await flush(); });
      const owner = runtime.owners[0]!, init = owner.receive.mock.calls.map(([message]) => message).find(message => message.type === "init")!;
      await act(async () => { owner.post({ type: "framePresented", epoch: init.epoch }); await flush(); });
      await act(async () => { for (const close of value.closeListeners) close(0); await flush(); });
      expect(shell.container.querySelector("dialog")).toBeNull();
      await act(async () => { for (const close of value.closeListeners) close(1); await flush(); });
      expect(shell.container.querySelector("dialog[open]")).not.toBeNull();
      expect(value.api.close).not.toHaveBeenCalled();
      await act(async () => { shell.container.querySelector<HTMLButtonElement>("dialog button")!.click(); await flush(); });
      expect(shell.container.querySelector("dialog")).toBeNull(); expect(value.api.close).not.toHaveBeenCalled();
      await act(async () => { for (const close of value.closeListeners) close(1); await flush(); });
      await act(async () => { shell.container.querySelector<HTMLButtonElement>("dialog button:last-child")!.click(); await flush(); });
      expect(value.api.close).toHaveBeenCalledExactlyOnceWith(1);
    } finally {
      if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, "showModal", descriptor);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    }
  });

  it("keeps mounted null-target content local until a fresh binding adopts the same renderer", async () => {
    const value = fixture(0, false, null), shell = await render(value.api), owner = runtime.owners[0]!;
    expect(value.api.ready).toHaveBeenCalledExactlyOnceWith(0);
    expect(value.readyViews).toEqual([{ connected: true, status: "Connecting…", requests: 0 }]);
    expect(shell.container.querySelector(".remote-viewer-heading strong")?.textContent).toBe("Remote desktop");
    expect(shell.container.querySelector(".remote-viewer-heading [role=status]")?.textContent).toBe("Window inactive");
    expect(shell.container.querySelector<HTMLButtonElement>(".remote-viewer-toolbar .button")?.disabled).toBe(true);
    const stage = shell.container.querySelector("#stage");
    await act(async () => {
      shell.container.querySelector<HTMLButtonElement>('[aria-label="Disconnect"]')!.click();
      owner.post({ type: "input", epoch: "retired", sequence: 1, events: [{ kind: "key", code: "KeyA", down: true }] });
      await vi.advanceTimersByTimeAsync(6000); await flush();
    });
    expect(value.requests).toHaveLength(0); expect(value.api.close).not.toHaveBeenCalled();
    expect(value.api.credential).not.toHaveBeenCalled(); expect(value.api.preferences).not.toHaveBeenCalled();
    expect(owner.receive.mock.calls.some(([message]) => message.type === "init")).toBe(false);
    await act(async () => { value.bind(1, { deviceId: "peer", name: "Bound desk" }); await flush(); });
    expect(runtime.owners).toHaveLength(1); expect(shell.container.querySelector("#stage")).toBe(stage);
    expect(value.api.ready).toHaveBeenCalledTimes(2); expect(value.api.ready).toHaveBeenLastCalledWith(1);
    expect(value.requests.map(request => ({ generation: request.generation, name: request.name }))).toEqual([
      { generation: 1, name: "getRemoteDesktopCapabilities" }
    ]);
    await act(async () => { value.allowCapabilities(); await flush(); });
    const init = owner.receive.mock.calls.map(([message]) => message).find(message => message.type === "init")!;
    expect(init.epoch).toBe("lease-1:1000000000");
    await act(async () => {
      for (const listener of value.listeners) listener({ ...quiet, target: null, generation: 0, active: false });
      owner.post({ type: "framePresented", epoch: "retired" }); await flush();
    });
    expect(shell.container.querySelector(".remote-viewer-heading strong")?.textContent).toBe("Bound desk");
    expect(shell.container.querySelector(".remote-viewer-heading [role=status]")?.textContent).toBe("Connecting…");
    expect(value.api.ready).toHaveBeenCalledTimes(2);
    await act(async () => { owner.post({ type: "framePresented", epoch: init.epoch }); await flush(); });
    expect(shell.container.querySelector(".remote-viewer-heading [role=status]")?.textContent).toBe("Connected · Compatibility mode");
    expect(value.requests.filter(request => request.name === "startRemoteDesktop")).toHaveLength(1);
    expect(value.requests.every(request => request.generation === 1)).toBe(true);
  });

  it("presents committed quiet content before network or capture and rebuilds a fresh lease without accepting retired callbacks", async () => {
    const old = fixture(1, true), first = await render(old.api), oldRuntime = runtime.owners[0]!;
    expect(old.api.ready).toHaveBeenCalledExactlyOnceWith(1);
    expect(old.readyViews).toEqual([{ connected: true, status: "Connecting…", requests: 0 }]);
    expect(first.container.querySelector(".remote-viewer-heading strong")?.textContent).toBe("Remote desk");
    expect(first.container.querySelector(".remote-viewer-heading [role=status]")?.textContent).toBe("Connecting…");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); await flush(); });
    expect(old.api.ready).toHaveBeenCalledTimes(1);
    expect(old.requests.map(value => value.name)).toEqual(["getRemoteDesktopCapabilities"]);
    await act(async () => { old.allowCapabilities(); await flush(); });
    expect(old.requests.map(value => value.name)).toEqual(["getRemoteDesktopCapabilities", "startRemoteDesktop"]);
    expect(oldRuntime.receive.mock.calls.some(([value]) => value.type === "init")).toBe(false);
    const oldState = Array.from(old.listeners)[0]!;
    await act(async () => { first.root.unmount(); await flush(); }); roots.splice(roots.indexOf(first.root), 1); first.container.remove();
    expect(old.listeners.size).toBe(0); expect(oldRuntime.dispose).toHaveBeenCalledTimes(1);
    const fresh = fixture(2, false), second = await render(fresh.api), currentRuntime = runtime.owners[1]!;
    expect(fresh.api.ready).toHaveBeenCalledExactlyOnceWith(2);
    expect(fresh.readyViews).toEqual([{ connected: true, status: "Connecting…", requests: 0 }]);
    await act(async () => { fresh.allowCapabilities(); await flush(); });
    const init = currentRuntime.receive.mock.calls.map(([value]) => value).find(value => value.type === "init")!;
    expect(init.epoch).toBe("lease-2:1000000000");
    expect(fresh.requests.filter(value => value.name === "startRemoteDesktop")).toEqual([
      { generation: 2, name: "startRemoteDesktop", input: expect.objectContaining({ displayId: "one" }) }
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); await flush(); });
    expect(second.container.querySelector(".remote-viewer-heading [role=status]")?.textContent).toBe("Waiting for screen sharing approval on the host…");
    expect(fresh.api.ready).toHaveBeenCalledTimes(1);
    const priorCalls = currentRuntime.receive.mock.calls.length;
    await act(async () => {
      old.allowStart(); oldState({ ...quiet, generation: 99, active: true });
      oldRuntime.post({ type: "streaming", epoch: init.epoch }); await flush();
    });
    expect(oldRuntime.receive.mock.calls.some(([value]) => value.type === "init")).toBe(false);
    expect(currentRuntime.receive).toHaveBeenCalledTimes(priorCalls);
    expect(second.container.querySelector(".remote-viewer-heading [role=status]")?.textContent).toBe("Waiting for screen sharing approval on the host…");
    await act(async () => { currentRuntime.post({ type: "framePresented", epoch: init.epoch }); await flush(); });
    expect(second.container.querySelector(".remote-viewer-heading [role=status]")?.textContent).toBe("Connected · Compatibility mode");
    expect(fresh.api.ready).toHaveBeenCalledTimes(1);
  });
});
