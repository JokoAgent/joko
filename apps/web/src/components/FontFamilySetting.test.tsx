// @vitest-environment jsdom

import { act, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FontFamilySetting } from "./SettingsPage.js";

const translations: Record<string, string> = {
  "settings.appearance.fontApply": "Apply",
  "settings.appearance.fontCustom": "Custom font family",
  "settings.appearance.fontCustomPlaceholder": "For example: Inter, sans-serif",
  "settings.appearance.fontDefault": "System default",
  "settings.appearance.fontSaveFailed": "Could not save the font setting.",
  "settings.appearance.fontPresets": "Presets",
  "settings.appearance.fontReset": "Reset",
  "settings.defaults.restored": "Restored default settings",
  "settings.saved": "Saved",
  "common.working": "Working"
};

const t = ((key: string) => translations[key] ?? key) as Parameters<typeof FontFamilySetting>[0]["t"];
const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: true,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })));
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("FontFamilySetting", () => {
  it("keeps a failed custom draft retryable, ignores IME Enter, and closes once after a successful Enter retry", async () => {
    const failed = deferred<void>();
    const retried = deferred<void>();
    const save = vi.fn()
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => retried.promise);
    const onSuccess = vi.fn();
    const container = await renderSetting(<FontSettingHarness save={save} onSuccess={onSuccess} />);
    const trigger = required(container.querySelector<HTMLButtonElement>('button[aria-label="Code font"]'));
    const reset = required(container.querySelector<HTMLButtonElement>('button[aria-label="Reset"]'));
    await act(async () => trigger.click());
    const panel = await openFontPanel();
    const input = required(panel.querySelector<HTMLInputElement>('input[aria-label="Custom font family"]'));
    await act(async () => {
      setInputValue(input, '"Fira Code"');
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true, isComposing: true
    })));
    const legacyComposition = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(legacyComposition, "keyCode", { value: 229 });
    await act(async () => input.dispatchEvent(legacyComposition));
    expect(save).not.toHaveBeenCalled();

    const apply = buttonWithText(panel, "Apply");
    await act(async () => {
      apply.click();
      apply.click();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith('"Fira Code"');
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(reset.disabled).toBe(true);
    expect(reset.getAttribute("aria-busy")).toBe("true");
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect(apply.disabled).toBe(true);
    expect([...panel.querySelectorAll<HTMLButtonElement>('[role="option"]')].every((option) => option.disabled)).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Working");
    expect(panel.dataset.state).toBe("open");

    await act(async () => failed.reject(new Error("storage unavailable")));
    expect(panel.dataset.state).toBe("open");
    expect(input.value).toBe('"Fira Code"');
    expect(required(panel.querySelector<HTMLElement>(".appearance-font-preview")).style.fontFamily).toBe("monospace");
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save the font setting.");
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true
    })));
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => retried.resolve());
    await vi.waitFor(() => expect(document.body.querySelector('.appearance-font-picker__panel[data-state="open"]')).toBeNull());
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith("Saved");
    expect(document.activeElement).toBe(trigger);
  });

  it("single-flights a preset and an open-panel reset with pending state, success feedback, and trigger focus", async () => {
    const preset = deferred<void>();
    const resetSave = deferred<void>();
    const save = vi.fn()
      .mockImplementationOnce(() => preset.promise)
      .mockImplementationOnce(() => resetSave.promise);
    const onSuccess = vi.fn();
    const container = await renderSetting(<FontSettingHarness save={save} onSuccess={onSuccess} />);
    const trigger = required(container.querySelector<HTMLButtonElement>('button[aria-label="Code font"]'));
    await act(async () => trigger.click());
    let panel = await openFontPanel();
    const mono = buttonWithText(panel, "Mono");
    await act(async () => {
      mono.click();
      mono.click();
      trigger.click();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith("Consolas");
    expect(panel.dataset.state).toBe("open");
    await act(async () => preset.resolve());
    await vi.waitFor(() => expect(document.body.querySelector('.appearance-font-picker__panel[data-state="open"]')).toBeNull());
    expect(onSuccess).toHaveBeenLastCalledWith("Saved");
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    panel = await openFontPanel();
    const reset = required(container.querySelector<HTMLButtonElement>('button[aria-label="Reset"]'));
    await act(async () => {
      reset.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
      reset.click();
      reset.click();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("");
    expect(panel.dataset.state).toBe("open");
    expect(reset.disabled).toBe(true);
    expect(reset.getAttribute("aria-busy")).toBe("true");
    await act(async () => resetSave.resolve());
    await vi.waitFor(() => expect(document.body.querySelector('.appearance-font-picker__panel[data-state="open"]')).toBeNull());
    expect(onSuccess.mock.calls.map(([message]) => message)).toEqual(["Saved", "Restored default settings"]);
    expect(document.activeElement).toBe(trigger);
  });

  it("retires late font feedback across action replacement and unmount without cancelling either mutation", async () => {
    const stale = deferred<void>();
    const afterUnmount = deferred<void>();
    const firstSave = vi.fn(() => stale.promise);
    const secondSave = vi.fn(() => afterUnmount.promise);
    const onSuccess = vi.fn();
    const mounted = await mountSetting(<FontSettingHarness save={firstSave} onSuccess={onSuccess} />);
    const trigger = required(mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Code font"]'));
    await act(async () => trigger.click());
    let panel = await openFontPanel();
    await act(async () => buttonWithText(panel, "Mono").click());
    expect(firstSave).toHaveBeenCalledOnce();

    await act(async () => mounted.root.render(<FontSettingHarness save={secondSave} onSuccess={onSuccess} />));
    panel = await openFontPanel();
    await act(async () => buttonWithText(panel, "Mono").click());
    expect(secondSave).toHaveBeenCalledOnce();
    await act(async () => stale.reject(new Error("late owner failure")));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    expect(required(mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Code font"]')).disabled).toBe(true);
    expect(panel.dataset.state).toBe("open");

    await act(async () => mounted.root.render(<></>));
    await act(async () => afterUnmount.resolve());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(firstSave).toHaveBeenCalledOnce();
    expect(secondSave).toHaveBeenCalledOnce();
  });
});

function FontSettingHarness({ save, onSuccess }: {
  readonly save: (family: string) => Promise<void>;
  readonly onSuccess: (message: string) => void;
}): ReactElement {
  const [value, setValue] = useState("");
  const valueRef = useRef(value);
  const saveOwnerRef = useRef(save);
  valueRef.current = value;
  saveOwnerRef.current = save;
  useEffect(() => {
    valueRef.current = "";
    setValue("");
  }, [save]);
  const onChange = useCallback(async (family: string): Promise<void> => {
    const previous = valueRef.current;
    valueRef.current = family;
    setValue(family);
    try {
      await save(family);
    } catch (error) {
      if (saveOwnerRef.current === save) {
        valueRef.current = previous;
        setValue(previous);
      }
      throw error;
    }
  }, [save]);
  return <FontFamilySetting
    label="Code font"
    description="Code typography"
    value={value}
    presets={[
      { id: "default", label: "System default", family: "" },
      { id: "mono", label: "Mono", family: "Consolas" }
    ]}
    preview="const value = 1;"
    previewLanguage="typescript"
    fallback="monospace"
    onChange={onChange}
    onSuccess={onSuccess}
    t={t}
  />;
}

async function renderSetting(element: ReactElement): Promise<HTMLElement> {
  return (await mountSetting(element)).container;
}

async function mountSetting(element: ReactElement): Promise<{ readonly container: HTMLElement; readonly root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected element.");
  return value;
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === text);
  return required(button ?? null);
}

async function openFontPanel(): Promise<HTMLElement> {
  return vi.waitFor(() => required(document.body.querySelector<HTMLElement>('.appearance-font-picker__panel[data-state="open"]')));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Input value setter is unavailable.");
  setter.call(input, value);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve: (value?: T) => resolve(value as T), reject };
}
