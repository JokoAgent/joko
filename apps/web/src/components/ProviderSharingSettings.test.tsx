// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSharingSettings } from "./ProviderSharingSettings.js";
const roots: Root[] = [];
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });
function fixture() {
  let value = create(contract.ListProviderSharesResponseSchema, { owned: [{ shareId: "share", providerName: "Shared Provider", members: [{ memberId: "member", generation: 1n, person: { name: "Member" }, status: "active" }],
    requests: [{ requestId: "request", pairingCode: "0123", person: { name: "Applicant" }, status: "pending" }],
    reshares: [{ id: "consent", memberId: "member", person: { name: "Third person" }, state: "pending" }] }] });
  const list = vi.fn(async (_signal: AbortSignal) => value), refresh = vi.fn(async (_signal: AbortSignal) => value);
  const createLink = vi.fn(async () => create(contract.CreateProviderShareLinkResponseSchema, { link: contract.buildProviderSharingLink("http://127.0.0.1:4000", "a".repeat(43), `ed25519:${"a".repeat(64)}`), expiresAtMs: BigInt(Date.now() + 300_000) }));
  const decide = vi.fn(async () => { value = create(contract.ListProviderSharesResponseSchema, { owned: value.owned.map(row => ({ ...row, requests: [] })) }); return create(contract.DecideProviderShareRequestResponseSchema); });
  const member = vi.fn(async () => create(contract.SetProviderShareMemberResponseSchema)), reshare = vi.fn(async () => create(contract.DecideProviderReshareResponseSchema));
  const preview = vi.fn(async () => create(contract.PreviewProviderShareResponseSchema, { preview: { providerName: "Foreign Provider", owner: { name: "Issuer" }, hostServerId: "foreign-home", state: "unused", expiresAtMs: BigInt(Date.now() + 300_000) } }));
  const apply = vi.fn(async () => create(contract.ApplyProviderShareResponseSchema, { intent: { status: "unknown" } }));
  const api = { list, refresh, createLink, decide, member, reshare, preview, apply, withdraw: vi.fn(), leave: vi.fn() } as unknown as contract.ProviderSharingApi;
  const catalog = create(contract.GetHostedAgentCatalogResponseSchema, { remoteControlEnabled: true, backends: [{ backendId: "native", displayName: "Native", providers: [{ providerId: "provider", displayName: "Provider", connected: true, remoteInvocationEnabled: true, models: [{ key: { providerId: "provider", modelId: "model" } }] }] }] });
  return { api, catalog, list, refresh, createLink, decide, member, reshare, preview, apply };
}
async function mount(f: ReturnType<typeof fixture>, nodeKey = "home") {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<ProviderSharingSettings api={f.api} nodeKey={nodeKey} nodeName="Owner" catalog={f.catalog} language="en" />)); return { container, root };
}
function button(container: HTMLElement, label: string) { const result = [...container.querySelectorAll("button")].find(row => row.textContent === label); if (!result) throw new Error(`Missing ${label}`); return result; }
it("requires the human comparison before approval and keeps member and original issuer reshare decisions separate", async () => {
  const f = fixture(), { container } = await mount(f);
  expect(container.querySelector("output")?.textContent).toBe("0123");
  const approvals = [...container.querySelectorAll("button")].filter(row => row.textContent === "Approve"); expect(approvals[0]!.disabled).toBe(true); expect(approvals[1]!.disabled).toBe(false);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); expect(approvals[0]!.disabled).toBe(false);
  await act(async () => approvals[0]!.click()); expect(f.decide).toHaveBeenCalledWith(expect.any(String), "request", true, expect.any(AbortSignal)); expect(f.reshare).not.toHaveBeenCalled();
  await act(async () => button(container, "Approve").click()); expect(f.reshare).toHaveBeenCalledWith(expect.any(String), "consent", true, expect.any(AbortSignal));
  await act(async () => button(container, "Pause").click()); expect(f.member).toHaveBeenCalledWith(expect.objectContaining({ shareId: "share", memberId: "member", generation: 1n, action: "pause" }), expect.any(AbortSignal));
});
it("previews an invitation without submitting and only submits once after the explicit application", async () => {
  const f = fixture(), { container } = await mount(f); await act(async () => button(container, "Received").click());
  const textarea = container.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, contract.buildProviderSharingLink("http://127.0.0.1:4000", "a".repeat(43), `ed25519:${"a".repeat(64)}`)); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button(container, "Preview invitation").click()); expect(f.preview).toHaveBeenCalledTimes(1); expect(f.apply).not.toHaveBeenCalled(); expect(container.textContent).toContain("Issuer");
  await act(async () => button(container, "Submit application").click()); expect(f.apply).toHaveBeenCalledTimes(1); expect(textarea.value).toBe(""); expect(f.refresh).toHaveBeenCalled();
});
it("retires a pending list and clears private invitation drafts when the selected Home changes", async () => {
  const old = fixture(), next = fixture(); let finish!: (value: contract.ListProviderSharesResponse) => void, oldSignal: AbortSignal | undefined;
  old.list.mockImplementationOnce(signal => { oldSignal = signal; return new Promise(resolve => { finish = resolve; }); });
  const { container, root } = await mount(old, "old-home");
  await act(async () => root.render(<ProviderSharingSettings api={next.api} nodeKey="next-home" nodeName="Next" catalog={next.catalog} language="en" />));
  expect(oldSignal?.aborted).toBe(true); await act(async () => finish(create(contract.ListProviderSharesResponseSchema, { owned: [{ providerName: "Stale old Home" }] })));
  expect(container.textContent).not.toContain("Stale old Home"); expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Next");
});
it("navigates sharing tabs with the keyboard and identifies the active panel", async () => {
  const f = fixture(), { container } = await mount(f), tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1]);
  await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(tabs[1]);
  expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
  expect(tabs[1]!.classList.contains("button--primary")).toBe(true);
  expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(tabs[1]!.id);
  expect(document.getElementById(tabs[1]!.getAttribute("aria-controls")!)).toBe(container.querySelector('[role="tabpanel"]'));
  await act(async () => tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
  expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1]);
});
