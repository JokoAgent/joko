// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { CheckboxControl, RadioControl, SelectControl, SwitchControl } from "./ui.js";

afterEach(() => {
  document.body.replaceChildren();
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
});

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected rendered value.");
  return value;
}
