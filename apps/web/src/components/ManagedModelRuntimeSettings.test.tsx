// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { ManagedModelRuntimeView } from "../model.js";
import { ManagedModelRuntimeSettings } from "./ManagedModelRuntimeSettings.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ManagedModelRuntimeSettings", () => {
  it("covers recommended, custom, resumable and installed model actions through capabilities", async () => {
    const calls: string[] = [];
    const controller = {
      state: { preferences: { locale: "en" } },
      refreshManagedModelRuntimes: vi.fn(async () => [runtime]),
      pullManagedModel: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`pull:${name}`); return runtime; }),
      pauseManagedModelPull: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`pause:${name}`); return runtime; }),
      resumeManagedModelPull: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`resume:${name}`); return runtime; }),
      cancelManagedModelPull: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`cancel:${name}`); return runtime; }),
      deleteManagedModel: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`delete:${name}`); return runtime; })
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ManagedModelRuntimeSettings
      controller={controller}
      runtimes={[runtime]}
      runAction={(_key, action) => { void action(); }}
    />));

    expect(container.textContent).toContain("Recommended for this device");
    expect(container.textContent).toContain("Best for you");
    expect(container.textContent).toContain("Installed models");
    expect(container.textContent).toContain("25%");
    expect(container.textContent).toContain("Paused");

    await act(async () => buttonWithText(container, "Download & add").click());
    expect(calls).toContain("pull:recommended:a");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Resume download"]')).click());
    expect(calls).toContain("resume:paused:a");

    const manual = required(container.querySelector<HTMLInputElement>('[placeholder^="qwen3"]'));
    await act(async () => {
      setInputValue(manual, "custom:model");
      manual.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonWithText(container, "Download & add", true).click());
    expect(calls).toContain("pull:custom:model");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Delete Installed A"]')).click());
    await act(async () => buttonWithText(container, "Delete").click());
    expect(calls).toContain("delete:installed:a");
  });

  it("shows install preflight and cancel controls without inferring a concrete runtime identity", async () => {
    const installRuntime: ManagedModelRuntimeView = {
      ...runtime,
      id: "runtime-capability-a",
      name: "Local Runtime",
      state: "installing",
      capabilities: { ...runtime.capabilities, canInstall: true, canCancelInstall: true, canPullModels: false, supportsCustomModels: false },
      installedModels: [],
      catalog: [],
      transfers: [{ kind: "runtimeInstall", phase: "downloading", completedBytes: 50, totalBytes: 100, percent: 50, done: false }]
    };
    const cancel = vi.fn(async () => installRuntime);
    const controller = {
      state: { preferences: { locale: "en" } },
      refreshManagedModelRuntimes: vi.fn(async () => [installRuntime]),
      cancelManagedModelRuntimeInstall: cancel
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ManagedModelRuntimeSettings
      controller={controller}
      runtimes={[installRuntime]}
      runAction={(_key, action) => { void action(); }}
    />));
    expect(container.textContent).toContain("50%");
    await act(async () => buttonWithText(container, "Cancel install").click());
    expect(cancel).toHaveBeenCalledWith("runtime-capability-a");
  });
});

const runtime: ManagedModelRuntimeView = {
  id: "runtime-a",
  name: "Local Runtime",
  state: "ready",
  source: "running",
  version: "1.2.3",
  capabilities: {
    canInstall: true,
    canCancelInstall: false,
    canStart: true,
    canListModels: true,
    canPullModels: true,
    canDeleteModels: true,
    canPausePulls: true,
    canResumePulls: true,
    canCancelPulls: true,
    supportsCustomModels: true,
    supportsCuratedCatalog: true,
    supportsModelPreflight: true
  },
  installPreflight: { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 1_024 },
  installedModels: [{
    name: "installed:a",
    displayName: "Installed A",
    sizeBytes: 2_048,
    contextWindowTokens: 16_384,
    supportsTools: true,
    supportsImages: true
  }],
  catalog: [{
    id: "recommended-a",
    name: "recommended:a",
    displayName: "Recommended A",
    sizeBytes: 4_096,
    minimumMemoryGb: 8,
    platformLimited: false,
    recommended: true,
    preflight: { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 8_192 }
  }, {
    id: "paused-a",
    name: "paused:a",
    displayName: "Paused A",
    sizeBytes: 4_096,
    minimumMemoryGb: 8,
    platformLimited: false,
    recommended: true,
    preflight: { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 8_192 }
  }],
  transfers: [
    { kind: "modelPull", modelName: "paused:a", phase: "paused", completedBytes: 25, totalBytes: 100, percent: 25, done: true },
    { kind: "modelPull", modelName: "custom:active", phase: "downloading", completedBytes: 10, totalBytes: 100, percent: 10, done: false }
  ],
  revision: 1n
};

function buttonWithText(container: HTMLElement, text: string, last = false): HTMLButtonElement {
  const matches = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === text);
  const button = last ? matches.at(-1) : matches[0];
  if (button === undefined) throw new Error(`Expected button ${text}.`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected rendered value.");
  return value;
}
