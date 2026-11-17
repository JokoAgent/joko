// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { TaskActivityStateSchema, type TaskActivityState } from "@joko/contracts";
import type { TaskActivityPort } from "@joko/connection-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { dictionaryWatchFixture } from "../voice-dictionary.test-support.js";
import { TaskActivityProvider, TaskActivityBanner, useTaskActivityView } from "./TaskActivity.js";

let root: Root, host: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
function fixture() {
  const updates = dictionaryWatchFixture<TaskActivityState>();
  const views: Array<{ ids: readonly string[]; signal: AbortSignal }> = [];
  const port: TaskActivityPort = { watch: (ids, signal) => { views.push({ ids, signal }); return updates.watch(signal); }, revoke: vi.fn(async () => {}) };
  const controller = { taskActivity: vi.fn(() => port), navigate: vi.fn(), state: {
    connectionState: "connected", connectionGeneration: 1, effectiveLocale: "en", snapshot: { generation: 1n },
    activeProfile: { id: "connection", serverId: "server", origin: "https://node.test", deviceId: "self" }
  } } as unknown as AppController;
  const push = async (revision: bigint, ...ids: string[]) => act(async () => updates.push(create(TaskActivityStateSchema, {
    generation: 1n, revision, activeDevices: ids.map(deviceId => ({ deviceId, displayName: `Name ${deviceId}` }))
  })));
  return { updates, views, port, controller, push };
}
function Pane({ id }: { id: string }) { useTaskActivityView(id); return <TaskActivityBanner sessionId={id} />; }
async function render(controller: AppController, id?: string) { await act(async () => root.render(<TaskActivityProvider controller={controller} t={t}>
  <TaskActivityBanner />{id && <Pane id={id} />}</TaskActivityProvider>)); }
function button(label: string, scope: ParentNode = document.body) {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label)!;
}
async function click(label: string, scope?: ParentNode) { await act(async () => button(label, scope).click()); }

describe("task activity notice", () => {
  it("keeps the disconnected page mounted before pairing and after the authenticated owner retires", async () => {
    const f = fixture();
    const disconnected = { ...f.controller, state: { ...f.controller.state, connectionState: "disconnected" as const, activeProfile: undefined } };
    await render(disconnected);
    expect(f.views).toEqual([]); expect(host.querySelector("aside")).toBeNull();
    expect(f.controller.taskActivity).not.toHaveBeenCalled();
    await render(f.controller); await f.push(1n, "phone");
    expect(host.textContent).toContain("Name phone is viewing");
    await render(disconnected);
    expect(host.querySelector("aside")).toBeNull(); expect(f.views[0]!.signal.aborted).toBe(true);
    expect(f.port.revoke).not.toHaveBeenCalled();
  });

  it("retains its global feed across actual pane lifetimes, hides the current Device, and restores task-specific collapse", async () => {
    const f = fixture(); await render(f.controller); expect(f.views.map(v => v.ids)).toEqual([[]]);
    await f.push(1n, "self"); expect(host.querySelector("aside")).toBeNull();
    await f.push(2n, "self", "phone"); expect(host.textContent).toContain("Name phone is viewing tasks on this node");
    await render(f.controller, "task-a"); expect(f.views.map(v => v.ids)).toEqual([[], ["task-a"]]);
    expect(host.querySelectorAll(".task-activity--floating")).toHaveLength(0);
    await click("Collapse active device notice"); expect(button("Expand active device notice: Name phone is viewing tasks on this node")).toBeDefined();
    const firstView = f.views[1]!;
    await render(f.controller, "task-b"); expect(firstView.signal.aborted).toBe(true); expect(button("Collapse active device notice")).toBeDefined();
    await render(f.controller, "task-a"); expect(button("Expand active device notice: Name phone is viewing tasks on this node")).toBeDefined();
    await render(f.controller); expect(host.querySelector(".task-activity--floating")).not.toBeNull();
    expect(f.views[0]!.signal.aborted).toBe(false); expect(f.updates.count).toBe(1);
    await f.push(1n, "stale"); expect(host.textContent).not.toContain("stale");
    await f.push(3n); expect(host.querySelector("aside")).toBeNull();
  });

  it("confirms the original single Device through list changes and routes a multiple-device notice to existing management", async () => {
    const f = fixture(); await render(f.controller); await f.push(1n, "phone"); await click("Revoke access");
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Name phone's access");
    await f.push(2n, "other", "phone");
    await click("Revoke access", document.querySelector('[role="alertdialog"]')!);
    expect(f.port.revoke).toHaveBeenCalledExactlyOnceWith("phone");
    await click("Manage devices"); expect(f.controller.navigate).toHaveBeenCalledWith({ kind: "settings" }, { exactHash: "#/settings/connections" });
    await f.push(3n, "other"); vi.mocked(f.port.revoke).mockRejectedValueOnce(new Error("unknown receipt"));
    await click("Revoke access"); await click("Revoke access", document.querySelector('[role="alertdialog"]')!);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
    expect(f.port.revoke).toHaveBeenCalledTimes(2);
  });

  it("drops the old initial state and confirmation when the same connection is replaced", async () => {
    const f = fixture(); await render(f.controller); await f.push(1n, "old"); await click("Revoke access");
    const next = fixture(), replacement = { ...next.controller, state: { ...next.controller.state, connectionGeneration: 2 } };
    await render(replacement); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(host.querySelector("aside")).toBeNull(); expect(f.views[0]!.signal.aborted).toBe(true);
    await f.push(5n, "late-old"); expect(host.textContent).not.toContain("late-old");
    await next.push(1n, "new"); expect(host.textContent).toContain("Name new"); expect(f.port.revoke).not.toHaveBeenCalled();
  });
});
