/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { isPromptRecommendationAcceptKey, PromptRecommendationEditorFrame, shouldShowPromptRecommendation, type PromptRecommendationVisibilityInput } from "./PromptRecommendationOverlay.js";

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("PromptRecommendationEditorFrame", () => {
  it("renders a separate aria-hidden overlay and marks the native placeholder for hiding", async () => {
    const container = await render(<PromptRecommendationEditorFrame recommendation="Run the focused tests.">
      <div className="composer-rich-editor"><div className="composer-rich-editor__content" data-empty="true"><p /></div></div>
    </PromptRecommendationEditorFrame>);

    const frame = required(container.querySelector<HTMLElement>(".prompt-recommendation-editor"));
    const overlay = required(container.querySelector<HTMLElement>(".prompt-recommendation-editor__overlay"));
    expect(frame.dataset["recommendationActive"]).toBe("true");
    expect(overlay.textContent).toBe("Run the focused tests.Tab");
    expect(required(overlay.querySelector("kbd")).textContent).toBe("Tab");
    expect(required(overlay.querySelector(".prompt-recommendation-editor__text")).getAttribute("aria-hidden")).toBe("true");
  });

  it("exposes the keycap as an accessible action without moving pointer focus", async () => {
    let accepted = 0;
    const container = await render(<PromptRecommendationEditorFrame
      recommendation="Run the focused tests."
      acceptLabel="Tab"
      onAccept={() => { accepted += 1; }}
    ><div data-editor /></PromptRecommendationEditorFrame>);
    const button = required(container.querySelector<HTMLButtonElement>("button.prompt-recommendation-editor__key"));
    expect(button.getAttribute("aria-label")).toBe("Tab: Run the focused tests.");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(accepted).toBe(1);
  });

  it("does not create an overlay or hide the normal placeholder without a recommendation", async () => {
    const container = await render(<PromptRecommendationEditorFrame><div data-editor /></PromptRecommendationEditorFrame>);
    const frame = required(container.querySelector<HTMLElement>(".prompt-recommendation-editor"));

    expect(frame.hasAttribute("data-recommendation-active")).toBe(false);
    expect(container.querySelector(".prompt-recommendation-editor__overlay")).toBeNull();
  });

});

describe("isPromptRecommendationAcceptKey", () => {
  const bareTab: KeyboardInput = {
    key: "Tab",
    repeat: false,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false
  };

  it("accepts only a non-repeating bare Tab", () => {
    expect(isPromptRecommendationAcceptKey(bareTab)).toBe(true);
    expect(isPromptRecommendationAcceptKey({ ...bareTab, repeat: true })).toBe(false);
    expect(isPromptRecommendationAcceptKey({ ...bareTab, isComposing: true })).toBe(false);
    expect(isPromptRecommendationAcceptKey({ ...bareTab, shiftKey: true })).toBe(false);
    expect(isPromptRecommendationAcceptKey({ ...bareTab, metaKey: true })).toBe(false);
    expect(isPromptRecommendationAcceptKey({ ...bareTab, ctrlKey: true })).toBe(false);
    expect(isPromptRecommendationAcceptKey({ ...bareTab, altKey: true })).toBe(false);
    expect(isPromptRecommendationAcceptKey({ ...bareTab, key: "Enter" })).toBe(false);
  });
});

describe("shouldShowPromptRecommendation", () => {
  const eligible: PromptRecommendationVisibilityInput = {
    enabled: true,
    available: true,
    hydrated: true,
    readOnly: false,
    locked: false,
    bashMode: false,
    paletteOpen: false,
    documentEmpty: true,
    hasAttachments: false,
    hasMentions: false,
    hasSelectionQuotes: false,
    hasUnfinishedQueue: false,
    queuePaused: false
  };

  it("clears eligibility immediately on authoritative disable/unavailability or queued work", () => {
    expect(shouldShowPromptRecommendation(eligible)).toBe(true);
    expect(shouldShowPromptRecommendation({ ...eligible, enabled: false })).toBe(false);
    expect(shouldShowPromptRecommendation({ ...eligible, available: false })).toBe(false);
    expect(shouldShowPromptRecommendation({ ...eligible, hasUnfinishedQueue: true })).toBe(false);
    expect(shouldShowPromptRecommendation({ ...eligible, queuePaused: true })).toBe(false);
  });

  it.each<keyof PromptRecommendationVisibilityInput>([
    "readOnly",
    "locked",
    "bashMode",
    "paletteOpen",
    "hasAttachments",
    "hasMentions",
    "hasSelectionQuotes"
  ])("rejects blocking composer state %s", (key) => {
    expect(shouldShowPromptRecommendation({ ...eligible, [key]: true })).toBe(false);
  });

  it("requires the target Session draft to be hydrated and empty", () => {
    expect(shouldShowPromptRecommendation({ ...eligible, hydrated: false })).toBe(false);
    expect(shouldShowPromptRecommendation({ ...eligible, documentEmpty: false })).toBe(false);
  });

  it("temporarily hides on ordinary input and reveals the same recommendation after clearing", () => {
    const stored = "Run the focused tests.";
    const visible = (documentEmpty: boolean) => shouldShowPromptRecommendation({ ...eligible, documentEmpty })
      ? stored
      : undefined;

    expect(visible(true)).toBe(stored);
    expect(visible(false)).toBeUndefined();
    expect(visible(true)).toBe(stored);
  });

});

type KeyboardInput = Parameters<typeof isPromptRecommendationAcceptKey>[0];

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return container;
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected rendered element.");
  return value;
}
