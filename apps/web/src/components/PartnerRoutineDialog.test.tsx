// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ListPartnerRoutinesResponseSchema, PartnerRoutineSchema, ListPartnerRoutineRunsResponseSchema,
  GetPartnerRoutineCreationResponseSchema, RetirePartnerRoutineCreationResponseSchema, RoutineFilterOperator, RoutineSourceStatus,
  RoutineSessionMode, type PartnerRoutineApi } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { PartnerRoutineDialog } from "./PartnerRoutineDialog.js";

let root: Root | undefined; let host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
function fixture() {
  let catalog = create(ListPartnerRoutinesResponseSchema, { partnerId: "partner", partnerRevision: { value: 3n }, writable: true,
    models: [{ route: { backendId: 'pi', selection: { model: { providerId: 'vision', modelId: 'multimodal' }, effortId: 'medium' } }, name: 'Pi · Vision', efforts: ['medium', 'high'] }],
    sources: [{ id: "extension:watcher", name: "Watcher", status: RoutineSourceStatus.LISTENING, events: [{ type: "change", name: "Change", fields: ["path"] }] }] });
  let sequence = 0;
  const api: PartnerRoutineApi = { ownerKey: "owner", newRequestId: () => `routine-request-${++sequence}`,
    list: vi.fn(async () => catalog), save: vi.fn(async (_revision, definition) => {
      const routine = create(PartnerRoutineSchema, { id: "routine", partnerId: "partner", revision: { value: 1n }, definition });
      catalog = { ...catalog, routines: [routine] }; return routine;
    }), run: vi.fn(async () => {}), remove: vi.fn(async () => {}), history: vi.fn(async () => create(ListPartnerRoutineRunsResponseSchema)),
    lookup: vi.fn(async () => create(GetPartnerRoutineCreationResponseSchema)), retire: vi.fn(async () => create(RetirePartnerRoutineCreationResponseSchema, { retired: true })) };
  const close = vi.fn(); const state = { effectiveLocale: "en", connectionState: "connected", activeProfile: { id: "profile", serverId: "server", deviceId: "device", origin: "http://127.0.0.1:7319" } };
  const controller = { state, partnerRoutineApi: () => api } as unknown as AppController;
  const render = async () => { if (!root) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); }
    await act(async () => root!.render(createElement(PartnerRoutineDialog, { controller, partnerId: "partner", ownerKey: "owner", onClose: close }))); };
  return { api, state, close, render };
}
function button(label: string) { const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label); expect(value, label).toBeTruthy(); return value!; }
async function press(label: string) { await act(async () => button(label).click()); }
function input(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const field = [...document.querySelectorAll("label")].find(item => item.querySelector("span")?.textContent === label)?.querySelector("input,textarea,select");
  expect(field, label).toBeTruthy(); return field as HTMLInputElement;
}
async function fill(label: string, value: string) { const field = input(label);
  await act(async () => { const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); }); }

describe("Partner routine settings", () => {
  it('saves an independent task mode and complete model route, then restores inheritance explicitly', async () => {
    const f = fixture(); await f.render(); await fill('Name', 'Separate review'); await fill('Instructions', 'Review work');
    await fill('Task context', 'fresh'); await fill('Routine model', JSON.stringify(['pi', 'vision', 'multimodal'])); await fill('Reasoning effort', 'high');
    await press('Save');
    expect(f.api.save).toHaveBeenLastCalledWith(3n, expect.objectContaining({ sessionMode: RoutineSessionMode.FRESH,
      modelOverride: expect.objectContaining({ backendId: 'pi', selection: expect.objectContaining({ model: expect.objectContaining({ providerId: 'vision', modelId: 'multimodal' }), effortId: 'high' }) })
    }), expect.anything(), expect.any(AbortSignal));
    await fill('Routine model', ''); await fill('Task context', 'persistent'); await press('Save');
    expect(f.api.save).toHaveBeenLastCalledWith(3n, expect.objectContaining({ sessionMode: RoutineSessionMode.PERSISTENT, modelOverride: undefined }), expect.anything(), expect.any(AbortSignal));
  });
  it("edits OR time and event filters, saves through the owner API and confirms destructive actions", async () => {
    const f = fixture(); await f.render(); await fill("Name", "Review"); await fill("Instructions", "Inspect changes");
    await press("+ Event"); await fill("Event source", "extension:watcher"); await fill("Event type", "change"); await press("Add filter");
    await fill("Field", "path"); await fill("Value", ".ts"); await press("Save");
    expect(f.api.save).toHaveBeenCalledExactlyOnceWith(3n, expect.objectContaining({ name: "Review", triggers: [expect.objectContaining({ kind: { case: "interval", value: expect.anything() } }),
      expect.objectContaining({ kind: { case: "event", value: expect.objectContaining({ sourceId: "extension:watcher", eventType: "change", filters: [expect.objectContaining({ field: "path", operator: RoutineFilterOperator.EQUALS, value: ".ts" })] }) } })] }), { requestId: expect.any(String) }, expect.any(AbortSignal));
    await press("Run now"); expect(f.api.run).toHaveBeenCalledOnce(); await press("Delete routine");
    expect(f.api.remove).not.toHaveBeenCalled(); expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("delete its definition");
    await press("Confirm"); expect(f.api.remove).toHaveBeenCalledOnce();
  });
  it("guards dirty close and fences edits after losing the connection until an explicit refresh", async () => {
    const f = fixture(); await f.render(); await fill("Name", "Unsaved"); await press("Close");
    expect(f.close).not.toHaveBeenCalled(); expect(document.querySelector('[role="alertdialog"]')).toBeTruthy(); await press("Back");
    f.state.connectionState = "offline"; await f.render(); expect(input("Name").closest("fieldset")?.disabled).toBe(true);
    f.state.connectionState = "connected"; await f.render(); expect(document.body.textContent).toContain("Refresh to use the current Partner");
    expect(input("Name").value).toBe("Unsaved"); await press("Refresh"); expect(f.api.list).toHaveBeenCalledOnce();
    await press("Confirm"); expect(f.api.list).toHaveBeenCalledTimes(2); expect(input("Name").value).toBe(""); expect(f.api.save).not.toHaveBeenCalled();
  });
});
