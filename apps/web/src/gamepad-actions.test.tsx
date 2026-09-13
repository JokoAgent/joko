// @vitest-environment jsdom
import { act, useRef } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchGamepadOwnedAction, useGamepadActions, type GamepadActionHandlers } from "./gamepad-actions.js";

const roots: Root[] = [];
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren(); document.body.className = ""; vi.unstubAllGlobals();
});
function Task({ name, focused = false, handlers, scope = 1 }: { name: string; focused?: boolean; handlers: GamepadActionHandlers; scope?: number }) {
  const pane = useRef<HTMLElement>(null); const composer = useRef<HTMLDivElement>(null);
  useGamepadActions(pane, scope, "session", handlers); useGamepadActions(composer, scope, "composer", handlers);
  return <section className={`session-split-pane${focused ? " is-focused" : ""}`}><main className="session-pane" ref={pane}>
    <div ref={composer}><button>{name}</button></div>
  </main></section>;
}
function Interaction({ target, decide }: { target: Element; decide: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  useGamepadActions(element, "request", "interaction", { approve: decide });
  return createPortal(<div role="dialog" aria-modal="true"><div ref={element}><button>Decision</button></div></div>, target);
}
async function render(children: React.ReactNode): Promise<Root> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root); await act(async () => root.render(children)); return root;
}
function focus(label: string): void { [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!.focus(); }

describe("gamepad action owner routing", () => {
  it("uses the exact focused split and its composer, and uses selected split only when focus is outside tasks", async () => {
    const first = vi.fn(); const second = vi.fn();
    await render(<><Task name="First" focused handlers={{ submit: first, "toggle-plan": first }} /><Task name="Second" handlers={{ submit: second, "toggle-plan": second }} /><button>Sidebar</button></>);
    focus("Second"); dispatchGamepadOwnedAction(document, "submit"); dispatchGamepadOwnedAction(document, "toggle-plan");
    expect(second).toHaveBeenCalledTimes(2); expect(first).not.toHaveBeenCalled();
    focus("Sidebar"); dispatchGamepadOwnedAction(document, "submit"); expect(first).toHaveBeenCalledOnce();
    document.querySelector(".is-focused")!.removeAttribute("class");
    expect(dispatchGamepadOwnedAction(document, "submit")).toBe(false);
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2);
  });

  it("never routes through hidden panes, unrelated popovers, or dialogs into a background task", async () => {
    const submit = vi.fn(); await render(<Task name="Input" focused handlers={{ submit }} />);
    focus("Input"); const pane = document.querySelector(".session-pane")!;
    for (const attribute of ["hidden", "inert", "aria-hidden"]) {
      pane.setAttribute(attribute, attribute === "aria-hidden" ? "true" : "");
      expect(dispatchGamepadOwnedAction(document, "submit")).toBe(false); pane.removeAttribute(attribute);
    }
    const popup = document.body.appendChild(document.createElement("div"));
    popup.innerHTML = '<div role="listbox"><button>Option</button></div>';
    focus("Option"); expect(dispatchGamepadOwnedAction(document, "submit")).toBe(false);
    focus("Input"); document.body.classList.add("modal-open");
    expect(dispatchGamepadOwnedAction(document, "submit")).toBe(false); expect(submit).not.toHaveBeenCalled();
  });

  it("requires the focused portal to own approval and does not confirm an unrelated modal", async () => {
    const approve = vi.fn(); const submit = vi.fn(); const portal = document.body.appendChild(document.createElement("div"));
    await render(<><Task name="Task" focused handlers={{ submit }} /><Interaction target={portal} decide={approve} /></>);
    document.body.classList.add("modal-open"); focus("Decision");
    expect(dispatchGamepadOwnedAction(document, "approve")).toBe(true); expect(approve).toHaveBeenCalledOnce();
    expect(dispatchGamepadOwnedAction(document, "submit")).toBe(false);
    const other = document.body.appendChild(document.createElement("div")); other.innerHTML = '<div role="dialog" aria-modal="true"><button>Delete task</button></div>';
    focus("Delete task"); expect(dispatchGamepadOwnedAction(document, "approve")).toBe(false);
    expect(approve).toHaveBeenCalledOnce(); expect(submit).not.toHaveBeenCalled();
  });

  it("replaces capabilities without replay and retires the exact element on pagehide and unmount", async () => {
    const original = vi.fn(); const replacement = vi.fn();
    const root = await render(<Task name="Input" handlers={{ submit: original }} />);
    focus("Input"); dispatchGamepadOwnedAction(document, "submit"); expect(original).toHaveBeenCalledOnce();
    await act(async () => root.render(<Task name="Input" scope={2} handlers={{ submit: replacement }} />));
    expect(replacement).not.toHaveBeenCalled();
    dispatchGamepadOwnedAction(document, "submit"); expect(replacement).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("pagehide")); expect(dispatchGamepadOwnedAction(document, "submit")).toBe(false);
    await act(async () => root.render(<Task name="Input" scope={2} handlers={{ submit: replacement }} />));
    expect(dispatchGamepadOwnedAction(document, "submit")).toBe(false);
    window.dispatchEvent(new Event("pageshow")); dispatchGamepadOwnedAction(document, "submit"); expect(replacement).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<Task name="Input" scope={3} handlers={{}} />));
    expect(dispatchGamepadOwnedAction(document, "submit")).toBe(false);
    const previous = document.querySelector("[data-gamepad-actions='composer']")!;
    await act(async () => root.render(null)); document.body.append(previous);
    expect(previous.hasAttribute("data-gamepad-actions")).toBe(false);
  });
});
