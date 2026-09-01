// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { PermissionMode } from "../model.js";
import { MORPH_POPOVER_DURATION_MS } from "./MorphPopover.js";
import { PermissionSelector } from "./PermissionSelector.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("PermissionSelector", () => {
  it("portals above clipping ancestors, roves with Arrow/Home/End, and restores trigger focus", async () => {
    const onChange = vi.fn<(mode: PermissionMode) => void>();
    const container = document.createElement("div");
    container.style.overflow = "hidden";
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<PermissionSelector
      value="auto"
      modes={["ask", "auto", "bypassPermissions"]}
      onChange={onChange}
      t={(key, values) => translate("en", key, values)}
    />));

    const trigger = required(container.querySelector<HTMLButtonElement>(".permission-selector__trigger"));
    await act(async () => { trigger.focus(); trigger.click(); });
    const dialog = required(document.body.querySelector<HTMLElement>('.permission-selector__panel[role="dialog"]'));
    expect(container.contains(dialog)).toBe(false);
    const listbox = required(dialog.querySelector<HTMLElement>('[role="listbox"]'));
    const options = [...listbox.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS); });
    expect(document.activeElement).toBe(options[1]);

    await act(async () => listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(options[2]);
    await act(async () => listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(options[0]);
    await act(async () => listbox.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(options[2]);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(dialog.dataset.state).toBe("closed");
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.querySelector(".permission-selector__panel")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("commits the exact option and exposes descriptions and risk tone", async () => {
    const onChange = vi.fn<(mode: PermissionMode) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<PermissionSelector
      value="ask"
      modes={["ask", "auto", "bypassPermissions"]}
      onChange={onChange}
      t={(key, values) => translate("en", key, values)}
    />));
    await act(async () => required(container.querySelector<HTMLButtonElement>(".permission-selector__trigger")).click());
    const dangerous = required(document.querySelector<HTMLButtonElement>('.permission-selector__list > button.is-danger'));
    expect(dangerous.textContent).toContain("Not an OS sandbox");
    await act(async () => dangerous.click());
    expect(onChange).toHaveBeenCalledWith("bypassPermissions");
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.querySelector(".permission-selector__panel")).toBeNull();
  });

  it("clears an open selection when disabled so re-enabling does not reopen it", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderSelector = (disabled: boolean): React.ReactNode => <PermissionSelector disabled={disabled} disabledReason="Busy" value="ask" modes={["ask", "auto"]} onChange={() => undefined} t={(key, values) => translate("en", key, values)} />;
    await act(async () => root.render(renderSelector(false)));
    await act(async () => required(container.querySelector<HTMLButtonElement>(".permission-selector__trigger")).click());
    expect(document.querySelector(".permission-selector__panel")).not.toBeNull();

    await act(async () => root.render(renderSelector(true)));
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.querySelector(".permission-selector__panel")).toBeNull();
    await act(async () => root.render(renderSelector(false)));
    expect(document.querySelector(".permission-selector__panel")).toBeNull();
    expect(required(container.querySelector<HTMLButtonElement>(".permission-selector__trigger")).getAttribute("aria-expanded")).toBe("false");
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test element");
  return value;
}
