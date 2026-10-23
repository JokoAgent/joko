// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { PartnerIdentityApi } from "../partner-identity-api.js";
import type { PartnerProfileView } from "../model.js";
import { PartnerIdentityDirectory } from "./PartnerIdentityDirectory.js";

let root: Root, container: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const link = create(contract.PartnerIdentityLinkSchema, { linkId: "link", alias: "My Partner", status: "active", identity: { authorityServerId: "source", partnerId: "partner", displayName: "Remote" } });
const joined = create(contract.JoinedTaskShareSchema, { joinId: "canonical-join", status: "active", share: { sessionId: "canonical", hostServerId: "source" } });
function fixture() {
  const navigate = vi.fn(), open = vi.fn(async () => create(contract.OpenPartnerIdentityResponseSchema, { link, joined }));
  const api = { listPartnerIdentities: vi.fn(async () => create(contract.ListPartnerIdentitiesResponseSchema, { links: [link] })),
    openPartnerIdentity: open, issuePartnerIdentity: vi.fn(async () => create(contract.IssuePartnerIdentityResponseSchema, { invitation: "private-invitation" })) } as unknown as PartnerIdentityApi;
  const controller = { partnerIdentity: api, state: { effectiveLocale: "en", activeProfile: { id: "home-profile" } }, navigate } as unknown as AppController;
  return { api, controller, open, navigate };
}
async function mount(controller: AppController, partners: readonly PartnerProfileView[] = []) { await act(async () => root.render(<PartnerIdentityDirectory controller={controller} partners={partners} />)); }
async function click(text: string) { const button = [...container.querySelectorAll("button")].find(row => row.textContent === text); expect(button).toBeDefined(); await act(async () => button!.click()); }
it("opens the exact joined canonical in the Home profile and retains an unknown join for an explicit receipt check", async () => {
  const f = fixture(); await mount(f.controller); await click("Open conversation");
  expect(f.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "sharedTask", joinId: "canonical-join", profileId: "home-profile" });
  f.navigate.mockClear(); f.open.mockResolvedValueOnce(create(contract.OpenPartnerIdentityResponseSchema, { link, intent: { status: "unknown" } }));
  await click("Open conversation"); expect(f.navigate).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("unconfirmed");
  expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
});
it("does not navigate a late identity result after the connection changes", async () => {
  const f = fixture(); let finish!: (value: contract.OpenPartnerIdentityResponse) => void;
  f.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); await mount(f.controller);
  const button = [...container.querySelectorAll("button")].find(row => row.textContent === "Open conversation")!;
  await act(async () => button.click()); expect(f.open).toHaveBeenCalledOnce();
  const next = fixture(); await mount(next.controller);
  await act(async () => finish(create(contract.OpenPartnerIdentityResponseSchema, { link, joined })));
  expect(f.navigate).not.toHaveBeenCalled(); expect(next.navigate).not.toHaveBeenCalled();
});
it("issues only the selected current profile revision and keeps the private reply visible until closed", async () => {
  const f = fixture(), partners = [{ id: "partner", revision: 7n, lifecycle: "active", canonicalSessionId: "canonical", displayName: "Local" }] as unknown as PartnerProfileView[];
  await mount(f.controller, partners);
  await act(async () => { const select = container.querySelector("select")!; select.value = "partner"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("Issue private access");
  expect(f.api.issuePartnerIdentity).toHaveBeenCalledWith(expect.objectContaining({ partnerId: "partner", expectedRevision: 7n }), expect.anything());
  expect(container.querySelector("textarea")?.value).toBe("private-invitation"); await click("Close"); expect(container.querySelector("textarea")).toBeNull();
});
