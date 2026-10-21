// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { PartnerPackageEntrySchema, PartnerImportResultSchema, PartnerImportStatus, PartnerImportCheckStatus } from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { PartnerDiscoveryDialog } from "./PartnerDiscoveryDialog.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
const entry = () => create(PartnerPackageEntrySchema, { packageId: "engineer", packageVersion: "0.5.0", packageHash: "a".repeat(64),
  name: "Engineering partner", description: "Keeps delivery moving", bubble: "Review the current delivery", avatar: "orbit",
  capabilities: [{ icon: "code", label: "Review code" }, { icon: "check", label: "Check evidence" }, { icon: "file", label: "Report results" }],
  skills: [{ name: "Review", description: "Review selected work" }], knowledge: [{ name: "Evidence", description: "What counts as evidence" }], remembers: ["Repository"],
  tools: [{ id: "gitlab", purpose: "Read selected merge requests" }], routines: [{ name: "Daily check", description: "Check selected work" }] });
const result = () => create(PartnerImportResultSchema, { requestId: "request-one", partnerId: "partner-one", canonicalSessionId: "session-one", saved: true,
  status: PartnerImportStatus.NEEDS_ATTENTION, checks: [{ entryId: "routine-one", name: "Daily check", status: PartnerImportCheckStatus.NEEDS_ATTENTION, message: "IMPORT_ITEM_FAILED" }] });
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function button(label: string) { const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === label); if (!match) throw new Error("Missing button: " + label); return match; }
async function mount(invite: (...args: unknown[]) => Promise<ReturnType<typeof result>>, created: (value: ReturnType<typeof result>) => void) {
  const api = { ownerKey: "owner", packages: vi.fn(async () => [entry()]), invitePackage: vi.fn(invite), status: vi.fn() };
  const controller = { state: { effectiveLocale: "en" }, partnerImportApi: () => api } as unknown as AppController;
  const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
  await act(async () => { root!.render(<PartnerDiscoveryDialog controller={controller} ownerKey="owner" foreground onClose={() => {}} onCreated={created} />); await settle(); });
  return api;
}
it("shows authored detail modules, keeps routines off, and opens a partial installation without another invite", async () => {
  const created = vi.fn(); const api = await mount(async () => result(), created);
  expect(api.invitePackage).not.toHaveBeenCalled();
  await act(async () => { button("Engineering partner").click(); await settle(); });
  expect(document.body.textContent).toContain("Off by default"); expect(document.body.textContent).toContain("GitLab");
  expect(document.body.textContent).toContain("Knowledge and memory");
  await act(async () => { button("Invite").click(); await settle(); });
  expect(api.invitePackage).toHaveBeenCalledTimes(1); expect(created).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Daily check");
  await act(async () => { button("Open partner").click(); await settle(); });
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ partnerId: "partner-one", canonicalSessionId: "session-one" }));
  expect(api.invitePackage).toHaveBeenCalledTimes(1);
});
it("keeps an accepted invitation owned by its original dialog after it closes", async () => {
  let complete!: (value: ReturnType<typeof result>) => void;
  const response = new Promise<ReturnType<typeof result>>(resolve => { complete = resolve; });
  const created = vi.fn(); const api = await mount(() => response, created);
  await act(async () => { button("Invite").click(); await settle(); });
  expect(api.invitePackage).toHaveBeenCalledTimes(1);
  await act(async () => { root!.unmount(); root = undefined; complete({ ...result(), status: PartnerImportStatus.COMPLETE }); await settle(); });
  expect(created).not.toHaveBeenCalled();
});
