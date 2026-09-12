// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { AppSnapshot, BackendView, ResourceView } from "../model.js";
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
