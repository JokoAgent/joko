// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteModelAccessEditor } from "./RemoteModelAccessEditor.js";
import { ProviderSharingInsights } from "./ProviderSharingInsights.js";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
const roots: Root[] = [];
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
function mount() { const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root); return { container, root }; }

it("preserves a missing selected identity, limits member choices and sends an explicit empty selection", async () => {
  const { container, root } = mount(), save = vi.fn(async () => {});
  await act(async () => root.render(<RemoteModelAccessEditor member models={[{ id: "allowed", name: "Allowed" }, { id: "denied", name: "Denied" }]}
    selected={["missing"]} providerSelected={["allowed"]} onSave={save} />));
  expect(container.textContent).toContain("missing");
  const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(checkboxes[2]!.disabled).toBe(true); expect(checkboxes[3]!.checked).toBe(true);
  await act(async () => checkboxes[3]!.click());
  expect(container.textContent).toContain("allows no models");
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(save).toHaveBeenCalledWith([]);
});

it("loads quota only on expansion, requests usage separately and discards an obsolete response", async () => {
  const { container, root } = mount(); let finish!: (value: contract.GetReceivedProviderShareInsightsResponse) => void;
  const insights = vi.fn((_join: string, _usage: boolean, _signal: AbortSignal) => new Promise<contract.GetReceivedProviderShareInsightsResponse>(resolve => { finish = resolve; }));
  const api = { insights } as unknown as contract.ProviderSharingApi;
  await act(async () => root.render(<ProviderSharingInsights api={api} joinId="first" language="en" />)); expect(insights).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(insights).toHaveBeenCalledWith("first", false, expect.any(AbortSignal));
  const oldSignal = insights.mock.calls[0]![2];
  await act(async () => root.render(<ProviderSharingInsights key="second" api={api} joinId="second" language="en" />));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finish(create(contract.GetReceivedProviderShareInsightsResponseSchema, { insights: { visibility: { quota: true, usage: true }, quotaStatus: "ready", usageStatus: "ready",
    accounts: [{ state: "unlimited" }], days: [{ day: "2026-10-28", modelId: "stale-first-model" }] } })));
  expect(container.textContent).not.toContain("stale-first-model");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => finish(create(contract.GetReceivedProviderShareInsightsResponseSchema, { insights: { visibility: { quota: false, usage: true }, quotaStatus: "disabled", usageStatus: "not_requested" } })));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(insights).toHaveBeenLastCalledWith("second", true, expect.any(AbortSignal));
});
