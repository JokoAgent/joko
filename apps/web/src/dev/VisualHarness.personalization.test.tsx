// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualHarness } from "./VisualHarness.js";
import { VisionBackendSelector } from "../components/VisionBridgeSection.js";
import type { AppSnapshot } from "../model.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, "", "/__visual-harness__?scenario=personalization&theme=light#/settings/personalization");
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
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Personalization visual harness", () => {
  it("keeps a configured but currently unavailable backend visible by its typed identity", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<VisionBackendSelector
      label="Primary"
      emptyLabel="None selected"
      searchPlaceholder="Search models…"
      noResultsLabel="No matching models"
      value={{ backendId: "retired-backend", providerId: "retired-provider", modelId: "retired-model" }}
      candidates={[]}
      backendNames={new Map([["retired-backend", "Retired Backend"]])}
      disabled={false}
      onChange={vi.fn()}
    />));

    const trigger = required(container.querySelector<HTMLButtonElement>(".vision-backend-selector__trigger"));
    expect(trigger.textContent).toContain("retired-model");
    expect(trigger.getAttribute("aria-label")).toContain("retired-provider · Retired Backend · retired-model");
    expect(trigger.querySelector("small")).toBeNull();
    expect(trigger.querySelector(".vision-backend-selector__source-mark")?.textContent).toBe("R");
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(selectorRect(20, 428, 200, 40));
    await act(async () => trigger.click());
    const popover = required(document.querySelector<HTMLElement>(".vision-backend-selector__popover"));
    Object.defineProperty(popover, "scrollHeight", { configurable: true, value: 140 });
    await flushFrame();
    expect(popover.style.top).toBe("472px");
    expect(popover.style.bottom).toBe("");
  });

  it("keeps duplicate Provider models from different Backend instances distinct", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const onChange = vi.fn();
    const backendNames = new Map([["backend-a", "Alpha Backend"], ["backend-b", "Beta Backend"]]);
    const candidates: AppSnapshot["models"] = [
      model("backend-a", "provider", "Provider", "same-model"),
      model("backend-b", "provider", "Provider", "same-model")
    ];
    await act(async () => root.render(<VisionBackendSelector
      label="Primary"
      emptyLabel="None selected"
      searchPlaceholder="Search models…"
      noResultsLabel="No matching models"
      value={{ backendId: "backend-a", providerId: "provider", modelId: "same-model" }}
      candidates={candidates}
      backendNames={backendNames}
      disabled={false}
      onChange={onChange}
    />));
    const trigger = required(container.querySelector<HTMLButtonElement>(".vision-backend-selector__trigger"));
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(selectorRect(20, 460, 280, 40));
    await act(async () => trigger.click());
    await flushFrame();
    const search = required(document.querySelector<HTMLInputElement>('input[aria-label="Search models…"]'));
    expect(document.activeElement).toBe(search);
    const duplicatePopover = required(search.closest<HTMLElement>(".vision-backend-selector__popover"));
    Object.defineProperty(duplicatePopover, "scrollHeight", {
      configurable: true,
      get: () => search.value.length === 0 ? 400 : 140
    });
    await flushFrame();
    expect(duplicatePopover.style.bottom).not.toBe("");
    await act(async () => setNativeValue(search, "same"));
    await flushFrame();
    expect(duplicatePopover.style.top).not.toBe("");
    expect(duplicatePopover.style.bottom).toBe("");
    expect(document.querySelectorAll(".vision-backend-selector__option-main .vision-backend-selector__source-mark"))
      .toHaveLength(2);
    await act(async () => setNativeValue(search, "Beta Backend"));
    expect(document.querySelector('[role="group"][aria-label="Provider · Alpha Backend"]')).toBeNull();
    expect(document.querySelector('[role="group"][aria-label="Provider · Beta Backend"]')).not.toBeNull();
    await act(async () => setNativeValue(search, "same"));
    await pressKey(search, "ArrowDown");
    await pressKey(document.activeElement, "ArrowDown");
    await pressKey(document.activeElement, "Enter");
    expect(onChange).toHaveBeenCalledWith({ backendId: "backend-b", providerId: "provider", modelId: "same-model" });
  });

  it("opens the real Personalization surface with healthy Pi and semantic-index fixtures", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    expect(document.documentElement.dataset.visualHarness).toBe("personalization");
    expect(container.querySelector("#settings-panel-personalization")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>("#settings-tab-personalization")?.getAttribute("aria-selected")).toBe("true");
    const settingsTabs = [...container.querySelectorAll<HTMLButtonElement>('.settings-nav [role="tab"]')];
    expect(settingsTabs.length).toBeGreaterThan(1);
    expect(settingsTabs.filter((tab) => tab.tabIndex === 0)).toEqual([
      container.querySelector("#settings-tab-personalization")
    ]);
    expect(settingsTabs.filter((tab) => tab.tabIndex === -1)).toHaveLength(settingsTabs.length - 1);
    expect(settingsTabs.map((tab) => tab.id)).toEqual([
      "settings-tab-general",
      "settings-tab-personalization",
      "settings-tab-providers",
      "settings-tab-voice",
      "settings-tab-shortcuts",
      "settings-tab-import",
      "settings-tab-connections",
      "settings-tab-tools",
      "settings-tab-automation",
      "settings-tab-about"
    ]);
    const personalizationTab = required(container.querySelector<HTMLButtonElement>("#settings-tab-personalization"));
    await pressKey(personalizationTab, "ArrowDown");
    expect(document.activeElement).toBe(container.querySelector("#settings-tab-providers"));
    expect(container.querySelector("#settings-panel-providers")).not.toBeNull();
    await pressKey(required(container.querySelector<HTMLButtonElement>("#settings-tab-providers")), "Home");
    expect(document.activeElement).toBe(container.querySelector("#settings-tab-general"));
    expect(container.querySelector("#settings-panel-general")).not.toBeNull();
    await pressKey(required(container.querySelector<HTMLButtonElement>("#settings-tab-general")), "End");
    expect(document.activeElement).toBe(container.querySelector("#settings-tab-about"));
    expect(container.querySelector("#settings-panel-about")).not.toBeNull();
    await act(async () => personalizationTab.click());
    const compactionSlider = required(container.querySelector<HTMLInputElement>('input[aria-label="Adjust auto-compaction trigger threshold"]'));
    expect(compactionSlider.value).toBe("75");
    expect(container.querySelector<HTMLOutputElement>(".personalization-range output")?.textContent).toBe("75%");
    expect(controlChecked(required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle chat semantic indexing"]')))).toBe(true);
    expect(controlChecked(required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Maker Memory"]')))).toBe(true);
    expect(controlChecked(required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Visual backend Auto Memory"]')))).toBe(true);
    expect(controlChecked(required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Vision Bridge"]')))).toBe(true);
    expect(controlChecked(required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Vision Bridge for Text Model"]')))).toBe(true);
    expect(controlChecked(required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle prompt recommendations"]')))).toBe(true);
    expect(container.textContent).toContain("voyage/voyage-4");
    expect(container.textContent).toContain("Maker Memory");
    expect(container.textContent).toContain("Vision Bridge");
    expect(container.textContent).toContain("nearby text used as focus hints are sent to the vision backend you choose");
    expect(container.querySelector(".vision-bridge__backend-row select")).toBeNull();
    const primaryBackend = required(container.querySelector<HTMLButtonElement>(
      '.vision-backend-selector__trigger[aria-label^="Primary:"]'
    ));
    let primaryRect = selectorRect(12, 20, 200, 40);
    vi.spyOn(primaryBackend, "getBoundingClientRect").mockImplementation(() => primaryRect);
    await act(async () => primaryBackend.click());
    await flushFrame();
    const primaryListbox = required(document.querySelector<HTMLElement>('[role="listbox"][aria-label="Primary"]'));
    const primaryPopover = required(primaryListbox.closest<HTMLElement>(".vision-backend-selector__popover"));
    expect(primaryPopover.parentElement).toBe(document.body);
    expect(primaryPopover.style.position).toBe("fixed");
    expect(primaryPopover.style.width).toBe("200px");
    expect(primaryPopover.style.left).toBe("12px");
    expect(primaryPopover.style.top).toBe("64px");
    const search = required(primaryPopover.querySelector<HTMLInputElement>('input[aria-label="Search models…"]'));
    expect(search.getAttribute("type")).toBe("search");
    expect(document.querySelector('[role="group"][aria-label="Joko Visual · Visual backend"]')).not.toBeNull();
    expect(primaryPopover.querySelectorAll(".vision-backend-selector__option-main .vision-backend-selector__source-mark")).toHaveLength(1);
    expect(document.activeElement).toBe(search);
    await pressKey(search, "ArrowDown");
    expect((document.activeElement as HTMLElement | null)?.getAttribute("aria-selected")).toBe("true");
    await pressKey(document.activeElement, "Home");
    expect(document.activeElement?.textContent).toContain("None selected");
    await pressKey(document.activeElement, "End");
    expect(document.activeElement?.textContent).toContain("Vision Model");
    await pressKey(document.activeElement, "ArrowUp");
    expect(document.activeElement?.textContent).toContain("None selected");
    await pressKey(document.activeElement, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Vision Model");
    await pressKey(document.activeElement, "Escape");
    expect(document.querySelector('[role="listbox"][aria-label="Primary"]')).toBeNull();
    expect(document.activeElement).toBe(primaryBackend);

    primaryRect = selectorRect(-20, 700, 200, 40);
    await act(async () => primaryBackend.click());
    await flushFrame();
    const reopenedSearch = required(document.querySelector<HTMLInputElement>('input[aria-label="Search models…"]'));
    const reopenedPopover = required(reopenedSearch.closest<HTMLElement>(".vision-backend-selector__popover"));
    expect(reopenedPopover.style.width).toBe("200px");
    expect(reopenedPopover.style.left).toBe("8px");
    expect(reopenedPopover.style.top).toBe("");
    expect(reopenedPopover.style.bottom).not.toBe("");
    const fallbackOption = required(reopenedPopover.querySelector<HTMLElement>(".vision-backend-selector__fallback-option"));
    expect(fallbackOption.compareDocumentPosition(reopenedSearch) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await act(async () => setNativeValue(reopenedSearch, "missing"));
    expect(document.body.textContent).toContain("No matching models");
    expect(reopenedPopover.querySelector(".vision-backend-selector__fallback-option")).not.toBeNull();
    expect(document.querySelector('[role="group"][aria-label="Joko Visual · Visual backend"]')).toBeNull();
    await act(async () => setNativeValue(reopenedSearch, "vision"));
    expect(document.querySelector('[role="group"][aria-label="Joko Visual · Visual backend"]')).not.toBeNull();
    await act(async () => reopenedSearch.focus());
    await pressKey(reopenedSearch, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Vision Model");
    await pressKey(document.activeElement, "Escape");
    expect(document.querySelector('[role="listbox"][aria-label="Primary"]')).toBeNull();

    const backupBackend = required(container.querySelector<HTMLButtonElement>(
      '.vision-backend-selector__trigger[aria-label^="Backup:"]'
    ));
    expect(backupBackend.querySelector(".vision-backend-selector__source-mark")).toBeNull();
    await act(async () => backupBackend.click());
    await flushFrame();
    await pressKey(document.activeElement, "ArrowDown");
    await pressKey(document.activeElement, "End");
    await pressKey(document.activeElement, "Enter");
    expect(document.querySelector('[role="listbox"][aria-label="Backup"]')).toBeNull();
    expect(document.activeElement).toBe(backupBackend);
    await act(async () => backupBackend.click());
    await flushFrame();
    await pressKey(document.activeElement, "Tab");
    expect(document.querySelector('[role="listbox"][aria-label="Backup"]')).not.toBeNull();
    expect((document.activeElement as HTMLElement | null)?.getAttribute("role")).toBe("option");
    await pressKey(document.activeElement, "Tab");
    expect(document.querySelector('[role="listbox"][aria-label="Backup"]')).toBeNull();
    await act(async () => backupBackend.click());
    await flushFrame();
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.querySelector('[role="listbox"][aria-label="Backup"]')).toBeNull();
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("opens Pi as a General nested page without adding browser history", async () => {
    window.history.replaceState(null, "", "/__visual-harness__?scenario=personalization&theme=light#/settings/general");
    const initialHistoryLength = window.history.length;
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    expect(container.querySelector<HTMLButtonElement>("#settings-tab-general")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("#settings-subsection-appearance")).not.toBeNull();
    expect(container.querySelector("#settings-subsection-policy")).not.toBeNull();
    const piEntry = required(container.querySelector<HTMLButtonElement>(".settings-row-link"));
    expect(piEntry.textContent).toContain("Pi resources");

    await act(async () => piEntry.click());
    await flushFrame();
    expect(window.location.hash).toBe("#/settings/general/pi");
    expect(window.history.length).toBe(initialHistoryLength);
    expect(container.querySelector<HTMLButtonElement>("#settings-tab-general")?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".settings-nested-back")).not.toBeNull();
    expect(container.querySelector("#settings-subsection-appearance")).toBeNull();
    expect(container.textContent).toContain("Managed resources");

    await act(async () => required(container.querySelector<HTMLButtonElement>(".settings-nested-back")).click());
    await flushFrame();
    expect(window.location.hash).toBe("#/settings/general");
    expect(window.history.length).toBe(initialHistoryLength);
    expect(container.querySelector("#settings-subsection-appearance")).not.toBeNull();
  });

  it("uses a settings index instead of a horizontally scrolling tab strip on compact screens", async () => {
    window.history.replaceState(null, "", "/__visual-harness__?scenario=personalization&theme=light#/settings");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === "(max-width: 720px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true)
      }))
    });
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    const page = required(container.querySelector<HTMLElement>(".settings-page"));
    expect(page.dataset.mobileMode).toBe("index");
    expect(container.querySelectorAll('.settings-nav [role="tab"]')).toHaveLength(10);

    await act(async () => required(container.querySelector<HTMLButtonElement>("#settings-tab-providers")).click());
    await flushFrame();
    expect(page.dataset.mobileMode).toBe("detail");
    expect(window.location.hash).toBe("#/settings/providers");
    expect(container.querySelector<HTMLButtonElement>(".settings-back")?.getAttribute("aria-label")).toBe("Back to all settings");

    await act(async () => required(container.querySelector<HTMLButtonElement>(".settings-back")).click());
    await flushFrame();
    expect(page.dataset.mobileMode).toBe("index");
    expect(window.location.hash).toBe("#/settings");
  });

  it("keeps prompt, link, motion, message navigation, and Pi mutations live in memory", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    await renderHarness(container);

    const prompt = required(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Custom instructions"]'));
    await act(async () => setNativeValue(prompt, "Prefer concise, evidence-backed answers."));
    const save = buttonWithText(container, "Save");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await flushFrame();
    expect(document.documentElement.dataset.harnessLastAction).toBe("personalization-prompt:set");
    expect(buttonWithText(container, "Save").disabled).toBe(true);
    expect(required(container.querySelector<HTMLElement>(".settings-success-notification")).textContent).toContain("Custom instructions saved");

    const external = buttonWithText(container, "System browser");
    await act(async () => external.click());
    expect(external.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.dataset.harnessLastAction).toBe("link-open:external");

    const streamFade = required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle streaming fade-in motion"]'));
    await act(async () => streamFade.click());
    expect(controlChecked(streamFade)).toBe(false);
    expect(document.documentElement.dataset.harnessLastAction).toBe("stream-fade:off");

    const messageRail = required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle question navigation rail"]'));
    await act(async () => messageRail.click());
    expect(controlChecked(messageRail)).toBe(false);
    expect(document.documentElement.dataset.harnessLastAction).toBe("message-nav-rail:off");

    const encryptedRetry = required(container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle silently dropping protocol-encrypted content and retrying"]'
    ));
    expect(controlChecked(encryptedRetry)).toBe(true);
    await act(async () => encryptedRetry.click());
    await flushFrame();
    expect(controlChecked(encryptedRetry)).toBe(false);
    expect(document.documentElement.dataset.harnessLastAction).toBe("silent-encrypted-retry:off");
    expect(required(container.querySelector<HTMLElement>(".settings-success-notification")).textContent).toContain("Silent encrypted-content retry is off.");

    const makerReset = required(container.querySelector<HTMLButtonElement>('button[aria-label="Reset Maker Memory?"]'));
    await act(async () => makerReset.click());
    await act(async () => buttonWithText(document.body, "Reset memory").click());
    expect(document.documentElement.dataset.harnessLastAction).toBe("memory:reset:curated");
    expect(controlChecked(required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Visual backend Auto Memory"]')))).toBe(true);

    const backendReset = required(container.querySelector<HTMLButtonElement>('button[aria-label="Reset Visual backend Auto Memory?"]'));
    await act(async () => backendReset.click());
    await act(async () => buttonWithText(document.body, "Reset memory").click());
    expect(document.documentElement.dataset.harnessLastAction).toBe("memory:reset:backend");
    expect(controlChecked(required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Maker Memory"]')))).toBe(true);

    const makerMemory = required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Maker Memory"]'));
    await act(async () => makerMemory.click());
    expect(controlChecked(makerMemory)).toBe(false);
    expect(document.documentElement.dataset.harnessLastAction).toBe("memory:update");

    const visionBridge = required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle Vision Bridge"]'));
    await act(async () => visionBridge.click());
    await flushFrame();
    expect(controlChecked(visionBridge)).toBe(false);
    expect(document.documentElement.dataset.harnessLastAction).toBe("vision-bridge:update");

    const promptRecommendation = required(container.querySelector<HTMLButtonElement>('button[aria-label="Toggle prompt recommendations"]'));
    await act(async () => promptRecommendation.click());
    expect(controlChecked(promptRecommendation)).toBe(false);
    expect(document.documentElement.dataset.harnessLastAction).toBe("prompt-recommendation:off");

    const threshold = required(container.querySelector<HTMLInputElement>('input[aria-label="Adjust auto-compaction trigger threshold"]'));
    await act(async () => setNativeValue(threshold, "82"));
    expect(container.querySelector<HTMLOutputElement>(".personalization-range output")?.textContent).toBe("82%");
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 350)));
    expect(document.documentElement.dataset.harnessLastAction).toBe("pi-settings:visual-backend:82");
    expect(required(container.querySelector<HTMLInputElement>('input[aria-label="Adjust auto-compaction trigger threshold"]')).value).toBe("82");
  });
});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected the visual fixture control to exist.");
  return value;
}

function controlChecked(control: HTMLElement): boolean {
  return control.getAttribute("aria-checked") === "true";
}

function selectorRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({ left, top, width, height })
  } as DOMRect;
}

function model(backendId: string, providerId: string, providerName: string, modelId: string): AppSnapshot["models"][number] {
  return {
    backendId,
    providerId,
    providerName,
    modelId,
    name: "Same Model",
    available: true,
    supportsImages: true,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsFast: false,
    efforts: [],
    contextWindow: 32_768,
    maximumOutputTokens: 4_096,
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
    currencyCode: "USD"
  };
}

async function renderHarness(container: HTMLElement): Promise<void> {
  // Warm the lazy route module, then let React flush the Suspense boundary in
  // the same act scope used for the first visual frame.
  await import("../components/SettingsPage.js");
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<VisualHarness />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected a button labelled ${text}.`);
  return button;
}

function setNativeValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) throw new Error("The visual control value setter is unavailable.");
  setter.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

async function pressKey(target: EventTarget | null, key: string): Promise<void> {
  if (target === null) throw new Error(`Expected a keyboard target for ${key}.`);
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  await flushFrame();
}

async function flushFrame(): Promise<void> {
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 24)));
}
