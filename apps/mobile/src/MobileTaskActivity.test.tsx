// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { TaskActivityStateSchema, type TaskActivityState } from "@joko/contracts";
import type { TaskActivityPort } from "@joko/connection-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileState } from "./mobile-client";
const native = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock("react-native", () => ({
  Alert: { alert: native.alert },
  View: ({ children }: { children?: ReactNode }) => createElement("div", {}, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
  Pressable: ({ children, accessibilityLabel, disabled, onPress }: { children?: ReactNode; accessibilityLabel?: string; disabled?: boolean; onPress?: () => void }) =>
    createElement("button", { "aria-label": accessibilityLabel, disabled, onClick: onPress }, children)
}));
import { MobileTaskActivityProvider, MobileTaskActivityBanner, useMobileTaskActivityView } from "./MobileTaskActivity";
let root: Root, host: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.alert.mockClear(); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const colors = { ink: "#111", surface: "#fff", accent: "#985100", border: "#ccc" };
function fixture() {
  const subscribers = new Set<{ pending?: TaskActivityState; wake?: () => void; closed: boolean }>();
  const views: Array<{ ids: readonly string[]; signal: AbortSignal }> = [];
  const port: TaskActivityPort = { watch: async function* (ids, signal) {
    views.push({ ids, signal }); const subscriber: { pending?: TaskActivityState; wake?: () => void; closed: boolean } = { closed: signal.aborted };
    const close = () => { subscriber.closed = true; subscribers.delete(subscriber); subscriber.wake?.(); };
    signal.addEventListener("abort", close, { once: true }); subscribers.add(subscriber);
    try { while (!subscriber.closed) {
      if (subscriber.pending) { const value = subscriber.pending; subscriber.pending = undefined; yield value; }
      else await new Promise<void>(resolve => { subscriber.wake = resolve; });
    } } finally { signal.removeEventListener("abort", close); subscribers.delete(subscriber); }
  }, revoke: vi.fn(async () => {}) };
  const client = { taskActivityOwnerKey: (): string | undefined => "owner-1", taskActivity: () => port };
  const state = { activeProfileId: "profile", saved: [{ profileId: "profile", deviceId: "self" }], owner: { generation: 1n }, node: { serverId: "node" }, origin: "https://node.test" } as unknown as MobileState;
  const push = async (...ids: string[]) => act(async () => {
    for (const subscriber of subscribers) { subscriber.pending = create(TaskActivityStateSchema, {
      generation: 1n, revision: 1n, activeDevices: ids.map(deviceId => ({ deviceId, displayName: `Name ${deviceId}` }))
    }); subscriber.wake?.(); }
  });
  return { port, client, state, views, push, manage: vi.fn() };
}
function Pane({ id }: { id: string }) { useMobileTaskActivityView(id); return <MobileTaskActivityBanner sessionId={id} />; }
async function render(f: ReturnType<typeof fixture>, foreground = true, id?: string, locale = "en") { await act(async () => root.render(
  <MobileTaskActivityProvider client={f.client} state={f.state} foreground={foreground} locale={locale} colors={colors} onManage={f.manage}>
    <MobileTaskActivityBanner />{id && <Pane id={id} />}
  </MobileTaskActivityProvider>)); }
async function click(label: string) { await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click()); }
function confirmButton() { return (native.alert.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void }>).find(button => button.style === "destructive")!; }

describe("Mobile task activity", () => {
  it.each([false, true])("renders the connection page before there is an authenticated owner (foreground=%s)", async foreground => {
    const f = fixture(); let owner: string | undefined;
    f.client.taskActivityOwnerKey = () => owner;
    await render(f, foreground);
    expect(f.views).toEqual([]); expect(host.textContent).toBe("");
    owner = "owner-1";
    await render(f, true); await f.push("phone");
    expect(host.textContent).toContain("Name phone is viewing");
    owner = undefined;
    await render(f, true);
    expect(host.textContent).toBe(""); expect(f.views.every(view => view.signal.aborted)).toBe(true);
    expect(f.port.revoke).not.toHaveBeenCalled();
  });

  it("binds only mounted task pages, hides its own Device, and retires both streams on background", async () => {
    const f = fixture(); await render(f); expect(f.views.map(v => v.ids)).toEqual([[]]);
    await f.push("self"); expect(host.textContent).toBe("");
    await render(f, true, "task-a"); await f.push("self", "phone");
    expect(host.textContent?.match(/Name phone is viewing/gu)).toHaveLength(1);
    expect(f.views.map(v => v.ids)).toEqual([[], ["task-a"]]);
    await click("Collapse active device notice"); expect(host.textContent).toBe("●");
    await render(f, true, "task-b"); expect(f.views[1]!.signal.aborted).toBe(true); expect(host.textContent).toContain("Name phone");
    await render(f, true, "task-a"); expect(host.textContent).toBe("●");
    await render(f, false, "task-a"); expect(f.views.every(v => v.signal.aborted)).toBe(true); expect(host.textContent).toBe("");
    await f.push("late"); expect(host.textContent).toBe("");
    await render(f, true); await f.push("phone", "tablet"); await click("Manage devices"); expect(f.manage).toHaveBeenCalledOnce();
  });

  it("captures the original Device before native confirmation and rejects stale callbacks after background", async () => {
    const f = fixture(); await render(f); await f.push("phone"); await click("Revoke access"); const confirmed = confirmButton();
    await f.push("phone", "tablet"); await act(async () => confirmed.onPress?.());
    expect(f.port.revoke).toHaveBeenCalledExactlyOnceWith("phone");
    await f.push("tablet"); await click("Revoke access"); const stale = confirmButton();
    await render(f, false); await act(async () => stale.onPress?.()); expect(f.port.revoke).toHaveBeenCalledTimes(1);
  });

  it("keeps failed revocation explicit and localizes the activity and management actions", async () => {
    const f = fixture(); vi.mocked(f.port.revoke).mockRejectedValueOnce(new Error("unknown receipt"));
    await render(f, true, undefined, "zh-CN"); await f.push("phone");
    expect(host.textContent).toContain("Name phone 正在查看此节点的任务"); await click("撤销访问");
    await act(async () => confirmButton().onPress?.());
    expect(native.alert.mock.calls.at(-1)?.[0]).toContain("无法确认设备访问已撤销");
    expect(f.port.revoke).toHaveBeenCalledTimes(1);
  });
});
