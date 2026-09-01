// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualHarness } from "./VisualHarness.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/__visual-harness__?scenario=voice&theme=light#/settings/voice");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    }))
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Voice input visual harness", () => {
  it("mounts the configured service and persists rich dictionary edits", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    expect(document.documentElement.dataset.visualHarness).toBe("voice");
    expect(container.querySelector("#settings-panel-voice")).not.toBeNull();
    expect(required(container.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="Transcription protocol"]')).textContent)
      .toContain("OpenAI-compatible realtime");
    expect(container.textContent).toContain("gpt-realtime-whisper · OpenAI-compatible realtime");

    const input = required(container.querySelector<HTMLInputElement>('[aria-label="New dictionary term"]'));
    await act(async () => {
      setInput(input, "GraphQL");
    });
    const add = buttonWithText(container, "Add term");
    expect(add.disabled).toBe(false);
    await act(async () => add.click());
    expect(container.textContent).toContain("GraphQL");
    expect(container.textContent).toContain("Manual (1)");
  });
});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected the voice input fixture control to exist.");
  return value;
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected a button labelled ${text}.`);
  return button;
}

async function renderHarness(container: HTMLElement): Promise<void> {
  await import("../components/SettingsPage.js");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
