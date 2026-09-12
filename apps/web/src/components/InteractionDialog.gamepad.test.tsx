// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { dispatchGamepadOwnedAction } from "../gamepad-actions.js";
import type { InteractionView } from "../model.js";
import type { InteractionChannel, InteractionChannelMessageEvent, InteractionLock, InteractionLockManager } from "../interaction-ownership-coordinator.js";
import { InteractionDialog } from "./InteractionDialog.js";

const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const locks = new SingleWindowLockManager();
  Object.defineProperty(window.navigator, "locks", { configurable: true, value: locks });
  Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: SilentChannel });
  let id = 0;
  Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: () => `gamepad-${++id}` });
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren(); document.body.className = ""; vi.unstubAllGlobals();
});
const permission: InteractionView = { id: "request", sessionId: "task", generation: 1n, kind: "permission", title: "Permission request", message: "Inspect workspace", fields: [], planSteps: [], createdAt: 1,
  options: [{ id: "1", label: "Allow once" }, { id: "3", label: "Always allow" }, { id: "4", label: "Reject" }] };

describe("gamepad interaction decisions", () => {
  it("uses the current explicit allow-once decision and settles it once while a response is pending", async () => {
    let complete!: () => void;
    const resolveInteraction = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const view = await mount(permission, resolveInteraction);
    await act(async () => { dispatchGamepadOwnedAction(document, "approve"); dispatchGamepadOwnedAction(document, "approve"); dispatchGamepadOwnedAction(document, "reject"); });
    expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(permission, { kind: "permission", decisionId: "1" });
    expect(view.node().getAttribute("aria-busy")).toBe("true");
    await act(async () => { complete(); await Promise.all(view.pending); });
    expect(resolveInteraction).toHaveBeenCalledOnce();
  });

  it("binds denial to the current request and refuses disconnected, confirmation, and withdrawn choices", async () => {
    const resolveInteraction = vi.fn(async () => undefined); const view = await mount(permission, resolveInteraction);
    await view.render(permission, "disconnected");
    await act(async () => dispatchGamepadOwnedAction(document, "reject")); expect(resolveInteraction).not.toHaveBeenCalled();
    const confirmation = { ...permission, id: "confirm", kind: "confirm" as const };
    await view.render(confirmation); await act(async () => dispatchGamepadOwnedAction(document, "approve")); expect(resolveInteraction).not.toHaveBeenCalled();
    const withdrawn = { ...permission, id: "revised", options: [{ id: "4", label: "Reject" }] };
    await view.render(withdrawn); await act(async () => dispatchGamepadOwnedAction(document, "approve")); expect(resolveInteraction).not.toHaveBeenCalled();
    await act(async () => { dispatchGamepadOwnedAction(document, "reject"); await Promise.all(view.pending); });
    expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(withdrawn, { kind: "permission", decisionId: "4" });
  });

  it("shows an unavailable state and cannot submit when permission choices are empty", async () => {
    const resolveInteraction = vi.fn(async () => undefined);
    const empty = { ...permission, id: "empty", options: [] };
    const view = await mount(empty, resolveInteraction);

    expect(view.node().querySelectorAll(".decision-option")).toHaveLength(0);
    expect([...view.node().querySelectorAll("[role='status']")].at(-1)?.textContent).toBe("interaction.noPermissionDecisions");
    await act(async () => {
      dispatchGamepadOwnedAction(document, "approve");
      dispatchGamepadOwnedAction(document, "reject");
      view.node().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      view.node().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(resolveInteraction).not.toHaveBeenCalled();
  });
});

async function mount(initial: InteractionView, resolveInteraction: AppController["resolveInteraction"]) {
  const host = document.body.appendChild(document.createElement("main")); host.className = "session-pane";
  const root = createRoot(host); roots.push(root); const pending: Promise<unknown>[] = [];
  const render = async (interaction: InteractionView, connectionState = "connected") => {
    await act(async () => root.render(<InteractionDialog interaction={interaction} remaining={0} inline
      controller={{ state: { connectionState, preferences: { locale: "en" }, activeProfile: { id: "profile", serverId: "server" } }, resolveInteraction } as unknown as AppController}
      t={(key) => key} runAction={(_key, action) => { pending.push(action()); }} />));
    await act(async () => { await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    host.querySelector<HTMLElement>(".interaction-dialog")!.focus();
  };
  await render(initial);
  return { render, pending, node: () => host.querySelector<HTMLElement>(".interaction-dialog")! };
}

class SilentChannel implements InteractionChannel {
  constructor(_name: string) {}
  postMessage(_message: unknown): void {}
  addEventListener(_type: "message", _listener: (event: InteractionChannelMessageEvent) => void): void {}
  removeEventListener(_type: "message", _listener: (event: InteractionChannelMessageEvent) => void): void {}
  close(): void {}
}

class SingleWindowLockManager implements InteractionLockManager {
  readonly #active = new Set<string>();
  request<T>(name: string, options: { readonly mode: "exclusive"; readonly ifAvailable?: boolean; readonly signal?: AbortSignal }, callback: (lock: InteractionLock | null) => Promise<T> | T): Promise<T> {
    if (this.#active.has(name)) return options.ifAvailable === true ? Promise.resolve().then(() => callback(null)) : Promise.reject(new DOMException("Aborted", "AbortError"));
    this.#active.add(name);
    return Promise.resolve(callback({ name })).finally(() => this.#active.delete(name));
  }
}
