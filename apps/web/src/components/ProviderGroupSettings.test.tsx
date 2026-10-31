// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { ProviderGroupSettings, type ProviderGroupSettingsTranslator } from "./ProviderGroupSettings.js";
import type { ProviderGroupSettingsApi } from "../provider-group-settings.js";
const roots: Root[] = [];
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
const t: ProviderGroupSettingsTranslator = key => key.split(".").at(-1)!;
function fixture(kind = contract.ProviderGroupMemberKind.LOCAL, available = true) {
  const key = { backendId: "native", providerId: "provider" }, member = create(contract.ProviderGroupMemberSchema, { key: "member", kind,
    ...key, nativeBackendId: key.backendId, nodeId: "node", displayName: "This computer", capacity: 4, weight: 1 });
  let snapshot = create(contract.ProviderGroupSnapshotSchema, { key, revision: 1n, config: { strategy: contract.ProviderGroupStrategy.LEAST_BUSY, autoSwitch: true, members: [member] } });
  const get = vi.fn(async () => snapshot), update = vi.fn(async (_key: typeof key, revision: bigint, config: contract.ProviderGroupConfig | undefined) => {
    expect(revision).toBe(snapshot.revision); snapshot = create(contract.ProviderGroupSnapshotSchema, { key, revision: revision + 1n, config }); return snapshot;
  });
  const usage = vi.fn(async () => [create(contract.ProviderGroupUsageRowSchema, { group: key, memberKey: "old-member", nodeId: "old-node", nodeName: "Removed computer", partyId: "person", partyName: "Person",
    modelId: "model", turns: 2n, totalTokens: 14n, costMicros: 1000001n, currencyCode: "USD", estimated: true, tokensComplete: true, costComplete: false })]);
  const quota = vi.fn(async (_query: Omit<contract.GetProviderGroupMemberAccountUsageRequest, '$typeName'>, _signal?: AbortSignal) => create(contract.GetProviderGroupMemberAccountUsageResponseSchema, { memberKey: member.key, revision: 1n, state: 'ready',
    accountUsage: { providerId: key.providerId, primaryWindow: { usedPercent: 12.5, windowMinutes: 300 }, credits: { balance: '7.5000' } } }));
  const api: ProviderGroupSettingsApi = { getProviderGroup: get, listProviderGroupCandidates: async () => [create(contract.ProviderGroupCandidateSchema, { member, available })],
    updateProviderGroup: update, getProviderGroupUsage: usage, getProviderGroupMemberAccountUsage: quota };
  return { api, get, update, usage, quota, key };
}
async function mount(f: ReturnType<typeof fixture>) { const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<ProviderGroupSettings api={f.api} nodeName="Owner" providers={[{ ...f.key, displayName: "Native Provider" }]} t={t} />)); return { container, root }; }
function button(container: HTMLElement, text: string) { const value = [...container.querySelectorAll("button")].find(button => button.textContent === text); if (!value) throw new Error("Missing " + text); return value; }
it('reads only the expanded original account and retires a late result when collapsed', async () => {
  const f = fixture(), { container } = await mount(f);
  expect(f.quota).not.toHaveBeenCalled();
  await act(async () => button(container, 'accountQuota').click());
  expect(f.quota).toHaveBeenCalledExactlyOnceWith({ key: f.key, expectedRevision: 1n, memberKey: 'member' }, expect.any(AbortSignal));
  expect(container.querySelector('[role="region"]')?.textContent).toContain('remaining');
  expect(container.querySelector('[role="region"]')?.textContent).toContain('7.5000');
  await act(async () => button(container, 'accountQuota').click());
  let finish!: (value: Awaited<ReturnType<typeof f.quota>>) => void;
  f.quota.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => button(container, 'accountQuota').click());
  const signal = f.quota.mock.calls[1]?.[1] as AbortSignal;
  await act(async () => button(container, 'accountQuota').click());
  expect(signal.aborted).toBe(true);
  await act(async () => finish(create(contract.GetProviderGroupMemberAccountUsageResponseSchema, { memberKey: 'member', revision: 1n, state: 'ready', accountUsage: { providerId: 'provider', credits: { balance: 'LATE_ACCOUNT' } } })));
  expect(container.textContent).not.toContain('LATE_ACCOUNT'); expect(container.querySelector('[role="region"]')).toBeNull();
});
it.each([['shared', contract.ProviderGroupMemberKind.SHARE, true], ['offline', contract.ProviderGroupMemberKind.DEVICE, false]] as const)(
  'shows %s accounts without querying their quota', async (_state, kind, available) => {
    const f = fixture(kind, available), { container } = await mount(f);
    await act(async () => button(container, 'accountQuota').click());
    expect(f.quota).not.toHaveBeenCalled();
    expect(container.querySelector('[role="region"]')?.textContent).toContain(available ? 'quotaShared' : 'quotaOffline');
  });
async function input(element: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
it("edits all four strategies and exact member bounds and saves one CAS with real incomplete usage", async () => {
  const f = fixture(), { container } = await mount(f), strategy = container.querySelectorAll("select")[1]!;
  expect([...strategy.options].map(option => option.value)).toEqual(["1", "2", "3", "4"]);
  await act(async () => { strategy.value = String(contract.ProviderGroupStrategy.WEIGHTED); strategy.dispatchEvent(new Event("change", { bubbles: true })); });
  const numbers = container.querySelectorAll<HTMLInputElement>('input[type="number"]'); await input(numbers[0]!, "17"); expect(button(container, "save").disabled).toBe(true);
  await input(numbers[0]!, "16"); await input(numbers[1]!, "100"); await act(async () => button(container, "save").click());
  expect(f.update).toHaveBeenCalledOnce(); expect(f.update.mock.calls[0]![2]).toMatchObject({ strategy: contract.ProviderGroupStrategy.WEIGHTED, members: [{ capacity: 16, weight: 100 }] });
  expect(container.textContent).toContain("Removed computer"); expect(container.textContent).toContain("1.000001"); expect(container.textContent).toContain("incomplete"); expect(container.textContent).toContain("estimated");
});
it("preserves the user's draft after a CAS conflict and never retries the failed mutation", async () => {
  const f = fixture(); f.update.mockRejectedValueOnce(new ConnectError("Changed", Code.Aborted)); const { container } = await mount(f);
  const capacity = container.querySelector<HTMLInputElement>('input[type="number"]')!; await input(capacity, "9"); await act(async () => button(container, "save").click());
  expect(capacity.value).toBe("9"); expect(container.textContent).toContain("conflict"); expect(f.update).toHaveBeenCalledOnce();
  await act(async () => button(container, "delete").click()); expect(f.update.mock.calls[1]![2]).toBeUndefined();
});
it("ignores an old source response after switching the authenticated owner API", async () => {
  const old = fixture(), next = fixture(); let finish!: (value: contract.ProviderGroupSnapshot) => void;
  old.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const { root, container } = await mount(old);
  await act(async () => root.render(<ProviderGroupSettings api={next.api} nodeName="Next" providers={[{ ...next.key, displayName: "New Provider" }]} t={t} />));
  await act(async () => finish(create(contract.ProviderGroupSnapshotSchema, { key: old.key, revision: 999n, config: { strategy: contract.ProviderGroupStrategy.ORDERED, members: [] } })));
  expect(container.querySelectorAll("select")[1]!.value).toBe(String(contract.ProviderGroupStrategy.LEAST_BUSY)); expect(container.textContent).not.toContain("loadFailed");
});
it("keeps refresh available after the first group read fails with a single provider", async () => {
  const f = fixture(); f.get.mockRejectedValueOnce(new Error("temporary read failure"));
  const { container } = await mount(f);
  expect(container.textContent).toContain("loadFailed");
  expect(container.querySelector('input[type="number"]')).toBeNull();
  await act(async () => button(container, "refresh").click());
  expect(f.get).toHaveBeenCalledTimes(2);
  expect(container.querySelector('input[type="number"]')).not.toBeNull();
  expect(container.textContent).not.toContain("loadFailed");
});
it("hides prior usage when the period changes and distinguishes loading, failure, and empty results", async () => {
  const f = fixture(), { container } = await mount(f);
  const panel = container.querySelector<HTMLElement>(".provider-group-settings__usage")!;
  expect(panel.textContent).toContain("1.000001");
  let fail!: (error: unknown) => void;
  f.usage.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await act(async () => { const select = panel.querySelector("select")!; select.value = "7d"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(panel.querySelector("table")).toBeNull();
  expect(panel.querySelector('[role="status"]')).not.toBeNull();
  expect(panel.textContent).not.toContain("noUsage");
  await act(async () => fail(new Error("usage unavailable")));
  expect(panel.querySelector("table")).toBeNull();
  expect(panel.textContent).toContain("loadFailed");
  expect(panel.textContent).not.toContain("noUsage");
  f.usage.mockResolvedValueOnce([]);
  await act(async () => button(panel, "refresh").click());
  expect(panel.textContent).toContain("noUsage");
  expect(panel.textContent).not.toContain("loadFailed");
});
