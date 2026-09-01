// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import {
  addModelFavorite,
  readModelPickerOwnerPreferences,
  resetModelPickerPreferencesForTests,
  providerPreferenceKey,
  setProviderDisplayOrder,
  setModelVisible
} from "../model-picker-preferences.js";
import type { ModelView } from "../model.js";
import { ModelPicker, type ModelPickerSelection } from "./ModelPicker.js";
import { Modal } from "./ui.js";

const roots: Root[] = [];
const models: readonly ModelView[] = [
  model("provider-a", "Alpha", "model-small", "Small", ["low", "high"], true, 100, 300),
  model("provider-a", "Alpha", "model-large", "Large", ["medium"], false, 800, 1_200),
  model("provider-b", "Beta", "beta-model", "Beta model", [], false, 0, 0),
  { ...model("provider-b", "Beta", "offline", "Offline", [], false, 0, 0), available: false }
];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetModelPickerPreferencesForTests();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  resetModelPickerPreferencesForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ModelPicker", () => {
  it("opens an anchored portal and searches across model and Provider names", async () => {
    await renderPicker();
    await openPicker();

    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    expect(dialog.textContent).toContain("Small");
    expect(dialog.textContent).toContain("Large");
    expect(dialog.textContent).not.toContain("Offline");
    const search = required(dialog.querySelector<HTMLInputElement>('input[type="search"]'));
    await act(async () => input(search, "Beta"));

    expect(dialog.textContent).toContain("Beta model");
    expect(dialog.textContent).not.toContain("Offline");
    expect(dialog.textContent).not.toContain("Small");
  });

  it("returns the configured effort and Fast mode while omitting unavailable rows", async () => {
    const onSelect = vi.fn<(selection: ModelPickerSelection | undefined) => void>();
    await renderPicker(onSelect);
    await openPicker();
    const small = findRow("Small");
    await act(async () => required(small.querySelector<HTMLButtonElement>('.model-picker__configure')).click());
    const flyout = required(document.body.querySelector<HTMLElement>('.model-picker__config-flyout'));
    expect(small.contains(flyout)).toBe(false);
    const high = [...flyout.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === "high");
    await act(async () => required(high).click());
    await act(async () => required(flyout.querySelector<HTMLInputElement>('input[type="checkbox"]')).click());
    await act(async () => small.click());

    expect(onSelect).toHaveBeenLastCalledWith({
      backendId: "backend-picker",
      providerId: "provider-a",
      modelId: "model-small",
      effort: "high",
      fastMode: true
    });

    await openPicker();
    expect(document.body.querySelector('[role="dialog"]')?.textContent).not.toContain("Offline");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("keeps an unavailable current selection in the trigger without rendering its row or favorite", async () => {
    const unavailable = { ...model("provider-b", "Beta", "offline", "Offline", [], false, 0, 0), available: false };
    addModelFavorite("owner-one", {
      backendId: unavailable.backendId,
      providerId: unavailable.providerId,
      modelId: unavailable.modelId
    });
    const selection: ModelPickerSelection = {
      backendId: unavailable.backendId,
      providerId: unavailable.providerId,
      modelId: unavailable.modelId,
      fastMode: false
    };
    await renderPicker(vi.fn(), "owner-one", undefined, false, undefined, [unavailable], selection);

    expect(readModelPickerOwnerPreferences("owner-one").favorites).toHaveLength(1);
    const trigger = required(document.body.querySelector<HTMLButtonElement>(".model-picker-trigger"));
    expect(trigger.textContent).toContain("Offline");
    expect(trigger.textContent).toContain("Source disconnected");
    expect(trigger.getAttribute("aria-label")).toContain("Source disconnected");
    await openPicker();
    expect(document.body.querySelectorAll(".model-picker__row")).toHaveLength(0);
    expect(document.body.querySelectorAll(".model-picker__row.is-favorite")).toHaveLength(0);
  });

  it("keeps a removed current route visible as a disconnected source", async () => {
    const selection: ModelPickerSelection = {
      backendId: "backend-removed",
      providerId: "provider-removed",
      modelId: "model-removed",
      fastMode: false
    };
    await renderPicker(vi.fn(), "owner-one", undefined, false, undefined, [], selection);

    const trigger = required(document.body.querySelector<HTMLButtonElement>(".model-picker-trigger"));
    expect(trigger.textContent).toContain("model-removed");
    expect(trigger.textContent).toContain("provider-removed");
    expect(trigger.textContent).toContain("Source disconnected");
  });

  it("omits models disabled for routing even when their picker visibility is on", async () => {
    const enabled = model("provider-a", "Alpha", "enabled", "Enabled", [], false, 0, 0);
    const disabled = { ...model("provider-a", "Alpha", "disabled", "Disabled", [], false, 0, 0), routingEnabled: false };
    await renderPicker(vi.fn(), "owner-one", undefined, false, undefined, [enabled, disabled]);
    await openPicker();

    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    expect(dialog.textContent).toContain("Enabled");
    expect(dialog.textContent).not.toContain("Disabled");
  });

  it("uses one Thinking switch for an off-or-on effort pair", async () => {
    const onSelect = vi.fn<(selection: ModelPickerSelection | undefined) => void>();
    const binaryModel = model("provider-a", "Alpha", "binary-reasoner", "Binary reasoner", ["off", "xhigh"], false, 0, 0);
    await renderPicker(onSelect, "owner-one", undefined, false, undefined, [binaryModel]);
    await openPicker();

    const row = findRow("Binary reasoner");
    await act(async () => required(row.querySelector<HTMLButtonElement>('[aria-label="Configure model"]')).click());
    const flyout = required([...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
      .find((group) => group.getAttribute("aria-label") === "Configure model"));
    const thinking = required([...flyout.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest("label")?.textContent?.includes("Thinking")));
    expect(thinking.checked).toBe(false);
    expect(flyout.textContent).not.toContain("xhigh");

    await act(async () => thinking.click());
    expect(thinking.checked).toBe(true);
    expect(row.textContent).toContain("Thinking");
    await act(async () => row.click());
    expect(onSelect).toHaveBeenLastCalledWith({
      backendId: "backend-picker",
      providerId: "provider-a",
      modelId: "binary-reasoner",
      effort: "xhigh",
      fastMode: false
    });

    await openPicker();
    const configuredRow = findRow("Binary reasoner");
    await act(async () => required(configuredRow.querySelector<HTMLButtonElement>('[aria-label="Configure model"]')).click());
    const configuredFlyout = required([...document.body.querySelectorAll<HTMLElement>('[role="group"]')]
      .find((group) => group.getAttribute("aria-label") === "Configure model"));
    const configuredThinking = required([...configuredFlyout.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest("label")?.textContent?.includes("Thinking")));
    await act(async () => configuredThinking.click());
    await act(async () => configuredRow.click());
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "off" }));
  });

  it("stores favorites as independent configuration copies", async () => {
    await renderPicker();
    await openPicker();
    const small = findRow("Small");
    await act(async () => required(small.querySelector<HTMLButtonElement>('.model-picker__configure')).click());
    const flyout = required(document.body.querySelector<HTMLElement>('.model-picker__config-flyout'));
    const star = required(small.querySelector<HTMLButtonElement>('.model-picker__star'));
    await act(async () => star.click());
    await act(async () => [...flyout.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === "high")?.click());
    await act(async () => star.click());

    expect(readModelPickerOwnerPreferences("owner-one").favorites.map((favorite) => favorite.effort)).toEqual(["low", "high"]);
  });

  it("applies owner-scoped visibility without disabling the catalog globally", async () => {
    setModelVisible("owner-one", "backend-picker", "provider-a", "model-large", false);
    await renderPicker();
    await openPicker();
    expect(document.body.textContent).toContain("Small");
    expect(document.body.textContent).not.toContain("Large");

    await act(async () => roots.pop()?.unmount());
    document.body.replaceChildren();
    await renderPicker(undefined, "owner-two");
    await openPicker();
    expect(document.body.textContent).toContain("Large");
  });

  it("uses the owner-scoped Provider order for both the rail and regular model groups", async () => {
    setProviderDisplayOrder("owner-one", [
      providerPreferenceKey("backend-picker", "provider-b"),
      providerPreferenceKey("backend-picker", "provider-a")
    ]);
    await renderPicker();
    await openPicker();

    const providerFilters = [...document.body.querySelectorAll<HTMLElement>(".model-picker__rail button small")]
      .slice(2)
      .map((label) => label.textContent);
    const regularRows = [...document.body.querySelectorAll<HTMLElement>(".model-picker__row:not(.is-favorite) strong")]
      .map((label) => label.textContent);
    expect(providerFilters).toEqual(["Beta", "Alpha"]);
    expect(regularRows).toEqual(["Beta model", "Small", "Large"]);
  });

  it("keeps default-hidden discoveries out of rows and refreshes when opening", async () => {
    const onOpen = vi.fn(async () => undefined);
    await renderPicker(undefined, "owner-one", undefined, false, onOpen, [
      ...models,
      { ...model("provider-b", "Beta", "new-model", "New model", [], false, 0, 0), defaultVisible: false }
    ]);
    await openPicker();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("New model");
  });

  it("shows subscription references as subscription, keeps upstream metered routes priced, reserves Free for known zero-price quotes, and hides unknown pricing", async () => {
    const subscription = { ...model("provider-a", "Alpha", "included", "Included model", [], false, 0, 0), providerAccessKind: "subscription" as const, pricingKnown: false };
    const pricedSubscription = { ...model("provider-a", "Alpha", "metered", "Metered subscription", [], false, 2_000_000, 6_000_000), providerAccessKind: "subscription" as const, pricingKnown: true, pricingSource: "upstream" as const };
    const subscriptionReference = { ...model("provider-a", "Alpha", "reference", "Subscription reference", [], false, 2_000_000, 6_000_000), providerAccessKind: "subscription" as const, pricingKnown: true, pricingSource: "providerReference" as const };
    const free = { ...model("provider-b", "Beta", "free", "Free model", [], false, 0, 0), providerAccessKind: "apiKey" as const, pricingKnown: true, pricingSource: "providerReference" as const };
    const unknown = { ...model("provider-b", "Beta", "unknown", "Unknown price", [], false, 0, 0), providerAccessKind: "apiKey" as const, pricingKnown: false };
    await renderPicker(undefined, "owner-one", undefined, false, undefined, [subscription, pricedSubscription, subscriptionReference, free, unknown]);
    await openPicker();

    expect(findRow("Included model").querySelector(".model-picker__price")?.textContent).toBe("Subscription");
    expect(findRow("Metered subscription").querySelector(".model-picker__price")?.textContent).toBe("$");
    expect(findRow("Subscription reference").querySelector(".model-picker__price")?.textContent).toBe("Subscription");
    expect(findRow("Free model").querySelector(".model-picker__price")?.textContent).toBe("Free");
    expect(findRow("Unknown price").querySelector(".model-picker__price")).toBeNull();
  });

  it("switches among all three local layouts and supports keyboard selection", async () => {
    const onSelect = vi.fn<(selection: ModelPickerSelection | undefined) => void>();
    await renderPicker(onSelect);
    await openPicker();
    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    await act(async () => required([...dialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Try another layout")).click());
    expect(required(document.body.querySelector<HTMLElement>('[role="dialog"]')).classList.contains("model-picker--classic")).toBe(true);
    await act(async () => required([...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "B")).click());
    expect(required(document.body.querySelector<HTMLElement>('[role="dialog"]')).classList.contains("model-picker--badge")).toBe(true);
    expect(required(document.body.querySelector<HTMLButtonElement>('button[aria-label="Classic layout"]')).title).toBe("Classic layout");
    await act(async () => required([...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Original layout")).click());
    expect(required(document.body.querySelector<HTMLElement>('[role="dialog"]')).classList.contains("model-picker--original")).toBe(true);

    const search = required(document.body.querySelector<HTMLInputElement>('input[type="search"]'));
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ modelId: "model-large" }));
  });

  it("dismisses only the picker on Escape when it is opened from a modal", async () => {
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(
      <Modal open title="Edit schedule" onClose={onClose}>
        <ModelPicker
          models={models}
          ownerId="owner-one"
          value={undefined}
          t={(key, values) => translate("en", key, values)}
          onSelect={() => undefined}
        />
      </Modal>
    ));
    await openPicker();

    const search = required(document.body.querySelector<HTMLInputElement>('.model-picker input[type="search"]'));
    await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(document.body.querySelector(".model-picker")).toBeNull();
    expect(document.body.textContent).toContain("Edit schedule");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("seeds the default favorite only once and renders a task-default row", async () => {
    const onSelect = vi.fn<(selection: ModelPickerSelection | undefined) => void>();
    await renderPicker(onSelect, "owner-one", {
      backendId: "backend-picker",
      providerId: "provider-a",
      modelId: "model-small",
      effort: "high",
      fastMode: true
    }, true);
    await openPicker();
    expect(readModelPickerOwnerPreferences("owner-one").favorites).toHaveLength(1);
    const defaultRow = required(document.body.querySelector<HTMLButtonElement>(".model-picker__default-row"));
    await act(async () => defaultRow.click());
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
  });

});

async function renderPicker(
  onSelect: (selection: ModelPickerSelection | undefined) => void = () => undefined,
  ownerId = "owner-one",
  seedDefault?: ModelPickerSelection,
  allowDefault = false,
  onOpen?: () => void | Promise<void>,
  pickerModels: readonly ModelView[] = models,
  value?: ModelPickerSelection
): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<ModelPicker
    models={pickerModels}
    ownerId={ownerId}
    value={value}
    t={(key, values) => translate("en", key, values)}
    onSelect={onSelect}
    onOpen={onOpen}
    allowDefault={allowDefault}
    seedDefault={seedDefault}
  />));
}

async function openPicker(): Promise<void> {
  const trigger = required(document.body.querySelector<HTMLButtonElement>(".model-picker-trigger"));
  await act(async () => trigger.click());
  await act(async () => Promise.resolve());
}

function findRow(name: string): HTMLElement {
  const row = [...document.body.querySelectorAll<HTMLElement>(".model-picker__row")]
    .find((candidate) => candidate.textContent?.includes(name));
  return required(row);
}

function input(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function model(
  providerId: string,
  providerName: string,
  modelId: string,
  name: string,
  efforts: readonly string[],
  supportsFast: boolean,
  inputCostMicrosPerMillion: number,
  outputCostMicrosPerMillion: number
): ModelView {
  return {
    backendId: "backend-picker",
    providerId,
    providerName,
    modelId,
    name,
    available: true,
    supportsImages: false,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsFast,
    efforts,
    contextWindow: 128_000,
    maximumOutputTokens: 8_192,
    inputCostMicrosPerMillion,
    outputCostMicrosPerMillion,
    currencyCode: "USD"
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered value.");
  return value;
}
