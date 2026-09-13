// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualHarness } from "./VisualHarness.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  setViewport(1_440, 960);
  window.history.replaceState(null, "", "/__visual-harness__?scenario=connection&theme=light");
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("max-width") ? window.innerWidth <= Number(query.match(/\d+/u)?.[0] ?? 0) : false,
      media: query,
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
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(window, "isSecureContext");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("Connection visual harness", () => {
  it("mounts the wide light connection route and exercises deterministic recovery actions", async () => {
    const container = await renderHarness();

    expect(document.documentElement.dataset.visualHarness).toBe("connection");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(container.querySelector(".connection-screen")).not.toBeNull();
    expect(container.querySelector(".local-connection-card[data-state='recoveryRequired']")).not.toBeNull();
    expect(container.querySelector(".profile-list")?.textContent).toContain("Studio node");
    expect(container.querySelector(".connection-card > .error-banner")?.textContent)
      .toContain("The saved node rejected this connection");

    const discoveryTab = required(container.querySelectorAll<HTMLButtonElement>(".connection-tabs > button")[0]);
    await activateFocusedButton(discoveryTab);
    expect(container.querySelector(".discovery-card")?.textContent).toContain("Nearby review node");
    expect(container.querySelector(".discovery-panel .error-banner")?.textContent)
      .toContain("Nearby node discovery timed out");

    const refresh = required(container.querySelector<HTMLButtonElement>(".discovery-panel__header button"));
    await activateFocusedButton(refresh);
    expect(document.documentElement.dataset.harnessLastAction).toBe("connection-discovery-refresh");

    const recoveryActions = [...container.querySelectorAll<HTMLButtonElement>(".local-connection-card__actions button")];
    await activateFocusedButton(required(recoveryActions[0]));
    expect(document.documentElement.dataset.harnessLastAction).toBe("retry-managed");

    await activateFocusedButton(required(recoveryActions[1]));
    const form = required(container.querySelector<HTMLFormElement>(".pair-form"));
    const origin = required(form.querySelector<HTMLInputElement>('input[type="url"]'));
    const code = required(form.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]'));
    expect(origin.value).toBe("http://127.0.0.1:4318");

    await act(async () => {
      setNativeValue(code, "PAIR-CODE");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    code.focus();
    expect(document.activeElement).toBe(code);
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);

    await act(async () => {
      code.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      form.requestSubmit();
      code.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(document.documentElement.dataset.harnessLastAction).toBe("connection-pair:automatic");
  });

});

async function renderHarness(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 24));
  });
  return container;
}

async function activateFocusedButton(button: HTMLButtonElement): Promise<void> {
  button.focus();
  await act(async () => {
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    // jsdom does not implement the browser's Enter-to-click default action.
    button.click();
    button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: height });
}

function setNativeValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Expected the visual connection input value setter.");
  setter.call(element, value);
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected the connection visual fixture element.");
  return value;
}
