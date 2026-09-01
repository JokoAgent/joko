// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { ModelPriceOverrideView, ModelView } from "../model.js";
import { ModelPriceOverrideDialog } from "./ModelPriceOverrideDialog.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ModelPriceOverrideDialog", () => {
  it("loads, resets, and saves one exact Backend, Provider, and model route", async () => {
    const initial: ModelPriceOverrideView = {
      backendId: model.backendId,
      providerId: model.providerId,
      modelId: model.modelId,
      reference: { currency: "USD", inputPerMillion: 1, outputPerMillion: 2 },
      effective: { currency: "CNY", inputPerMillion: 3, outputPerMillion: 6, cacheReadPerMillion: 0.1 },
      override: { currency: "CNY", inputPerMillion: 3, outputPerMillion: 6, cacheReadPerMillion: 0.1 },
      allowedCurrencies: ["USD", "CNY"],
      referenceAvailable: true,
      registryUpdatedAt: Date.UTC(2026, 7, 29),
      revision: 4n
    };
    const resetValue: ModelPriceOverrideView = {
      ...initial,
      effective: initial.reference,
      override: undefined,
      revision: 5n
    };
    const getModelPriceOverride = vi.fn(async () => initial);
    const resetModelPriceOverride = vi.fn(async () => resetValue);
    const setModelPriceOverride = vi.fn(async (_backendId: string, _providerId: string, _modelId: string, desired: typeof initial.reference) => ({
      ...initial,
      effective: desired,
      override: desired,
      revision: 6n
    }));
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(<ModelPriceOverrideDialog
      controller={{ getModelPriceOverride, resetModelPriceOverride, setModelPriceOverride }}
      model={model}
      t={(key, values) => translate("en", key, values)}
      onClose={onClose}
    />));

    expect(getModelPriceOverride.mock.calls[0]?.slice(0, 3)).toEqual(["backend-two", "shared-provider", "shared-model"]);
    expect(document.body.textContent).not.toContain("backend-two · shared-provider · shared-model");
    expect(document.body.querySelector(".model-price-dialog__route")).toBeNull();
    expect(document.body.querySelector(".model-price-dialog__summary")).toBeNull();
    expect(document.body.textContent).toContain("Shared Model API estimate");
    expect(document.body.textContent).toContain("Reference price updated 2026-08-29");
    expect(inputFor("Input").value).toBe("3");
    expect(inputFor("Cache read (optional)").value).toBe("0.1");
    expect(document.activeElement).toBe(inputFor("Input"));

    await act(async () => button("Restore current reference price").click());
    expect(resetModelPriceOverride).toHaveBeenCalledWith("backend-two", "shared-provider", "shared-model");
    expect(inputFor("Input").value).toBe("1");
    expect(document.body.textContent).not.toContain("Restore current reference price");

    await changeInput(inputFor("Input"), "-1");
    expect(button("Save").disabled).toBe(true);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("non-negative");
    await changeInput(inputFor("Input"), "4.5");
    await changeInput(inputFor("Output"), "8");
    await changeInput(inputFor("Cache write (optional)"), "0.25");
    await changeSelect(required(document.body.querySelector<HTMLSelectElement>("select")), "CNY");
    await act(async () => button("Save").click());

    expect(setModelPriceOverride).toHaveBeenCalledWith(
      "backend-two",
      "shared-provider",
      "shared-model",
      { currency: "CNY", inputPerMillion: 4.5, outputPerMillion: 8, cacheWritePerMillion: 0.25 }
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("switches runtime tabs independently and leaves an unknown reference blank", async () => {
    const alternate = { ...model, backendId: "backend-three" };
    const getModelPriceOverride = vi.fn(async (backendId: string): Promise<ModelPriceOverrideView> => ({
      backendId,
      providerId: model.providerId,
      modelId: model.modelId,
      reference: {
        currency: "USD",
        inputPerMillion: backendId === model.backendId ? 4 : 0,
        outputPerMillion: backendId === model.backendId ? 20 : 0
      },
      effective: { currency: "USD", inputPerMillion: 0, outputPerMillion: 0 },
      allowedCurrencies: ["USD", "CNY"],
      referenceAvailable: backendId === model.backendId
    }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(<ModelPriceOverrideDialog
      controller={{
        getModelPriceOverride,
        resetModelPriceOverride: vi.fn(),
        setModelPriceOverride: vi.fn()
      }}
      model={model}
      variants={[{ model, label: "Codex" }, { model: alternate, label: "Pi" }]}
      t={(key, values) => translate("en", key, values)}
      onClose={() => undefined}
    />));

    expect(inputFor("Input").value).toBe("4");
    expect(button("Codex").getAttribute("aria-selected")).toBe("true");
    await act(async () => { button("Pi").click(); await Promise.resolve(); });
    expect(getModelPriceOverride.mock.calls.at(-1)?.slice(0, 3)).toEqual([
      "backend-three",
      "shared-provider",
      "shared-model"
    ]);
    expect(inputFor("Input").value).toBe("");
    expect(inputFor("Output").value).toBe("");
    expect(button("Save").disabled).toBe(true);
  });
});

const model: ModelView = {
  backendId: "backend-two",
  providerId: "shared-provider",
  providerName: "Shared Provider",
  modelId: "shared-model",
  name: "Shared Model",
  available: true,
  supportsImages: false,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsFast: false,
  efforts: [],
  contextWindow: 64_000,
  maximumOutputTokens: 8_192,
  inputCostMicrosPerMillion: 1_000_000,
  outputCostMicrosPerMillion: 2_000_000,
  currencyCode: "USD"
};

function inputFor(label: string): HTMLInputElement {
  const owner = [...document.body.querySelectorAll("label")].find((candidate) => candidate.querySelector("span")?.textContent === label);
  return required(owner?.querySelector<HTMLInputElement>("input") ?? null);
}

function button(label: string): HTMLButtonElement {
  return required([...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label) ?? null);
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered control.");
  return value;
}
