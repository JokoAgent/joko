// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { GamepadClient, createGamepadDomInput, GAMEPAD_SCROLL_EVENT, GAMEPAD_SKILL_EVENT, GAMEPAD_VOICE_EVENT } from "./gamepad-client.js";
import { createDefaultGamepadPreferences, saveGamepadPreferences, type GamepadInputEffect } from "./gamepad-input.js";

let pads: Gamepad[];
const cleanup: (() => void)[] = [];
beforeEach(() => {
  pads = [pad()];
  window.localStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => pads });
  saveGamepadPreferences({ ...createDefaultGamepadPreferences(), enabled: true });
});
afterEach(() => { cleanup.splice(0).forEach((stop) => stop()); document.body.replaceChildren(); document.body.className = ""; vi.restoreAllMocks(); });

function pad(): Gamepad {
  return { index: 0, id: "Standard controller", mapping: "standard", connected: true,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), axes: [0, 0, 0, 0] } as unknown as Gamepad;
}
function press(index: number, down = true): void {
  const value = pads[0]!;
  pads = [{ ...value, buttons: value.buttons.map((button, i) => i === index ? { pressed: down, touched: down, value: down ? 1 : 0 } : button) }];
}
function sampler(): { client: GamepadClient; effects: GamepadInputEffect[] } {
  const client = new GamepadClient(window); const effects: GamepadInputEffect[] = [];
  cleanup.push(client.start((effect) => effects.push(effect)));
  return { client, effects };
}

describe("gamepad document sampler", () => {
  it("cancels immediately on blur and composition; held input is not replayed on return", () => {
    const { client, effects } = sampler(); client.sample(0); press(6); client.sample(16);
    expect(effects.at(-1)).toEqual({ kind: "action", action: "voice", phase: "press" });
    window.dispatchEvent(new Event("blur"));
    expect(effects.at(-1)).toEqual({ kind: "action", action: "voice", phase: "cancel" });
    const count = effects.length; client.sample(32); expect(effects).toHaveLength(count);
    press(6, false); client.sample(48); press(6); client.sample(64);
    document.dispatchEvent(new Event("compositionstart"));
    expect(effects.at(-1)).toMatchObject({ action: "voice", phase: "cancel" });
    const stopped = effects.length; press(6, false); client.sample(80); press(6); client.sample(96);
    expect(effects).toHaveLength(stopped);
  });
  it("renders preview inputs without dispatching and waits for release after leaving settings", () => {
    const { client, effects } = sampler(); client.sample(0);
    document.body.innerHTML = '<section data-gamepad-preview="true"></section>';
    press(0); client.sample(16);
    expect(client.getSnapshot().devices[0]?.buttons[0]).toBe(true); expect(effects).toEqual([]);
    document.body.replaceChildren(); client.sample(32); expect(effects).toEqual([]);
    press(0, false); client.sample(48); press(0); client.sample(64);
    expect(effects).toContainEqual({ kind: "action", action: "submit", phase: "press" });
  });
  it("surfaces permission failure, retires held work, and recovers without replay", () => {
    const { client, effects } = sampler(); client.sample(0); press(6); client.sample(16);
    const get = vi.spyOn(navigator, "getGamepads").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    client.sample(32); expect(client.getSnapshot().status).toBe("denied"); expect(effects.at(-1)).toMatchObject({ phase: "cancel" });
    const count = effects.length; get.mockImplementation(() => pads); client.sample(48);
    expect(client.getSnapshot().status).toBe("connected"); expect(effects).toHaveLength(count);
  });
  it("starts a fresh composition owner after remount and isolates failing observers and action callbacks", () => {
    const client = new GamepadClient(window);
    client.subscribe(() => { throw new Error("Observer stopped"); });
    const first = client.start(() => {}); document.dispatchEvent(new Event("compositionstart")); first();
    const emit = vi.fn(() => { throw new Error("Action failed"); }); cleanup.push(client.start(emit));
    client.sample(0); press(0); client.sample(16); expect(emit).toHaveBeenCalled(); expect(client.getSnapshot().status).toBe("error");
    press(0, false); client.sample(32); expect(client.getSnapshot().status).toBe("connected");
  });
});

describe("gamepad UI target ownership", () => {
  function task(id: string): HTMLElement {
    const root = document.createElement("section"); root.className = "session-split-pane";
    root.innerHTML = `<main class="session-pane"><div data-timeline-session-id="${id}"></div><div data-gamepad-voice><button>Input</button><div data-composer-editor="true" tabindex="0"></div></div></main>`;
    document.body.append(root); return root;
  }
  it("routes a skill press only to the focused composer outside modal input", () => {
    const first = task("one"); const second = task("two");
    first.querySelector("[data-gamepad-voice]")?.setAttribute("data-gamepad-skill", "true");
    second.querySelector("[data-gamepad-voice]")?.setAttribute("data-gamepad-skill", "true");
    const firstSkill = vi.fn(); const secondSkill = vi.fn();
    first.querySelector("[data-gamepad-skill]")!.addEventListener(GAMEPAD_SKILL_EVENT, firstSkill);
    second.querySelector("[data-gamepad-skill]")!.addEventListener(GAMEPAD_SKILL_EVENT, secondSkill);
    const input = createGamepadDomInput(document, vi.fn());
    const effect = { kind: "skill" as const, binding: { kind: "skill" as const, serverId: "server-one", resourceId: "resource-skill", name: "Review" } };
    first.querySelector("button")!.focus();
    input(effect); expect(firstSkill).toHaveBeenCalledOnce(); expect(secondSkill).not.toHaveBeenCalled();
    document.body.classList.add("modal-open");
    input(effect); expect(firstSkill).toHaveBeenCalledOnce();
    document.body.classList.remove("modal-open");
    second.querySelector("button")!.focus();
    input(effect); expect(secondSkill).toHaveBeenCalledOnce();
  });
  it("holds continuous scrolling on its original task and never transfers held input to another split", () => {
    const first = task("one"); const second = task("two");
    first.querySelector("button")!.focus();
    const firstScroll = vi.fn(); const secondScroll = vi.fn();
    first.querySelector("[data-timeline-session-id]")!.addEventListener(GAMEPAD_SCROLL_EVENT, firstScroll);
    second.querySelector("[data-timeline-session-id]")!.addEventListener(GAMEPAD_SCROLL_EVENT, secondScroll);
    const input = createGamepadDomInput(document, vi.fn());
    input({ kind: "scroll", x: 0, y: -20 }); expect(firstScroll).toHaveBeenCalledOnce();
    second.querySelector("button")!.focus(); input({ kind: "scroll", x: 0, y: -20 });
    expect(secondScroll).not.toHaveBeenCalled();
    input({ kind: "scroll", x: 0, y: 0 }); input({ kind: "scroll", x: 0, y: -20 }); expect(secondScroll).toHaveBeenCalledOnce();
  });
  it("cancels voice at the exact original target after focus changes", () => {
    const first = task("one"); const second = task("two"); first.querySelector("button")!.focus();
    const original = vi.fn(); const other = vi.fn();
    first.querySelector("[data-gamepad-voice]")!.addEventListener(GAMEPAD_VOICE_EVENT, original);
    second.querySelector("[data-gamepad-voice]")!.addEventListener(GAMEPAD_VOICE_EVENT, other);
    const input = createGamepadDomInput(document, vi.fn()); input({ kind: "action", action: "voice", phase: "press" });
    second.querySelector("button")!.focus(); input({ kind: "action", action: "voice", phase: "cancel" });
    expect(original.mock.calls.map(([event]) => event.detail)).toEqual(["press", "cancel"]); expect(other).not.toHaveBeenCalled();
  });
  it("respects modal and inert boundaries while using explicit focus activation and Escape", () => {
    const root = task("one"); const target = root.querySelector("button")!; target.focus();
    const clicked = vi.fn(); const back = vi.fn(); target.addEventListener("click", clicked); target.addEventListener("keydown", back);
    const navigate = vi.fn(); const input = createGamepadDomInput(document, navigate);
    document.body.classList.add("modal-open");
    input({ kind: "action", action: "new-task", phase: "press" }); expect(navigate).not.toHaveBeenCalled();
    input({ kind: "action", action: "activate", phase: "press" }); expect(clicked).toHaveBeenCalledOnce();
    input({ kind: "action", action: "back", phase: "press" }); expect(back.mock.calls[0]?.[0].key).toBe("Escape");
    root.setAttribute("inert", ""); input({ kind: "action", action: "activate", phase: "press" }); expect(clicked).toHaveBeenCalledOnce();
  });
  it("admits skill-library navigation only from the active host surface", () => {
    const navigate = vi.fn();
    const input = createGamepadDomInput(document, navigate);
    const pressSkills = (): void => input({ kind: "action", action: "open-skills", phase: "press" });
    pressSkills(); expect(navigate).toHaveBeenCalledTimes(1);
    document.body.classList.add("modal-open"); pressSkills(); expect(navigate).toHaveBeenCalledTimes(1);
    document.body.classList.remove("modal-open");
    const frame = document.body.appendChild(document.createElement("iframe")); frame.focus();
    pressSkills(); expect(navigate).toHaveBeenCalledTimes(1);
    const preview = document.body.appendChild(document.createElement("button")); preview.dataset.messageRewindPreview = "true"; preview.focus();
    pressSkills(); expect(navigate).toHaveBeenCalledTimes(1);
    preview.removeAttribute("data-message-rewind-preview");
    document.body.dataset.appShortcutRecording = "1"; pressSkills(); expect(navigate).toHaveBeenCalledTimes(1);
    delete document.body.dataset.appShortcutRecording;
    pressSkills(); expect(navigate).toHaveBeenCalledTimes(2);
  });
  it("keeps schedule navigation in the same host boundary", () => {
    const navigate = vi.fn();
    const input = createGamepadDomInput(document, navigate);
    const press = (): void => input({ kind: "action", action: "open-schedules", phase: "press" });
    const frame = document.body.appendChild(document.createElement("iframe")); frame.focus();
    press(); expect(navigate).not.toHaveBeenCalled();
    frame.remove(); document.body.focus();
    document.body.dataset.appShortcutRecording = "1"; press(); expect(navigate).not.toHaveBeenCalled();
    delete document.body.dataset.appShortcutRecording;
    press(); expect(navigate).toHaveBeenCalledWith("open-schedules");
  });
  it("admits page history only from the visible focused host outside modal, preview and shortcut recording", () => {
    const navigate = vi.fn();
    const input = createGamepadDomInput(document, navigate);
    const press = (action: "navigate-back" | "navigate-forward"): void => input({ kind: "action", action, phase: "press" });
    press("navigate-back"); press("navigate-forward");
    expect(navigate.mock.calls.map(([action]) => action)).toEqual(["navigate-back", "navigate-forward"]);
    document.body.classList.add("modal-open"); press("navigate-back");
    document.body.classList.remove("modal-open");
    const preview = document.body.appendChild(document.createElement("div")); preview.dataset.gamepadPreview = "true";
    press("navigate-forward"); preview.remove();
    document.body.dataset.appShortcutRecording = "1"; press("navigate-back");
    delete document.body.dataset.appShortcutRecording;
    const frame = document.body.appendChild(document.createElement("iframe")); frame.focus(); press("navigate-forward"); frame.remove();
    vi.spyOn(document, "hasFocus").mockReturnValue(false); press("navigate-back");
    expect(navigate).toHaveBeenCalledTimes(2);
  });
  it("routes inspector commands only while the focused task surface can act", () => {
    const root = task("one"); root.querySelector("button")!.focus();
    const navigate = vi.fn();
    const input = createGamepadDomInput(document, navigate);
    for (const action of ["open-terminal", "open-browser-tab", "toggle-review-tab"] as const) {
      input({ kind: "action", action, phase: "press" });
    }
    expect(navigate.mock.calls.map(([action]) => action)).toEqual(["open-terminal", "open-browser-tab", "toggle-review-tab"]);
    document.body.dataset.appShortcutRecording = "1";
    input({ kind: "action", action: "open-terminal", phase: "press" });
    delete document.body.dataset.appShortcutRecording;
    document.body.classList.add("modal-open");
    input({ kind: "action", action: "open-browser-tab", phase: "press" });
    document.body.classList.remove("modal-open");
    const frame = document.body.appendChild(document.createElement("iframe")); frame.focus();
    input({ kind: "action", action: "toggle-review-tab", phase: "press" });
    expect(navigate).toHaveBeenCalledTimes(3);
  });
  it("focuses the real new-task composer without selecting another task", () => {
    document.body.innerHTML = '<main class="new-task-page"><div data-composer-editor="true" tabindex="0"></div></main>';
    createGamepadDomInput(document, vi.fn())({ kind: "action", action: "focus-composer", phase: "press" });
    expect(document.activeElement?.matches("[data-composer-editor='true']")).toBe(true);
  });
  it("does not fall back to another selected task from hidden or embedded focus", () => {
    const first = task("one"); const second = task("two");
    first.classList.add("is-focused"); second.querySelector("button")!.focus(); second.hidden = true;
    const voice = vi.fn(); const scroll = vi.fn();
    first.querySelector("[data-gamepad-voice]")!.addEventListener(GAMEPAD_VOICE_EVENT, voice);
    first.querySelector("[data-timeline-session-id]")!.addEventListener(GAMEPAD_SCROLL_EVENT, scroll);
    const input = createGamepadDomInput(document, vi.fn());
    input({ kind: "action", action: "voice", phase: "press" }); input({ kind: "scroll", x: 0, y: 10 });
    expect(voice).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled();
    const frame = document.body.appendChild(document.createElement("iframe")); frame.focus();
    input({ kind: "action", action: "voice", phase: "press" }); input({ kind: "scroll", x: 0, y: 0 }); input({ kind: "scroll", x: 0, y: 10 });
    expect(voice).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled();
  });
});
