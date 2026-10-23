// @vitest-environment jsdom
import { Code, ConnectError } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { PartnerImportCategory, PartnerImportPreviewPageSchema, PartnerImportResultSchema, PartnerImportSourceSchema, PartnerImportStatus,
  ListPartnerHomeTargetsResponseSchema, InspectPartnerHomeTargetResponseSchema, MovePartnerHomeResponseSchema,
  GetPartnerHomeMoveResponseSchema, RetryPartnerHomeMoveResponseSchema, type PartnerHomeApi,
  type PartnerImportApi, type PartnerImportResult, type PartnerMemoryApi, type MemoryCatalog, type MemoryDetail } from "@joko/contracts";
import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import {
  emptySnapshot,
  type ArtifactView,
  type AppSnapshot,
  type PartnerDelegationView,
  type PartnerDirectoryView,
  type PartnerCapabilitiesView,
  type PartnerMutationView,
  type PartnerPrivateThreadView,
  type PartnerProfileView,
  type PartnerSessionView
} from "../model.js";
import { PartnersPage, PartnerSettingsDialog } from "./PartnersPage.js";
import { translate } from "../i18n.js";
import { ListPartnerGroupsResponseSchema, type PartnerGroupApi } from "@joko/contracts";
import type { ConnectionsDetail, PartnerConnectionsApi } from "@joko/contracts";
import { requestPartnerNavigationLeave } from "../partner-navigation-leave.js";

const roots: Root[] = [];

beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); });
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("PartnersPage", () => {
  it("defaults private input handoff on and autosaves the independent owner switch both ways", async () => {
    vi.useFakeTimers(); const view = await mountPermissionProfile();
    const control = required(view.host.querySelector<HTMLButtonElement>('[role="checkbox"][aria-label="Input handoff"]'));
    expect(control.getAttribute("aria-checked")).toBe("true");
    await act(async () => { control.click(); await vi.advanceTimersByTimeAsync(700); });
    expect(view.updatePartner).toHaveBeenLastCalledWith("partner-one", 8n, expect.objectContaining({ inputHandoff: false }));
    expect(control.getAttribute("aria-checked")).toBe("false");
    await act(async () => { control.click(); await vi.advanceTimersByTimeAsync(700); });
    expect(view.updatePartner).toHaveBeenLastCalledWith("partner-one", 9n, expect.objectContaining({ inputHandoff: true }));
  });
  it("shows the original failed initialization card without a Profile dialog and dispatches its existing explicit retry", async () => {
    const base = controller(), owner = base.state.activeProfile!;
    const failed = partner({ initializationState: "error", invitationStage: "failed", canonicalSessionId: undefined });
    const retryPartnerInitialization = vi.fn(async () => ({ partner: partner({ revision: 9n }), directory: directory() }));
    const listPartnerSessions = vi.fn(async () => []);
    const current = { ...snapshot(), remoteConnections: [{ id: owner.id, deviceId: owner.deviceId, name: owner.name, state: "connected" as const }],
      devices: [{ id: owner.deviceId, name: "Device", defaultDisplayName: "Device", revision: 1n, kind: "web" as const, platform: "web", appVersion: "1", revoked: false, remoteControlEnabled: false, presence: "online" as const }] };
    const view = await mount({ partners: [failed], focusPartnerId: failed.id, pageSnapshot: current, getPartner: vi.fn(async () => failed),
      controllerOverrides: { retryPartnerInitialization, listPartnerSessions,
        state: { ...base.state, snapshot: current, route: { kind: "partners", profileId: owner.id, partnerId: failed.id, preparation: true } } } });
    expect(document.body.querySelector("[role='dialog']")).toBeNull(); expect(listPartnerSessions).not.toHaveBeenCalled();
    const card = required(view.host.querySelector<HTMLElement>("[data-preparation-target='true']"));
    expect(card.textContent).toContain("partners.preparationFailed"); expect(button(card, "common.edit").disabled).toBe(true);
    await act(async () => { button(card, "common.retry").click(); await settle(); });
    expect(retryPartnerInitialization).toHaveBeenCalledExactlyOnceWith(failed.id, failed.revision);
    expect(card.textContent).toContain("partners.state.ready"); expect(document.body.querySelector("[role='dialog']")).toBeNull();
  });
  it("withholds a same-ID settings editor while its route requests another source that has not been adopted", async () => {
    const view = await mount({ partners: [partner()], focusPartnerId: "partner-one" });
    expect(document.body.querySelector("[role='dialog']")).not.toBeNull();
    const otherSource = { ...view.app, state: { ...view.app.state, route: { kind: "partners" as const, partnerId: "partner-one", profileId: "other-source" } } };
    await act(async () => { view.root.render(page(otherSource, snapshot(), "partner-one")); await settle(); });
    expect(document.body.querySelector("[role='dialog']")).toBeNull();
    expect(view.host.textContent).toContain("original Partner node has not been adopted");
  });
  it("retains a dirty original-node profile when leaving is cancelled, then requires explicit discard", async () => {
    vi.useFakeTimers(); const view = await mountPermissionProfile();
    const name = required(view.host.querySelector<HTMLInputElement>("input[required]"));
    await act(async () => { setNativeValue(name, "Unsaved source draft"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    let first!: Promise<boolean>;
    await act(async () => { first = requestPartnerNavigationLeave(new AbortController().signal)!; await settle(); });
    expect(first).toBeDefined();
    await act(async () => { button(required(document.body.querySelector("[role='alertdialog']")), "Keep editing").click(); await settle(); });
    await expect(first).resolves.toBe(false); expect(name.value).toBe("Unsaved source draft");
    let second!: Promise<boolean>;
    await act(async () => { second = requestPartnerNavigationLeave(new AbortController().signal)!; await settle(); });
    await act(async () => { button(required(document.body.querySelector("[role='alertdialog']")), "Discard and leave").click(); await settle(); });
    await expect(second).resolves.toBe(true); expect(name.value).toBe("Aster");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); }); expect(view.updatePartner).not.toHaveBeenCalled();
  });
  it("retires an aborted node handoff's discard prompt without clearing the original profile draft", async () => {
    vi.useFakeTimers(); const view = await mountPermissionProfile(); const name = required(view.host.querySelector<HTMLInputElement>("input[required]"));
    await act(async () => { setNativeValue(name, "Draft retained"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    const abort = new AbortController(); let result!: Promise<boolean>;
    await act(async () => { result = requestPartnerNavigationLeave(abort.signal)!; await settle(); });
    const stale = button(required(document.body.querySelector("[role='alertdialog']")), "Discard and leave");
    await act(async () => { abort.abort(); stale.click(); await settle(); });
    await expect(result).resolves.toBe(false); expect(name.value).toBe("Draft retained"); expect(document.body.querySelector("[role='alertdialog']")).toBeNull();
  });
  it("autosaves all three Partner permission values and requires the exact Full access risk confirmation before escalation", async () => {
    vi.useFakeTimers();
    const view = await mountPermissionProfile();
    await choosePermission(view.host, "auto");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(view.updatePartner).toHaveBeenLastCalledWith("partner-one", 8n, expect.objectContaining({ permissionMode: "auto" }));
    await choosePermission(view.host, "bypassPermissions");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(view.updatePartner).toHaveBeenCalledTimes(1);
    const alert = required(document.body.querySelector<HTMLElement>("[role='alertdialog']"));
    expect(alert.textContent).toContain("Not an OS sandbox");
    expect(alert.textContent).toContain("read credentials");
    expect(alert.textContent).toContain("extra directories");
    await act(async () => { button(alert, fullAccessConfirmLabel).click(); await settle(); });
    expect(view.updatePartner).toHaveBeenLastCalledWith("partner-one", 9n, expect.objectContaining({ permissionMode: "bypassPermissions" }));
    expect(document.body.querySelector("[role='alertdialog']")).toBeNull();
    await choosePermission(view.host, "ask");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(view.updatePartner).toHaveBeenLastCalledWith("partner-one", 10n, expect.objectContaining({ permissionMode: "ask" }));
  });

  it("preserves a cancelled Full access draft and requires a fresh explicit retry without changing saved permission", async () => {
    vi.useFakeTimers(); const view = await mountPermissionProfile();
    await choosePermission(view.host, "bypassPermissions");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await act(async () => button(required(document.body.querySelector("[role='alertdialog']")), "Cancel").click());
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(view.updatePartner).not.toHaveBeenCalled();
    expect(permissionSelect(view.host).value).toBe("bypassPermissions");
    expect(view.host.textContent).toContain("Full access has not been saved");
    await act(async () => { button(view.host, "Retry").click(); await settle(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    await act(async () => { button(required(document.body.querySelector("[role='alertdialog']")), fullAccessConfirmLabel).click(); await settle(); });
    expect(view.updatePartner).toHaveBeenCalledExactlyOnceWith("partner-one", 8n, expect.objectContaining({ permissionMode: "bypassPermissions" }));
  });

  it.each(["draft", "catalog", "baseline", "owner", "unmount", "pagehide"] as const)("retires a captured Full access confirmation after %s changes", async (change) => {
    vi.useFakeTimers(); const view = await mountPermissionProfile();
    await choosePermission(view.host, "bypassPermissions");
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    const staleConfirm = button(required(document.body.querySelector("[role='alertdialog']")), fullAccessConfirmLabel);
    if (change === "draft") {
      const name = required(view.host.querySelector<HTMLInputElement>("input[required]"));
      await act(async () => { setNativeValue(name, "Changed draft"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    } else if (change === "catalog") await view.render({ catalog: { ...permissionSnapshot(), models: [] } });
    else if (change === "baseline") await view.render({ profile: partner({ usesDirectoryDefaults: false, revision: 20n }) });
    else if (change === "owner") await view.render({ owner: "another-owner" });
    else if (change === "unmount") await act(async () => view.root.unmount());
    else await act(async () => window.dispatchEvent(new Event("pagehide")));
    await act(async () => { staleConfirm.click(); await settle(); });
    expect(view.updatePartner).not.toHaveBeenCalled();
    expect(document.body.querySelector("[role='alertdialog']")).toBeNull();
  });

  it("confirms Full access directory defaults and inherited creation at their existing write boundaries", async () => {
    vi.useFakeTimers();
    const full: PartnerCapabilitiesView = { ...capabilities(), permissionMode: "bypassPermissions" };
    const updatePartnerDefaults = vi.fn(async () => ({ directory: { ...directory(), revision: 5n, defaultCapabilities: full }, affectedPartners: [] }));
    const createPartner = vi.fn(async () => ({ partner: partner({ id: "new-partner", capabilities: full }), directory: directory() }));
    const view = await mount({ partners: [], controllerOverrides: { updatePartnerDefaults }, createPartner, pageSnapshot: permissionSnapshot() });
    await act(async () => { button(view.host, "partners.defaults").click(); await settle(); });
    const defaults = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    await choosePermission(defaults, "bypassPermissions");
    await act(async () => { button(defaults, "common.save").click(); await settle(); });
    expect(updatePartnerDefaults).not.toHaveBeenCalled();
    await act(async () => button(required(document.body.querySelector("[role='alertdialog']")), "common.cancel").click());
    expect(updatePartnerDefaults).not.toHaveBeenCalled();
    await act(async () => button(defaults, "common.save").click());
    await act(async () => { button(required(document.body.querySelector("[role='alertdialog']")), "common.enable permission.full").click(); await settle(); });
    expect(updatePartnerDefaults).toHaveBeenCalledExactlyOnceWith(4n, full);
    await act(async () => { button(view.host, "partners.invite").click(); await settle(); });
    const invite = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    const name = required(invite.querySelector<HTMLInputElement>("input[required]"));
    await act(async () => { setNativeValue(name, "New full Partner"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { required(invite.querySelector("form")).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await settle(); });
    expect(createPartner).not.toHaveBeenCalled();
    await act(async () => { button(required(document.body.querySelector("[role='alertdialog']")), "common.enable permission.full").click(); await settle(); });
    expect(createPartner).toHaveBeenCalledWith(5n, expect.objectContaining({ usesDirectoryDefaults: true, displayName: "New full Partner" }), expect.any(String), expect.any(AbortSignal));
  });

  it("keeps ordered fallback routes while selecting a primary on another Backend in actual profile settings", async () => {
    vi.useFakeTimers();
    const pageSnapshot = snapshot(), primary = capabilities().modelChain[0]!;
    const secondary = { ...primary, backendId: "backend-2" };
    const model = pageSnapshot.models[0]!;
    let current = partner({ usesDirectoryDefaults: false, capabilities: { ...capabilities(), modelChain: [primary, { ...primary, modelId: "fallback" }] } });
    const updatePartner = vi.fn<AppController["updatePartner"]>(async (_id, _revision, patch) => ({ partner: current = { ...current,
      capabilities: { ...current.capabilities, modelChain: patch.modelChain ?? current.capabilities.modelChain }, revision: current.revision + 1n,
      profileVersion: current.profileVersion + 1n }, directory: directory() }));
    await mount({ partners: [current], focusPartnerId: current.id, updatePartner, pageSnapshot: { ...pageSnapshot,
      backends: [...pageSnapshot.backends, { ...pageSnapshot.backends[0]!, id: secondary.backendId, name: "Other runtime" }],
      models: [model, { ...model, modelId: "fallback" }, { ...model, backendId: secondary.backendId }] } });
    await act(async () => { button(document.body, "partners.profileSettings").click(); await settle(); });
    const select = required([...document.body.querySelectorAll<HTMLSelectElement>("select")].find(element =>
      [...element.options].some(option => option.value === JSON.stringify([secondary.backendId, secondary.providerId, secondary.modelId]))));
    await act(async () => { select.value = JSON.stringify([secondary.backendId, secondary.providerId, secondary.modelId]); select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settle(); });
    expect(current.capabilities.modelChain).toEqual([secondary, { ...primary, modelId: "fallback" }]);
  });
  it("autosaves one independent task model and restores inheritance without changing the primary chain", async () => {
    vi.useFakeTimers();
    const pageSnapshot = snapshot(), task = { ...pageSnapshot.models[0]!, backendId: "task-backend", modelId: "task-model", name: "Task Model" };
    let current = partner({ usesDirectoryDefaults: true });
    const updatePartner = vi.fn<AppController["updatePartner"]>(async (_id, _revision, patch) => ({ partner: current = { ...current,
      taskModelOverride: patch.taskModelOverride ?? undefined, revision: current.revision + 1n, profileVersion: current.profileVersion + 1n }, directory: directory() }));
    await mount({ partners: [current], focusPartnerId: current.id, updatePartner, getPartner: vi.fn(async () => current),
      pageSnapshot: { ...pageSnapshot, models: [...pageSnapshot.models, task], backends: [...pageSnapshot.backends, { ...pageSnapshot.backends[0]!, id: task.backendId }] } });
    await act(async () => { button(document.body, "partners.profileSettings").click(); await settle(); });
    const choose = required([...document.body.querySelectorAll<HTMLSelectElement>("select")].find(select => select.closest("label")?.textContent?.startsWith("Choose task model")));
    await act(async () => { setNativeValue(choose, JSON.stringify([task.backendId, task.providerId, task.modelId])); choose.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settle(); });
    expect(current.taskModelOverride).toMatchObject({ backendId: task.backendId, modelId: task.modelId, effort: "medium", fastMode: false });
    expect(current.capabilities.modelChain).toEqual(capabilities().modelChain); expect(current.usesDirectoryDefaults).toBe(true);
    expect(updatePartner.mock.calls[0]?.[2].modelChain).toBeUndefined();
    const effort = required([...document.body.querySelectorAll<HTMLSelectElement>("select")].find(select => select.closest("label")?.textContent?.startsWith("Task model effort")));
    await act(async () => { setNativeValue(effort, "high"); effort.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settle(); }); expect(current.taskModelOverride?.effort).toBe("high");
    await act(async () => { button(document.body, "Use primary model").click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settle(); });
    expect(current.taskModelOverride).toBeUndefined(); expect(updatePartner.mock.calls.at(-1)?.[2].taskModelOverride).toBeNull();
  });

  it("opens actual Partner connections, autosaves independent selections and protects the parent profile", async () => {
    vi.useFakeTimers(); const selected = partner();
    const owner = { partnerId: selected.id, homeTargetId: selected.homeTargetId, canonicalSessionId: selected.canonicalSessionId!, revision: selected.revision, readOnly: false };
    let current: ConnectionsDetail = { owner, catalogRevision: "a".repeat(64), entries: [
      { kind: "skills", id: "shared-report", name: "Shared report", available: true, inherited: false },
      { kind: "skills", id: "personal-report", name: "Learned report", personal: true, available: true, inherited: false },
      { kind: "mcp", id: "server", name: "Server", available: true, inherited: true },
      { kind: "toolsets", id: "optional", name: "Optional", available: true, inherited: false }
    ], mcp: { mode: "inherit", ids: [] }, toolsets: { mode: "inherit", ids: [] }, skills: { mode: "allowlist", ids: [] } };
    const api: PartnerConnectionsApi = { ownerKey: "", read: vi.fn(async () => current),
      save: vi.fn(async (_base, draft) => current = { ...current, ...draft, revision: (current.revision ?? 0n) + 1n }) };
    const factory = vi.fn((_id: string, ownerKey: string) => ({ ...api, ownerKey }));
    await mount({ partners: [selected], focusPartnerId: selected.id, controllerOverrides: { partnerConnectionsApi: factory } });
    await act(async () => { button(document.body, "partners.profileSettings").click(); await settle(); });
    await act(async () => { button(document.body, "Skills & Connections").click(); await settle(); });
    expect(factory).toHaveBeenCalledWith(selected.id, expect.any(String)); expect(document.body.querySelector("fieldset")?.disabled).toBe(true);
    const modal = () => required([...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1));
    const check = (name: string) => required([...modal().querySelectorAll<HTMLLabelElement>("label")].find(label => label.textContent === name)?.querySelector<HTMLInputElement>("input"));
    expect(check("Learned report · Personal skill").checked).toBe(true); expect(check("Learned report · Personal skill").disabled).toBe(true);
    await act(async () => check("Shared report").click()); await act(async () => { await vi.advanceTimersByTimeAsync(800); await settle(); });
    expect(current.skills).toEqual({ mode: "allowlist", ids: ["shared-report"] });
    await act(async () => check("Server").click()); await act(async () => { await vi.advanceTimersByTimeAsync(800); await settle(); });
    expect(current.mcp).toEqual({ mode: "allowlist", ids: [] }); expect(current.toolsets.mode).toBe("inherit");
    await act(async () => check("Optional").click()); await act(async () => { await vi.advanceTimersByTimeAsync(800); await settle(); });
    expect(current.toolsets).toEqual({ mode: "allowlist", ids: ["optional"] }); expect(api.save).toHaveBeenCalledTimes(3);
    await act(async () => { required(modal().querySelector<HTMLButtonElement>('button[aria-label="Done"]')).click(); await settle(); }); expect(document.body.querySelector("fieldset")?.disabled).toBe(false); expect(localStorage.length).toBe(0);
  });
  it("edits and autosaves an introduction independently in the actual profile", async () => {
    vi.useFakeTimers(); let current = partner({ description: "Initial introduction", usesDirectoryDefaults: false });
    const updatePartner = vi.fn<AppController["updatePartner"]>(async (_id, _revision, patch) => ({ partner: current = { ...current,
      description: patch.description!, revision: current.revision + 1n, profileVersion: current.profileVersion + 1n }, directory: directory() }));
    await mount({ partners: [current], focusPartnerId: current.id, updatePartner });
    await act(async () => { button(document.body, "partners.profileSettings").click(); await settle(); });
    const input = [...document.body.querySelectorAll<HTMLTextAreaElement>("textarea")].find(element => element.value === "Initial introduction")!;
    expect(input).toBeTruthy();
    await act(async () => { setNativeValue(input, "Updated introduction"); input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1200); await settle(); });
    expect(updatePartner).toHaveBeenCalledWith(current.id, 8n, expect.objectContaining({ description: "Updated introduction", identitySource: "You are Aster." }));
    expect(current.description).toBe("Updated introduction");
  });

  it("adds, reorders and autosaves the fourth and fifth routes from profile settings and can remove the last backup", async () => {
    vi.useFakeTimers(); const pageSnapshot = snapshot();
    const models = Array.from({ length: 6 }, (_, index) => ({ ...pageSnapshot.models[0]!, modelId: `model-${index + 1}`, name: `Model ${index + 1}` }));
    const modelChain = models.slice(0, 3).map(model => ({ ...capabilities().modelChain[0]!, modelId: model.modelId }));
    let current = partner({ usesDirectoryDefaults: false, capabilities: { ...capabilities(), modelChain } });
    const updatePartner = vi.fn<AppController["updatePartner"]>(async (_id, _revision, patch) => ({ partner: current = { ...current,
      capabilities: { ...current.capabilities, modelChain: patch.modelChain ?? current.capabilities.modelChain },
      revision: current.revision + 1n, profileVersion: current.profileVersion + 1n }, directory: directory() }));
    await mount({ partners: [current], focusPartnerId: current.id, pageSnapshot: { ...pageSnapshot, models }, updatePartner });
    await act(async () => { button(document.body, "partners.profileSettings").click(); await settle(); });
    for (let added = 0; added < 2; added++) {
      await act(async () => { button(document.body, "partners.addFallback").click(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settle(); });
    }
    expect(current.capabilities.modelChain.map(route => route.modelId)).toEqual(models.slice(0, 5).map(model => model.modelId));
    expect([...document.body.querySelectorAll("button")].some(element => element.textContent === "partners.addFallback")).toBe(false);
    const before = [...current.capabilities.modelChain];
    const moveButtons = (direction: "Up" | "Down") => [...document.body.querySelectorAll<HTMLButtonElement>(`button[aria-label="partners.moveFallback${direction}"]`)];
    expect(moveButtons("Up")[0]!.disabled).toBe(true); expect(moveButtons("Down").at(-1)!.disabled).toBe(true);
    await act(async () => { moveButtons("Up").at(-1)!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settle(); });
    expect(current.capabilities.modelChain).toEqual([before[0], before[1], before[2], before[4], before[3]]);
    await act(async () => { moveButtons("Down")[0]!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settle(); });
    expect(current.capabilities.modelChain).toEqual([before[0], before[2], before[1], before[4], before[3]]);
    expect(current.capabilities.modelChain[0]).toEqual(before[0]);
    await act(async () => { [...document.body.querySelectorAll<HTMLButtonElement>('button[aria-label="partners.removeFallback"]')].at(-1)!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); await settle(); });
    expect(current.capabilities.modelChain).toHaveLength(4); expect(button(document.body, "partners.addFallback")).toBeTruthy();
  });

  it("opens saved memories from actual profile settings, preserves conflicts and confirms deletion", async () => {
    const selected = partner(); const owner = { partnerId: selected.id, homeTargetId: selected.homeTargetId,
      canonicalSessionId: selected.canonicalSessionId!, revision: selected.revision, readOnly: false, memoryEnabled: true };
    let entry: MemoryDetail | undefined = { owner, id: "memory", kind: "project", title: "Release steps", preview: "Run the required checks.", body: "**Run** the required checks. [Private path](file:///private.txt)", updatedAt: 2000, revision: 3n };
    const api: PartnerMemoryApi = { ownerKey: "", list: vi.fn(async (): Promise<MemoryCatalog> => ({ owner, groups: [{ kind: "project", count: entry ? 1 : 0, entries: entry ? [entry] : [] }], truncated: false })),
      read: vi.fn(async () => ({ owner, entry })), save: vi.fn(async (base, draft) => entry = { ...base, ...draft, revision: base.revision + 1n }), remove: vi.fn(async () => { entry = undefined; }),
      preferences: vi.fn(async () => ({ owner, enabled: owner.memoryEnabled, userContext: "", revision: 5n })),
      savePreferences: vi.fn(async (base, patch) => { owner.memoryEnabled = patch.enabled ?? base.enabled; return { ...base, ...patch, owner, revision: 6n }; }) };
    const factory = vi.fn((_id: string, ownerKey: string) => ({ ...api, ownerKey }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const view = await mount({ partners: [selected], focusPartnerId: selected.id, controllerOverrides: { partnerMemoryApi: factory } });
    await act(async () => { button(document.body, "partners.profileSettings").click(); await settle(); });
    await act(async () => { button(document.body, "Saved memories").click(); await settle(); });
    expect(factory).toHaveBeenCalledWith(selected.id, expect.any(String));
    const modal = () => required([...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1));
    await act(async () => { required(modal().querySelector<HTMLInputElement>('input[type="checkbox"]')).click(); await settle(); });
    expect(api.savePreferences).toHaveBeenCalledOnce(); expect(modal().textContent).toContain("Memory is off.");
    expect(api.savePreferences).toHaveBeenCalledWith(expect.any(Object), { enabled: false }, expect.any(AbortSignal));
    await act(async () => { required(modal().querySelector<HTMLButtonElement>('button[aria-label="Release steps"]')).click(); await settle(); });
    expect(modal().querySelector(".partner-memory__body strong")?.textContent).toBe("Run");
    expect(modal().querySelector(".partner-memory__body a")?.getAttribute("href")).toBe("");
    await act(async () => { button(modal(), "Edit").click(); await settle(); });
    const body = required(modal().querySelector<HTMLTextAreaElement>("textarea"));
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(body, "My release steps."); body.dispatchEvent(new Event("input", { bubbles: true })); });
    entry = { ...entry!, revision: 4n, body: "Updated by the partner." };
    await act(async () => { button(modal(), "Done").click(); await settle(); });
    expect(api.save).not.toHaveBeenCalled(); expect(modal().textContent).toContain("Updated by the partner.");
    await act(async () => { button(modal(), "Keep my changes").click(); await settle(); }); expect(api.save).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    await act(async () => { body.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(body, "中文输入完成。"); body.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); }); expect(api.save).toHaveBeenCalledOnce();
    await act(async () => { body.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(799); }); expect(api.save).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); await settle(); }); expect(api.save).toHaveBeenCalledTimes(2);
    expect(entry?.body).toBe("中文输入完成。"); vi.useRealTimers();
    await act(async () => { button(modal(), "Done").click(); await settle(); });
    confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);
    await act(async () => { button(modal(), "Delete memory").click(); await settle(); }); expect(api.remove).not.toHaveBeenCalled();
    await act(async () => { button(modal(), "Delete memory").click(); await settle(); }); expect(api.remove).toHaveBeenCalledOnce();
    expect(modal().textContent).toContain("No saved memories."); expect(localStorage.length).toBe(0);
    await act(async () => { view.root.render(page(controller({}, "next-node"), snapshot(), selected.id)); await settle(); });
    expect(document.body.querySelector(".partner-memory")).toBeNull();
  });
  it("imports all paged categories from the actual directory entry and reopens the original saved task after closing an accepted request", async () => {
    const preview = create(PartnerImportPreviewPageSchema, { id: "preview", source: { id: "source", name: "Native analyst" }, name: "Local analyst", total: 30,
      entries: [...Array.from({ length: 25 }, (_, index) => ({ id: `memory-${index}`, index, name: `Memory ${index}`, category: PartnerImportCategory.MEMORY, selected: true })),
        { id: "identity", index: 25, name: "Identity", category: PartnerImportCategory.PERSONALITY, selected: true },
        { id: "skill", index: 26, name: "Reports", category: PartnerImportCategory.SKILLS, selected: true },
        { id: "account-a", index: 27, name: "Account A", category: PartnerImportCategory.CONNECTIONS, selected: true, exclusiveWith: ["account-b"] },
        { id: "account-b", index: 28, name: "Account B", category: PartnerImportCategory.CONNECTIONS, selected: true, exclusiveWith: ["account-a"] },
        { id: "routine", index: 29, name: "Weekly", category: PartnerImportCategory.AUTOMATIONS, selected: true, enabled: false }] });
    let result: PartnerImportResult | undefined; let finish!: (value: PartnerImportResult) => void;
    const api: PartnerImportApi = { ownerKey: "", newRequestId: vi.fn(() => "directory_import_000001"), sources: vi.fn(async () => [create(PartnerImportSourceSchema, { id: "source", name: "Native analyst" })]),
      preview: vi.fn(async () => preview), status: vi.fn(async () => result), retry: vi.fn(), start: vi.fn(() => new Promise<PartnerImportResult>(resolve => { finish = resolve; })) };
    const view = await mount({ partners: [], controllerOverrides: { partnerImportApi: (ownerKey: string) => ({ ...api, ownerKey }) } });
    await act(async () => { button(view.host, "Import a local agent").click(); await settle(); });
    await act(async () => { button(document.body, "Native analyst").click(); await settle(); });
    await act(async () => button(document.body, "Memory · 25 / 25").click());
    await act(async () => button(document.body, "Next").click()); expect(document.body.textContent).toContain("Memory 24"); expect(document.body.textContent).not.toContain("Memory 0");
    await act(async () => button(document.body, "Back").click()); await act(async () => button(document.body, "Connections · 0 / 2").click());
    const account = (name: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
    await act(async () => account("Account A").click()); await act(async () => account("Account B").click());
    expect(account("Account A").checked).toBe(false); expect(account("Account B").checked).toBe(true);
    await act(async () => button(document.body, "Back").click()); await act(async () => { button(document.body, "Save Partner").click(); await settle(); });
    expect(api.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: "directory_import_000001", name: "Local analyst", deferSetup: true,
      entryIds: [], entryRanges: [expect.objectContaining({ first: 0, last: 26 }), expect.objectContaining({ first: 28, last: 29 })] }), expect.any(AbortSignal));
    await act(async () => { button(document.body, "Close").click(); await settle(); }); expect(view.navigate).not.toHaveBeenCalled();
    result = create(PartnerImportResultSchema, { requestId: "directory_import_000001", partnerId: "imported", canonicalSessionId: "imported-task", status: PartnerImportStatus.COMPLETE, saved: true,
      savedEntryIds: preview.entries.filter(entry => entry.id !== "account-a").map(entry => entry.id) });
    await act(async () => { finish(result!); await settle(); }); expect(view.navigate).not.toHaveBeenCalled();
    await act(async () => { button(view.host, "Import a local agent").click(); await settle(); });
    expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: "imported-task" }); expect(api.start).toHaveBeenCalledOnce(); expect(api.newRequestId).toHaveBeenCalledOnce();
    expect(api.preview).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(0);
  });
  it("keeps paused partners in the roster and requires current confirmation before resuming", async () => {
    let current = partner({ lifecycle: "paused", pauseCleanupPending: false });
    const resume = vi.fn(async () => ({ partner: current = { ...current, lifecycle: "active", pauseCleanupPending: undefined, revision: current.revision + 1n }, directory: directory() }));
    const view = await mount({ partners: [current], controllerOverrides: { getPartner: vi.fn(async () => current), setPartnerLifecycle: resume } });
    expect(view.host.textContent).toContain("Paused"); expect([...view.host.querySelectorAll("button")].some(value => value.textContent === "partners.restartAction")).toBe(false);
    await act(async () => { button(view.host, "Resume partner").click(); await settle(); });
    const modal = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    expect(modal.textContent).toContain("Tasks and routines you paused manually stay paused"); expect(resume).not.toHaveBeenCalled();
    await act(async () => { button(modal, "Resume partner").click(); await settle(); });
    expect(resume).toHaveBeenCalledExactlyOnceWith(current.id, current.revision - 1n, "active", expect.any(AbortSignal));
    expect(modal.textContent).toContain("Partner resumed");
  });
  it("checks an unknown resume by reading without dispatching again", async () => {
    let current = partner({ lifecycle: "paused", pauseCleanupPending: true });
    const resume = vi.fn(async () => { current = { ...current, lifecycle: "active", pauseCleanupPending: undefined, revision: current.revision + 1n }; throw new Error("Response lost"); });
    const view = await mount({ partners: [current], controllerOverrides: { getPartner: vi.fn(async () => current), setPartnerLifecycle: resume } });
    await act(async () => { button(view.host, "Resume partner").click(); await settle(); });
    const modal = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    expect(modal.textContent).toContain("Shutdown is still pending");
    await act(async () => { button(modal, "Resume partner").click(); await settle(); });
    expect(modal.textContent).toContain("The result is unknown"); expect(button(modal, "Resume partner").disabled).toBe(true);
    await act(async () => { button(modal, "Check status").click(); await settle(); }); expect(resume).toHaveBeenCalledOnce();
    expect(modal.textContent).toContain("Partner resumed");
  });
  it("retires a pending resume when the connection owner changes", async () => {
    const selected = partner({ lifecycle: "paused", pauseCleanupPending: false }); let finish!: (value: PartnerMutationView) => void;
    const resume = vi.fn(() => new Promise<PartnerMutationView>(resolve => { finish = resolve; }));
    const view = await mount({ partners: [selected], controllerOverrides: { getPartner: vi.fn(async () => selected), setPartnerLifecycle: resume } });
    await act(async () => { button(view.host, "Resume partner").click(); await settle(); });
    await act(async () => { button(required(document.body.querySelector<HTMLElement>('[role="dialog"]')), "Resume partner").click(); await settle(); });
    const replacement = controller({}, "owner-two");
    await act(async () => { view.root.render(page(replacement, snapshot())); await settle(); });
    await act(async () => { finish({ partner: { ...selected, lifecycle: "active", pauseCleanupPending: undefined, revision: selected.revision + 1n }, directory: directory() }); await settle(); });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull(); expect(view.host.textContent).not.toContain("Partner resumed");
    expect(resume).toHaveBeenCalledOnce();
  });
  it("refreshes Host restart controls, confirms explicitly and saves only the request identity before dispatch", async () => {
    const selected = partner(); const controls = vi.fn(async () => ({ revision: selected.revision, available: true }));
    controls.mockRejectedValueOnce(new Error("Read unavailable"));
    const restart = vi.fn(async (requestId: string, partnerId: string) => {
      expect([...Array(localStorage.length)].some((_item, index) => localStorage.getItem(localStorage.key(index)!) === requestId)).toBe(true);
      return { requestId, partnerId, phase: "ready" as const, runtimeClosePending: false, createdAt: 1, updatedAt: 2 };
    });
    const view = await mount({ partners: [selected], controllerOverrides: { getPartnerRestartControls: controls,
      restartPartner: restart, getPartnerRestart: vi.fn(async () => ({ retired: false })) } });
    await act(async () => { button(view.host, "partners.restartAction").click(); await settle(); });
    const modal = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    expect(modal.querySelector("input")).toBeNull(); expect(button(modal, "partners.restartAction").disabled).toBe(true);
    expect(modal.textContent).toContain("partners.restartLoadFailed");
    await act(async () => { button(modal, "common.retry").click(); await settle(); });
    expect(button(modal, "partners.restartAction").disabled).toBe(false);
    await act(async () => { button(modal, "common.cancel").click(); await settle(); }); expect(restart).not.toHaveBeenCalled();
    await act(async () => { button(view.host, "partners.restartAction").click(); await settle(); });
    await act(async () => { button(required(document.body.querySelector<HTMLElement>('[role="dialog"]')), "partners.restartAction").click(); await settle(); });
    expect(restart).toHaveBeenCalledExactlyOnceWith(expect.any(String), selected.id, selected.revision, expect.any(AbortSignal));
    expect(localStorage.length).toBe(0); expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(view.host.textContent).toContain("partners.restart.ready");
  });
  it("retains an unknown restart and recovers through reads or retirement without another dispatch", async () => {
    const selected = partner(); const restart = vi.fn(async () => { throw new Error("Lost response"); });
    const read = vi.fn(async () => ({ retired: false })); const retire = vi.fn(async () => ({ retired: true }));
    const view = await mount({ partners: [selected], controllerOverrides: { restartPartner: restart, getPartnerRestart: read,
      retirePartnerRestart: retire, getPartnerRestartControls: vi.fn(async () => ({ revision: selected.revision, available: true })) } });
    await act(async () => { button(view.host, "partners.restartAction").click(); await settle(); });
    const modal = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    await act(async () => { button(modal, "partners.restartAction").click(); await settle(); });
    expect(restart).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(1);
    expect([...Array(localStorage.length)].map((_item, index) => localStorage.getItem(localStorage.key(index)!)).join()).not.toContain(selected.displayName);
    await act(async () => { button(modal, "common.cancel").click(); await settle(); });
    await act(async () => { button(view.host, "partners.checkRestart").click(); await settle(); }); expect(read).toHaveBeenCalled();
    await act(async () => { button(view.host, "partners.retireRestart").click(); await settle(); });
    expect(retire).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(0); expect(restart).toHaveBeenCalledOnce();
  });
  it("persists a body-free intent before confirmed deletion and refreshes after real completion", async () => {
    const selected = partner(); let removed = false;
    const deletion = vi.fn(async (id: string, partnerId: string) => {
      expect([...Array(localStorage.length)].some((_item, index) => localStorage.getItem(localStorage.key(index)!) === id)).toBe(true);
      removed = true; return { requestId: id, partnerId, phase: "completed" as const, createdAt: 1, updatedAt: 2 };
    });
    const view = await mount({ partners: [selected], controllerOverrides: { deletePartner: deletion,
      getPartnerDeletion: vi.fn(async () => ({ retired: false })),
      listPartners: vi.fn(async () => ({ partners: removed ? [] : [selected], directory: { ...directory(), revision: removed ? 5n : 4n, activeCount: removed ? 0 : 1 } })) } });
    const trigger = required(view.host.querySelector<HTMLButtonElement>('button.partner-card__delete'));
    await act(async () => { trigger.click(); await settle(); });
    const modal = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    const input = required(modal.querySelector<HTMLInputElement>("input"));
    expect(button(modal, "common.delete").disabled).toBe(true);
    await act(async () => { setNativeValue(input, selected.displayName); input.dispatchEvent(new Event("input", { bubbles: true })); await settle(); });
    await act(async () => { button(modal, "common.delete").click(); await settle(); });
    expect(deletion).toHaveBeenCalledWith(expect.any(String), selected.id, selected.revision, selected.displayName, expect.any(AbortSignal));
    expect(localStorage.length).toBe(0); expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(view.host.querySelector('[data-partner-id="partner-one"]')).toBeNull();
  });

  it("keeps lost deletion responses query-only and retires an absent intent before another request", async () => {
    const deletion = vi.fn(async () => { throw new Error("Lost response"); });
    const read = vi.fn(async () => ({ retired: false })); const retire = vi.fn(async () => ({ retired: true }));
    const view = await mount({ partners: [partner()], controllerOverrides: { deletePartner: deletion, getPartnerDeletion: read, retirePartnerDeletion: retire } });
    await act(async () => { required(view.host.querySelector<HTMLButtonElement>('button.partner-card__delete')).click(); await settle(); });
    const modal = required(document.body.querySelector<HTMLElement>('[role="dialog"]')); const input = required(modal.querySelector<HTMLInputElement>("input"));
    await act(async () => { setNativeValue(input, partner().displayName); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { button(modal, "common.delete").click(); await settle(); });
    expect(deletion).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(1); expect(button(modal, "common.delete").disabled).toBe(true);
    expect([...Array(localStorage.length)].map((_item, index) => localStorage.getItem(localStorage.key(index)!)).join()).not.toContain(partner().displayName);
    await act(async () => { button(modal, "common.cancel").click(); await settle(); });
    await act(async () => { button(view.host, "partners.checkDeletion").click(); await settle(); });
    expect(read).toHaveBeenCalled(); expect(deletion).toHaveBeenCalledOnce();
    await act(async () => { button(view.host, "partners.retireDeletion").click(); await settle(); });
    expect(retire).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(0); expect(deletion).toHaveBeenCalledOnce();
  });
  it("shows only the current working turn, keeps roster reads single-flight, and stops on error until an explicit retry", async () => {
    vi.useFakeTimers(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const task = { id: "session-one", targetId: "partner-home-one", backendId: "backend-1", generation: 3n, state: "running" as const,
      activeRunId: "run", activeAttemptId: "attempt", name: "Current", pinned: false, archived: false, fastMode: false,
      permissionMode: "ask" as const, planMode: false, updatedAt: 0 };
    const live: AppSnapshot = { ...snapshot(), sessions: [task], targets: [{ id: task.targetId, revision: 1n, backendId: task.backendId,
      name: "Home", workspaceId: "home", workspaceName: "Home", trusted: true, pinned: false, archived: false }] };
    const working = { sessionId: task.id, targetId: task.targetId, backendId: task.backendId, generation: 3n,
      runId: "run", attemptId: "attempt", phase: "checking" as const };
    const initial = partner({ activity: { ...partner().activity, latestReplyPreview: "A public reply", workingStatus: working } });
    let finish!: (value: { partners: readonly PartnerProfileView[]; directory: PartnerDirectoryView }) => void;
    const later = new Promise<{ partners: readonly PartnerProfileView[]; directory: PartnerDirectoryView }>((resolve) => { finish = resolve; });
    const latest = { ...initial, activity: { ...initial.activity, workingStatus: { ...working, attemptId: "next", phase: "reading-file" as const } } };
    const list = vi.fn().mockResolvedValueOnce({ partners: [initial], directory: directory() }).mockImplementationOnce(() => later)
      .mockRejectedValueOnce(new Error("Read unavailable")).mockResolvedValue({ partners: [latest], directory: directory() });
    const base = controller(); const read = vi.fn(async () => undefined);
    const view = await mount({ partners: [initial], pageSnapshot: live, controllerOverrides: { listPartners: list,
      readPartnerWorkingStatus: read, state: { ...base.state, ready: true, snapshot: live, effectiveLocale: "en", connectionGeneration: 1 } } });
    expect(view.host.textContent).toContain("partnerWorking.checking");
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); await vi.advanceTimersByTimeAsync(7500); });
    expect(list).toHaveBeenCalledTimes(2);
    const next = { ...live, sessions: [{ ...task, activeAttemptId: "next" }] };
    const app = { ...view.app, state: { ...view.app.state, snapshot: next } };
    await act(async () => { view.root.render(page(app, next)); await settle(); });
    expect(view.host.textContent).toContain("partnerWorking.processing");
    await act(async () => { finish({ partners: [latest], directory: directory() }); await settle(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(view.host.textContent).toContain("partnerWorking.reading-file");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(view.host.querySelector(".partner-card__working")).toBeNull();
    expect(view.host.textContent).toContain("Read unavailable");
    expect(view.host.textContent).toContain("A public reply");
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); expect(list).toHaveBeenCalledTimes(3);
    await act(async () => { button(view.host, "common.retry").click(); await settle(); });
    expect(list).toHaveBeenCalledTimes(4); expect(view.host.textContent).toContain("partnerWorking.reading-file");
    expect(view.app.markPartnerRead).not.toHaveBeenCalled();
    const { workingStatus: _working, ...doneActivity } = latest.activity;
    list.mockResolvedValue({ partners: [{ ...latest, activity: doneActivity }], directory: directory() });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(view.host.querySelector(".partner-card__working")).toBeNull();
    expect(app.state.snapshot.sessions[0]?.state).toBe("running");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(view.host.querySelector(".partner-card__working")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("invites from a template and archives then restores the same durable profile", async () => {
    const first = partner();
    let directoryValue = directory();
    const createPartner = vi.fn(async (): Promise<PartnerMutationView> => {
      const created = partner({ id: "partner-two", displayName: "Nova", revision: 1n });
      directoryValue = { ...directoryValue, revision: 5n, activeCount: 2 };
      return { partner: created, directory: directoryValue };
    });
    const setPartnerLifecycle = vi.fn(async (id: string, _revision: bigint, lifecycle: "active" | "archived" | "deleted"): Promise<PartnerMutationView> => {
      const next = partner({ id, lifecycle, revision: lifecycle === "archived" ? 9n : 10n });
      directoryValue = { ...directoryValue, revision: directoryValue.revision + 1n, activeCount: lifecycle === "active" ? 2 : 1, archivedCount: lifecycle === "archived" ? 1 : 0 };
      return { partner: next, directory: directoryValue };
    });
    const view = await mount({ partners: [first], createPartner, setPartnerLifecycle });

    await act(async () => button(document.body, "partners.invite").click());
    const invite = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    const name = required(invite.querySelector<HTMLInputElement>("input[required]"));
    await act(async () => {
      setNativeValue(name, "Nova");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button(invite, "partners.invite").click();
      await settle();
    });
    expect(createPartner).toHaveBeenCalledWith(4n, expect.objectContaining({
      displayName: "Nova", templateId: "general", usesDirectoryDefaults: true
    }), expect.stringMatching(/^[A-Za-z0-9_-]{16,80}$/u), expect.any(AbortSignal));
    expect(view.navigate).toHaveBeenCalledWith({ kind: "partners", partnerId: "partner-two" });

    const firstCard = required(view.host.querySelector<HTMLElement>('[data-partner-id="partner-one"]'));
    await act(async () => { button(firstCard, "session.archive").click(); await settle(); });
    expect(setPartnerLifecycle).toHaveBeenLastCalledWith("partner-one", 8n, "archived");
    await act(async () => button(view.host, "partners.archived").click());
    const archivedCard = required(view.host.querySelector<HTMLElement>('[data-partner-id="partner-one"]'));
    await act(async () => { button(archivedCard, "partners.restore").click(); await settle(); });
    expect(setPartnerLifecycle).toHaveBeenLastCalledWith("partner-one", 9n, "active");
  });

  it("retains the invitation draft through snapshots of the same connection", async () => {
    const view = await mount({ partners: [] });
    await fillInvite("Nova");
    const dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    const avatar = required(dialog.querySelectorAll<HTMLButtonElement>(".partner-avatar-picker button")[1]);
    await act(async () => avatar.click());
    expect(button(dialog, "partners.invite").disabled).toBe(false);

    const nextSnapshot = { ...snapshot() };
    const next = { ...view.app, state: { ...view.app.state, snapshot: nextSnapshot } };
    await act(async () => { view.root.render(page(next, nextSnapshot)); await settle(); });

    expect(required(dialog.querySelector<HTMLInputElement>("input[required]")).value).toBe("Nova");
    expect(avatar.getAttribute("aria-pressed")).toBe("true");
    expect(button(dialog, "partners.invite").disabled).toBe(false);
  });

  it("settles the original invitation through snapshots without aborting or resending it", async () => {
    let release!: (value: PartnerMutationView) => void;
    const pending = new Promise<PartnerMutationView>((resolve) => { release = resolve; });
    const createPartner = vi.fn<AppController["createPartner"]>(() => pending);
    const view = await mount({ partners: [], createPartner });
    await fillInvite("Nova");
    await act(async () => {
      button(required(document.body.querySelector<HTMLElement>("[role='dialog']")), "partners.invite").click();
      await settle();
    });
    const signal = createPartner.mock.calls[0]![3];
    const nextSnapshot = { ...snapshot() };
    const next = { ...view.app, state: { ...view.app.state, snapshot: nextSnapshot } };
    await act(async () => { view.root.render(page(next, nextSnapshot)); await settle(); });
    expect(signal?.aborted).toBe(false);
    await act(async () => { release({ partner: partner({ id: "created-original" }), directory: directory() }); await settle(); });

    expect(createPartner).toHaveBeenCalledTimes(1);
    expect(view.navigate).toHaveBeenCalledWith({ kind: "partners", partnerId: "created-original" });
    expect(localStorage.length).toBe(0);
  });

  it("keeps an ambiguous creation locked across directory refresh and recovers the same request without resending", async () => {
    const createPartner = vi.fn<AppController["createPartner"]>(async () => { throw new Error("Lost response"); });
    const getPartnerCreation = vi.fn()
      .mockRejectedValueOnce(new ConnectError("Temporarily unavailable", Code.Unavailable))
      .mockResolvedValueOnce({ partner: partner({ id: "created-one", displayName: "Nova" }), directory: directory() });
    let catalog = directory();
    const view = await mount({ partners: [], createPartner, controllerOverrides: {
      getPartnerCreation, listPartners: vi.fn(async () => ({ partners: [], directory: catalog }))
    } });
    await fillInvite("Nova");
    let dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    await act(async () => {
      const form = required(dialog.querySelector("form"));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(createPartner).toHaveBeenCalledTimes(1);
    const requestId = createPartner.mock.calls[0]![2];
    expect(required(dialog.querySelector<HTMLInputElement>("input[required]")).disabled).toBe(true);
    expect(required(dialog.querySelector<HTMLInputElement>("input[type=checkbox]")).disabled).toBe(true);
    catalog = { ...catalog, revision: 5n };
    await act(async () => { button(view.host, "common.refresh").click(); await settle(); });
    dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    expect(required(dialog.querySelector<HTMLInputElement>("input[required]")).value).toBe("Nova");
    await act(async () => { button(dialog, "partners.creationCheck").click(); await settle(); });
    expect(dialog.textContent).toContain("partners.creationLookupFailed");
    expect(createPartner).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(1);
    await act(async () => { button(dialog, "partners.creationCheck").click(); await settle(); });
    expect(getPartnerCreation).toHaveBeenLastCalledWith(requestId, expect.any(AbortSignal));
    expect(view.navigate).toHaveBeenCalledWith({ kind: "partners", partnerId: "created-one" });
    expect(localStorage.length).toBe(0);
  });

  it("recovers a body-free creation receipt after unmount and remount", async () => {
    const createPartner = vi.fn<AppController["createPartner"]>(async () => { throw new Error("Lost response"); });
    const first = await mount({ partners: [], createPartner });
    await fillInvite("Private draft name");
    await act(async () => { button(required(document.body.querySelector<HTMLElement>("[role='dialog']")), "partners.invite").click(); await settle(); });
    const requestId = createPartner.mock.calls[0]![2];
    expect(localStorage.getItem(localStorage.key(0)!)).toBe(requestId);
    await act(async () => first.root.unmount());
    roots.splice(roots.indexOf(first.root), 1);
    const getPartnerCreation = vi.fn(async () => ({ partner: partner({ id: "original-partner" }), directory: directory() }));
    const second = await mount({ partners: [], controllerOverrides: { getPartnerCreation } });
    await act(async () => button(second.host, "partners.invite").click());
    const dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    expect(required(dialog.querySelector<HTMLInputElement>("input[required]")).disabled).toBe(true);
    expect(dialog.textContent).not.toContain("Private draft name");
    await act(async () => { button(dialog, "partners.creationCheck").click(); await settle(); });
    expect(getPartnerCreation).toHaveBeenCalledWith(requestId, expect.any(AbortSignal));
    expect(second.navigate).toHaveBeenCalledWith({ kind: "partners", partnerId: "original-partner" });
    expect(createPartner).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit server retirement before admitting a new intent after NotFound", async () => {
    const createPartner = vi.fn<AppController["createPartner"]>(async () => { throw new Error("Lost response"); });
    const getPartnerCreation = vi.fn(async () => { throw new ConnectError("No result yet", Code.NotFound); });
    const retirePartnerCreation = vi.fn(async () => ({ directory: { ...directory(), revision: 7n } }));
    const getPartnerDirectory = vi.fn(async () => ({ ...directory(), revision: 7n }));
    await mount({ partners: [], createPartner, controllerOverrides: { getPartnerCreation, retirePartnerCreation, getPartnerDirectory } });
    await fillInvite("Nova");
    let dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    await act(async () => { button(dialog, "partners.invite").click(); await settle(); });
    const firstId = createPartner.mock.calls[0]![2];
    await act(async () => { button(dialog, "partners.creationCheck").click(); await settle(); });
    expect(createPartner).toHaveBeenCalledTimes(1);
    expect(retirePartnerCreation).not.toHaveBeenCalled();
    await act(async () => { button(dialog, "partners.creationNewIntent").click(); await settle(); });
    expect(retirePartnerCreation).toHaveBeenCalledWith(firstId, expect.any(AbortSignal));
    dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    expect(required(dialog.querySelector<HTMLInputElement>("input[required]")).disabled).toBe(false);
    await act(async () => { button(dialog, "partners.invite").click(); await settle(); });
    expect(createPartner).toHaveBeenLastCalledWith(7n, expect.objectContaining({ displayName: "Nova" }), expect.any(String), expect.any(AbortSignal));
    expect(createPartner.mock.calls[1]![2]).not.toBe(firstId);
  });

  it("recovers an original create that won the absence-retirement race instead of creating again", async () => {
    const createPartner = vi.fn<AppController["createPartner"]>(async () => { throw new Error("Lost response"); });
    const retirePartnerCreation = vi.fn(async () => ({ partner: partner({ id: "won-race" }), directory: directory() }));
    const view = await mount({ partners: [], createPartner, controllerOverrides: {
      getPartnerCreation: vi.fn(async () => { throw new ConnectError("Not found yet", Code.NotFound); }), retirePartnerCreation
    } });
    await fillInvite("Nova");
    const dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    await act(async () => { button(dialog, "partners.invite").click(); await settle(); });
    await act(async () => { button(dialog, "partners.creationCheck").click(); await settle(); });
    await act(async () => { button(dialog, "partners.creationNewIntent").click(); await settle(); });
    expect(view.navigate).toHaveBeenCalledWith({ kind: "partners", partnerId: "won-race" });
    expect(createPartner).toHaveBeenCalledTimes(1);
  });

  it("retires late create presentation on pagehide and retains its receipt for explicit recovery", async () => {
    let release!: (value: PartnerMutationView) => void;
    const pending = new Promise<PartnerMutationView>((resolve) => { release = resolve; });
    const createPartner = vi.fn<AppController["createPartner"]>(() => pending);
    const view = await mount({ partners: [], createPartner });
    await fillInvite("Nova");
    await act(async () => { button(required(document.body.querySelector<HTMLElement>("[role='dialog']")), "partners.invite").click(); await settle(); });
    const signal = createPartner.mock.calls[0]![3];
    await act(async () => { window.dispatchEvent(new Event("pagehide")); release({ partner: partner(), directory: directory() }); await settle(); });
    expect(required(signal).aborted).toBe(true);
    expect(view.navigate).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(1);
    await act(async () => { window.dispatchEvent(new Event("pageshow")); await settle(); });
    expect(button(document.body, "partners.creationCheck").disabled).toBe(false);
    expect(createPartner).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a create when its local receipt cannot be persisted", async () => {
    const createPartner = vi.fn();
    await mount({ partners: [], createPartner });
    await fillInvite("Nova");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    await act(async () => { button(required(document.body.querySelector<HTMLElement>("[role='dialog']")), "partners.invite").click(); await settle(); });
    expect(document.body.textContent).toContain("partners.creationReceiptFailed");
    expect(createPartner).not.toHaveBeenCalled();
  });

  it("keeps recovery available without usable models and retires late creation on connection replacement", async () => {
    let release!: (value: PartnerMutationView) => void;
    const pending = new Promise<PartnerMutationView>((resolve) => { release = resolve; });
    const createPartner = vi.fn<AppController["createPartner"]>(() => pending);
    const view = await mount({ partners: [], createPartner });
    await fillInvite("Nova");
    const dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    await act(async () => { button(dialog, "partners.invite").click(); await settle(); });
    const next = controller({}, "owner-two");
    await act(async () => { view.root.render(page(next, snapshot())); await settle(); });
    await act(async () => { release({ partner: partner(), directory: directory() }); await settle(); });
    expect(view.navigate).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(1);
    const getPartnerCreation = vi.fn(async () => ({ partner: partner({ id: "recovered-owner-one" }), directory: directory() }));
    const original = controller({ getPartnerCreation });
    await act(async () => { view.root.render(page(original, { ...snapshot(), models: [] })); await settle(); });
    if (document.body.querySelector("[role='dialog']") === null) await act(async () => button(view.host, "partners.invite").click());
    const recovery = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    await act(async () => { button(recovery, "partners.creationCheck").click(); await settle(); });
    expect(getPartnerCreation).toHaveBeenCalledTimes(1);
    expect(original.navigate).toHaveBeenCalledWith({ kind: "partners", partnerId: "recovered-owner-one" });
    expect(createPartner).toHaveBeenCalledTimes(1);
  });

  it("preserves an autosave draft on a revision conflict and can reload the authoritative profile", async () => {
    vi.useFakeTimers();
    const updatePartner = vi.fn(async () => { throw new ConnectError("Profile changed", Code.Aborted); });
    const current = partner({ displayName: "Aster from server", revision: 11n, profileVersion: 3n });
    const getPartner = vi.fn(async () => current);
    const view = await mount({ partners: [partner()], focusPartnerId: "partner-one", updatePartner, getPartner });
    const dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
    const activityTab = button(dialog, "partners.activity");
    await act(async () => {
      activityTab.focus();
      activityTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await settle();
    });
    expect(document.activeElement).toBe(button(dialog, "partners.profileSettings"));
    const name = required(dialog.querySelector<HTMLInputElement>("input[required]"));
    await act(async () => {
      setNativeValue(name, "Local draft");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(700);
      await Promise.resolve();
    });
    expect(updatePartner).toHaveBeenCalledWith("partner-one", 8n, expect.objectContaining({ displayName: "Local draft" }));
    expect(dialog.textContent).toContain("partners.conflictTitle");
    expect(name.value).toBe("Local draft");

    await act(async () => { button(dialog, "partners.reload").click(); await Promise.resolve(); });
    expect(getPartner).toHaveBeenCalledWith("partner-one");
    expect(name.value).toBe("Aster from server");
    expect(dialog.textContent).not.toContain("partners.conflictTitle");
  });

  it("retires a late directory response when the connection owner changes", async () => {
    let resolveOld!: (value: { readonly partners: readonly PartnerProfileView[]; readonly directory: PartnerDirectoryView }) => void;
    const oldResult = new Promise<{ readonly partners: readonly PartnerProfileView[]; readonly directory: PartnerDirectoryView }>((resolve) => { resolveOld = resolve; });
    const oldController = controller({ listPartners: vi.fn(() => oldResult) });
    const nextController = controller({ listPartners: vi.fn(async () => ({ partners: [partner({ id: "new", displayName: "New owner" })], directory: directory() })) }, "owner-two");
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); roots.push(root);
    await act(async () => root.render(page(oldController, snapshot())));
    await act(async () => root.render(page(nextController, snapshot())));
    await act(async () => { await settle(); });
    expect(host.textContent).toContain("New owner");
    await act(async () => { resolveOld({ partners: [partner({ id: "old", displayName: "Old owner" })], directory: directory() }); await settle(); });
    expect(host.textContent).toContain("New owner");
    expect(host.textContent).not.toContain("Old owner");
  });

  it("advances the durable unread cursor before opening the canonical task", async () => {
    const current = partner({
      activity: {
        partnerId: "partner-one",
        unreadReplyCount: 2,
        latestReplyCursor: 9n,
        latestReplyAt: 9_000,
        artifactCount: 0,
        activeDelegationCount: 0,
        readThroughCursor: 4n,
        readUpdatedAt: 4_000
      }
    });
    const markPartnerRead = vi.fn(async () => ({
      ...current.activity,
      unreadReplyCount: 0,
      readThroughCursor: 9n,
      readUpdatedAt: 10_000
    }));
    const view = await mount({
      partners: [current],
      controllerOverrides: { markPartnerRead }
    });

    await act(async () => { button(view.host, "partners.openTask").click(); await settle(); });

    expect(markPartnerRead).toHaveBeenCalledWith(current.id, 9n);
    expect(view.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "session-one" });
    expect(view.host.textContent).not.toContain("partners.unreadReplies");
  });

  it("shows durable history, private reads, delegated work, and source-attributed files", async () => {
    const source = partner({
      activity: {
        partnerId: "partner-one",
        unreadReplyCount: 2,
        latestReplyCursor: 9n,
        latestReplyAt: 9_000,
        artifactCount: 1,
        activeDelegationCount: 1,
        readThroughCursor: 4n,
        readUpdatedAt: 4_000
      }
    });
    const target = partner({
      id: "partner-two",
      displayName: "Nova",
      homeTargetId: "partner-home-two",
      canonicalSessionId: "session-two",
      activity: {
        partnerId: "partner-two",
        unreadReplyCount: 0,
        artifactCount: 0,
        activeDelegationCount: 0,
        readThroughCursor: 0n,
        readUpdatedAt: 0
      }
    });
    const sessions: readonly PartnerSessionView[] = [
      partnerSession("session-one", "canonical", "Aster task", false),
      partnerSession("session-old", "history", "Historical task", true)
    ];
    const thread = privateThread();
    const delegation = partnerDelegation();
    const artifact: ArtifactView = {
      id: "artifact-one",
      blobId: "blob-one",
      sourceSessionId: "session-old",
      sourceRevealAvailable: true,
      title: "Report",
      kind: "file",
      fileName: "report.txt",
      mediaType: "text/plain",
      byteSize: 12
    };
    const markThreadRead = vi.fn(async () => ({ threadId: thread.id, partnerId: source.id, throughSequence: 1, updatedAt: 8_000 }));
    const cancelDelegation = vi.fn(async () => ({ ...delegation, revision: 2n, status: "cancelled" as const, completedAt: 9_000 }));
    const view = await mount({
      partners: [source, target],
      focusPartnerId: source.id,
      getPartner: vi.fn(async () => source),
      controllerOverrides: {
        listPartnerSessions: vi.fn(async () => sessions),
        listPartnerPrivateThreads: vi.fn(async () => [thread]),
        listPartnerDelegations: vi.fn(async () => [delegation]),
        listSessionArtifacts: vi.fn(async (sessionId: string) => sessionId === "session-old" ? [artifact] : []),
        getPartnerPrivateThread: vi.fn(async () => ({
          thread,
          messages: [{
            id: "message-one",
            threadId: thread.id,
            sequence: 1,
            senderPartnerId: target.id,
            recipientPartnerId: source.id,
            content: "Private result",
            deliveryStatus: "delivered" as const,
            createdAt: 7_000,
            deliveredAt: 7_100
          }]
        })),
        markPartnerPrivateThreadRead: markThreadRead,
        cancelPartnerDelegation: cancelDelegation
      }
    });

    expect(view.host.textContent).toContain("Historical task");
    expect(view.host.textContent).toContain("partners.readOnly");
    expect(view.host.textContent).toContain("Report");
    expect(view.host.textContent).toContain("partners.delegationState.running");

    const privateConversation = required(view.host.querySelector<HTMLButtonElement>(".partner-private-list button"));
    await act(async () => { privateConversation.click(); await settle(); });
    expect(view.host.textContent).toContain("Private result");
    expect(markThreadRead).toHaveBeenCalledWith(source.id, thread.id, 1, expect.any(AbortSignal));

    await act(async () => { button(view.host, "partners.stopDelegation").click(); await settle(); });
    expect(cancelDelegation).toHaveBeenCalledWith(source.id, delegation.id, 1n);
    expect(view.host.textContent).toContain("partners.delegationState.cancelled");
  });
});

describe("Partner independent task activity", () => {
  it("opens the real task and pauses/resumes its owned execution from the activity panel", async () => {
    const selected = partner();
    let task: import("@joko/contracts").PartnerSessionTaskView = { id: "task:independent", partnerId: selected.id, sessionId: "independent-session", title: "Prepare report",
      status: "running", control: "active", revision: 2n, deadlineAt: 2_000_000, result: "", error: "" };
    const control = vi.fn(async (_partnerId, _revision, _task, action) => task = { ...task, revision: task.revision + 1n, status: action === "pause" ? "waiting" : "running", control: action === "pause" ? "paused" : "active" });
    const view = await mount({ partners: [selected], focusPartnerId: selected.id, controllerOverrides: { listPartnerSessionTasks: vi.fn(async () => [task]), controlPartnerSessionTask: control } });
    expect(view.host.textContent).toContain("Prepare report");
    await act(async () => { button(view.host, "Open task").click(); await settle(); });
    expect(view.navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "independent-session" });
    await act(async () => { button(view.host, "Pause").click(); await settle(); });
    expect(control).toHaveBeenCalledWith(selected.id, selected.revision, expect.objectContaining({ id: task.id }), "pause");
    expect(view.host.textContent).toContain("Paused");
    await act(async () => { button(view.host, "Resume").click(); await settle(); });
    expect(control).toHaveBeenCalledTimes(2); expect(task.control).toBe("active");
  });
});

const fullAccessConfirmLabel = `${translate("en", "common.enable")} ${translate("en", "permission.full")}`;
const permissionTranslator = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);

function permissionSnapshot(): AppSnapshot {
  const value = snapshot();
  return { ...value, backends: value.backends.map((backend) => ({ ...backend,
    capabilities: new Map([...backend.capabilities, ["permission.modes", { name: "permission.modes", supported: true, options: ["ask", "auto", "bypassPermissions"] }]]) })) };
}

function permissionSelect(host: ParentNode): HTMLSelectElement {
  return required([...host.querySelectorAll<HTMLSelectElement>("select")].find(select => [...select.options].some(option => option.value === "ask")));
}

async function choosePermission(host: ParentNode, mode: PartnerCapabilitiesView["permissionMode"]): Promise<void> {
  const select = permissionSelect(host);
  await act(async () => { select.value = mode; select.dispatchEvent(new Event("change", { bubbles: true })); });
}

async function mountPermissionProfile() {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  let profile = partner({ usesDirectoryDefaults: false });
  let catalog = permissionSnapshot(); let owner = "permission-owner";
  let savedProfile = profile;
  const updatePartner = vi.fn<AppController["updatePartner"]>(async (_id, _revision, patch) => ({
    partner: savedProfile = { ...savedProfile, displayName: patch.displayName ?? savedProfile.displayName,
      revision: savedProfile.revision + 1n, profileVersion: savedProfile.profileVersion + 1n,
      capabilities: { ...savedProfile.capabilities, permissionMode: patch.permissionMode ?? savedProfile.capabilities.permissionMode,
        inputHandoff: patch.inputHandoff ?? savedProfile.capabilities.inputHandoff } }, directory: directory() }));
  const app = controller({ updatePartner, getPartner: vi.fn(async () => savedProfile) });
  const render = async (next?: { readonly profile?: PartnerProfileView; readonly catalog?: AppSnapshot; readonly owner?: string }): Promise<void> => {
    profile = next?.profile ?? profile; catalog = next?.catalog ?? catalog; owner = next?.owner ?? owner;
    await act(async () => { root.render(<PartnerSettingsDialog partner={profile} partners={[profile]} directory={directory()} snapshot={catalog}
      controller={app} ownerKey={owner} t={permissionTranslator} initialSection="profile" onClose={() => undefined}
      onUpdated={() => undefined} onActivityUpdated={() => undefined} />); await settle(); });
  };
  await render();
  return { host: document.body, root, updatePartner, render };
}

async function mount(overrides: {
  readonly partners: readonly PartnerProfileView[];
  readonly pageSnapshot?: AppSnapshot;
  readonly focusPartnerId?: string;
  readonly createPartner?: AppController["createPartner"];
  readonly updatePartner?: AppController["updatePartner"];
  readonly getPartner?: AppController["getPartner"];
  readonly setPartnerLifecycle?: AppController["setPartnerLifecycle"];
  readonly controllerOverrides?: Partial<AppController>;
}) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  const navigate = vi.fn();
  const app = controller({
    listPartners: vi.fn(async () => ({ partners: overrides.partners, directory: directory() })),
    navigate,
    ...(overrides.createPartner === undefined ? {} : { createPartner: overrides.createPartner }),
    ...(overrides.updatePartner === undefined ? {} : { updatePartner: overrides.updatePartner }),
    ...(overrides.getPartner === undefined ? {} : { getPartner: overrides.getPartner }),
    ...(overrides.setPartnerLifecycle === undefined ? {} : { setPartnerLifecycle: overrides.setPartnerLifecycle }),
    ...overrides.controllerOverrides
  });
  await act(async () => { root.render(page(app, overrides.pageSnapshot ?? snapshot(), overrides.focusPartnerId)); await settle(); });
  return { host, navigate, root, app };
}

function controller(overrides: Record<string, unknown> = {}, owner = "owner-one"): AppController {
  return {
    state: {
      ready: true, effectiveLocale: "en",
      connectionState: "connected",
      activeProfile: { id: `profile-${owner}`, serverId: owner, deviceId: `device-${owner}`, origin: "https://node.example", name: "Work node" },
      preferences: DEFAULT_UI_PREFERENCES, connectionGeneration: 1, snapshot: snapshot()
    },
    navigate: vi.fn(),
    partnerHomeApi: (ownerKey: string): PartnerHomeApi => ({ ownerKey,
      list: vi.fn(async () => create(ListPartnerHomeTargetsResponseSchema)), inspect: vi.fn(async () => create(InspectPartnerHomeTargetResponseSchema)),
      move: vi.fn(async () => create(MovePartnerHomeResponseSchema)), status: vi.fn(async () => create(GetPartnerHomeMoveResponseSchema)),
      retry: vi.fn(async () => create(RetryPartnerHomeMoveResponseSchema)) }),
    listPartners: vi.fn(async () => ({ partners: [], directory: directory() })),
    partnerGroupApi: (ownerKey: string) => ({ ownerKey, list: async () => create(ListPartnerGroupsResponseSchema, { revision: { value: 1n }, groups: [] }),
      changes: async function* (_after: bigint, signal: AbortSignal) { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); } } as unknown as PartnerGroupApi),
    createPartner: vi.fn(),
    updatePartner: vi.fn(),
    getPartner: vi.fn(async () => partner()),
    getPartnerDirectory: vi.fn(async () => directory()),
    getPartnerCreation: vi.fn(),
    retirePartnerCreation: vi.fn(),
    setPartnerLifecycle: vi.fn(),
    retryPartnerInitialization: vi.fn(),
    updatePartnerDefaults: vi.fn(),
    listPartnerSessions: vi.fn(async () => []),
    markPartnerRead: vi.fn(async () => partner().activity),
    listPartnerPrivateThreads: vi.fn(async () => []),
    getPartnerPrivateThread: vi.fn(async () => ({ thread: privateThread(), messages: [] })),
    markPartnerPrivateThreadRead: vi.fn(async () => ({ threadId: "thread-one", partnerId: "partner-one", throughSequence: 0, updatedAt: 0 })),
    listPartnerDelegations: vi.fn(async () => []),
    listPartnerSessionTasks: vi.fn(async () => []),
    controlPartnerSessionTask: vi.fn(),
    getPartnerDelegation: vi.fn(async () => partnerDelegation()),
    cancelPartnerDelegation: vi.fn(async () => ({ ...partnerDelegation(), status: "cancelled" as const })),
    listSessionArtifacts: vi.fn(async () => []),
    copyArtifactFile: vi.fn(),
    openArtifactFile: vi.fn(),
    openArtifactFileWithApplication: vi.fn(),
    revealArtifactSource: vi.fn(),
    ...overrides
  } as unknown as AppController;
}

async function fillInvite(name: string): Promise<void> {
  await act(async () => button(document.body, "partners.invite").click());
  const dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
  const input = required(dialog.querySelector<HTMLInputElement>("input[required]"));
  await act(async () => { setNativeValue(input, name); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

function page(app: AppController, value: AppSnapshot, focusPartnerId?: string): JSX.Element {
  return <PartnersPage controller={app} snapshot={value} focusPartnerId={focusPartnerId} t={(key) => key} onOpenNavigation={() => undefined} />;
}

function snapshot(): AppSnapshot {
  return {
    ...emptySnapshot(),
    generation: 1n,
    backends: [{
      id: "backend-1", name: "Backend", version: "1", health: "healthy", installationState: "installed", authenticationState: "notRequired",
      capabilities: new Map([
        ["permission.modes", { name: "permission.modes", supported: true, options: ["ask", "auto"] }],
        ["model.effort", { name: "model.effort", supported: true, options: [] }],
        ["model.fast_mode", { name: "model.fast_mode", supported: true, options: [] }],
        ["model.switch", { name: "model.switch", supported: true, options: [] }],
        ["plan_mode", { name: "plan_mode", supported: true, options: [] }]
      ])
    }],
    models: [{
      backendId: "backend-1", providerId: "provider-1", providerName: "Provider", modelId: "model-1", name: "Model 1",
      available: true, routingEnabled: true, supportsImages: true, inputModalities: ["text"], outputModalities: ["text"], supportsFast: true,
      efforts: ["medium", "high"], contextWindow: 100_000, maximumOutputTokens: 8_000,
      inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD"
    }]
  };
}

function directory(): PartnerDirectoryView {
  return {
    revision: 4n, activeCount: 1, archivedCount: 0, errorCount: 0, updatedAt: 4_000,
    templates: [{ id: "general", displayName: "General", description: "General work", identitySource: "You are a partner." }],
    avatarPresets: ["orbit", "spark"],
    defaultCapabilities: capabilities()
  };
}

function capabilities() {
  return {
    modelChain: [{ backendId: "backend-1", providerId: "provider-1", modelId: "model-1", effort: "medium", fastMode: false }],
    permissionMode: "ask" as const,
    planMode: false,
    inputHandoff: true
  };
}

function partner(overrides: Partial<PartnerProfileView> = {}): PartnerProfileView {
  return {
    id: "partner-one", revision: 8n, profileVersion: 2n, displayName: "Aster", description: "", avatar: "orbit",
    identitySource: "You are Aster.", templateId: "general", lifecycle: "active", initializationState: "ready", invitationStage: "ready",
    homeTargetId: "partner-home-one", canonicalSessionId: "session-one", capabilities: capabilities(), usesDirectoryDefaults: true,
    activity: {
      partnerId: "partner-one",
      unreadReplyCount: 0,
      artifactCount: 0,
      activeDelegationCount: 0,
      readThroughCursor: 0n,
      readUpdatedAt: 0
    },
    createdAt: 1_000, updatedAt: 3_000, ...overrides
  };
}

function partnerSession(sessionId: string, role: PartnerSessionView["role"], displayName: string, readOnly: boolean): PartnerSessionView {
  return {
    sessionId,
    partnerId: "partner-one",
    role,
    profileVersion: role === "history" ? 1n : 2n,
    displayName,
    available: true,
    readOnly,
    archived: false,
    deleted: false,
    createdAt: 1_000,
    lastActivityAt: 7_000
  };
}

function privateThread(): PartnerPrivateThreadView {
  return {
    id: "thread-one",
    firstPartnerId: "partner-one",
    secondPartnerId: "partner-two",
    status: "active",
    messageCount: 1,
    maxMessages: 12,
    expiresAt: 60_000,
    createdAt: 1_000,
    updatedAt: 7_000
  };
}

function partnerDelegation(): PartnerDelegationView {
  return {
    id: "delegation-one",
    revision: 1n,
    requesterPartnerId: "partner-one",
    targetPartnerId: "partner-two",
    parentSessionId: "session-one",
    targetProfileVersion: 2n,
    title: "Research",
    objective: "Find the durable answer",
    status: "running",
    childSessionId: "delegated-session",
    runId: "run-one",
    artifactCount: 0,
    createdAt: 2_000,
    updatedAt: 4_000,
    startedAt: 3_000
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected Partner fixture element.");
  return value;
}

function button(host: ParentNode, text: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text);
  if (result === undefined) throw new Error(`Missing ${text} action.`);
  return result;
}

function setNativeValue(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
