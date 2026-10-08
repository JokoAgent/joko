// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ObjectiveDialog } from "./ObjectiveDialog.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ObjectiveDialog", () => {
  it("focuses the Objective, uses the fixed first-create limits, and preserves a failed draft", async () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error("Owner changed"))
      .mockResolvedValueOnce(undefined);
    await act(async () => root.render(<ObjectiveDialog
      open
      ownerDocument={document}
      t={(key) => key}
      onClose={onClose}
      onSubmit={onSubmit}
    />));
    const textarea = required(document.querySelector<HTMLTextAreaElement>(".objective-dialog textarea"));
    expect(document.activeElement).toBe(textarea);
    await act(async () => changeValue(textarea, "Ship the complete feature"));

    await act(async () => { primaryButton().click(); await settle(); });
    expect(onSubmit).toHaveBeenCalledWith("Ship the complete feature", {
      maximumTurns: null,
      tokenBudget: null,
      noProgressTurnLimit: 3
    });
    expect(textarea.value).toBe("Ship the complete feature");
    expect(document.querySelector("[role='alert']")?.textContent).toContain("Owner changed");
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { primaryButton().click(); await settle(); });
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function primaryButton(): HTMLButtonElement {
  return required(document.querySelector<HTMLButtonElement>(".objective-dialog .button--primary"));
}

function changeValue(element: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected value.");
  return value;
}
