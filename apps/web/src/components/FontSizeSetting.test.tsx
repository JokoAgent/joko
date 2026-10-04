// @vitest-environment jsdom

import { act, useCallback, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FontSizeSetting } from "./SettingsPage.js";

const translations: Record<string, string> = {
  "settings.appearance.fontReset": "Reset",
  "settings.appearance.fontSaveFailed": "Could not save the font setting.",
  "settings.defaults.restored": "Restored default settings",
  "settings.saved": "Saved",
  "common.working": "Working"
};

const t = ((key: string) => translations[key] ?? key) as Parameters<typeof FontSizeSetting>[0]["t"];
const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("FontSizeSetting", () => {
  it("keeps a numeric draft local and commits normalized input once on non-IME Enter plus blur", async () => {
    const save = vi.fn(async () => undefined);
    const onSuccess = vi.fn();
    const container = await renderSetting(<FontSizeHarness save={save} onSuccess={onSuccess} />);
    const number = required(container.querySelector<HTMLInputElement>('input[type="number"]'));

    await input(number, "99");
    expect(number.value).toBe("99");
    expect(save).not.toHaveBeenCalled();

    await act(async () => number.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true, isComposing: true
    })));
    const legacyComposition = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(legacyComposition, "keyCode", { value: 229 });
    await act(async () => number.dispatchEvent(legacyComposition));
    expect(save).not.toHaveBeenCalled();

    await act(async () => number.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true
    })));
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenLastCalledWith(24);
    await vi.waitFor(() => expect(number.value).toBe("24"));
    expect(onSuccess).toHaveBeenCalledWith("Saved");

    await input(number, "24.4");
    await act(async () => number.blur());
    expect(save).toHaveBeenCalledOnce();
    expect(number.value).toBe("24");

    await input(number, "");
    await act(async () => number.blur());
    expect(save).toHaveBeenCalledOnce();
    expect(number.value).toBe("24");

    await input(number, "1e999");
    await act(async () => number.blur());
    expect(save).toHaveBeenCalledOnce();
    expect(number.value).toBe("24");
  });

  it("keeps the range live while overlapping saves settle and preserves the latest intent", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const save = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onSuccess = vi.fn();
    const container = await renderSetting(<FontSizeHarness save={save} onSuccess={onSuccess} />);
    const range = required(container.querySelector<HTMLInputElement>('input[type="range"]'));
    const number = required(container.querySelector<HTMLInputElement>('input[type="number"]'));
    const reset = required(container.querySelector<HTMLButtonElement>('button[aria-label="Reset"]'));

    await input(range, "16");
    await input(range, "18");
    expect(save.mock.calls.map(([size]) => size)).toEqual([16, 18]);
    expect(range.value).toBe("18");
    expect(range.disabled).toBe(false);
    expect(range.getAttribute("aria-busy")).toBe("true");
    expect(number.disabled).toBe(true);
    expect(number.getAttribute("aria-busy")).toBe("true");
    expect(reset.disabled).toBe(true);
    expect(reset.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Working");

    await act(async () => second.resolve());
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Working");
    expect(onSuccess).not.toHaveBeenCalled();
    await act(async () => first.resolve());
    await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
    expect(range.value).toBe("18");
    expect(number.value).toBe("18");
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith("Saved");
  });

  it("restores the authoritative value after failure and reports a successful default reset", async () => {
    const failed = deferred<void>();
    const retried = deferred<void>();
    const save = vi.fn()
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => retried.promise);
    const onSuccess = vi.fn();
    const container = await renderSetting(<FontSizeHarness initial={18} save={save} onSuccess={onSuccess} />);
    const reset = required(container.querySelector<HTMLButtonElement>('button[aria-label="Reset"]'));
    await act(async () => reset.click());
    expect(save).toHaveBeenCalledWith(14);
    await act(async () => failed.reject(new Error("storage unavailable")));
    await vi.waitFor(() => expect(required(container.querySelector<HTMLInputElement>('input[type="number"]')).value).toBe("18"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save the font setting.");
    expect(onSuccess).not.toHaveBeenCalled();

    await act(async () => reset.click());
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => retried.resolve());
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledWith("Restored default settings"));
    expect(required(container.querySelector<HTMLInputElement>('input[type="number"]')).value).toBe("14");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("retires late feedback across action replacement and unmount without cancelling mutations", async () => {
    const stale = deferred<void>();
    const afterUnmount = deferred<void>();
    const firstSave = vi.fn(() => stale.promise);
    const secondSave = vi.fn(() => afterUnmount.promise);
    const onSuccess = vi.fn();
    const mounted = await mountSetting(<FontSizeHarness initial={14} save={firstSave} onSuccess={onSuccess} />);
    let range = required(mounted.container.querySelector<HTMLInputElement>('input[type="range"]'));
    await input(range, "16");
    expect(firstSave).toHaveBeenCalledOnce();

    await act(async () => mounted.root.render(<FontSizeHarness initial={14} save={secondSave} onSuccess={onSuccess} />));
    await act(async () => stale.reject(new Error("late owner failure")));
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();

    range = required(mounted.container.querySelector<HTMLInputElement>('input[type="range"]'));
    await input(range, "17");
    expect(secondSave).toHaveBeenCalledOnce();
    await act(async () => mounted.root.render(<></>));
    await act(async () => afterUnmount.resolve());
    expect(onSuccess).not.toHaveBeenCalled();
    expect(firstSave).toHaveBeenCalledOnce();
    expect(secondSave).toHaveBeenCalledOnce();
  });
});

function FontSizeHarness({ initial = 14, save, onSuccess }: {
  readonly initial?: number;
  readonly save: (size: number) => Promise<void>;
  readonly onSuccess: (message: string) => void;
}): ReactElement {
  const [value, setValue] = useState(initial);
  const valueRef = useRef(value);
  const saveOwnerRef = useRef(save);
  valueRef.current = value;
  saveOwnerRef.current = save;
  const onChange = useCallback(async (next: number): Promise<void> => {
    const previous = valueRef.current;
    valueRef.current = next;
    setValue(next);
    try {
      await save(next);
    } catch (error) {
      if (saveOwnerRef.current === save) {
        valueRef.current = previous;
        setValue(previous);
      }
      throw error;
    }
  }, [save]);
  return <FontSizeSetting
    label="Interface font size"
    description="Interface typography"
    value={value}
    min={12}
    max={24}
    defaultValue={14}
    normalize={(size) => Number.isFinite(size) ? Math.min(24, Math.max(12, Math.round(size))) : 14}
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

async function input(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    element.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("Input value setter is unavailable.");
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected element.");
  return value;
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
