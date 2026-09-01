// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot } from "../model.js";
import { PersonalizationSettings } from "./SettingsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("PersonalizationSettings persistence", () => {
  it("clears durable overrides through dedicated reset operations", async () => {
    const base = emptySnapshot();
    const snapshot = {
      ...base,
      settings: {
        ...base.settings,
        pi: [{
          backendId: "pi",
          autoCompaction: true,
          autoCompactionThresholdPercent: 68,
          autoCompactionThresholdCustomized: true,
          autoRetry: true,
          steeringMode: "oneAtATime" as const,
          followUpMode: "oneAtATime" as const
        }],
        messageSearch: {
          ...base.settings.messageSearch,
          semanticIndexEnabled: false,
          vectorAvailable: true,
          embeddingProviderAvailable: true,
          customized: true
        },
        promptRecommendation: {
          enabled: false,
          available: false,
          unavailableReason: "No prediction route.",
          customized: true
        },
        visionBridge: {
          ...base.settings.visionBridge,
          enabled: true,
          customizedFields: ["enabled"]
        }
      }
    };
    const resetPersonalizationPrompt = vi.fn(async () => undefined);
    const updatePiSettings = vi.fn(async () => undefined);
    const resetLinkOpenPreference = vi.fn(async () => undefined);
    const resetStreamFadeEnabled = vi.fn(async () => undefined);
    const resetPromptRecommendationSettings = vi.fn(async () => undefined);
    const updateVisionBridgeSettings = vi.fn(async () => undefined);
    const resetMessageSearchSettings = vi.fn(async () => undefined);
    const resetMessageNavRailEnabled = vi.fn(async () => undefined);
    const controller = {
      getPersonalizationPrompt: () => "Keep replies concise.",
      resetPersonalizationPrompt,
      updatePiSettings,
      resetLinkOpenPreference,
      resetStreamFadeEnabled,
      resetPromptRecommendationSettings,
      updateVisionBridgeSettings,
      resetMessageSearchSettings,
      resetMessageNavRailEnabled,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: {
          locale: "en",
          linkOpenPreference: "external",
          streamFadeEnabled: false,
          messageNavRailEnabled: false
        },
        snapshot
      }
    } as unknown as AppController;
    const actionKeys: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<PersonalizationSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(key, action) => {
        actionKeys.push(key);
        void action();
      }}
      onSuccess={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    const restore = async (scope: Element | null): Promise<void> => {
      const button = required(scope?.querySelector<HTMLButtonElement>('[aria-label="Restore default"]') ?? null);
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
    };
    await restore(container.querySelector('[aria-labelledby="personalization-prompt-heading"]'));
    await restore(container.querySelector('[aria-labelledby="vision-bridge-title"]'));
    await restore(container.querySelector('[aria-labelledby="personalization-compaction-heading"]'));
    await restore(container.querySelector('[aria-labelledby="personalization-links-heading"]'));
    await restore(container.querySelector('[aria-labelledby="personalization-stream-heading"]'));
    await restore(container.querySelector(".prompt-recommendation"));
    await restore(required(container.querySelector<HTMLInputElement>('[aria-label="Toggle chat semantic indexing"]')).closest(".personalization-tip-row"));
    await restore(required(container.querySelector<HTMLInputElement>('[aria-label="Toggle question navigation rail"]')).closest(".personalization-tip-row"));

    expect(resetPersonalizationPrompt).toHaveBeenCalledOnce();
    expect(updateVisionBridgeSettings).toHaveBeenCalledWith({ resetAll: true });
    expect(updatePiSettings).toHaveBeenCalledWith("pi", { resetAutoCompactionThresholdPercent: true });
    expect(resetLinkOpenPreference).toHaveBeenCalledOnce();
    expect(resetStreamFadeEnabled).toHaveBeenCalledOnce();
    expect(resetPromptRecommendationSettings).toHaveBeenCalledOnce();
    expect(resetMessageSearchSettings).toHaveBeenCalledOnce();
    expect(resetMessageNavRailEnabled).toHaveBeenCalledOnce();
    expect(required(container.querySelector<HTMLInputElement>('[aria-label="Toggle prompt recommendations"]')).disabled).toBe(true);
    expect(actionKeys).toEqual([
      "personalization-prompt:reset",
      "vision-bridge-reset",
      "pi-auto-compact-threshold:reset",
      "link-open:reset",
      "stream-fade:reset",
      "prompt-recommendation:reset",
      "message-search-semantic-index:reset",
      "message-nav-rail:reset"
    ]);
  });

  it("rolls an optimistic local preference back when persistence fails", async () => {
    const snapshot = emptySnapshot();
    const controller = {
      getPersonalizationPrompt: () => "",
      setLinkOpenPreference: vi.fn(async () => { throw new Error("write failed"); }),
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: {
          locale: "en",
          linkOpenPreference: "sidebar",
          streamFadeEnabled: true,
          messageNavRailEnabled: true
        },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<PersonalizationSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action().catch(() => undefined); }}
      onSuccess={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    const external = required(container.querySelector<HTMLButtonElement>('[role="radio"]:last-child'));
    await act(async () => {
      external.click();
      await Promise.resolve();
    });

    const sidebar = required(container.querySelector<HTMLButtonElement>('[role="radio"]:first-child'));
    expect(sidebar.getAttribute("aria-checked")).toBe("true");
    expect(external.getAttribute("aria-checked")).toBe("false");
  });
});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected rendered value.");
  return value;
}
