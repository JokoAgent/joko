// @vitest-environment jsdom
import { Code, ConnectError } from "@connectrpc/connect";
import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import {
  emptySnapshot,
  type AppSnapshot,
  type PartnerDirectoryView,
  type PartnerMutationView,
  type PartnerProfileView
} from "../model.js";
import { PartnersPage } from "./PartnersPage.js";

const roots: Root[] = [];

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
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
    }));
    expect(view.navigate).toHaveBeenCalledWith({ kind: "partners", partnerId: "partner-two" });

    const firstCard = required(view.host.querySelector<HTMLElement>('[data-partner-id="partner-one"]'));
    await act(async () => { button(firstCard, "session.archive").click(); await settle(); });
    expect(setPartnerLifecycle).toHaveBeenLastCalledWith("partner-one", 8n, "archived");
    await act(async () => button(view.host, "partners.archived").click());
    const archivedCard = required(view.host.querySelector<HTMLElement>('[data-partner-id="partner-one"]'));
    await act(async () => { button(archivedCard, "partners.restore").click(); await settle(); });
    expect(setPartnerLifecycle).toHaveBeenLastCalledWith("partner-one", 9n, "active");
  });

  it("preserves an autosave draft on a revision conflict and can reload the authoritative profile", async () => {
    vi.useFakeTimers();
    const updatePartner = vi.fn(async () => { throw new ConnectError("Profile changed", Code.Aborted); });
    const current = partner({ displayName: "Aster from server", revision: 11n, profileVersion: 3n });
    const getPartner = vi.fn(async () => current);
    const view = await mount({ partners: [partner()], focusPartnerId: "partner-one", updatePartner, getPartner });
    const dialog = required(document.body.querySelector<HTMLElement>("[role='dialog']"));
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
});

async function mount(overrides: {
  readonly partners: readonly PartnerProfileView[];
  readonly focusPartnerId?: string;
  readonly createPartner?: AppController["createPartner"];
  readonly updatePartner?: AppController["updatePartner"];
  readonly getPartner?: AppController["getPartner"];
  readonly setPartnerLifecycle?: AppController["setPartnerLifecycle"];
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
    ...(overrides.setPartnerLifecycle === undefined ? {} : { setPartnerLifecycle: overrides.setPartnerLifecycle })
  });
  await act(async () => { root.render(page(app, snapshot(), overrides.focusPartnerId)); await settle(); });
  return { host, navigate };
}

function controller(overrides: Record<string, unknown> = {}, owner = "owner-one"): AppController {
  return {
    state: {
      connectionState: "connected",
      activeProfile: { id: `profile-${owner}`, serverId: owner },
      preferences: DEFAULT_UI_PREFERENCES
    },
    navigate: vi.fn(),
    listPartners: vi.fn(async () => ({ partners: [], directory: directory() })),
    createPartner: vi.fn(),
    updatePartner: vi.fn(),
    getPartner: vi.fn(),
    setPartnerLifecycle: vi.fn(),
    retryPartnerInitialization: vi.fn(),
    updatePartnerDefaults: vi.fn(),
    ...overrides
  } as unknown as AppController;
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
    createdAt: 1_000, updatedAt: 3_000, ...overrides
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
