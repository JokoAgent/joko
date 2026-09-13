// @vitest-environment jsdom

import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckboxControl, Modal, RadioControl, SelectControl, SwitchControl } from "./ui.js";

const roots: Root[] = [];
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("custom form controls", () => {
  it("renders the select as an app-owned popup with keyboard selection", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    function Harness() {
      const [value, setValue] = useState("standard");
      return <SelectControl aria-label="Diagnostic level" value={value} onChange={(event) => setValue(event.target.value)}>
        <option value="standard">Standard</option>
        <option value="unavailable" disabled>Unavailable</option>
        <option value="detailed">Detailed</option>
      </SelectControl>;
    }
    await act(async () => root.render(<Harness />));

    const trigger = required(document.querySelector<HTMLButtonElement>('[role="combobox"]'));
    expect(trigger.textContent).toContain("Standard");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(trigger.textContent).toContain("Detailed");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => root.unmount());
  });

  it("uses one visible app-owned button for checkbox, radio, and switch", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    function Harness() {
      const [checkbox, setCheckbox] = useState(false);
      const [radio, setRadio] = useState(false);
      const [toggle, setToggle] = useState(false);
      return <>
        <CheckboxControl aria-label="Checkbox" checked={checkbox} onChange={(event) => setCheckbox(event.target.checked)} />
        <RadioControl aria-label="Radio" checked={radio} onChange={(event) => setRadio(event.target.checked)} />
        <SwitchControl aria-label="Switch" checked={toggle} onChange={(event) => setToggle(event.target.checked)} />
      </>;
    }
    await act(async () => root.render(<Harness />));

    for (const role of ["checkbox", "radio", "switch"] as const) {
      const control = required(document.querySelector<HTMLButtonElement>(`button[role="${role}"]`));
      expect(control.getAttribute("aria-checked")).toBe("false");
      await act(async () => control.click());
      expect(control.getAttribute("aria-checked")).toBe("true");
    }
    await act(async () => root.unmount());
  });

  it("keeps the active option by value and separates IME, navigation, commitment and focus departure", async () => {
    const changed = vi.fn();
    const root = mountedRoot();
    function Harness({ entries }: { entries: readonly string[] }) {
      const [value, setValue] = useState("Alpha");
      return <form id="choices"><SelectControl aria-label="Choice" name="choice" required value={value} onChange={(event) => { changed(event.target.value); setValue(event.target.value); }}>
        <optgroup label="Unavailable" disabled><option value="Blocked">Blocked</option></optgroup>
        <optgroup label="Available">{entries.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</optgroup>
      </SelectControl><button type="button">After</button></form>;
    }
    await act(async () => root.render(<Harness entries={["Alpha", "Beta", "Bravo", "Gamma"]} />));
    const trigger = required(document.querySelector<HTMLButtonElement>('[role="combobox"]'));
    const key = async (value: string, composing = false): Promise<KeyboardEvent> => {
      const event = new KeyboardEvent("keydown", { key: value, isComposing: composing, bubbles: true, cancelable: true });
      await act(async () => trigger.dispatchEvent(event));
      return event;
    };
    const active = (): string | null | undefined => document.getElementById(trigger.getAttribute("aria-activedescendant") ?? "")?.textContent;
    await act(async () => trigger.focus());
    await key("ArrowDown");
    await key("ArrowDown");
    expect(active()).toContain("Beta");
    expect((await key("Enter", true)).defaultPrevented).toBe(false);
    expect(changed).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness entries={["Beta", "Gamma", "Alpha", "Bravo"]} />));
    expect(active()).toContain("Beta");
    await act(async () => root.render(<Harness entries={["Gamma", "Alpha", "Bravo"]} />));
    expect(active()).toContain("Alpha");
    await key("Home");
    expect(active()).toContain("Gamma");
    await key("End");
    expect(active()).toContain("Bravo");
    expect((await key("Tab")).defaultPrevented).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(changed).not.toHaveBeenCalled();
    await key("b");
    expect(trigger.textContent).toContain("Bravo");
    expect(changed).toHaveBeenLastCalledWith("Bravo");
    expect(new FormData(required(document.querySelector("form"))).get("choice")).toBe("Bravo");
    await key("ArrowUp");
    await key("Enter");
    expect(changed).toHaveBeenCalledTimes(1);
    await key("ArrowDown");
    await act(async () => required(document.querySelector<HTMLButtonElement>('button:not([role])')).focus());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await key("ArrowDown");
    await act(async () => root.render(<Harness entries={[]} />));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("owns its portal, viewport and listeners in the initiating document and retires them on replacement", async () => {
    vi.useFakeTimers();
    const first = frameDocument();
    const second = frameDocument();
    const ownerWindow = required(first.defaultView);
    const viewport = Object.assign(new ownerWindow.EventTarget(), { offsetLeft: 40, offsetTop: 60, width: 140, height: 100 });
    Object.defineProperty(ownerWindow, "visualViewport", { configurable: true, value: viewport });
    const observed: Element[] = [];
    const disconnect = vi.fn();
    let resized: (() => void) | undefined;
    Object.defineProperty(ownerWindow, "ResizeObserver", { configurable: true, value: class {
      constructor(callback: () => void) { resized = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect = disconnect;
    } });
    ownerWindow.requestAnimationFrame = (callback) => ownerWindow.setTimeout(() => callback(0), 16);
    ownerWindow.cancelAnimationFrame = (id) => ownerWindow.clearTimeout(id);
    const root = mountedRoot();
    const content = <SelectControl aria-label="Foreign choice" value="one"><option value="one">One</option><option value="two">Two</option></SelectControl>;
    await act(async () => root.render(createPortal(content, first.body)));
    let trigger = required(first.querySelector<HTMLButtonElement>('[role="combobox"]'));
    trigger.getBoundingClientRect = () => ({ x: 80, y: 100, left: 80, right: 130, top: 100, bottom: 120, width: 50, height: 20, toJSON: () => ({}) });
    await act(async () => { trigger.focus(); trigger.click(); });
    let popup = required(first.querySelector<HTMLElement>('[role="listbox"]'));
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(observed.includes(trigger)).toBe(true);
    expect(observed.includes(popup)).toBe(true);
    expect(Number.parseFloat(popup.style.width)).toBe(124);
    expect(Number.parseFloat(popup.style.maxHeight)).toBeLessThan(72);
    await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(first.querySelector('[role="listbox"]')).toBe(popup);
    viewport.width = 90;
    viewport.height = 70;
    await act(async () => { viewport.dispatchEvent(new ownerWindow.Event("resize")); resized?.(); vi.advanceTimersByTime(16); });
    expect(Number.parseFloat(popup.style.width)).toBe(74);
    expect(Number.parseFloat(popup.style.top)).toBeGreaterThanOrEqual(viewport.offsetTop + 8);
    await act(async () => first.body.dispatchEvent(new ownerWindow.Event("pointerdown", { bubbles: true })));
    expect(first.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => trigger.click());
    await act(async () => ownerWindow.dispatchEvent(new ownerWindow.Event("pagehide")));
    expect(first.querySelector('[role="listbox"]')).toBeNull();
    await act(async () => trigger.click());
    popup = required(first.querySelector<HTMLElement>('[role="listbox"]'));
    await act(async () => root.render(createPortal(content, second.body)));
    expect(popup.isConnected).toBe(false);
    trigger = required(second.querySelector<HTMLButtonElement>('[role="combobox"]'));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(first.activeElement).toBe(first.body);
    await act(async () => root.render(createPortal(content, first.body)));
    expect(first.querySelector('[role="listbox"]')).toBeNull();
    expect(disconnect).toHaveBeenCalled();
  });

  it("ports modal focus and nested Escape to the requested document without reviving an old window", async () => {
    const first = frameDocument();
    const second = frameDocument();
    const firstTrigger = first.body.appendChild(first.createElement("button"));
    const secondTrigger = second.body.appendChild(second.createElement("button"));
    firstTrigger.focus();
    const root = mountedRoot();
    const closed = vi.fn();
    function Harness({ ownerDocument }: { ownerDocument: Document }) {
      const [open, setOpen] = useState(true);
      return <Modal ownerDocument={ownerDocument} open={open} title="Choose" onClose={() => { closed(); setOpen(false); }}>
        <SelectControl aria-label="Modal choice" value="one"><option value="one">One</option><option value="two">Two</option></SelectControl>
        <button type="button" onClick={() => setOpen(false)}>Close</button>
      </Modal>;
    }
    await act(async () => root.render(<Harness ownerDocument={first} />));
    const select = required(first.querySelector<HTMLButtonElement>('[role="combobox"]'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(first.activeElement).toBe(select);
    const ownerWindow = required(first.defaultView);
    await act(async () => select.click());
    await act(async () => select.dispatchEvent(new ownerWindow.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })));
    expect(select.getAttribute("aria-expanded")).toBe("true");
    await act(async () => select.dispatchEvent(new ownerWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(first.querySelector('[role="listbox"]')).toBeNull();
    expect(closed).not.toHaveBeenCalled();
    secondTrigger.focus();
    await act(async () => root.render(<Harness ownerDocument={second} />));
    expect(first.querySelector('[role="dialog"]')).toBeNull();
    expect(first.activeElement).not.toBe(firstTrigger);
    expect(first.body.classList.contains("modal-open")).toBe(false);
    const secondSelect = required(second.querySelector<HTMLButtonElement>('[role="combobox"]'));
    expect(second.activeElement).toBe(secondSelect);
    const secondWindow = required(second.defaultView);
    await act(async () => { secondWindow.dispatchEvent(new secondWindow.Event("pagehide")); secondSelect.dispatchEvent(new secondWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(closed).not.toHaveBeenCalled();
    await act(async () => secondWindow.dispatchEvent(new secondWindow.Event("pageshow")));
    await act(async () => secondSelect.dispatchEvent(new (required(second.defaultView).KeyboardEvent)("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(second.querySelector('[role="dialog"]')).toBeNull();
    expect(second.activeElement).toBe(secondTrigger);
    expect(second.body.classList.contains("modal-open")).toBe(false);
  });

  it("leaves keyboard ownership with the active modal and releases an interleaved external body lock", async () => {
    const external = document.body.appendChild(document.createElement("div"));
    external.setAttribute("role", "dialog");
    external.setAttribute("aria-modal", "true");
    document.body.classList.add("modal-open");
    const firstClosed = vi.fn();
    const secondClosed = vi.fn();
    const root = mountedRoot();
    function Stack() {
      const [first, setFirst] = useState(true);
      const [second, setSecond] = useState(true);
      return <>
        <Modal open={first} title="First" onClose={() => { firstClosed(); setFirst(false); }}><p>First has no focusable controls.</p></Modal>
        <Modal open={second} title="Second" onClose={() => { secondClosed(); setSecond(false); }}><input aria-label="Second input" /><button type="button">Second last</button></Modal>
      </>;
    }
    await act(async () => root.render(<Stack />));
    const secondInput = required(document.querySelector<HTMLInputElement>('input[aria-label="Second input"]'));
    const secondButton = required([...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Second last") ?? null);
    await act(async () => secondButton.focus());
    await act(async () => secondButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(secondInput);
    external.remove();
    await act(async () => secondInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(secondClosed).toHaveBeenCalledOnce();
    expect(firstClosed).not.toHaveBeenCalled();
    expect(document.body.classList.contains("modal-open")).toBe(true);
    const firstDialog = required(document.querySelector<HTMLElement>('[role="dialog"]'));
    expect(document.activeElement).toBe(firstDialog);
    await act(async () => firstDialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(firstClosed).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.classList.contains("modal-open")).toBe(false);
  });
});

function mountedRoot(): Root {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  return root;
}

function frameDocument(): Document {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  return required(iframe.contentDocument);
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected rendered value.");
  return value;
}
