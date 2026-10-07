// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InteractionLock, InteractionLockManager } from "../interaction-ownership-coordinator.js";
import type { InteractionView } from "../model.js";
import { VisualHarness } from "./VisualHarness.js";
import { VisualInteractionFixture, VISUAL_INTERACTION_SETTLE_EVENT, type VisualInteractionState } from "./VisualInteractionFixture.js";

let root: Root | undefined;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState(null, "", "/__visual-harness__?scenario=interaction&theme=light");
  Object.defineProperty(window.navigator, "locks", { configurable: true, value: new FixtureLocks() });
  Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: class {
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {}
  } });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((media: string) => ({
    matches: false, media, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(() => true)
  })) });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  window.localStorage.clear();
  delete document.documentElement.dataset.harnessLastAction;
  delete document.documentElement.dataset.visualHarness;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.harnessInteractionState;
  Reflect.deleteProperty(window.navigator, "locks");
  Reflect.deleteProperty(window, "BroadcastChannel");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
});

describe("Interaction visual harness", () => {
  it("keeps one typed pending decision and preserves question and plan drafts through explicit failure and retry", async () => {
    await renderHarness();
    expect(state()).toMatchObject({ activeId: "visual-interaction-permission", phase: "ready", totalAttempts: 0 });
    expect(container.querySelector(".permission-subject")?.textContent).toContain("src/App.tsx");
    const allow = button("Allow once");
    await click(allow);
    expect(state()).toMatchObject({ phase: "pending", attempt: 1, totalAttempts: 1,
      pending: { kind: "permission", action: "resolve", decisionId: "1" } });
    expect(allow.disabled).toBe(true);
    expect(container.querySelector(".interaction-dialog")?.getAttribute("aria-busy")).toBe("true");
    await click(allow);
    expect(state().totalAttempts).toBe(1);
    await settle("failure");
    expect(container.textContent).toContain("The deterministic interaction request failed. Retry the same decision.");
    expect(allow.disabled).toBe(false);
    await click(allow);
    await settle("success", 1);
    expect(state()).toMatchObject({ phase: "pending", attempt: 2, confirmed: [] });
    await settle("success");
    expect(state()).toMatchObject({ activeId: "visual-interaction-question", phase: "ready", confirmed: [{ kind: "permission", attempt: 2 }] });

    const summary = required(container.querySelector<HTMLTextAreaElement>(".question-field textarea"));
    expect(button("Continue").disabled).toBe(true);
    await input(summary, "Keep the scoped UI evidence and recovery draft.");
    await click(button("Minimize without answering"));
    expect(container.querySelector(".interaction-takeover-minimized")).not.toBeNull();
    await click(required(container.querySelector<HTMLButtonElement>(".interaction-takeover-minimized")));
    expect(container.querySelector<HTMLTextAreaElement>(".question-field textarea")?.value).toBe("Keep the scoped UI evidence and recovery draft.");
    await click(button("Continue"), 240);
    await click(required(container.querySelector<HTMLButtonElement>('[data-question-other-toggle="density"]')));
    await input(required(container.querySelector<HTMLTextAreaElement>('[data-question-other-input="density"]')), "Use a tested narrow layout");
    await click(required(container.querySelector<HTMLButtonElement>('.question-choice-other__editor [aria-label="Continue"]')), 240);
    await click(choice("Geometry"));
    await click(required(container.querySelector<HTMLButtonElement>('[data-question-other-toggle="evidence"]')));
    await input(required(container.querySelector<HTMLTextAreaElement>('[data-question-other-input="evidence"]')), "Retain retry evidence");
    expect(choice("Keyboard").disabled).toBe(true);
    await click(button("Continue"), 240);
    await click(required(container.querySelector<HTMLButtonElement>('.question-field [role="radio"]')));
    await click(button("Submit answers"));
    expect(state()).toMatchObject({ phase: "pending", pending: { kind: "question",
      answeredFieldIds: ["summary", "density", "evidence", "approved"] } });
    await settle("failure");
    expect(container.querySelector('.question-field [role="radio"]')?.getAttribute("aria-checked")).toBe("true");
    await click(button("Back"), 240);
    expect(container.querySelector<HTMLTextAreaElement>('[data-question-other-input="evidence"]')?.value).toBe("Retain retry evidence");
    await click(button("Continue"), 240);
    await click(button("Submit answers"));
    await settle("success");

    expect(state()).toMatchObject({ activeId: "visual-interaction-plan", phase: "ready" });
    expect(container.querySelector(".plan-preview")?.textContent).toContain("Scoped implementation");
    expect(container.querySelectorAll(".plan-step-list li")).toHaveLength(3);
    await click(required(container.querySelector<HTMLButtonElement>(".plan-feedback__row")));
    const feedback = required(container.querySelector<HTMLTextAreaElement>('[aria-label="Request changes"]'));
    await input(feedback, "Keep the draft after an explicit failure.");
    await act(async () => feedback.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => wait(40));
    expect(state().totalAttempts).toBe(4);
    expect(container.querySelector(".plan-feedback__editor")).toBeNull();
    expect(document.activeElement?.className).toBe("plan-feedback__row");
    await click(required(container.querySelector<HTMLButtonElement>(".plan-feedback__row")));
    await input(required(container.querySelector<HTMLTextAreaElement>('[aria-label="Request changes"]')), "Capture the same recovery state on both layouts.");
    await click(required(container.querySelector<HTMLButtonElement>('[aria-label="Submit plan feedback"]')));
    expect(state().pending).toMatchObject({ kind: "plan", decisionId: "3", feedbackLength: 48 });
    await settle("failure");
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Request changes"]')?.value).toBe("Capture the same recovery state on both layouts.");
    await click(required(container.querySelector<HTMLButtonElement>('[aria-label="Submit plan feedback"]')));
    await settle("success");
    expect(state()).toMatchObject({ phase: "completed", totalAttempts: 6, failedAttempts: 3 });
    expect(state().confirmed.map((value) => value.kind)).toEqual(["permission", "question", "plan"]);
    expect(container.querySelector(".interaction-takeover")).toBeNull();
  }, 15_000);

  it("retires pending fixture work and rejects old attempt releases after reset or disposal", async () => {
    const request: InteractionView = { id: "request", sessionId: "session", generation: 1n, kind: "permission",
      title: "Permission", message: "Read the scoped file", options: [{ id: "1", label: "Allow once" }], fields: [], planSteps: [], createdAt: 1 };
    const fixture = new VisualInteractionFixture([request]);
    const first = fixture.begin(request, { kind: "permission", decisionId: "1" });
    const rejected = expect(first).rejects.toThrow("owner retired");
    fixture.cancelPending();
    await rejected;
    const ownerId = fixture.state.ownerId;
    expect(fixture.settle({ ownerId, interactionId: request.id, attempt: 1, outcome: "success" })).toBe(false);
    const second = fixture.begin(request, { kind: "permission", decisionId: "1" });
    expect(fixture.settle({ ownerId, interactionId: request.id, attempt: 1, outcome: "success" })).toBe(false);
    expect(fixture.settle({ ownerId, interactionId: "other", attempt: 2, outcome: "success" })).toBe(false);
    expect(fixture.settle({ ownerId, interactionId: request.id, attempt: 2, outcome: "success" })).toBe(true);
    await second;
    expect(fixture.settle({ ownerId, interactionId: request.id, attempt: 2, outcome: "success" })).toBe(false);
    expect(fixture.state.confirmed).toHaveLength(1);
    const replacement = new VisualInteractionFixture([request]);
    const replacementPending = replacement.begin(request, { kind: "permission", decisionId: "1" });
    expect(replacement.settle({ ownerId, interactionId: request.id, attempt: 1, outcome: "success" })).toBe(false);
    expect(replacement.settle({ ownerId: replacement.state.ownerId, interactionId: request.id, attempt: 1, outcome: "success" })).toBe(true);
    await replacementPending;

    await renderHarness();
    await click(button("Allow once"));
    const pending = state().pending;
    const mountedOwnerId = state().ownerId;
    expect(pending).toBeDefined();
    await act(async () => root?.unmount());
    root = undefined;
    expect(document.documentElement.dataset.harnessInteractionState).toBeUndefined();
    window.dispatchEvent(new CustomEvent(VISUAL_INTERACTION_SETTLE_EVENT, { detail: { ownerId: mountedOwnerId, ...pending, outcome: "success" } }));
    expect(document.documentElement.dataset.harnessInteractionState).toBeUndefined();
  });
});

async function renderHarness(): Promise<void> {
  await Promise.all([import("../components/SessionPane.js"), import("../components/SettingsPage.js")]);
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => { root?.render(<VisualHarness />); await wait(100); });
}
function state(): VisualInteractionState {
  return JSON.parse(required(document.documentElement.dataset.harnessInteractionState)) as VisualInteractionState;
}
function button(label: string): HTMLButtonElement {
  return required([...container.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.trim() === label
    || value.querySelector("strong")?.textContent?.trim() === label || value.getAttribute("aria-label") === label));
}
function choice(label: string): HTMLButtonElement {
  const control = [...container.querySelectorAll<HTMLLabelElement>(".question-choice-grid label")]
    .find((value) => value.querySelector("strong")?.textContent === label)?.querySelector<HTMLButtonElement>("button");
  if (control === undefined || control === null) throw new Error(`Expected choice ${label}; observed ${container.querySelector(".question-form")?.textContent}`);
  return control;
}
async function click(control: HTMLButtonElement, delay = 35): Promise<void> {
  await act(async () => { control.click(); await wait(delay); });
}
async function input(control: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(20);
  });
}
async function settle(outcome: "failure" | "success", attempt?: number): Promise<void> {
  const pending = required(state().pending);
  await act(async () => {
    window.dispatchEvent(new CustomEvent(VISUAL_INTERACTION_SETTLE_EVENT, { detail: {
      ownerId: state().ownerId, interactionId: pending.interactionId, attempt: attempt ?? pending.attempt, outcome
    } }));
    await wait(35);
  });
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected the interaction fixture control to exist.");
  return value;
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

// The real coordinator owns each scope; this only supplies jsdom's missing Web Locks API.
class FixtureLocks implements InteractionLockManager {
  readonly #active = new Set<string>();
  readonly #queues = new Map<string, Array<() => void>>();
  request<T>(name: string, options: { readonly mode: "exclusive"; readonly ifAvailable?: boolean; readonly signal?: AbortSignal }, callback: (lock: InteractionLock | null) => Promise<T> | T): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (this.#active.has(name) && options.ifAvailable) return Promise.resolve().then(() => callback(null));
    return new Promise<T>((resolve, reject) => {
      const acquire = (): void => {
        if (options.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); drain(); return; }
        this.#active.add(name);
        Promise.resolve().then(() => callback({ name })).then(resolve, reject).finally(() => {
          this.#active.delete(name); drain();
        });
      };
      const drain = (): void => {
        const queue = this.#queues.get(name);
        const next = queue?.shift();
        if (queue?.length === 0) this.#queues.delete(name);
        next?.();
      };
      if (this.#active.has(name)) {
        const queue = this.#queues.get(name) ?? [];
        queue.push(acquire); this.#queues.set(name, queue);
      } else acquire();
    });
  }
}
