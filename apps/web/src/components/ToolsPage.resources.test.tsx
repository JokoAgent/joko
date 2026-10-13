// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AppSnapshot, type BackendView, type ResourceView } from "../model.js";
import { PiPackagesSection } from "./PiPackagesSection.js";
import { ToolsPage } from "./ToolsPage.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Tools resource actions", () => {
  it("keeps same-name remote project approvals distinct and renders remote and service-node origins in both existing resource entries", async () => {
    const approveResource = vi.fn(async () => undefined);
    const setResourceEnabled = vi.fn(async () => undefined);
    const controller = { state: { preferences: { navigationOpen: true } }, approveResource, setResourceEnabled } as unknown as AppController;
    const first: ResourceView = { ...managedResource(), id: "remote-one", name: "Review", kind: "skill", scope: "project",
      targetId: "project-one", source: "review", sourceKind: "remoteProject", sourceIdentity: "remote-source:one" };
    const second: ResourceView = { ...first, id: "remote-two", targetId: "project-two", sourceIdentity: "remote-source:two", discoveredRevision: "sha256:second" };
    const local: ResourceView = { ...managedResource(), source: "review", sourceKind: "local" };
    let snapshot = { ...emptySnapshot(), backends: [resourceBackend(first.backendId, ["skill", "prompt"])],
      targets: [{ id: "project-one", name: "Project One" }, { id: "project-two", name: "Project Two" }].map((target) => ({ ...target,
        backendId: first.backendId, revision: 1n, workspaceId: "workspace", workspaceName: "Project", trusted: true, pinned: false, archived: false })),
      resources: [first, second, local] };
    let pending: Promise<void> | undefined;
    const runAction = (_key: string, action: () => Promise<void>) => { pending = action(); };
    const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); roots.push(root);
    const render = () => act(async () => root.render(<ToolsPage controller={controller} snapshot={snapshot} locale="en" t={t} runAction={runAction} onOpenNavigation={() => undefined} />));
    await render();
    await act(async () => required(container.querySelector<HTMLButtonElement>("#tools-tab-resources")).click());
    const secondCard = required([...container.querySelectorAll<HTMLElement>(".resource-card")].find((card) => card.textContent?.includes("remote-two")));
    expect(secondCard.textContent).toContain("Remote project (SSH)");
    expect(secondCard.textContent).toContain("Project Two");
    expect(secondCard.textContent).toContain("Awaiting approval");
    expect(secondCard.textContent).toContain("Not loaded");
    expect(container.textContent).toContain("Service-node path");
    await act(async () => { buttonWithText(secondCard, "Approve resource").click(); await pending; });
    expect(approveResource).toHaveBeenCalledExactlyOnceWith(second.id, second.discoveredRevision);
    snapshot = { ...snapshot, resources: [first, { ...second, state: "approved", canToggle: true }, local] };
    await render();
    const approvedCard = required([...container.querySelectorAll<HTMLElement>(".resource-card")].find((card) => card.textContent?.includes("remote-two")));
    await act(async () => { buttonWithText(approvedCard, "Enable").click(); await pending; });
    expect(setResourceEnabled).toHaveBeenCalledExactlyOnceWith(second.id, true);
    expect(approvedCard.textContent).toContain("Not loaded");
    await act(async () => root.render(<PiPackagesSection controller={controller} backends={snapshot.backends} resources={snapshot.resources} runAction={runAction} t={t} />));
    expect(container.textContent).toContain("Remote project (SSH)");
    expect(container.textContent).toContain("Service-node path");
  });

  it("binds approval to the revision rendered on the resource card", async () => {
    const approveResource = vi.fn(async () => undefined);
    const controller = {
      state: { preferences: { navigationOpen: true } },
      approveResource
    } as unknown as AppController;
    const resource = managedResource();
    const snapshot = {
      timelineBySession: new Map(),
      backends: [resourceBackend(resource.backendId, [resource.kind])],
      sessions: [],
      browsers: [],
      resources: [resource],
      extensions: [],
      settings: {
        visionBridge: { enabled: false, targetModels: [] },
        browsers: [],
        mcpServers: []
      }
    } as unknown as AppSnapshot;
    let pending: Promise<void> | undefined;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ToolsPage
      controller={controller}
      snapshot={snapshot}
      locale="en"
      t={(key, values) => translate("en", key, values)}
      runAction={(_key, action) => { pending = action(); }}
      onOpenNavigation={() => undefined}
    />));

    await act(async () => required(container.querySelector<HTMLButtonElement>("#tools-tab-resources")).click());
    await act(async () => buttonWithText(container, "Approve resource").click());
    await act(async () => { await required(pending); });

    expect(approveResource).toHaveBeenCalledWith(resource.id, resource.discoveredRevision);
  });
});

function managedResource(): ResourceView {
  return {
    id: "resource-release",
    backendId: "runtime-capability",
    name: "Release",
    kind: "prompt",
    scope: "managed",
    state: "awaitingApproval",
    enabled: false,
    source: "local resource",
    discoveredRevision: "sha256:rendered-content",
    compatibilityDetails: [],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: false,
    requiresExtensionApproval: false,
    postMutationNotice: false
  };
}

function resourceBackend(id: string, kinds: readonly string[]): BackendView {
  return {
    id,
    name: id,
    version: "1",
    health: "healthy",
    capabilities: new Map([["runtime.resources", {
      name: "runtime.resources",
      supported: true,
      options: kinds
    }]])
  };
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected button ${text}.`);
  return button;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value.");
  return value;
}
