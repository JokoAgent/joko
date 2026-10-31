// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ProviderAccountBalanceResultSchema, type ProviderAccountBalanceResult } from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { ProviderRuntimeView } from "../model.js";
import { translate } from "../i18n.js";
import { ProviderAccountBalance } from "./ProviderAccountBalance.js";
const roots: Root[] = [];
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate("en", key, values);
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
function fixture() {
  const read = vi.fn(async (_backend: string, _provider: string, _force: boolean, _signal?: AbortSignal): Promise<ProviderAccountBalanceResult> => create(ProviderAccountBalanceResultSchema, { status: "ready", snapshot: { case: "deepseek", value: { isAvailable: true, balances: [{ currency: "CNY", totalBalance: "2.123456789", grantedBalance: "0", toppedUpBalance: "2.123456789" }] } } }));
  const controller = { state: { effectiveLocale: "en" }, readProviderAccountBalance: read } as unknown as AppController;
  const runtime = { backendId: "pi", id: "deepseek", capabilities: new Set(["provider.account_balance"]), accountBalanceRevision: "original" } as unknown as ProviderRuntimeView;
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  const render = async (value = runtime) => { await act(async () => root.render(<ProviderAccountBalance controller={controller} runtime={value} t={t} />)); };
  const click = async (label: string) => { const button = [...container.querySelectorAll("button")].find(button => button.textContent === label); if (!button) throw new Error(label); await act(async () => button.click()); };
  return { read, runtime, container, root, render, click };
}
it("reads only on expansion and sends manual refresh to the original Backend", async () => {
  const f = fixture(); await f.render(); expect(f.read).not.toHaveBeenCalled(); await f.click(t("balance.title"));
  expect(f.read).toHaveBeenCalledExactlyOnceWith("pi", "deepseek", false, expect.any(AbortSignal)); expect(f.container.textContent).toContain("2.123456789");
  await f.click(t("settings.providerGroups.refresh")); expect(f.read).toHaveBeenLastCalledWith("pi", "deepseek", true, expect.any(AbortSignal));
});
it("retires a collapsed request and an old credential response", async () => {
  const f = fixture(); let finish!: (value: ProviderAccountBalanceResult) => void;
  f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await f.render(); await f.click(t("balance.title"));
  const signal = f.read.mock.calls[0]![3]!; await f.render({ ...f.runtime, accountBalanceRevision: "replacement" }); expect(signal.aborted).toBe(true);
  await act(async () => finish(create(ProviderAccountBalanceResultSchema, { status: "unavailable", error: "LATE_CREDENTIAL" })));
  expect(f.container.textContent).not.toContain("LATE_CREDENTIAL"); expect(f.read).toHaveBeenCalledTimes(2);
  await f.click(t("balance.title")); expect(f.container.querySelector('[role="region"]')).toBeNull();
});
it("shows stale data, the exact provider error, retry time and the region's official dashboard", async () => {
  const f = fixture(); f.read.mockResolvedValueOnce(create(ProviderAccountBalanceResultSchema, { status: "ready", stale: true, error: "auth", retryAt: { seconds: 1_800_000_000n }, dashboardUrl: "https://z.ai/manage-apikey/coding-plan/personal/my-plan", snapshot: { case: "zhipu", value: { noPlan: true } } }));
  await f.render(); await f.click(t("balance.title")); expect(f.container.textContent).toContain(t("balance.stale")); expect(f.container.textContent).toContain(t("balance.noPlan"));
  expect(f.container.querySelector('[role="alert"]')?.textContent).toBe(t("balance.error.auth")); expect(f.container.querySelector("a")?.href).toBe("https://z.ai/manage-apikey/coding-plan/personal/my-plan");
});
