// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot } from "../model.js";
import { RuntimeGovernanceSettings } from "./RuntimeGovernanceSettings.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("RuntimeGovernanceSettings", () => {
  it("covers presets, direct fields, collaboration limits, savepoint status, cleanup, and resets", async () => {
    const updateAgentResourceSettings = vi.fn(async () => undefined);
    const updateCollaborationSettings = vi.fn(async () => undefined);
    const updateGitSafetySettings = vi.fn(async () => undefined);
    const cleanupGitSafetySavepoints = vi.fn(async () => undefined);
    const controller = {
      updateAgentResourceSettings,
      updateCollaborationSettings,
      updateGitSafetySettings,
      cleanupGitSafetySavepoints
    } as unknown as AppController;
    const snapshot = emptySnapshot();
    const configured = {
      ...snapshot,
      settings: {
        ...snapshot.settings,
        agentResource: {
          maxConcurrentCommands: 7,
          processPriority: "low" as const,
          capToolchainThreads: true,
          customized: true,
          revision: 1n
        },
        collaboration: {
          workerSoftLimit: 3,
          workerHardLimit: 8,
          workerIdleReleaseMinutes: 0,
          customized: true,
          revision: 2n
        },
        gitSafety: {
          autoSnapshotEnabled: false,
          pendingTurns: 0,
          trackedSessions: 2,
          trackedRepositories: 1,
          cleanupAvailable: true,
          customized: true,
          revision: 3n
        }
      }
    };
    const pending: Promise<void>[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<RuntimeGovernanceSettings
      controller={controller}
      snapshot={configured}
      runAction={(_key, action) => { pending.push(action()); }}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.textContent).toContain("Agent Resource Usage");
    expect(container.textContent).toContain("Collaboration");
    expect(container.textContent).toContain("2 tasks across 1 repositories");

    await clickButton(container, "Background");
    expect(updateAgentResourceSettings).toHaveBeenCalledWith({
      maxConcurrentCommands: 2,
      processPriority: "lowest",
      capToolchainThreads: true
    });

    const commandLimit = inputFor(container, "Concurrent Command Limit");
    await changeAndBlur(commandLimit, "5");
    expect(updateAgentResourceSettings).toHaveBeenCalledWith({ maxConcurrentCommands: 5 });

    const softLimit = inputFor(container, "Worker Soft Limit");
    await changeAndBlur(softLimit, "4");
    expect(updateCollaborationSettings).toHaveBeenCalledWith({ workerSoftLimit: 4 });

    const savepointToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle hidden Git savepoints"]')!;
    await act(async () => savepointToggle.click());
    expect(updateGitSafetySettings).toHaveBeenCalledWith({ autoSnapshotEnabled: true });

    await clickButton(container, "Clear savepoints");
    expect(cleanupGitSafetySavepoints).toHaveBeenCalledTimes(1);
    await clickButton(container, "Restore default");
    expect(updateCollaborationSettings).toHaveBeenCalledWith({ resetAll: true });
    await act(async () => Promise.all(pending));
  });
});

function inputFor(container: HTMLElement, text: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.includes(text));
  const input = label?.querySelector<HTMLInputElement>('input[type="number"]');
  if (input === null || input === undefined) throw new Error(`Missing number input: ${text}`);
  return input;
}

async function clickButton(container: HTMLElement, text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
  if (button === undefined) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}

async function changeAndBlur(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.blur());
}
