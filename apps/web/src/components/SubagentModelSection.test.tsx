// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type ModelView, type SubagentModelSettingsView } from "../model.js";
import { resetModelPickerPreferencesForTests } from "../model-picker-preferences.js";
import { SubagentModelSection } from "./SubagentModelSection.js";

let root: Root;
const t = (key: Parameters<typeof translate>[1]) => translate("en", key);
const a = { providerId: "source", modelId: "small" };
const b = { providerId: "source", modelId: "large" };
const setting = (model?: typeof a, revision = 0n): SubagentModelSettingsView => ({ backendId: "worker", ...(model === undefined ? {} : { model }), revision, available: true, unavailableReason: "" });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetModelPickerPreferencesForTests();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  resetModelPickerPreferencesForTests();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

it("uses the shared picker, waits for committed settings, serializes saves and restores the native default", async () => {
  const fixture = await mount();
  const deferred = promise();
  fixture.save.mockReturnValueOnce(deferred.value);
  await choose("Small");
  expect(fixture.save).toHaveBeenCalledExactlyOnceWith("worker", a, 0n);
  expect(trigger().disabled).toBe(true);
  await fixture.render();
  expect(trigger().disabled).toBe(true);
  await act(async () => deferred.resolve());
  expect(document.body.textContent).toContain("Waiting for the current settings");
  await fixture.publish(setting(a, 1n));
  expect(trigger().disabled).toBe(false);
  await click("Restore default");
  expect(fixture.save).toHaveBeenLastCalledWith("worker", undefined, 1n);
  await fixture.publish(setting(undefined, 2n));
  expect(trigger().textContent).toContain("Unspecified");
  expect(document.body.textContent).not.toContain("Waiting for the current settings");
});

it("retains a failed selection and resolves cross-window conflict explicitly without accepting an older snapshot", async () => {
  const fixture = await mount();
  fixture.save.mockRejectedValueOnce(new Error("failed"));
  await choose("Small");
  expect(document.body.textContent).toContain("Your selection is kept");
  await fixture.publish(setting(b, 2n));
  expect(trigger().textContent).toContain("Small");
  expect(document.body.textContent).toContain("changed in another window");
  await click("Save selection with latest settings");
  expect(fixture.save).toHaveBeenLastCalledWith("worker", a, 2n);
  await fixture.publish(setting(a, 3n));
  await fixture.publish(setting(b, 2n));
  expect(trigger().textContent).toContain("Small");
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
});

it("retires late saves across profile and disconnection changes and keeps unavailable stored choices resettable", async () => {
  const fixture = await mount();
  const deferred = promise();
  fixture.save.mockReturnValueOnce(deferred.value);
  await choose("Small");
  await fixture.render("second");
  await fixture.render("first");
  await act(async () => deferred.reject(new Error("old profile")));
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  expect(trigger().textContent).toContain("Unspecified");
  const late = promise();
  fixture.save.mockReturnValueOnce(late.value);
  await choose("Large");
  await fixture.render("first", false);
  await act(async () => late.reject(new Error("disconnected")));
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  await fixture.render("first", true);
  await fixture.publish({ ...setting(b, 1n), available: false, unavailableReason: "Source unavailable; using native default." });
  expect(document.body.textContent).toContain("Source unavailable");
  await click("Restore default");
  expect(fixture.save).toHaveBeenLastCalledWith("worker", undefined, 1n);
});

it("allows explicit reset of invalid stored settings and restores focus only while the reset still owns it", async () => {
  const fixture = await mount();
  await fixture.publish({ ...setting(undefined, 4n), available: false, unavailableReason: "Subagent model settings are invalid." });
  const reset = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore default")!;
  reset.focus();
  await click("Restore default");
  expect(fixture.save).toHaveBeenLastCalledWith("worker", undefined, 4n);
  await fixture.publish(setting(undefined, 5n));
  expect(document.activeElement).toBe(trigger());
  expect(document.body.textContent).not.toContain("settings are invalid");

  await fixture.publish(setting(a, 6n));
  const nextReset = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Restore default")!;
  nextReset.focus();
  await click("Restore default");
  const other = document.createElement("button");
  other.textContent = "Another setting";
  document.body.append(other);
  other.focus();
  await fixture.publish(setting(undefined, 7n));
  expect(document.activeElement).toBe(other);
});

async function mount() {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const save = vi.fn<AppController["updateSubagentModelSettings"]>().mockResolvedValue(undefined);
  const gatewayIdentity = vi.fn();
  let current = setting();
  let profile = "first";
  let connected = true;
  const render = async (nextProfile = profile, nextConnected = connected) => {
    profile = nextProfile; connected = nextConnected;
    const snapshot = { ...emptySnapshot(), revision: 1n, generation: 1n,
      backends: [{ id: "worker", name: "Worker", version: "1", health: "healthy" as const,
        capabilities: new Map([["subagents.default_model", { name: "subagents.default_model", supported: true, options: [] }]]) }],
      models: [model(a, "Small"), model(b, "Large")],
      settings: { ...emptySnapshot().settings, subagentModels: [current] }
    };
    const controller = { state: { ready: true, connectionState: connected ? "connected" : "disconnected", activeProfile: { id: profile, serverId: "node" } },
      updateSubagentModelSettings: save, getArtifactUrl: gatewayIdentity, refresh: vi.fn().mockResolvedValue(undefined)
    } as unknown as AppController;
    await act(async () => root.render(<StrictMode><SubagentModelSection controller={controller} snapshot={snapshot} t={t} /></StrictMode>));
  };
  await render();
  return { save, render, publish: async (value: SubagentModelSettingsView) => { current = value; await render(); } };
}
function model(selection: typeof a, name: string): ModelView {
  return { backendId: "worker", ...selection, providerName: "Source", name, available: true, supportsImages: false,
    inputModalities: ["text"], outputModalities: ["text"], supportsFast: false, efforts: [], contextWindow: 32_000,
    maximumOutputTokens: 4_000, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD" };
}
function trigger(): HTMLButtonElement { return document.querySelector<HTMLButtonElement>(".model-picker-trigger")!; }
async function choose(name: string) {
  await act(async () => trigger().click());
  const row = [...document.querySelectorAll<HTMLElement>(".model-picker__row")].find((element) => element.textContent?.includes(name));
  if (row === undefined) throw new Error(`Missing model ${name}`);
  await act(async () => row.click());
}
async function click(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === name || element.getAttribute("aria-label") === name);
  if (button === undefined) throw new Error(`Missing button ${name}`);
  await act(async () => button.click());
}
function promise() {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const value = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { value, resolve, reject };
}
