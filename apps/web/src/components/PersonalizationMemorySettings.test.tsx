// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type AppSnapshot } from "../model.js";
import { PersonalizationMemorySettings } from "./PersonalizationMemorySettings.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("PersonalizationMemorySettings", () => {
  it("renders Maker/backend rows and wires capability-scoped toggles", async () => {
    const update = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const controller = {
      updateMemorySettings: update,
      restoreMemoryDefaults: restore,
      resetMemory: vi.fn(async () => ({ removedEntries: 0, removedTargets: 0 }))
    } as unknown as AppController;
    const onSuccess = vi.fn();
    const container = await render(controller, snapshot(true), undefined, onSuccess);

    expect(container.textContent).toContain("Maker Memory");
    expect(container.textContent).toContain("Pi Auto Memory");
    expect(container.querySelector(".memory-settings__notice")).toBeNull();
    const backendToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Pi Auto Memory"]')!;
    await act(async () => backendToggle.click());
    expect(update).toHaveBeenCalledWith({ backendId: "memory-capable", backendEnabled: false });
    expect(onSuccess).toHaveBeenCalledWith("Pi Auto Memory disabled — takes effect on the next agent session");

    const makerToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Maker Memory"]')!;
    await act(async () => makerToggle.click());
    expect(update).toHaveBeenCalledWith({ makerEnabled: false });
    expect(onSuccess).toHaveBeenCalledWith("Maker Memory disabled");

    const restoreButton = container.querySelector<HTMLButtonElement>('button[aria-label="Restore default"]')!;
    await act(async () => restoreButton.click());
    expect(restore).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith("Restored default settings");
  });

  it("confirms curated Maker reset and Backend-only digest reset with distinct typed scopes", async () => {
    const reset = vi.fn(async () => ({ removedEntries: 2, removedTargets: 1 }));
    const controller = {
      updateMemorySettings: vi.fn(async () => undefined),
      restoreMemoryDefaults: vi.fn(async () => undefined),
      resetMemory: reset
    } as unknown as AppController;
    const onSuccess = vi.fn();
    const container = await render(controller, snapshot(true), undefined, onSuccess);
    const resetButtons = container.querySelectorAll<HTMLButtonElement>(".memory-settings__reset");

    await act(async () => resetButtons[1]!.click());
    expect(document.body.textContent).toContain("Reset Pi Auto Memory?");
    const alertDialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(alertDialog).not.toBeNull();
    const layer = alertDialog?.parentElement;
    await act(async () => layer?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.body.querySelector('[role="alertdialog"]')).toBe(alertDialog);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Back");
    await act(async () => document.body.querySelector<HTMLButtonElement>(".modal .button--primary")!.click());
    expect(reset).toHaveBeenCalledWith("backend", "memory-capable");
    expect(onSuccess).toHaveBeenCalledWith("Pi Auto Memory reset — removed 2 entries");

    await act(async () => resetButtons[0]!.click());
    expect(document.body.textContent).toContain("Reset Maker Memory?");
    await act(async () => document.body.querySelector<HTMLButtonElement>(".modal .button--primary")!.click());
    expect(reset).toHaveBeenCalledWith("curated");
    expect(onSuccess).toHaveBeenCalledWith("Maker Memory reset — removed 2 entries");
    expect(container.querySelector(".memory-settings__notice")).toBeNull();
  });

  it("disables Auto Memory controls when Maker Memory is off but keeps global reset reachable", async () => {
    const container = await render({} as AppController, snapshot(false), () => undefined);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Pi Auto Memory"]')?.disabled).toBe(true);
    const resetButtons = container.querySelectorAll<HTMLButtonElement>(".memory-settings__reset");
    expect(resetButtons[0]?.disabled).toBe(false);
    expect(resetButtons[1]?.disabled).toBe(true);
  });
});

async function render(
  controller: AppController,
  value: AppSnapshot,
  runAction: (key: string, work: () => Promise<void>) => void = (_key, work) => { void work(); },
  onSuccess: (text: string) => void = () => undefined
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<PersonalizationMemorySettings
    controller={controller}
    snapshot={value}
    runAction={runAction}
    onSuccess={onSuccess}
    t={(key, values) => translate("en", key, values)}
  />));
  return container;
}

function snapshot(makerEnabled: boolean): AppSnapshot {
  const base = emptySnapshot();
  return {
    ...base,
    backends: [{
      id: "memory-capable",
      name: "Pi",
      version: "test",
      health: "healthy",
      capabilities: new Map()
    }],
    settings: {
      ...base.settings,
      memory: {
        makerEnabled,
        makerSupported: true,
        makerReason: "",
        customized: true,
        entryCount: 4,
        backends: [{
          backendId: "memory-capable",
          enabled: true,
          supported: true,
          reason: "",
          entryCount: 2
        }]
      }
    }
  };
}
