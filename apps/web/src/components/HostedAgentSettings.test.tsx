// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { HostedAgentSettingsView, HostedAgentSettingsUpdate } from "../hosted-agent-settings.js";
import { translate } from "../i18n.js";
import { HostedAgentSettings } from "./HostedAgentSettings.js";

const roots: Root[] = [];
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("zh-CN", key, values);
function fixture(name = "测试节点") {
  let settings: HostedAgentSettingsView = { revision: 1n, remoteControlEnabled: false, providers: [{ backendId: "native-a", providerId: "provider", enabled: true }],
    limits: { perDevice: 16, total: 64 }, limitsOverridden: false, usage: { total: 3, devices: 2, maximumDevice: 2 } };
  const getHostedAgentSettings = vi.fn(async () => settings);
  const getHostedAgentCatalog = vi.fn(async () => ({ backends: [{ backendId: "native-a", displayName: "真实运行时", providers: [{ providerId: "provider", displayName: "模型账户", connected: true, modelCount: 2 }] }] }));
  const updateHostedAgentSettings = vi.fn(async (update: HostedAgentSettingsUpdate, expected: bigint, _signal?: AbortSignal) => {
    expect(expected).toBe(settings.revision);
    settings = { ...settings, revision: settings.revision + 1n,
      ...(update.kind === "remoteControl" ? { remoteControlEnabled: update.enabled } : update.kind === "provider" ? { providers: [{ backendId: update.backendId, providerId: update.providerId, enabled: update.enabled }] }
        : update.kind === "limits" ? { limits: { perDevice: update.perDevice, total: update.total }, limitsOverridden: true }
          : { limits: { perDevice: 16, total: 64 }, limitsOverridden: false }) };
    return settings;
  });
  const controller = { getHostedAgentSettings, getHostedAgentCatalog, updateHostedAgentSettings, state: { activeProfile: { id: name, serverId: name, name }, connectionState: "connected", connectionGeneration: 1 } } as unknown as AppController;
  return { controller, getHostedAgentSettings, updateHostedAgentSettings, set: (value: Partial<HostedAgentSettingsView>) => { settings = { ...settings, ...value }; }, value: () => settings };
}
async function mount(controller: AppController) {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<HostedAgentSettings controller={controller} t={t} />));
  return { container, root };
}
async function change(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function button(container: HTMLElement, text: string): HTMLButtonElement { const result = [...container.querySelectorAll("button")].find(value => value.textContent === text); if (!result) throw new Error(`Missing button ${text}.`); return result; }

it("keeps paused Provider choices, enables the exact native route and lowers limits without changing existing usage", async () => {
  const f = fixture(), { container } = await mount(f.controller);
  const master = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="允许远程调用模型"]')!;
  const provider = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="允许远程调用真实运行时的模型账户"]')!;
  expect(provider.disabled).toBe(true); expect(provider.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("默认 16 / 64"); expect(container.textContent).toContain("已有 3 个运行");
  await act(async () => master.click()); expect(f.updateHostedAgentSettings.mock.calls[0]?.slice(0, 2)).toEqual([{ kind: "remoteControl", enabled: true }, 1n]);
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="number"]'); await change(inputs[0]!, "1"); await change(inputs[1]!, "2");
  await act(async () => provider.click()); expect(f.updateHostedAgentSettings.mock.calls[1]?.slice(0, 2)).toEqual([{ kind: "provider", backendId: "native-a", providerId: "provider", enabled: false }, 2n]);
  expect(inputs[0]!.value).toBe("1"); expect(inputs[1]!.value).toBe("2");
  await act(async () => button(container, "保存").click()); expect(f.value().limits).toEqual({ perDevice: 1, total: 2 });
  expect(container.textContent).toContain("已有 3 个运行"); expect(container.textContent).toContain("降低额度不会停止现有运行");
  await act(async () => button(container, "恢复默认额度").click()); expect(f.value().limits).toEqual({ perDevice: 16, total: 64 });
});

it("rejects invalid quotas and reloads a CAS conflict without replaying the update or losing the reviewed draft", async () => {
  const f = fixture(); f.set({ remoteControlEnabled: true }); const { container } = await mount(f.controller);
  const inputs = container.querySelectorAll<HTMLInputElement>('input[type="number"]');
  await change(inputs[0]!, "0"); expect(button(container, "保存").disabled).toBe(true); expect(container.textContent).toContain("1–1000");
  await change(inputs[0]!, "1"); await change(inputs[1]!, "1001"); expect(button(container, "保存").disabled).toBe(true);
  await change(inputs[1]!, "2");
  f.updateHostedAgentSettings.mockImplementationOnce(async () => { f.set({ revision: 7n, limits: { perDevice: 8, total: 32 } }); throw new ConnectError("Concurrent change.", Code.Aborted); });
  await act(async () => button(container, "保存").click());
  expect(f.updateHostedAgentSettings).toHaveBeenCalledTimes(1); expect(f.getHostedAgentSettings).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("当前状态已刷新"); expect(container.textContent).toContain("当前：8"); expect(inputs[0]!.value).toBe("1"); expect(inputs[1]!.value).toBe("2");
  await act(async () => button(container, "保存").click()); expect(f.updateHostedAgentSettings.mock.calls[1]?.[1]).toBe(7n);
});

it("retires pending reads when the selected node changes and hides owner controls in a shared guest task", async () => {
  const old = fixture("旧节点"), next = fixture("新节点");
  let finish!: (settings: HostedAgentSettingsView) => void; let oldSignal: AbortSignal | undefined;
  old.getHostedAgentSettings.mockImplementationOnce((signal?: AbortSignal) => { oldSignal = signal; return new Promise(resolve => { finish = resolve; }); });
  const { container, root } = await mount(old.controller);
  await act(async () => root.render(<HostedAgentSettings controller={next.controller} t={t} />)); expect(oldSignal?.aborted).toBe(true);
  await act(async () => finish({ ...old.value(), remoteControlEnabled: true }));
  expect(container.textContent).toContain("本节点：新节点"); expect(container.textContent).not.toContain("本节点：旧节点");
  expect(container.querySelector('[role="switch"][aria-label="允许远程调用模型"]')?.getAttribute("aria-checked")).toBe("false");
  const guest = { ...next.controller, state: { ...next.controller.state, sessionAccess: { role: "guest" } } } as unknown as AppController;
  await act(async () => root.render(<HostedAgentSettings controller={guest} t={t} />)); expect(container.textContent).toBe("");
});
