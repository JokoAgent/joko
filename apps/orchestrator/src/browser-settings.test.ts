import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { BrowserAutomationTarget, BrowserSettingsPatchSchema } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  BrowserSettingsController,
  BrowserSettingsEffectError,
  BrowserSettingsValidationError,
  type BrowserRuntimeSettings,
  type BrowserSettingsEffect,
  type BrowserSettingsHooks,
  type BrowserSettingsTransition
} from "./browser-settings.js";

const DEFAULTS: BrowserRuntimeSettings = {
  browserProviderId: "browser",
  enabled: true,
  profileDisplayName: "Joko",
  takeoverTimeoutMs: 15 * 60_000,
  allowUploads: true,
  allowDownloads: true,
  automationTarget: "external"
};
const cleanups: Array<() => void> = [];

afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("BrowserSettingsController Target policy", () => {
  it("stores service configuration separately and isolates Target activation", async () => {
    const fixture = createFixture();
    expect(fixture.controller.snapshot()).toMatchObject({
      profileDisplayName: "Joko",
      targetSettings: [
        { targetId: "target-a", enabled: true },
        { targetId: "target-b", enabled: true }
      ]
    });

    const updated = await fixture.controller.apply(create(BrowserSettingsPatchSchema, {
      browserProviderId: "browser",
      targetId: "target-a",
      enabled: false
    }));
    expect(updated.targetSettings).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetId: "target-a", enabled: false }),
      expect.objectContaining({ targetId: "target-b", enabled: true })
    ]));
    expect(fixture.controller.enabled("target-a")).toBe(false);
    expect(fixture.controller.enabled("target-b")).toBe(true);
    expect(fixture.calls).toEqual([expect.objectContaining({ effect: "stop", transition: expect.objectContaining({ targetId: "target-a" }) })]);
    expect(fixture.store.getSetting("service", "orchestrator", "settings.browser.browser").value).toMatchObject({ format: 1, profileDisplayName: "Joko" });
    expect(fixture.store.getSetting("target", "target-a", "settings.browser.browser.enabled").value).toEqual({
      format: 1,
      browserProviderId: "browser",
      enabled: false
    });
  });

  it("updates service placement without changing either Target policy", async () => {
    const fixture = createFixture();
    const updated = await fixture.controller.apply(create(BrowserSettingsPatchSchema, {
      browserProviderId: "browser",
      profileDisplayName: "Work browser",
      automationTarget: BrowserAutomationTarget.SIDEBAR
    }));
    expect(updated).toMatchObject({ profileDisplayName: "Work browser", automationTarget: BrowserAutomationTarget.SIDEBAR });
    expect(updated.targetSettings.every((target) => target.enabled)).toBe(true);
    expect(fixture.calls).toEqual([expect.objectContaining({ effect: "refresh" })]);
  });

  it("publishes policy before persistence and retains durable truth when the effect fails", async () => {
    const fixture = createFixture({ fail: "stop" });
    await expect(fixture.controller.apply(create(BrowserSettingsPatchSchema, {
      browserProviderId: "browser",
      targetId: "target-a",
      enabled: false
    }))).rejects.toBeInstanceOf(BrowserSettingsEffectError);
    expect(fixture.controller.enabled("target-a")).toBe(true);
    expect(fixture.store.findSetting("target", "target-a", "settings.browser.browser.enabled")).toBeUndefined();
  });

  it("requires a real Target only for activation patches", async () => {
    const fixture = createFixture();
    await expect(fixture.controller.apply(create(BrowserSettingsPatchSchema, {
      browserProviderId: "browser",
      enabled: false
    }))).rejects.toBeInstanceOf(BrowserSettingsValidationError);
    await expect(fixture.controller.apply(create(BrowserSettingsPatchSchema, {
      browserProviderId: "browser",
      targetId: "missing",
      enabled: false
    }))).rejects.toBeInstanceOf(BrowserSettingsValidationError);
    await expect(fixture.controller.apply(create(BrowserSettingsPatchSchema, {
      browserProviderId: "browser",
      allowUploads: false
    }))).resolves.toMatchObject({ allowUploads: false });
  });
});

function createFixture(options: {
  readonly fail?: BrowserSettingsEffect;
  readonly beforeController?: (store: OperationalStore) => void;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "joko-browser-settings-"));
  let now = 10_000;
  const store = new OperationalStore(join(root, "operational.sqlite"), { now: () => ++now });
  store.upsertBackend({ id: "pi", adapterKind: "fixture", instanceGeneration: 0, displayName: "Pi", version: "test", health: "healthy", installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  for (const id of ["target-a", "target-b"]) store.upsertTarget({ id, backendId: "pi", displayName: id, workspaceRoot: `D:/${id}`, managed: false, trusted: true });
  options.beforeController?.(store);
  const calls: Array<{ readonly effect: BrowserSettingsEffect; readonly transition: BrowserSettingsTransition }> = [];
  const hook = (effect: BrowserSettingsEffect) => async (transition: BrowserSettingsTransition) => {
    calls.push({ effect, transition });
    if (options.fail === effect) throw new Error(`${effect} failed`);
  };
  const hooks: BrowserSettingsHooks = { start: hook("start"), stop: hook("stop"), refresh: hook("refresh") };
  const controller = new BrowserSettingsController({ store, defaults: DEFAULTS, hooks, now: () => ++now });
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, controller, calls };
}
