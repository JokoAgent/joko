// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FontFamilySetting } from "./SettingsPage.js";

const translations: Record<string, string> = {
  "settings.appearance.fontApply": "Apply",
  "settings.appearance.fontCustom": "Custom font family",
  "settings.appearance.fontCustomPlaceholder": "For example: Inter, sans-serif",
  "settings.appearance.fontDefault": "System default",
  "settings.appearance.fontPresets": "Presets",
  "settings.appearance.fontReset": "Reset"
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
  it("lets a default-font user select and apply a custom family", async () => {
    const onChange = vi.fn(async () => undefined);
    const container = await renderSetting(<FontFamilySetting
      label="Code font"
      description="Code typography"
      value=""
      presets={[
        { id: "default", label: "System default", family: "" },
        { id: "mono", label: "Mono", family: "Consolas" }
      ]}
      preview="const value = 1;"
      fallback="monospace"
      onChange={onChange}
      t={t}
    />);

    await act(async () => required(container.querySelector<HTMLButtonElement>('button[aria-label="Code font"]')).click());
    const panel = await openFontPanel();
    const input = required(panel.querySelector<HTMLInputElement>('input[aria-label="Custom font family"]'));
    await act(async () => {
      setInputValue(input, '"Fira Code"');
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => buttonWithText(panel, "Apply").click());
    expect(onChange).toHaveBeenCalledWith('"Fira Code"');
  });

  it("focuses the selected preset and persists a new choice", async () => {
    const onChange = vi.fn(async () => undefined);
    const container = await renderSetting(<FontFamilySetting
      label="Code font"
      description="Code typography"
      value=""
      presets={[
        { id: "default", label: "System default", family: "" },
        { id: "mono", label: "Mono", family: "Consolas" }
      ]}
      preview="const value = 1;"
      previewLanguage="typescript"
      fallback="monospace"
      onChange={onChange}
      t={t}
    />);

    await act(async () => required(container.querySelector<HTMLButtonElement>('button[aria-label="Code font"]')).click());
    const panel = await openFontPanel();
    await vi.waitFor(() => expect(document.activeElement).toBe(buttonWithText(panel, "System default")));
    const mono = buttonWithText(panel, "Mono");
    await act(async () => {
      mono.focus();
    });
    await act(async () => mono.click());
    expect(onChange).toHaveBeenCalledWith("Consolas");
  });
});

async function renderSetting(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
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
