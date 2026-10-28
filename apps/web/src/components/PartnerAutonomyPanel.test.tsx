// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { PartnerAutonomySettingsSchema, GetPartnerGlanceResponseSchema, ListPartnerTodosResponseSchema, type PartnerAutonomyApi } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartnerAutonomyPanel } from "./PartnerAutonomyPanel.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  let settings = create(PartnerAutonomySettingsSchema, { revision: { value: 1n }, customized: false }); let lose = true;
  const api: PartnerAutonomyApi = { ownerKey: "original-node", newOperationId: () => "original-save", settings: vi.fn(async () => settings),
    save: vi.fn(async () => { if (lose) { lose = false; throw new Error("Lost receipt"); } settings = create(PartnerAutonomySettingsSchema,
      { revision: { value: 2n }, customized: true, schedulerPartnerId: "partner" }); return settings; }),
    glance: vi.fn(async () => create(GetPartnerGlanceResponseSchema, { partnerId: "partner", partnerRevision: { value: 1n }, snapshotToken: "page", observedAt: { seconds: 1n } })),
    todos: vi.fn(async () => create(ListPartnerTodosResponseSchema, { partnerId: "partner", partnerRevision: { value: 1n } })),
    updateTodo: vi.fn(), outputs: vi.fn(async () => []) };
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PartnerAutonomyPanel api={api} partnerId="partner" name="Ada" locale="en" engaged onOpenTask={() => undefined} />); });
  return { api, host };
}
function button(label: string, scope: ParentNode = document): HTMLButtonElement { const value = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label); expect(value).toBeDefined(); return value!; }
describe("Partner follow-up invitation", () => {
  it("requires scope and allowance confirmation and explicitly recovers the same save after a lost receipt", async () => {
    const f = await fixture(); expect(f.api.glance).not.toHaveBeenCalled(); expect(f.api.save).not.toHaveBeenCalled();
    await act(async () => button("Start following up").click());
    const consent = document.querySelector('[role="alertdialog"]')!; expect(consent.textContent).toContain("model allowance"); expect(consent.textContent).toContain("does not allow answering");
    await act(async () => button("Cancel", consent).click()); expect(f.api.save).not.toHaveBeenCalled();
    await act(async () => button("Start following up").click());
    await act(async () => button("Start following up", document.querySelector('[role="alertdialog"]')!).click());
    expect(f.api.save).toHaveBeenCalledTimes(1);
    await act(async () => button("Retry the original save").click()); expect(f.api.save).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.api.save).mock.calls[0]!.slice(0, 3)).toEqual(vi.mocked(f.api.save).mock.calls[1]!.slice(0, 3));
  });
});
