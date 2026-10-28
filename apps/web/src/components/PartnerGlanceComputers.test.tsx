// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { ListPartnerHomeTargetsResponseSchema, type ListPartnerHomeTargetsResponse, type PartnerHomeApi } from "@joko/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PartnerGlanceComputers } from "./PartnerGlanceContents.js";

let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("reads the real residence catalog and opens only the selected online target in the original change flow", async () => {
  const catalog = create(ListPartnerHomeTargetsResponseSchema, { home: { deviceId: "node", deviceName: "Main desktop", serviceNode: true, available: true }, targets: [
    { deviceName: "Main desktop", available: true, destination: { location: { case: "serviceNode", value: true } } },
    { deviceName: "Online laptop", available: true, destination: { location: { case: "peer", value: { targetDeviceId: "laptop", routeGeneration: 5n } } } },
    { deviceName: "Offline desktop", available: false, destination: { location: { case: "peer", value: { targetDeviceId: "offline", routeGeneration: 1n } } } }
  ] });
  const api: PartnerHomeApi = { ownerKey: "original", list: vi.fn(async () => catalog), inspect: vi.fn(), move: vi.fn(), status: vi.fn(), retry: vi.fn() }, select = vi.fn();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PartnerGlanceComputers api={api} partnerId="partner" locale="en" enabled onSelect={select} />); });
  expect(host.textContent).toContain("Main desktop"); expect(host.textContent).not.toContain("Offline desktop");
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
  await act(async () => { buttons().find(button => button.textContent?.includes("Online laptop"))!.click(); });
  expect(select).toHaveBeenCalledWith(catalog.targets[1]!.destination); expect(api.move).not.toHaveBeenCalled(); expect(api.inspect).not.toHaveBeenCalled();
  await act(async () => { buttons().find(button => button.textContent === "1 offline computers")!.click(); });
  expect(host.textContent).toContain("Offline desktop"); expect(buttons().some(button => button.textContent?.includes("Offline desktop"))).toBe(false);
});
it("aborts a delayed original catalog read when the glance closes", async () => {
  let signal: AbortSignal | undefined, finish!: (value: ListPartnerHomeTargetsResponse) => void;
  const api = { ownerKey: "original", list: async (_id: string, captured: AbortSignal) => { signal = captured; return new Promise<ListPartnerHomeTargetsResponse>(resolve => { finish = resolve; }); } } as PartnerHomeApi;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<PartnerGlanceComputers api={api} partnerId="partner" locale="en" enabled onSelect={() => {}} />); });
  await act(async () => { root!.render(<PartnerGlanceComputers api={api} partnerId="partner" locale="en" enabled={false} onSelect={() => {}} />); });
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish(create(ListPartnerHomeTargetsResponseSchema, { home: { deviceName: "Retired result" } })); });
  expect(host.textContent).not.toContain("Retired result");
});
