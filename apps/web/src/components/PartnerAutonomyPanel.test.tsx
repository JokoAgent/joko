// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { GetPartnerGlanceResponseSchema, type PartnerAutonomyApi } from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartnerAutonomyPanel } from "./PartnerAutonomyPanel.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("Partner glance", () => {
  it("loads on open, retries a failed read, and opens the selected original task", async () => {
    const response = create(GetPartnerGlanceResponseSchema, { rows: [{ sessionId: "task-1", title: "Review the work", online: true }] });
    const glance = vi.fn<PartnerAutonomyApi["glance"]>().mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue(response);
    const api: PartnerAutonomyApi = { ownerKey: "original-node", glance, outputs: vi.fn(async () => []) };
    const select = vi.fn();
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<PartnerAutonomyPanel api={api} partnerId="partner" sessions={[]} t={key => key} onOpenTask={select} />));
    expect(glance).not.toHaveBeenCalled();
    const details = host.querySelector("details")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(host.querySelector("[role=alert]")?.textContent).toContain("could not refresh");
    await act(async () => host.querySelector<HTMLButtonElement>("[role=alert] button")!.click());
    const task = [...host.querySelectorAll("button")].find(button => button.textContent === "Review the work")!;
    expect(host.textContent).not.toMatch(/daily todo|start following up/iu);
    await act(async () => task.click());
    expect(select).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(details.open).toBe(false);
  });
});
