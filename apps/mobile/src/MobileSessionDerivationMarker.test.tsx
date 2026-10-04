// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSessionOriginControls } from "./mobile-session-origin";

const native = vi.hoisted(() => ({ state: "active", listeners: new Set<(state: string) => void>() }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
  Pressable: ({ children, onPress, accessibilityLabel, disabled, style }: {
    children?: ReactNode; onPress?: () => void; accessibilityLabel?: string; disabled?: boolean; style: unknown[]
  }) => createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled, "data-style": JSON.stringify(style) }, children),
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
  AppState: { get currentState() { return native.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
    native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
  } }
}));
import { MobileSessionDerivationMarker } from "./MobileSessionDerivationMarker";

const controls: MobileSessionOriginControls = { kind: "fork", originKey: "lineage", authorityKey: "owner-one", canOpen: true };
const colors = { muted: "#666", border: "#ccc", accent: "#ff9800" };
const open = vi.fn<(key: string, signal: AbortSignal) => Promise<boolean>>();
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.state = "active"; open.mockReset();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); native.listeners.clear();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
async function render(value: MobileSessionOriginControls | undefined = controls, busy = false, locale: "en" | "zh-CN" = "en") {
  await act(async () => root.render(createElement(MobileSessionDerivationMarker, { controls: value, busy, locale, colors, onOpen: open })));
}
async function press() { await act(async () => host.querySelector<HTMLButtonElement>("button")?.click()); }
async function appState(state: string) {
  await act(async () => { native.state = state; for (const listener of native.listeners) listener(state); });
}

describe("native derived task origin marker", () => {
  it("shows the durable kind without a dead link and uses one touch target for current origin navigation", async () => {
    await render({ ...controls, kind: "clone", canOpen: false, authorityKey: undefined }, false, "zh-CN");
    expect(host.textContent).toContain("克隆自其他任务"); expect(host.textContent).toContain("来源不可用");
    expect(host.querySelector("button")).toBeNull();
    let finish!: (value: boolean) => void;
    open.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render(); await press(); await press();
    expect(open).toHaveBeenCalledOnce(); expect(open.mock.calls[0]?.[0]).toBe("owner-one");
    expect(host.querySelector("button")?.dataset.style).toContain('"minHeight":44');
    expect(host.textContent).toContain("Opening source…");
    await act(async () => finish(false));
    expect(host.textContent).toContain("The source could not be opened.");
    open.mockResolvedValueOnce(true); await press();
    expect(host.textContent).not.toContain("The source could not be opened.");
  });

  it("aborts old navigation on owner, background and busy changes without late feedback or clearing a newer request", async () => {
    const finishes: Array<(value: boolean) => void> = [];
    open.mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
    await render(); await press();
    await render({ ...controls, authorityKey: "owner-two" });
    expect(open.mock.calls[0]![1].aborted).toBe(true);
    await press(); await act(async () => finishes[0]!(false));
    expect(host.textContent).toContain("Opening source…");
    await appState("background"); expect(open.mock.calls[1]![1].aborted).toBe(true);
    expect(host.querySelector("button")).toBeNull();
    await appState("active"); await press();
    await act(async () => finishes[1]!(false));
    expect(host.textContent).toContain("Opening source…");
    await render({ ...controls, authorityKey: "owner-two" }, true);
    expect(open.mock.calls[2]![1].aborted).toBe(true);
    await act(async () => finishes[2]!(false));
    expect(host.textContent).not.toContain("The source could not be opened.");
    expect(host.querySelector("button")?.disabled).toBe(true);
  });
});
