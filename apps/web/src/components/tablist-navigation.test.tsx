// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moveTablistSelection } from "./tablist-navigation.js";

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("tablist keyboard navigation", () => {
  it("wraps horizontal selection and supports Home and End", async () => {
    const selected: string[] = [];
    const container = await renderTabs("horizontal", selected);
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    tabs[0]?.focus();
    press(tabs[0], "ArrowLeft");
    expect(document.activeElement).toBe(tabs[2]);
    expect(selected).toEqual(["three"]);

    press(tabs[2], "Home");
    press(tabs[0], "End");
    expect(selected).toEqual(["three", "one", "three"]);
  });

  it("uses vertical arrows, skips disabled tabs, and ignores modified keys", async () => {
    const selected: string[] = [];
    const container = await renderTabs("vertical", selected, true);
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];

    tabs[0]?.focus();
    press(tabs[0], "ArrowDown");
    expect(document.activeElement).toBe(tabs[2]);
    expect(selected).toEqual(["three"]);

    press(tabs[2], "ArrowDown", { ctrlKey: true });
    press(tabs[2], "ArrowRight");
    expect(document.activeElement).toBe(tabs[2]);
    expect(selected).toEqual(["three"]);
  });
});

async function renderTabs(orientation: "horizontal" | "vertical", selected: string[], disableMiddle = false): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<div role="tablist">{["one", "two", "three"].map((id, index) => <button
    key={id}
    type="button"
    role="tab"
    disabled={disableMiddle && index === 1}
    onClick={() => selected.push(id)}
    onKeyDown={(event) => moveTablistSelection(event, orientation)}
  >{id}</button>)}</div>));
  return container;
}

function press(target: HTMLButtonElement | undefined, key: string, init: KeyboardEventInit = {}): void {
  if (target === undefined) throw new Error("Expected a tab fixture.");
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}
