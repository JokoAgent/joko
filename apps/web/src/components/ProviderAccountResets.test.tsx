// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ProviderAccountResetStateSchema, ProviderAccountResetResultSchema, ProviderAccountResetAvailability, ProviderAccountResetOutcome,
  ProviderAccountResetOfferSchema, ProviderAccountResetAutomaticSettingsSchema, RevisionSchema,
  DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, type ProviderAccountResetApi, type ProviderAccountResetState } from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { ProviderRuntimeView } from "../model.js";
import { translate } from "../i18n.js";
import { ProviderAccountResets } from "./ProviderAccountResets.js";
const roots: Root[] = [], offerId = "0d724809-86af-4f8d-93dc-fbfa21e81afe";
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate("en", key, values);
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
function fixture() {
  let state = create(ProviderAccountResetStateSchema, { backendId: "codex", providerId: "openai", availability: ProviderAccountResetAvailability.AVAILABLE,
    accountKey: "a".repeat(64), accountLabel: "…ccount", availableCount: 1, defaultOffer: { offerId }, settingsRevision: { value: 0n }, automaticSettings: DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS });
  const read = vi.fn(async (_backend: string, _provider: string, _signal: AbortSignal): Promise<ProviderAccountResetState> => state);
  const consume = vi.fn<ProviderAccountResetApi["consume"]>(async value => create(ProviderAccountResetResultSchema, { backendId: value.backendId, providerId: value.providerId,
    accountKey: value.accountKey, offerId, outcome: ProviderAccountResetOutcome.ALREADY_REDEEMED }));
  const save = vi.fn<ProviderAccountResetApi["save"]>(async () => undefined);
  let api: ProviderAccountResetApi = { ownerKey: "original-owner", read, consume, save };
  const controller = { providerAccountResets: () => api } as unknown as AppController;
  const runtime = { backendId: "codex", id: "openai", capabilities: new Set(["provider.account_resets"]) } as unknown as ProviderRuntimeView;
  const container = document.body.appendChild(document.createElement("div")), root = createRoot(container); roots.push(root);
  const render = async (value = runtime, compact = false) => { await act(async () => root.render(<ProviderAccountResets controller={controller} runtime={value} locale="en" t={t} compact={compact} />)); };
  const click = async (label: string, within: ParentNode = container) => { const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === label);
    if (!button) throw new Error(`Missing ${label}`); await act(async () => button.click()); };
  return { read, consume, save, render, click, container, runtime, get state() { return state; }, set state(value) { state = value; },
    replaceOwner: () => { api = { ...api, ownerKey: "replacement-owner" }; } };
}
it("requires confirmation, retains the original offer after an ambiguous result, and retries only that offer", async () => {
  const f = fixture(); await f.render(); await f.click(t("accountReset.use")); expect(f.consume).not.toHaveBeenCalled();
  await f.click(t("accountReset.cancel"), document.querySelector('[role="alertdialog"]')!); expect(f.consume).not.toHaveBeenCalled();
  f.consume.mockImplementationOnce(async () => { f.state = create(ProviderAccountResetStateSchema, { ...f.state, defaultOffer: create(ProviderAccountResetOfferSchema, { offerId, retryOnly: true }) }); throw new Error("Unknown native result"); });
  await f.click(t("accountReset.use")); await f.click(t("accountReset.use"), document.querySelector('[role="alertdialog"]')!);
  expect(f.container.textContent).toContain(t("accountReset.pending")); expect(f.container.textContent).toContain(t("accountReset.failed"));
  await f.click(t("accountReset.retry")); await f.click(t("accountReset.retry"), document.querySelector('[role="alertdialog"]')!);
  expect(f.consume.mock.calls.map(call => call[1].offerId)).toEqual([offerId, offerId]);
  expect(f.container.textContent).toContain(t("accountReset.outcome.alreadyRedeemed"));
});
it("disables automatic use when its last rule is cleared, validates day bounds, and saves the original settings revision", async () => {
  const f = fixture(); f.state = create(ProviderAccountResetStateSchema, { ...f.state,
    automaticSettings: create(ProviderAccountResetAutomaticSettingsSchema, { ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: true }), settingsRevision: create(RevisionSchema, { value: 7n }) });
  await f.render();
  const checkbox = (label: string) => [...f.container.querySelectorAll<HTMLLabelElement>("label")].find(node => node.textContent === label)!.querySelector<HTMLInputElement>("input")!;
  await act(async () => { checkbox(t("accountReset.lowQuota")).click(); checkbox(t("accountReset.expiring")).click(); });
  expect(checkbox(t("accountReset.enabled")).checked).toBe(false); expect(checkbox(t("accountReset.enabled")).disabled).toBe(true);
  await f.click(t("accountReset.save")); expect(f.save).toHaveBeenCalledWith(expect.objectContaining({ settingsRevision: expect.objectContaining({ value: 7n }) }),
    { ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: false, lowQuota: false, expiring: false }, expect.any(AbortSignal));
  const days = f.container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(days, "366"); days.dispatchEvent(new Event("input", { bubbles: true })); });
  await f.click(t("accountReset.save")); expect(f.container.textContent).toContain(t("accountReset.invalid")); expect(f.save).toHaveBeenCalledTimes(1);
});
it("retires an old account read when the connection owner changes and hides controls for another Backend", async () => {
  const f = fixture(); let finish!: (value: ProviderAccountResetState) => void;
  f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await f.render(); const signal = f.read.mock.calls[0]![2];
  const old = f.state; f.state = create(ProviderAccountResetStateSchema, { ...old, accountKey: "b".repeat(64), accountLabel: "…second", availableCount: 0 }); f.replaceOwner(); await f.render();
  expect(signal.aborted).toBe(true); await act(async () => finish(old));
  expect(f.container.textContent).toContain("…second"); expect(f.container.textContent).not.toContain("…ccount");
  const count = f.read.mock.calls.length; await f.render({ ...f.runtime, capabilities: new Set() }); expect(f.container.textContent).toBe(""); expect(f.read).toHaveBeenCalledTimes(count);
});

it("keeps an unsaved automatic rule after a settings failure until the user explicitly refreshes", async () => {
  const f = fixture(); await f.render(); f.save.mockRejectedValueOnce(new Error("Settings revision changed"));
  const low = [...f.container.querySelectorAll("label")].find(node => node.textContent === t("accountReset.lowQuota"))!.querySelector<HTMLInputElement>("input")!;
  await act(async () => low.click()); await f.click(t("accountReset.save"));
  expect(low.checked).toBe(false); expect(f.read).toHaveBeenCalledTimes(1); expect(f.container.textContent).toContain(t("accountReset.failed"));
});

it("reads the compact task quota entry only after it is opened", async () => {
  const f = fixture(); await f.render(f.runtime, true); expect(f.read).not.toHaveBeenCalled();
  await f.click(t("accountReset.title")); expect(f.read).toHaveBeenCalledOnce(); expect(document.querySelector('[role="dialog"]')?.textContent).toContain("…ccount");
});
