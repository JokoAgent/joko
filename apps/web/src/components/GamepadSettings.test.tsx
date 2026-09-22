// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../i18n.js";
import type { AppController } from "../controller.js";
import type { SkillDescriptorView } from "../model.js";
import {
  createDefaultGamepadPreferences, GAMEPAD_PREFERENCES_KEY, readGamepadPreferences,
  type GamepadPreferences
} from "../gamepad-input.js";
import { GamepadSettings } from "./GamepadSettings.js";

vi.mock("../gamepad-client.js", () => ({
  gamepadClient: () => ({ reset() {}, sample() {} }),
  useGamepadSnapshot: () => ({ status: "disabled", devices: [] })
}));

const roots: Root[] = [];
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
});
afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const listedSkill: SkillDescriptorView = {
  id: "resource-skill", backendId: "backend", scope: "global", name: "Review",
  sourceLabel: "Local", state: "loaded", enabled: true, canToggle: true,
  contentAvailable: true, canEdit: true, canDelete: true, revision: 1n,
  approvedRevision: "1", updatedAt: 1
};
async function renderSettings(input: { readonly serverId?: string; readonly connected?: boolean; readonly listSkills?: AppController["listSkills"] } = {}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<GamepadSettings t={(key, values) => translate("en", key, values)}
    serverId={input.serverId} connected={input.connected ?? false}
    listSkills={input.listSkills ?? (async () => ({ revision: 1n, skills: [] }))} />));
  return container;
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected gamepad setting control.");
  return value;
}
function control(container: HTMLElement, label: string): HTMLButtonElement {
  return required([...container.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
    .find((button) => button.getAttribute("aria-label") === label));
}
function button(container: HTMLElement, text: string): HTMLButtonElement {
  return required([...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === text));
}
async function key(target: HTMLElement, value: string): Promise<void> {
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
function store(value: unknown): void { window.localStorage.setItem(GAMEPAD_PREFERENCES_KEY, JSON.stringify(value)); }

describe("gamepad settings", () => {
  it("persists an enabled skill identity only after a successful save", async () => {
    const listSkills = vi.fn(async () => ({ revision: 1n, skills: [listedSkill] }));
    const container = await renderSettings({ serverId: "server-one", connected: true, listSkills });
    await vi.waitFor(() => expect(listSkills).toHaveBeenCalledOnce());
    const binding = control(container, "Action for South face button");
    binding.focus();
    await key(binding, "ArrowDown"); await key(binding, "End"); await key(binding, "Enter");
    expect(readGamepadPreferences().preferences.buttons[0]).toEqual({
      kind: "skill", serverId: "server-one", resourceId: "resource-skill", name: "Review"
    });
    expect(binding.textContent).toContain("Review");
    expect(container.textContent).toContain("Gamepad settings saved.");
  });
  it("starts off and adopts enabled input only after its device setting has been saved", async () => {
    const container = await renderSettings();
    const enabled = control(container, "Enable gamepad input");
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Gamepad input is off.");
    expect(container.querySelector("[data-gamepad-preview='true']")).not.toBeNull();
    expect(window.localStorage.getItem(GAMEPAD_PREFERENCES_KEY)).toBeNull();

    const originalWrite = Storage.prototype.setItem;
    let checkedWhileSaving: string | null = null;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
      checkedWhileSaving = enabled.getAttribute("aria-checked");
      originalWrite.call(this, name, value);
    });
    await act(async () => enabled.click());
    expect(checkedWhileSaving).toBe("false");
    expect(readGamepadPreferences().preferences.enabled).toBe(true);
    expect(enabled.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Gamepad settings saved.");
  });
  it("offers the skill library as a persistent standard gamepad action", async () => {
    const container = await renderSettings();
    const binding = control(container, "Action for South face button");
    await act(async () => binding.click());
    const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((candidate) => candidate.textContent === "Open skills");
    expect(option).toBeDefined();
    await act(async () => option?.click());
    expect(readGamepadPreferences().preferences.buttons[0]).toBe("open-skills");
  });
  it("offers the schedule manager as a persistent standard gamepad action", async () => {
    const container = await renderSettings();
    const binding = control(container, "Action for South face button");
    await act(async () => binding.click());
    const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((candidate) => candidate.textContent === "Open schedules");
    expect(option).toBeDefined();
    await act(async () => option?.click());
    expect(readGamepadPreferences().preferences.buttons[0]).toBe("open-schedules");
  });

  it("retains the committed binding and keyboard focus on save failure, then allows a successful retry", async () => {
    const container = await renderSettings();
    const binding = required(container.querySelector<HTMLButtonElement>("[role='combobox']"));
    const original = binding.textContent;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Device storage is full"); });
    binding.focus();
    await key(binding, "ArrowDown"); await key(binding, "End"); await key(binding, "Enter");
    expect(binding.textContent).toBe(original);
    expect(document.activeElement).toBe(binding);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Could not save the layout");
    expect(readGamepadPreferences().preferences.buttons[0]).toBe("submit");
    expect(window.localStorage.getItem(GAMEPAD_PREFERENCES_KEY)).toBeNull();

    write.mockRestore();
    await key(binding, "ArrowDown"); await key(binding, "End"); await key(binding, "Enter");
    expect(readGamepadPreferences().preferences.buttons[0]).toBe("voice");
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(binding.textContent).not.toBe(original);
    expect(document.activeElement).toBe(binding);
    expect(binding.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("[role='listbox']")).toBeNull();
  });

  it("restores every button and stick assignment while preserving the enabled setting", async () => {
    const defaults = createDefaultGamepadPreferences();
    const changed: GamepadPreferences = {
      ...defaults, enabled: true, buttons: defaults.buttons.map(() => "none"),
      leftStick: { ...defaults.leftStick, mode: "disabled" },
      rightStick: { mode: "commands", directions: { up: "new-task", down: "back", left: "previous-task", right: "next-task" } }
    };
    store(changed);
    const container = await renderSettings();
    expect(control(container, "Left stick mode").textContent).toBe("Disabled");
    expect(control(container, "Right stick mode").textContent).toBe("Directional actions");
    const restore = button(container, "Restore default layout");
    restore.focus();
    await act(async () => restore.click());
    expect(readGamepadPreferences()).toEqual({ preferences: { ...defaults, enabled: true } });
    expect(control(container, "Enable gamepad input").getAttribute("aria-checked")).toBe("true");
    expect(control(container, "Left stick mode").textContent).toBe("Directional actions");
    expect(control(container, "Right stick mode").textContent).toBe("Scroll conversation");
    expect(document.activeElement).toBe(restore);
    expect(container.textContent).toContain("Default layout restored.");
  });

  it("makes invalid persisted settings read-only until the user explicitly restores the layout", async () => {
    const invalid = { ...createDefaultGamepadPreferences(), enabled: true, unknownSetting: true };
    store(invalid);
    const container = await renderSettings();
    const enabled = control(container, "Enable gamepad input");
    expect(enabled.disabled).toBe(true);
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    expect([...container.querySelectorAll<HTMLButtonElement>("[role='combobox']")].every((node) => node.disabled)).toBe(true);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Saved gamepad settings are invalid");
    expect(JSON.parse(required(window.localStorage.getItem(GAMEPAD_PREFERENCES_KEY)))).toEqual(invalid);

    const restore = button(container, "Restore default layout");
    expect(restore.disabled).toBe(false);
    await act(async () => restore.click());
    expect(readGamepadPreferences()).toEqual({ preferences: createDefaultGamepadPreferences() });
    expect(enabled.disabled).toBe(false);
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("[role='combobox']")].every((node) => !node.disabled)).toBe(true);
  });

  it("applies another window's committed preferences and invalidation without retaining stale success feedback", async () => {
    const container = await renderSettings();
    const enabled = control(container, "Enable gamepad input");
    await act(async () => enabled.click());
    expect(container.textContent).toContain("Gamepad settings saved.");
    const current = createDefaultGamepadPreferences();
    store({ ...current, rightStick: { ...current.rightStick, mode: "disabled" } });
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: GAMEPAD_PREFERENCES_KEY, storageArea: window.localStorage })));
    expect(enabled.getAttribute("aria-checked")).toBe("false");
    expect(control(container, "Right stick mode").textContent).toBe("Disabled");
    expect(container.textContent).not.toContain("Gamepad settings saved.");

    store({ ...current, buttons: [] });
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: GAMEPAD_PREFERENCES_KEY, storageArea: window.localStorage })));
    expect(enabled.disabled).toBe(true);
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Saved gamepad settings are invalid");
  });
});
