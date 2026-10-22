// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ListPartnerHomeTargetsResponseSchema, InspectPartnerHomeTargetResponseSchema, MovePartnerHomeResponseSchema,
  GetPartnerHomeMoveResponseSchema, RetryPartnerHomeMoveResponseSchema, PartnerHomeMovePhase, PermissionMode,
  PartnerHomeBusyAction, partnerHomeMessages, type PartnerHomeApi } from "@joko/contracts";
import { PartnerHomeDialog } from "./PartnerHomeDialog.js";

const roots: Root[] = [], text = partnerHomeMessages("en");
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const receipt = { requestId: "change-main-once", sourceDeviceName: "Original", targetDeviceName: "Laptop", phase: PartnerHomeMovePhase.WAITING };
function fixture(pending = false) {
  const api: PartnerHomeApi = { ownerKey: "node:partner", list: vi.fn(async () => create(ListPartnerHomeTargetsResponseSchema, {
    home: { identity: { authorityServerId: "node", partnerId: "partner", generation: 1n }, deviceId: "node", deviceName: "Original", serviceNode: true, available: true, changing: pending },
    targets: [{ destination: { location: { case: "serviceNode", value: true } }, deviceName: "Original", platform: "linux", available: true },
      { destination: { location: { case: "peer", value: { targetDeviceId: "computer", routeGeneration: 1n } } }, deviceName: "Laptop", platform: "linux", available: true }],
    ...(pending ? { pendingMove: { ...receipt, phase: PartnerHomeMovePhase.NEEDS_ATTENTION } } : {}) })),
    inspect: vi.fn(async () => create(InspectPartnerHomeTargetResponseSchema, { models: [{ displayName: "Configured model", route: { backendId: "runtime", providerId: "configured", modelId: "model" },
      permissionModes: [PermissionMode.ASK, PermissionMode.ACCEPT_EDITS], canSetPlanMode: true }] })),
    move: vi.fn(async () => create(MovePartnerHomeResponseSchema, { move: receipt })),
    status: vi.fn(async () => create(GetPartnerHomeMoveResponseSchema, { move: { ...receipt, phase: PartnerHomeMovePhase.READY, canonicalSessionId: "new-main-session" } })),
    retry: vi.fn(async () => create(RetryPartnerHomeMoveResponseSchema, { move: { ...receipt, phase: PartnerHomeMovePhase.READY, canonicalSessionId: "recovered-session" } })) };
  return { api, changed: vi.fn(), close: vi.fn() };
}
async function mount(f: ReturnType<typeof fixture>, inputHandoff = true) {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host); roots.push(root);
  await act(async () => { root.render(<PartnerHomeDialog api={f.api} partnerId="partner" revision={9n} inputHandoff={inputHandoff} locale="en" onChanged={f.changed} onClose={f.close} />); });
}
async function select(label: string, value: string) {
  const field = [...document.querySelectorAll("label")].find(item => item.textContent?.startsWith(label))?.querySelector("select");
  if (!field) throw new Error(`Missing select: ${label}`);
  await act(async () => { field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent === label);
  if (!button) throw new Error(`Missing action: ${label}`); await act(async () => { button.click(); });
}
it("requires an actual target model and sends explicit permissions and busy policy before following the new canonical Session", async () => {
  const f = fixture(); await mount(f, false); await select(text.choose, "1");
  expect(f.api.inspect).toHaveBeenCalledWith("partner", expect.objectContaining({ location: expect.objectContaining({ case: "peer" }) }), expect.any(AbortSignal));
  const action = [...document.querySelectorAll("button")].find(item => item.textContent === text.change)!;
  expect(action.disabled).toBe(true); await select(text.model, "0"); await select(text.permissions, String(PermissionMode.ACCEPT_EDITS));
  const stop = [...document.querySelectorAll("label")].find(item => item.textContent === text.stop)!.querySelector("input")!;
  await act(async () => { stop.click(); }); await click(text.change);
  expect(f.api.move).toHaveBeenCalledOnce(); expect(f.api.move).toHaveBeenCalledWith(expect.objectContaining({ expectedPartnerRevision: { value: 9n }, busyAction: PartnerHomeBusyAction.STOP,
    capabilities: expect.objectContaining({ permissionMode: PermissionMode.ACCEPT_EDITS, inputHandoff: false }) }), expect.any(AbortSignal));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
  expect(f.changed).toHaveBeenCalledWith("new-main-session");
});
it("reopens a persisted change and retries its original identity without creating another move", async () => {
  const f = fixture(true); await mount(f); expect(document.body.textContent).toContain(text.attention);
  expect(document.querySelectorAll("select")).toHaveLength(0); await click(text.retry);
  expect(f.api.retry).toHaveBeenCalledWith("change-main-once", expect.any(AbortSignal)); expect(f.api.move).not.toHaveBeenCalled();
  expect(f.changed).toHaveBeenCalledWith("recovered-session");
});
