// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ProviderAccountResetStateSchema, ProviderAccountResetResultSchema, ProviderAccountResetAvailability, ProviderAccountResetOutcome,
  ProviderAccountResetOfferSchema, ProviderAccountResetAutomaticSettingsSchema,
  DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, type ProviderAccountResetApi, type ProviderAccountResetState } from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: box, Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children), Alert: { alert: native.alert },
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => createElement("button", { onClick: onPress, disabled, "aria-label": accessibilityLabel }, children),
    Switch: ({ value, onValueChange, disabled, accessibilityLabel }: { value: boolean; onValueChange: (value: boolean) => void; disabled?: boolean; accessibilityLabel?: string }) => createElement("input", { type: "checkbox", checked: value, disabled, "aria-label": accessibilityLabel, onChange: () => onValueChange(!value) }),
    TextInput: ({ value, onChangeText, editable, accessibilityLabel }: { value: string; onChangeText: (value: string) => void; editable?: boolean; accessibilityLabel?: string }) => createElement("input", { value, disabled: !editable, "aria-label": accessibilityLabel, onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) }),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 } };
});
vi.mock("./MobileModelQuotaBar", () => ({ MobileModelQuotaBar: () => null }));
import { MobileAccountUsageSummary } from "./MobileAccountUsageSummary";
let root: Root, host: HTMLDivElement;
const offerId = "0d724809-86af-4f8d-93dc-fbfa21e81afe", colors = { ink: "#111", muted: "#666", border: "#ccc" };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); native.alert.mockReset(); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
function fixture() {
  let state = create(ProviderAccountResetStateSchema, { backendId: "codex", providerId: "openai", availability: ProviderAccountResetAvailability.AVAILABLE,
    accountKey: "a".repeat(64), accountLabel: "…ccount", availableCount: 1, defaultOffer: { offerId }, settingsRevision: { value: 0n }, automaticSettings: DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS });
  const read = vi.fn(async (_backend: string, _provider: string, _signal: AbortSignal): Promise<ProviderAccountResetState> => state);
  const consume = vi.fn<ProviderAccountResetApi["consume"]>(async value => create(ProviderAccountResetResultSchema, { backendId: value.backendId, providerId: value.providerId,
    accountKey: value.accountKey, offerId, outcome: ProviderAccountResetOutcome.ALREADY_REDEEMED }));
  const save = vi.fn<ProviderAccountResetApi["save"]>(async () => undefined);
  let api: ProviderAccountResetApi = { ownerKey: "original", read, consume, save };
  return { read, consume, save, get state() { return state; }, set state(value) { state = value; }, replaceOwner: () => { api = { ...api, ownerKey: "replacement" }; },
    render: async () => { await act(async () => root.render(createElement(MobileAccountUsageSummary, { colors, locale: "en", now: Date.now(), reset: { api, backendId: "codex", providerId: "openai" } }))); } };
}
async function click(label: string) { const button = [...host.querySelectorAll("button")].find(value => value.textContent === label); if (!button) throw new Error(`Missing ${label}`); await act(async () => button.click()); }
async function confirm() { const buttons = native.alert.mock.calls.at(-1)![2] as { onPress?: () => void }[]; await act(async () => buttons[1]!.onPress?.()); }
it("mounts resets in the original mobile usage summary, confirms consumption, and keeps unknown retries on the same offer", async () => {
  const f = fixture(); await f.render(); await click("Use reset"); expect(f.consume).not.toHaveBeenCalled(); expect(native.alert.mock.calls[0]![1]).toContain("…ccount");
  f.consume.mockImplementationOnce(async () => { f.state = create(ProviderAccountResetStateSchema, { ...f.state, defaultOffer: create(ProviderAccountResetOfferSchema, { offerId, retryOnly: true }) }); throw new Error("Unknown"); });
  await confirm(); expect(host.textContent).toContain("unconfirmed result"); await click("Retry original reset"); await confirm();
  expect(f.consume.mock.calls.map(call => call[1].offerId)).toEqual([offerId, offerId]); expect(host.textContent).toContain("The original reset already completed.");
});
it("retires the original mobile account read and ignores its late result after the owner changes", async () => {
  const f = fixture(); let finish!: (value: ProviderAccountResetState) => void;
  f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await f.render(); const signal = f.read.mock.calls[0]![2], old = f.state;
  f.state = create(ProviderAccountResetStateSchema, { ...old, accountKey: "b".repeat(64), accountLabel: "…second" }); f.replaceOwner(); await f.render();
  expect(signal.aborted).toBe(true); await act(async () => finish(old)); expect(host.textContent).toContain("…second"); expect(host.textContent).not.toContain("…ccount"); expect(f.consume).not.toHaveBeenCalled();
});

it("disables mobile automation with its last condition and preserves the failed settings draft", async () => {
  const f = fixture(); f.state = create(ProviderAccountResetStateSchema, { ...f.state,
    automaticSettings: create(ProviderAccountResetAutomaticSettingsSchema, { ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, enabled: true }) });
  await f.render(); f.save.mockRejectedValueOnce(new Error("Settings save failed"));
  const toggle = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => toggle("When the ordinary weekly quota is almost exhausted").click());
  await act(async () => toggle("When a reset credit is about to expire").click());
  expect(toggle("Use reset credits automatically").checked).toBe(false); expect(toggle("Use reset credits automatically").disabled).toBe(true);
  await click("Save automatic settings"); expect(f.save).toHaveBeenCalledWith(expect.anything(), { ...DEFAULT_PROVIDER_ACCOUNT_RESET_SETTINGS, lowQuota: false, expiring: false, enabled: false }, expect.any(AbortSignal));
  expect(f.read).toHaveBeenCalledTimes(1); expect(toggle("When a reset credit is about to expire").checked).toBe(false);
});
