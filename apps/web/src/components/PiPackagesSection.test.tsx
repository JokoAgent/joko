// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { ResourceView } from "../model.js";
import { PiPackagesSection, packageCompatibility, resourceCanToggle, resourceCanUpdate } from "./PiPackagesSection.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("PiPackagesSection", () => {
  it("expands complete compatibility details and reviews changed extension content after update", async () => {
    const updated: ResourceView = {
      ...extension,
      state: "awaitingApproval",
      discoveredRevision: "sha256:new-extension-content",
      requiresExtensionApproval: true,
      extensionContentFingerprint: "sha256:new-extension-content",
      postMutationNotice: true
    };
    const updateResource = vi.fn(async () => updated);
    const approveResource = vi.fn(async () => undefined);
    const controller = { updateResource, approveResource } as unknown as AppController;
    let pending: Promise<void> | undefined;
    const container = await renderPackages(controller, [extension], (_key, action) => {
      pending = action();
    });

    expect(container.textContent).toContain("Partially supported");
    expect(container.textContent).not.toContain("Adapted UI APIs");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Expand details for Review helper"]')).click());
    expect(container.textContent).toContain("Adapted UI APIs");
    expect(container.textContent).toContain("select");
    expect(container.textContent).toContain("Unsupported UI APIs");
    expect(container.textContent).toContain("setFooter");
    expect(container.textContent).toContain("Terminal layout controls are unavailable");
    expect(container.textContent).toContain("Disabled scripts: preinstall, postinstall");
    expect(container.textContent).toContain("sha256:reviewed-extension-content");

    await act(async () => buttonWithText(container, "Update").click());
    await act(async () => { await required(pending); });
    expect(updateResource).toHaveBeenCalledWith("resource-extension");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Package compatibility review");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("sha256:new-extension-content");

    await act(async () => buttonWithText(container, "Approve current content").click());
    await act(async () => { await required(pending); });
    expect(approveResource).toHaveBeenCalledWith("resource-extension", "sha256:new-extension-content");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps unsupported themes non-toggleable and derives the worst package compatibility", async () => {
    const controller = {} as AppController;
    const container = await renderPackages(controller, [theme], (_key, action) => { void action(); });
    expect(container.textContent).toContain("Theme");
    expect(container.textContent).toContain("Unsupported");
    expect(buttonTexts(container)).not.toContain("Enable");
    expect(buttonTexts(container)).not.toContain("Disable");
    expect(resourceCanToggle(theme)).toBe(false);
    expect(resourceCanUpdate(theme)).toBe(true);
    expect(packageCompatibility({
      ...extension,
      compatibilityDetails: [
        { ...extension.compatibilityDetails[0]!, compatibility: "supported" },
        { ...extension.compatibilityDetails[0]!, name: "unsafe.ts", compatibility: "unsupported" }
      ]
    })).toBe("unsupported");
  });
});

const extension: ResourceView = {
  id: "resource-extension",
  backendId: "runtime-capability",
  name: "Review helper",
  version: "2.0.0",
  kind: "extension",
  scope: "global",
  state: "updateAvailable",
  enabled: false,
  source: "registry:review-helper",
  discoveredRevision: "tree:2",
  compatibilityDetails: [{
    kind: "extension",
    name: "review.ts",
    compatibility: "partial",
    issues: ["terminalLayout"],
    detectedApis: ["select", "setFooter"],
    adaptedApis: ["select"],
    unsupportedApis: ["setFooter"]
  }],
  runtimeRequirements: [{
    packageName: "@runtime/core",
    range: "^0.9.0",
    currentVersion: "1.2.0",
    status: "incompatible"
  }],
  warnings: ["lifecycleScriptsDisabled"],
  disabledLifecycleScripts: ["preinstall", "postinstall"],
  canToggle: true,
  requiresExtensionApproval: false,
  extensionContentFingerprint: "sha256:reviewed-extension-content",
  postMutationNotice: false
};

const theme: ResourceView = {
  id: "resource-theme",
  backendId: "runtime-capability",
  name: "Night theme",
  kind: "theme",
  scope: "user",
  state: "loaded",
  enabled: false,
  source: "service-node theme",
  discoveredRevision: "tree:theme",
  compatibilityDetails: [{
    kind: "theme",
    name: "night.json",
    compatibility: "unsupported",
    issues: ["themeControl"],
    detectedApis: [],
    adaptedApis: [],
    unsupportedApis: []
  }],
  runtimeRequirements: [],
  warnings: [],
  disabledLifecycleScripts: [],
  canToggle: false,
  requiresExtensionApproval: false,
  postMutationNotice: false
};

async function renderPackages(
  controller: AppController,
  resources: readonly ResourceView[],
  runAction: (key: string, action: () => Promise<void>) => void
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<PiPackagesSection
    controller={controller}
    resources={resources}
    runAction={runAction}
    t={(key, values) => translate("en", key, values)}
  />));
  return container;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected button ${text}.`);
  return button;
}

function buttonTexts(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent?.trim() ?? "");
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered value.");
  return value;
}
