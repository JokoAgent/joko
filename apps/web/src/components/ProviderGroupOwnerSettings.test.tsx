// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { ProviderGroupSettingsApi } from "../provider-group-settings.js";
import { ProviderGroupOwnerSettings } from "./ProviderGroupOwnerSettings.js";

let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });
it("keeps a failed provider directory visible and retries it on the same connection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const key = { backendId: "backend", providerId: "provider" };
  const group = create(contract.ProviderGroupSnapshotSchema, { key, revision: 1n });
  const api: ProviderGroupSettingsApi = { getProviderGroup: vi.fn(async () => group), listProviderGroupCandidates: vi.fn(async () => []),
    getProviderGroupUsage: vi.fn(async () => []), updateProviderGroup: vi.fn(async () => group),
    getProviderGroupMemberAccountUsage: vi.fn(async () => create(contract.GetProviderGroupMemberAccountUsageResponseSchema, { memberKey: 'unused', revision: 1n, state: 'unsupported' })) };
  const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(create(contract.GetHostedAgentCatalogResponseSchema, {
    backends: [{ backendId: key.backendId, displayName: "Backend", providers: [{ providerId: key.providerId, displayName: "Provider", connected: true }] }]
  }));
  const controller = { providerGroups: api, readProviderSharingCatalog: read,
    state: { activeProfile: { id: "profile", serverId: "server", origin: "https://owner.test", name: "Owner" }, connectionGeneration: 1, connectionState: "connected" } } as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(<ProviderGroupOwnerSettings controller={controller} t={key => key} />));
  expect(host.textContent).toContain("settings.providerGroups.title");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("settings.providerGroups.loadFailed");
  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "common.retry")!;
  await act(async () => retry.click());
  expect(read).toHaveBeenCalledTimes(2);
  expect(api.getProviderGroup).toHaveBeenCalledWith({ ...key, displayName: "Backend · Provider" }, expect.any(AbortSignal));
  expect(host.querySelector('button[role="switch"]')).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
