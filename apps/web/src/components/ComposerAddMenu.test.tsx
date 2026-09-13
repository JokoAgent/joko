// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComposerAddMenu } from "./ComposerAddMenu.js";
import { MORPH_POPOVER_DURATION_MS } from "./MorphPopover.js";

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

describe("ComposerAddMenu", () => {
  it("uses one portal menu for composer additions and restores its trigger", async () => {
    const clipping = document.createElement("div");
    clipping.style.overflow = "hidden";
    document.body.append(clipping);
    const root = createRoot(clipping);
    roots.push(root);
    await act(async () => root.render(<Harness />));

    const trigger = required(clipping.querySelector<HTMLButtonElement>('.composer-add-menu__trigger'));
    await act(async () => { trigger.focus(); trigger.click(); });
    const panel = required(document.body.querySelector<HTMLElement>('.composer-add-menu__panel[role="dialog"]'));
    expect(clipping.contains(panel)).toBe(false);
    expect(panel.textContent).toContain("Attach");
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS); });
    const actions = [...panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(actions[0]);
    await act(async () => actions[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(actions[1]);
    await act(async () => actions[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(actions[2]);
    await act(async () => actions[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(actions[0]);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel.dataset.state).toBe("closed");
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.querySelector(".composer-add-menu__panel")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("switches Mention into the same open morph panel without a reverse-close overlap", async () => {
    const clipping = document.createElement("div");
    document.body.append(clipping);
    const root = createRoot(clipping);
    roots.push(root);
    await act(async () => root.render(<SwitchHarness />));

    await act(async () => required(clipping.querySelector<HTMLButtonElement>(".composer-add-menu__trigger")).click());
    const panel = required(document.body.querySelector<HTMLElement>(".composer-add-menu__panel"));
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS); });
    expect(panel.dataset.state).toBe("open");
    await act(async () => required(panel.querySelector<HTMLButtonElement>("[data-open-mention]")).click());

    expect(document.body.querySelectorAll(".composer-add-menu__panel")).toHaveLength(1);
    expect(document.body.querySelector(".composer-add-menu__panel")).toBe(panel);
    expect(panel.dataset.state).toBe("open");
    expect(panel.querySelector("[data-open-mention]")).toBeNull();
    expect(panel.querySelector("[data-mention-view]")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.body.querySelector(".composer-add-menu__panel")).toBe(panel);
  });

  it("notifies the owner to clear an open menu when disabled and stays closed after re-enable", async () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const renderMenu = (disabled: boolean, open: boolean): React.ReactNode => <ComposerAddMenu open={open} disabled={disabled} disabledReason="Busy" onOpenChange={onOpenChange} label="Add" closeLabel="Close"><div role="menu"><button role="menuitem">Attach</button></div></ComposerAddMenu>;
    await act(async () => root.render(renderMenu(false, true)));
    expect(document.querySelector(".composer-add-menu__panel")).not.toBeNull();

    await act(async () => root.render(renderMenu(true, true)));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => root.render(renderMenu(false, false)));
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.querySelector(".composer-add-menu__panel")).toBeNull();
    expect(required(container.querySelector<HTMLButtonElement>(".composer-add-menu__trigger")).getAttribute("aria-expanded")).toBe("false");
  });
});

function Harness(): React.ReactNode {
  const [open, setOpen] = useState(false);
  return <ComposerAddMenu open={open} onOpenChange={setOpen} label="Add" closeLabel="Close" count={2}>
    <div role="menu">
      <button className="composer-add-menu__action" role="menuitem" type="button">Attach</button>
      <button className="composer-add-menu__action" role="menuitem" type="button">Mention</button>
      <button className="composer-add-menu__action" role="menuitem" type="button">Commands</button>
    </div>
  </ComposerAddMenu>;
}

function SwitchHarness(): React.ReactNode {
  const [view, setView] = useState<"closed" | "add" | "mention">("closed");
  return <ComposerAddMenu
    open={view !== "closed"}
    onOpenChange={(open) => setView(open ? "add" : "closed")}
    label="Add"
    panelLabel={view === "mention" ? "Mention" : "Add"}
    closeLabel="Close"
  >{view === "mention"
      ? <div data-mention-view><input autoFocus aria-label="Find mention" /></div>
      : <div role="menu"><button data-open-mention className="composer-add-menu__action" role="menuitem" type="button" onClick={() => setView("mention")}>Mention</button></div>}
  </ComposerAddMenu>;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test element");
  return value;
}
