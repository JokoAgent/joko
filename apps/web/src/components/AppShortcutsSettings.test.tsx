// @vitest-environment jsdom

import { act, useMemo, useState, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { AppShortcutId, AppShortcutOverrideValue, AppShortcutOverrides } from "../app-shortcuts.js";
import { AppShortcutsSettings, appShortcutRecordingDecision } from "./AppShortcutsSettings.js";

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

describe("application shortcut settings", () => {
  it("renders accessible editors for executable shortcuts while keeping delegated actions hidden", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<AppShortcutsSettings
      controller={{
        setAppShortcutOverride: async () => {},
        resetAppShortcutOverrides: async () => {}
      } as unknown as AppController}
      overrides={{}}
      platform="linux"
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.querySelector("h2")?.textContent).toBe("Keyboard shortcuts");
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    expect(container.querySelectorAll('[aria-label^="Edit shortcut for "]')).toHaveLength(14);
    expect(container.textContent).toContain("Focus address bar");
    expect(container.textContent).toContain("Reload page");
    expect(container.textContent).not.toContain("Save file");
    expect(container.textContent).not.toContain("Open settings");
  });

  it("models wait, unchanged, validation, conflict, and commit recording outcomes", () => {
    expect(appShortcutRecordingDecision("find-in-page", key({ code: "ControlLeft", key: "Control" }), {}, "win32")).toEqual({ kind: "wait" });
    expect(appShortcutRecordingDecision("find-in-page", key(), {}, "win32")).toEqual({ kind: "unchanged" });
    expect(appShortcutRecordingDecision("find-in-page", key({ code: "KeyQ", key: "q", ctrlKey: false }), {}, "win32")).toEqual({
      kind: "reject",
      issue: { kind: "not-bindable" }
    });
    expect(appShortcutRecordingDecision("find-in-page", key({ shiftKey: true }), {}, "win32")).toEqual({
      kind: "reject",
      issue: { kind: "conflict", conflictingId: "search-in-project" }
    });
    expect(appShortcutRecordingDecision("find-in-page", key({ code: "KeyG", key: "g" }), {}, "win32")).toMatchObject({
      kind: "commit",
      combo: { code: "KeyG", ctrl: true }
    });
    expect(appShortcutRecordingDecision("find-in-page", key({ code: "KeyM", key: "m" }), {}, "win32", {
      code: "KeyM", key: "m", meta: false, ctrl: true, alt: false, shift: false, fn: false
    })).toEqual({ kind: "reject", issue: { kind: "voice-conflict" } });
    expect(appShortcutRecordingDecision("find-in-page", key({ code: "KeyM", key: "m" }), {}, "win32", {
      code: "KeyM", key: "m", meta: false, ctrl: true, alt: false, shift: false, fn: true
    })).toMatchObject({ kind: "commit" });
    expect(appShortcutRecordingDecision("new-maker", key({
      code: "NumpadAdd", key: "+", ctrlKey: false, metaKey: true
    }), {}, "darwin")).toEqual({ kind: "reject", issue: { kind: "menu-inexpressible" } });
  });

  it("restores keyboard focus after per-item and whole-page defaults remove their action buttons", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ShortcutHarness />));

    const resetFind = required(container.querySelector<HTMLButtonElement>('[aria-label="Restore default shortcut for Find in page"]'));
    resetFind.focus();
    await act(async () => resetFind.click());
    expect(container.querySelector('[aria-label="Restore default shortcut for Find in page"]')).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit shortcut for Find in page");

    const resetAll = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Restore all defaults");
    required(resetAll).focus();
    await act(async () => required(resetAll).click());
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Restore all defaults")).toBe(false);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Edit shortcut for New session");
  });
});

function ShortcutHarness(): JSX.Element {
  const [overrides, setOverrides] = useState<AppShortcutOverrides>({
    "find-in-page": combo("KeyG", "g"),
    "search-in-project": combo("KeyH", "h")
  });
  const controller = useMemo(() => ({
    setAppShortcutOverride: async (id: AppShortcutId, value: AppShortcutOverrideValue | undefined): Promise<void> => {
      setOverrides((current) => {
        const next = { ...current };
        if (value === undefined) delete next[id];
        else next[id] = value;
        return next;
      });
    },
    resetAppShortcutOverrides: async (): Promise<void> => setOverrides({})
  } as unknown as AppController), []);
  return <AppShortcutsSettings
    controller={controller}
    overrides={overrides}
    platform="win32"
    t={(key, values) => translate("en", key, values)}
  />;
}

function combo(code: string, key: string) {
  return { code, key, meta: false, ctrl: true, alt: false, shift: false } as const;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered shortcut control.");
  return value;
}

function key(overrides: Partial<Pick<KeyboardEvent,
  "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>> = {}) {
  return {
    code: "KeyF",
    key: "f",
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    ...overrides
  };
}
