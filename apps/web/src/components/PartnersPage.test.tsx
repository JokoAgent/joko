// @vitest-environment jsdom
import { Code, ConnectError } from "@connectrpc/connect";
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
  type PartnerMutationView,
  type PartnerPrivateThreadView,
  type PartnerProfileView,
  type PartnerSessionView
} from "../model.js";
import { PartnersPage } from "./PartnersPage.js";

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

async function mount(overrides: {
  readonly partners: readonly PartnerProfileView[];
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
  await act(async () => { root.render(page(app, snapshot(), overrides.focusPartnerId)); await settle(); });
  return { host, navigate, root, app };
}

function controller(overrides: Record<string, unknown> = {}, owner = "owner-one"): AppController {
  return {
    state: {
      connectionState: "connected",
      activeProfile: { id: `profile-${owner}`, serverId: owner, deviceId: `device-${owner}`, origin: "https://node.example", name: "Work node" },
      preferences: DEFAULT_UI_PREFERENCES
    },
    navigate: vi.fn(),
    listPartners: vi.fn(async () => ({ partners: [], directory: directory() })),
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
    planMode: false
  };
}

function partner(overrides: Partial<PartnerProfileView> = {}): PartnerProfileView {
  return {
    id: "partner-one", revision: 8n, profileVersion: 2n, displayName: "Aster", avatar: "orbit",
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

function setNativeValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
