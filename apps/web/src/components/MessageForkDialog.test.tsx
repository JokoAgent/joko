// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import { MessageForkDialog } from "./MessageForkDialog.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("message fork confirmation", () => {
  it("introduces the action and runs it only after explicit confirmation", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => root.render(<MessageForkDialog
      open
      t={(key, values) => translate("en", key, values)}
      onClose={onClose}
      onConfirm={onConfirm}
    />));

    const dialog = required(container.querySelector<HTMLElement>("[role='alertdialog']"));
    const confirm = required(dialog.querySelector<HTMLButtonElement>("[data-message-fork-confirm='true']"));
    const cancel = required(dialog.querySelector<HTMLButtonElement>("[data-message-fork-cancel='true']"));
    expect(dialog.textContent).toContain("A new task will be created at this message");
    expect(document.activeElement).toBe(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    await act(async () => cancel.click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();

    await act(async () => confirm.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected element.");
  return value;
}
