// @vitest-environment jsdom
import { act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { InteractionView } from "../model.js";
import { dispatchGamepadOwnedAction } from "../gamepad-actions.js";
import type { RunAction } from "./types.js";
import type { InteractionLock, InteractionLockManager } from "../interaction-ownership-coordinator.js";
import { InteractionDialog } from "./InteractionDialog.js";

const roots: Root[] = [];
type BrowsingContextWindow = Window & typeof globalThis;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
});

afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  document.body.className = "";
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const permission: InteractionView = {
  id: "permission",
  sessionId: "task",
  generation: 1n,
  kind: "permission",
  title: "Permission request",
  message: "Inspect workspace",
  fields: [],
  planSteps: [],
  createdAt: 1,
  options: [
    { id: "1", label: "Allow once" },
    { id: "4", label: "Reject" }
  ]
};

const plan: InteractionView = {
  ...permission,
  id: "plan",
  kind: "plan",
  title: "Review plan",
  message: "Do the work",
  planMarkdown: "Do the work",
  options: [
    { id: "1", label: "Execute plan" },
    { id: "3", label: "Refine plan" }
  ]
};

const question: InteractionView = {
  ...permission,
  id: "question",
  kind: "question",
  title: "Choose an approach",
  options: [],
  fields: [{
    id: "approach",
    label: "Approach",
    required: true,
    kind: "single",
    options: [{ id: "guided", label: "Guided" }],
    multiline: false,
    minimumSelections: 0,
    allowOther: true
  }]
};

const twoStepQuestion: InteractionView = {
  ...question,
  id: "two-step-question",
  fields: [
    question.fields[0]!,
    {
      id: "details",
      label: "Details",
      required: true,
      kind: "text",
      options: [],
      multiline: false,
      minimumSelections: 0,
      allowOther: false
    }
  ]
};

describe("InteractionDialog portal ownership", () => {
  it("does not treat an iframe-realm editor as a permission shortcut target", async () => {
    const resolveInteraction = vi.fn(async () => undefined);
    const dismissInteraction = vi.fn(async () => undefined);
    const view = await mountPortal(permission, { resolveInteraction, dismissInteraction });
    const editor = view.document.createElement("textarea");
    view.dialog().append(editor);
    editor.focus();

    await act(async () => {
      press(view.window, editor, "Enter");
      press(view.window, editor, "Escape");
    });

    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(dismissInteraction).not.toHaveBeenCalled();
  });

  it("binds plan shortcuts to the portal owner, ignores its editors, and retires during pagehide", async () => {
    const resolveInteraction = vi.fn(async () => undefined);
    const dismissInteraction = vi.fn(async () => undefined);
    const view = await mountPortal(plan, { resolveInteraction, dismissInteraction });
    await view.flushAnimationFrames();
    const feedbackRow = view.document.querySelector<HTMLButtonElement>(".plan-feedback__row");
    await act(async () => feedbackRow?.click());
    await view.flushAnimationFrames();
    const feedbackEditor = view.document.querySelector<HTMLTextAreaElement>(".plan-feedback__editor textarea");
    expect(view.document.activeElement).toBe(feedbackEditor);
    await act(async () => press(view.window, feedbackEditor!, "Escape"));
    await view.flushAnimationFrames();
    expect(view.document.activeElement).toBe(view.document.querySelector(".plan-feedback__row"));

    const outsideEditor = view.document.body.appendChild(view.document.createElement("textarea"));
    outsideEditor.focus();

    await act(async () => {
      press(view.window, outsideEditor, "Enter");
      press(view.window, outsideEditor, "Escape");
    });
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(dismissInteraction).not.toHaveBeenCalled();

    view.window.dispatchEvent(new view.window.Event("pagehide"));
    view.dialog().focus();
    await act(async () => press(view.window, view.dialog(), "Enter"));
    expect(resolveInteraction).not.toHaveBeenCalled();

    await act(async () => view.window.dispatchEvent(new view.window.Event("pageshow")));
    await view.flushCoordination();
    await act(async () => press(view.window, view.dialog(), "Enter"));
    expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(plan, { kind: "plan", decisionId: "1", feedback: "" });
    expect(dismissInteraction).not.toHaveBeenCalled();
  });

  it("handles a minimized permission only from its own live window and leaves editor Escape alone", async () => {
    const resolveInteraction = vi.fn(async () => undefined);
    const dismissInteraction = vi.fn(async () => undefined);
    const view = await mountPortal(permission, { resolveInteraction, dismissInteraction }, false);
    const minimize = [...view.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === "interaction.minimize");
    expect(minimize).toBeDefined();
    await act(async () => minimize?.click());
    await view.flushAnimationFrames();
    const minimized = view.document.querySelector<HTMLButtonElement>(".interaction-minimized");
    expect(minimized).not.toBeNull();
    expect(view.document.activeElement).toBe(minimized);

    const editor = view.document.body.appendChild(view.document.createElement("textarea"));
    editor.focus();
    await act(async () => press(view.window, editor, "Escape"));
    expect(resolveInteraction).not.toHaveBeenCalled();
    expect(dismissInteraction).not.toHaveBeenCalled();

    view.window.dispatchEvent(new view.window.Event("pagehide"));
    minimized?.focus();
    await act(async () => press(view.window, minimized!, "Escape"));
    expect(resolveInteraction).not.toHaveBeenCalled();
    await act(async () => view.window.dispatchEvent(new view.window.Event("pageshow")));
    await view.flushCoordination();
    const restoredMinimized = view.document.querySelector<HTMLButtonElement>(".interaction-minimized")!;
    await act(async () => press(view.window, restoredMinimized, "Escape"));
    expect(resolveInteraction).toHaveBeenCalledExactlyOnceWith(permission, { kind: "permission", decisionId: "4" });
  });

  it("elects one permission owner and fences observer click, keyboard, gamepad, and stale takeover actions", async () => {
    const browser = new PortalQuestionDraftBrowser();
    const firstResolve = vi.fn(async () => undefined);
    const secondResolve = vi.fn(async () => undefined);
    const first = await mountPortal(permission, { resolveInteraction: firstResolve, dismissInteraction: vi.fn(async () => undefined) }, true, browser);
    const second = await mountPortal(permission, { resolveInteraction: secondResolve, dismissInteraction: vi.fn(async () => undefined) }, true, browser);
    await first.flushCoordination(); await second.flushCoordination();
    const views = [first, second] as const;
    const owner = views.find((view) => view.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled === false)!;
    const observer = owner === first ? second : first;
    expect(views.filter((view) => view.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled === false)).toHaveLength(1);
    const observerAllow = observer.document.querySelector<HTMLButtonElement>(".decision-option")!;
    await act(async () => {
      observerAllow.click();
      press(observer.window, observer.dialog(), "Enter");
      press(observer.window, observer.dialog(), "Escape");
      dispatchGamepadOwnedAction(observer.document, "approve");
      dispatchGamepadOwnedAction(observer.document, "reject");
    });
    expect(firstResolve).not.toHaveBeenCalled(); expect(secondResolve).not.toHaveBeenCalled();

    const continueHere = [...observer.document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "interaction.ownershipContinueHere")!;
    await act(async () => continueHere.click());
    await first.flushCoordination(); await second.flushCoordination();
    expect(owner.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    expect(observer.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(false);
    await act(async () => {
      owner.document.querySelector<HTMLButtonElement>(".decision-option")?.click();
      observer.document.querySelector<HTMLButtonElement>(".decision-option")?.click();
      await Promise.all(observer.pending);
    });
    const winner = observer === first ? firstResolve : secondResolve;
    const loser = observer === first ? secondResolve : firstResolve;
    expect(winner).toHaveBeenCalledOnce(); expect(loser).not.toHaveBeenCalled();
  });

  it("lets a modal permission observer minimize and restore locally without changing ownership", async () => {
    const browser = new PortalQuestionDraftBrowser();
    const firstResolve = vi.fn(async () => undefined);
    const firstDismiss = vi.fn(async () => undefined);
    const secondResolve = vi.fn(async () => undefined);
    const secondDismiss = vi.fn(async () => undefined);
    const first = await mountPortal(permission, { resolveInteraction: firstResolve, dismissInteraction: firstDismiss }, false, browser);
    const second = await mountPortal(permission, { resolveInteraction: secondResolve, dismissInteraction: secondDismiss }, false, browser);
    await first.flushCoordination();
    await second.flushCoordination();

    const views = [first, second] as const;
    const owner = views.find((view) => view.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled === false)!;
    const observer = owner === first ? second : first;
    const close = observer.document.querySelector<HTMLButtonElement>("button[aria-label='interaction.minimize']");
    expect(close).not.toBeNull();

    await act(async () => close?.click());
    await observer.flushAnimationFrames();
    const minimized = observer.document.querySelector<HTMLButtonElement>(".interaction-minimized");
    expect(minimized).not.toBeNull();
    expect(minimized?.disabled).toBe(false);
    expect(owner.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(false);
    expect(firstResolve).not.toHaveBeenCalled();
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(secondResolve).not.toHaveBeenCalled();
    expect(secondDismiss).not.toHaveBeenCalled();

    await act(async () => minimized?.click());
    await observer.flushAnimationFrames();
    expect(observer.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    expect([...observer.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "interaction.ownershipContinueHere")).toBeDefined();
    expect(owner.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(false);

    await act(async () => press(observer.window, observer.dialog(), "Escape"));
    await observer.flushAnimationFrames();
    expect(observer.document.querySelector(".interaction-minimized")).not.toBeNull();
    expect(owner.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(false);
    expect(firstResolve).not.toHaveBeenCalled();
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(secondResolve).not.toHaveBeenCalled();
    expect(secondDismiss).not.toHaveBeenCalled();
  });

  it("moves focus from a fenced owner control to the final takeover control", async () => {
    const browser = new PortalQuestionDraftBrowser();
    const first = await mountPortal(permission, {
      resolveInteraction: vi.fn(async () => undefined),
      dismissInteraction: vi.fn(async () => undefined)
    }, true, browser);
    const second = await mountPortal(permission, {
      resolveInteraction: vi.fn(async () => undefined),
      dismissInteraction: vi.fn(async () => undefined)
    }, true, browser);
    await first.flushCoordination();
    await second.flushCoordination();

    const views = [first, second] as const;
    const owner = views.find((view) => view.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled === false)!;
    const observer = owner === first ? second : first;
    const ownerDecision = owner.document.querySelector<HTMLButtonElement>(".decision-option")!;
    ownerDecision.focus();
    expect(owner.document.activeElement).toBe(ownerDecision);

    const continueHere = [...observer.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "interaction.ownershipContinueHere")!;
    await act(async () => continueHere.click());
    await owner.flushCoordination();
    await observer.flushCoordination();
    await owner.flushAnimationFrames();

    const formerOwnerTakeover = [...owner.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "interaction.ownershipContinueHere");
    expect(owner.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    expect(formerOwnerTakeover).toBeDefined();
    expect(owner.document.activeElement).toBe(formerOwnerTakeover);
  });

  it("keeps permission ownership through pagehide settle and restores a live peer after RPC failure", async () => {
    const browser = new PortalQuestionDraftBrowser();
    let reject!: (reason: Error) => void;
    const firstResolve = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const first = await mountPortal(permission, { resolveInteraction: firstResolve, dismissInteraction: vi.fn(async () => undefined) }, true, browser);
    await act(async () => first.document.querySelector<HTMLButtonElement>(".decision-option")!.click());
    await act(async () => first.window.dispatchEvent(new first.window.Event("pagehide")));
    const secondResolve = vi.fn(async () => undefined);
    const second = await mountPortal(permission, { resolveInteraction: secondResolve, dismissInteraction: vi.fn(async () => undefined) }, true, browser);
    await second.flushCoordination();
    expect(second.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    reject(new Error("RPC failed"));
    await expect(first.pending[0]).rejects.toThrow("RPC failed");
    await first.flushCoordination(); await second.flushCoordination();
    expect({ disabled: second.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled,
      status: second.document.querySelector(".interaction-ownership")?.textContent }).toEqual({ disabled: false, status: undefined });
  });

  it("restores the same visible window when it resumes before its in-flight settle fails", async () => {
    const browser = new PortalQuestionDraftBrowser();
    let reject!: (reason: Error) => void;
    const resolveInteraction = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const view = await mountPortal(permission, { resolveInteraction, dismissInteraction: vi.fn(async () => undefined) }, true, browser);

    await act(async () => view.document.querySelector<HTMLButtonElement>(".decision-option")!.click());
    await act(async () => {
      view.window.dispatchEvent(new view.window.Event("pagehide"));
      view.window.dispatchEvent(new view.window.Event("pageshow"));
    });
    reject(new Error("RPC failed after pageshow"));
    await expect(view.pending[0]).rejects.toThrow("RPC failed after pageshow");
    await view.flushCoordination();

    expect(resolveInteraction).toHaveBeenCalledOnce();
    expect(view.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(false);
    expect(view.document.querySelector(".interaction-ownership")).toBeNull();
  });

  it("keeps a peer hidden before settle terminal after the owner releases its lock", async () => {
    const browser = new PortalQuestionDraftBrowser();
    const resolves = [vi.fn(async () => undefined), vi.fn(async () => undefined), vi.fn(async () => undefined)] as const;
    const views = [
      await mountPortal(permission, { resolveInteraction: resolves[0], dismissInteraction: vi.fn(async () => undefined) }, true, browser),
      await mountPortal(permission, { resolveInteraction: resolves[1], dismissInteraction: vi.fn(async () => undefined) }, true, browser),
      await mountPortal(permission, { resolveInteraction: resolves[2], dismissInteraction: vi.fn(async () => undefined) }, true, browser)
    ] as const;
    for (const view of views) await view.flushCoordination();
    const ownerIndex = views.findIndex((view) => view.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled === false);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    const hiddenIndex = [0, 1, 2].find((index) => index !== ownerIndex)!;
    const owner = views[ownerIndex]!;
    const hiddenPeer = views[hiddenIndex]!;

    await act(async () => hiddenPeer.window.dispatchEvent(new hiddenPeer.window.Event("pagehide")));
    await act(async () => owner.document.querySelector<HTMLButtonElement>(".decision-option")!.click());
    await Promise.all(owner.pending);
    await act(async () => owner.window.dispatchEvent(new owner.window.Event("pagehide")));
    await owner.flushCoordination();
    await act(async () => hiddenPeer.window.dispatchEvent(new hiddenPeer.window.Event("pageshow")));
    await hiddenPeer.flushCoordination();

    expect(hiddenPeer.document.querySelector(".interaction-ownership")?.textContent).toContain("interaction.ownershipSettled");
    expect(hiddenPeer.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    expect([...hiddenPeer.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "interaction.ownershipContinueHere")).toBeUndefined();
    await act(async () => {
      hiddenPeer.document.querySelector<HTMLButtonElement>(".decision-option")?.click();
      press(hiddenPeer.window, hiddenPeer.dialog(), "Enter");
      dispatchGamepadOwnedAction(hiddenPeer.document, "approve");
    });
    expect(resolves[hiddenIndex]).not.toHaveBeenCalled();
    expect(resolves.reduce((total, resolve) => total + resolve.mock.calls.length, 0)).toBe(1);
  });

  it("keeps a peer terminal after successful settle and pagehide while projection is delayed", async () => {
    const browser = new PortalQuestionDraftBrowser();
    const firstResolve = vi.fn(async () => undefined);
    const firstDismiss = vi.fn(async () => undefined);
    const secondResolve = vi.fn(async () => undefined);
    const secondDismiss = vi.fn(async () => undefined);
    const first = await mountPortal(permission, { resolveInteraction: firstResolve, dismissInteraction: firstDismiss }, false, browser);
    const second = await mountPortal(permission, { resolveInteraction: secondResolve, dismissInteraction: secondDismiss }, false, browser);
    await first.flushCoordination();
    await second.flushCoordination();

    const views = [first, second] as const;
    const owner = views.find((view) => view.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled === false)!;
    const peer = owner === first ? second : first;
    const ownerResolve = owner === first ? firstResolve : secondResolve;
    const peerResolve = owner === first ? secondResolve : firstResolve;
    const ownerDismiss = owner === first ? firstDismiss : secondDismiss;
    const peerDismiss = owner === first ? secondDismiss : firstDismiss;

    await act(async () => owner.document.querySelector<HTMLButtonElement>(".decision-option")?.click());
    await Promise.all(owner.pending);
    expect(owner.document.querySelector(".interaction-ownership")?.textContent).toContain("interaction.ownershipSettled");
    expect(owner.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    await act(async () => owner.window.dispatchEvent(new owner.window.Event("pagehide")));
    await peer.flushCoordination();
    await act(async () => {
      owner.window.dispatchEvent(new owner.window.Event("pageshow"));
      peer.window.dispatchEvent(new peer.window.Event("pagehide"));
      peer.window.dispatchEvent(new peer.window.Event("pageshow"));
    });
    await owner.flushCoordination();
    await peer.flushCoordination();

    expect(ownerResolve).toHaveBeenCalledOnce();
    expect(ownerDismiss).not.toHaveBeenCalled();
    expect(owner.document.querySelector(".interaction-ownership")?.textContent).toContain("interaction.ownershipSettled");
    expect(owner.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    expect(peer.document.querySelector(".interaction-ownership")?.textContent).toContain("interaction.ownershipSettled");
    expect([...peer.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "interaction.ownershipContinueHere")).toBeUndefined();
    expect(peer.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);

    await act(async () => {
      peer.document.querySelector<HTMLButtonElement>(".decision-option")?.click();
      press(peer.window, peer.dialog(), "Enter");
      dispatchGamepadOwnedAction(peer.document, "approve");
      dispatchGamepadOwnedAction(peer.document, "reject");
    });
    expect(peerResolve).not.toHaveBeenCalled();
    expect(peerDismiss).not.toHaveBeenCalled();

    const close = peer.document.querySelector<HTMLButtonElement>("button[aria-label='interaction.minimize']");
    expect(close).not.toBeNull();
    await act(async () => close?.click());
    await peer.flushAnimationFrames();
    const minimized = peer.document.querySelector<HTMLButtonElement>(".interaction-minimized");
    expect(minimized).not.toBeNull();
    await act(async () => press(peer.window, minimized!, "Escape"));
    expect(peer.document.querySelector(".interaction-minimized")).not.toBeNull();
    expect(peerResolve).not.toHaveBeenCalled();
    expect(peerDismiss).not.toHaveBeenCalled();

    await act(async () => minimized?.click());
    await peer.flushAnimationFrames();
    expect(peer.document.querySelector(".interaction-ownership")?.textContent).toContain("interaction.ownershipSettled");
    expect(peer.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    expect([...peer.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "interaction.ownershipContinueHere")).toBeUndefined();
    expect(peerResolve).not.toHaveBeenCalled();
    expect(peerDismiss).not.toHaveBeenCalled();
  });

  it("does not let an old generation rejection clear the new generation action", async () => {
    const completions: Array<{ resolve: () => void; reject: (reason: Error) => void }> = [];
    const resolveInteraction = vi.fn(() => new Promise<void>((resolve, reject) => completions.push({ resolve, reject })));
    const view = await mountPortal(permission, { resolveInteraction, dismissInteraction: vi.fn(async () => undefined) });
    await act(async () => view.document.querySelector<HTMLButtonElement>(".decision-option")!.click());
    const revised = { ...permission, generation: 2n };
    await view.render(revised);
    await act(async () => view.document.querySelector<HTMLButtonElement>(".decision-option")!.click());
    expect(resolveInteraction).toHaveBeenCalledTimes(2);
    completions[0]!.reject(new Error("old generation failed"));
    await expect(view.pending[0]).rejects.toThrow("old generation failed");
    await view.flushCoordination();
    expect(view.dialog().getAttribute("aria-busy")).toBe("true");
    expect(view.document.querySelector<HTMLButtonElement>(".decision-option")?.disabled).toBe(true);
    await act(async () => view.document.querySelector<HTMLButtonElement>(".decision-option")?.click());
    expect(resolveInteraction).toHaveBeenCalledTimes(2);
    completions[1]!.resolve(); await view.pending[1];
  });

  it("returns Other-question focus within the portal owner document", async () => {
    const view = await mountPortal(question, {
      resolveInteraction: vi.fn(async () => undefined),
      dismissInteraction: vi.fn(async () => undefined)
    });
    await view.flushAnimationFrames();
    const toggle = view.document.querySelector<HTMLElement>("[data-question-other-toggle='approach']");
    expect(toggle).not.toBeNull();

    await act(async () => toggle?.click());
    await view.flushAnimationFrames();
    const editor = view.document.querySelector<HTMLTextAreaElement>("[data-question-other-input='approach']");
    expect(view.document.activeElement).toBe(editor);

    await act(async () => press(view.window, editor!, "Escape"));
    await view.flushAnimationFrames();
    const restored = view.document.querySelector<HTMLElement>("[data-question-other-toggle='approach']");
    expect(view.document.activeElement).toBe(restored);
  });

  it("moves one complete two-step draft between portal documents and fences the former owner", async () => {
    const browser = new PortalQuestionDraftBrowser();
    const firstResolve = vi.fn(async () => undefined);
    const secondResolve = vi.fn(async () => undefined);
    const first = await mountPortal(twoStepQuestion, { resolveInteraction: firstResolve, dismissInteraction: vi.fn(async () => undefined) }, true, browser);
    const second = await mountPortal(twoStepQuestion, { resolveInteraction: secondResolve, dismissInteraction: vi.fn(async () => undefined) }, true, browser);
    await first.flushCoordination();
    await second.flushCoordination();

    const views = [first, second] as const;
    const owner = views.find((view) => view.document.querySelector<HTMLFieldSetElement>(".question-wizard__lease")?.disabled === false)!;
    const observer = owner === first ? second : first;
    expect(views.filter((view) => view.document.querySelector<HTMLFieldSetElement>(".question-wizard__lease")?.disabled === false)).toHaveLength(1);
    const observerToggle = observer.document.querySelector<HTMLElement>("[data-question-other-toggle='approach']");
    await act(async () => {
      observerToggle?.click();
      press(observer.window, observerToggle!, "Enter");
    });
    expect(firstResolve).not.toHaveBeenCalled();
    expect(secondResolve).not.toHaveBeenCalled();

    const ownerToggle = owner.document.querySelector<HTMLElement>("[data-question-other-toggle='approach']");
    await act(async () => ownerToggle?.click());
    await owner.flushAnimationFrames();
    const other = owner.document.querySelector<HTMLTextAreaElement>("[data-question-other-input='approach']")!;
    await act(async () => inputText(owner.window, other, "Keep the complete draft"));
    const next = other.parentElement?.querySelector<HTMLButtonElement>("button");
    expect(next).toBeDefined();
    expect(next?.disabled).toBe(false);
    vi.useFakeTimers();
    try {
      await act(async () => {
        press(owner.window, other, "Enter");
        await vi.runAllTimersAsync();
      });
    } finally {
      vi.useRealTimers();
    }
    await owner.flushAnimationFrames();
    expect(owner.document.querySelector(".question-field")?.textContent).toContain("Details");
    expect(owner.document.querySelector(".question-wizard__progress")?.textContent).toContain("interaction.step");

    const minimize = owner.document.querySelector<HTMLButtonElement>(".interaction-takeover__header button")!;
    await act(async () => minimize.click());
    await owner.flushCoordination();
    await observer.flushCoordination();
    expect(owner.document.querySelector(".interaction-takeover-minimized")).not.toBeNull();

    const continueHere = [...observer.document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "interaction.ownershipContinueHere");
    expect(continueHere).toBeDefined();
    await act(async () => continueHere?.click());
    await owner.flushCoordination();
    await observer.flushCoordination();

    expect(owner.document.querySelector<HTMLFieldSetElement>(".question-wizard__lease")?.disabled).toBe(true);
    expect(observer.document.querySelector<HTMLFieldSetElement>(".question-wizard__lease")?.disabled).toBe(false);
    expect(observer.document.querySelector(".question-wizard__progress")?.textContent).toContain("interaction.step");
    const oldInput = owner.document.querySelector<HTMLInputElement>(".question-field input");
    if (oldInput !== null) await act(async () => inputText(owner.window, oldInput, "stale"));
    expect(firstResolve).not.toHaveBeenCalled();
    expect(secondResolve).not.toHaveBeenCalled();

    const details = observer.document.querySelector<HTMLInputElement>(".question-field input")!;
    await act(async () => inputText(observer.window, details, "Finish here"));
    await act(async () => press(observer.window, details, "Enter"));
    await Promise.all(observer.pending);
    const winningResolve = observer === first ? firstResolve : secondResolve;
    const losingResolve = observer === first ? secondResolve : firstResolve;
    expect(winningResolve).toHaveBeenCalledExactlyOnceWith(twoStepQuestion, {
      kind: "question",
      answers: {
        approach: { kind: "single", selection: { kind: "other", text: "Keep the complete draft" } },
        details: { kind: "text", value: "Finish here" }
      }
    });
    expect(losingResolve).not.toHaveBeenCalled();
  });

  it("fails closed when the portal owner lacks cross-window ownership APIs", async () => {
    const resolveInteraction = vi.fn(async () => undefined);
    const view = await mountPortal(question, { resolveInteraction, dismissInteraction: vi.fn(async () => undefined) }, true, null);
    expect(view.document.querySelector(".interaction-ownership")?.textContent).toContain("interaction.ownershipUnavailable");
    const fieldset = view.document.querySelector<HTMLFieldSetElement>(".question-wizard__lease")!;
    expect(fieldset.disabled).toBe(true);
    const toggle = view.document.querySelector<HTMLElement>("[data-question-other-toggle='approach']")!;
    await act(async () => { toggle.click(); press(view.window, toggle, "Enter"); });
    expect(resolveInteraction).not.toHaveBeenCalled();
  });
});

async function mountPortal(
  interaction: InteractionView,
  actions: Pick<AppController, "resolveInteraction" | "dismissInteraction">,
  inline = true,
  questionBrowser: PortalQuestionDraftBrowser | null = new PortalQuestionDraftBrowser()
) {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const portalDocument = iframe.contentDocument;
  const portalWindow = iframe.contentWindow as BrowsingContextWindow | null;
  if (portalDocument === null || portalWindow === null) throw new Error("Expected an iframe browsing context.");
  questionBrowser?.install(portalWindow);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  Object.defineProperties(portalWindow, {
    requestAnimationFrame: {
      configurable: true,
      value: (callback: FrameRequestCallback): number => {
        nextFrame += 1;
        frames.set(nextFrame, callback);
        return nextFrame;
      }
    },
    cancelAnimationFrame: {
      configurable: true,
      value: (frame: number): void => { frames.delete(frame); }
    }
  });
  const host = document.body.appendChild(document.createElement("main"));
  const root = createRoot(host);
  roots.push(root);
  const pending: Promise<void>[] = [];
  const runAction: RunAction = (_key, action) => { pending.push(action()); };
  const controller = {
    state: {
      connectionState: "connected",
      preferences: { locale: "en" },
      activeProfile: { id: "profile", serverId: "server", deviceId: "device", name: "Node", origin: "https://joko.test" }
    },
    ...actions
  } as unknown as AppController;
  const render = async (nextInteraction: InteractionView): Promise<void> => {
    await act(async () => root.render(createPortal(
      <InteractionDialog controller={controller} interaction={nextInteraction} remaining={0} inline={inline}
        t={(key) => key} runAction={runAction} />,
      portalDocument.body
    )));
    await flushCoordination(portalWindow);
  };
  await render(interaction);
  return {
    document: portalDocument,
    window: portalWindow,
    pending,
    render,
    flushCoordination: (): Promise<void> => flushCoordination(portalWindow),
    dialog: (): HTMLElement => portalDocument.querySelector<HTMLElement>(".interaction-dialog")!,
    flushAnimationFrames: async (): Promise<void> => {
      await act(async () => {
        while (frames.size > 0) {
          const callbacks = [...frames.values()];
          frames.clear();
          callbacks.forEach((callback) => callback(portalWindow.performance.now()));
        }
      });
    }
  };
}

async function flushCoordination(ownerWindow: BrowsingContextWindow): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
      await new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, 0));
    }
  });
}

function press(ownerWindow: BrowsingContextWindow, target: EventTarget, key: string): boolean {
  return target.dispatchEvent(new ownerWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

function inputText(ownerWindow: BrowsingContextWindow, input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof ownerWindow.HTMLTextAreaElement ? ownerWindow.HTMLTextAreaElement.prototype : ownerWindow.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new ownerWindow.Event("input", { bubbles: true, cancelable: true }));
}

class PortalQuestionDraftBrowser {
  readonly #locks = new PortalLockManager();
  readonly #channels = new Map<string, Set<PortalBroadcastChannel>>();
  readonly #terminalValues = new Map<string, string>();
  #nextId = 0;

  install(ownerWindow: BrowsingContextWindow): void {
    const browser = this;
    class InstalledBroadcastChannel {
      readonly #channel: PortalBroadcastChannel;
      constructor(name: string) { this.#channel = browser.open(name); }
      postMessage(message: unknown): void { this.#channel.postMessage(message); }
      addEventListener(type: "message", listener: (event: MessageEvent) => void): void { this.#channel.addEventListener(type, listener); }
      removeEventListener(type: "message", listener: (event: MessageEvent) => void): void { this.#channel.removeEventListener(type, listener); }
      close(): void { this.#channel.close(); }
    }
    Object.defineProperty(ownerWindow.navigator, "locks", { configurable: true, value: this.#locks });
    Object.defineProperty(ownerWindow, "BroadcastChannel", { configurable: true, value: InstalledBroadcastChannel });
    Object.defineProperty(ownerWindow, "localStorage", { configurable: true, value: {
      getItem: (name: string) => this.#terminalValues.get(name) ?? null,
      setItem: (name: string, value: string) => { this.#terminalValues.set(name, value); }
    } });
    Object.defineProperty(ownerWindow.crypto, "randomUUID", { configurable: true, value: () => `portal-${++this.#nextId}` });
  }

  open(name: string): PortalBroadcastChannel {
    const channel = new PortalBroadcastChannel(name, this);
    const group = this.#channels.get(name) ?? new Set<PortalBroadcastChannel>();
    group.add(channel);
    this.#channels.set(name, group);
    return channel;
  }

  post(source: PortalBroadcastChannel, message: unknown): void {
    for (const channel of this.#channels.get(source.name) ?? []) {
      if (channel !== source) setTimeout(() => channel.deliver(message), 0);
    }
  }

  close(channel: PortalBroadcastChannel): void {
    const group = this.#channels.get(channel.name);
    group?.delete(channel);
    if (group?.size === 0) this.#channels.delete(channel.name);
  }
}

class PortalBroadcastChannel {
  readonly name: string;
  readonly #browser: PortalQuestionDraftBrowser;
  readonly #listeners = new Set<(event: MessageEvent) => void>();
  #closed = false;

  constructor(name: string, browser: PortalQuestionDraftBrowser) { this.name = name; this.#browser = browser; }
  postMessage(message: unknown): void { if (!this.#closed) this.#browser.post(this, message); }
  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void { this.#listeners.add(listener); }
  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void { this.#listeners.delete(listener); }
  close(): void { if (!this.#closed) { this.#closed = true; this.#browser.close(this); this.#listeners.clear(); } }
  deliver(data: unknown): void { if (!this.#closed) for (const listener of this.#listeners) listener({ data } as MessageEvent); }
}

class PortalLockManager implements InteractionLockManager {
  readonly #active = new Set<string>();
  readonly #queues = new Map<string, Array<{
    readonly signal?: AbortSignal;
    readonly callback: (lock: InteractionLock | null) => Promise<unknown> | unknown;
    readonly resolve: (value: unknown) => void;
    readonly reject: (reason?: unknown) => void;
  }>>();

  request<T>(name: string, options: { readonly mode: "exclusive"; readonly ifAvailable?: boolean; readonly signal?: AbortSignal }, callback: (lock: InteractionLock | null) => Promise<T> | T): Promise<T> {
    if (options.signal?.aborted === true) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (this.#active.has(name) && options.ifAvailable === true) return Promise.resolve().then(() => callback(null));
    return new Promise<T>((resolve, reject) => {
      const entry = { signal: options.signal, callback, resolve: resolve as (value: unknown) => void, reject };
      if (this.#active.has(name)) {
        const queue = this.#queues.get(name) ?? [];
        queue.push(entry);
        this.#queues.set(name, queue);
        options.signal?.addEventListener("abort", () => {
          const pending = this.#queues.get(name);
          const index = pending?.indexOf(entry) ?? -1;
          if (pending !== undefined && index >= 0) {
            pending.splice(index, 1);
            reject(new DOMException("Aborted", "AbortError"));
          }
        }, { once: true });
      } else this.#acquire(name, entry);
    });
  }

  #acquire(name: string, entry: { readonly signal?: AbortSignal; readonly callback: (lock: InteractionLock | null) => Promise<unknown> | unknown; readonly resolve: (value: unknown) => void; readonly reject: (reason?: unknown) => void }): void {
    if (entry.signal?.aborted === true) { entry.reject(new DOMException("Aborted", "AbortError")); this.#drain(name); return; }
    this.#active.add(name);
    Promise.resolve().then(() => entry.callback({ name })).then(entry.resolve, entry.reject).finally(() => { this.#active.delete(name); this.#drain(name); });
  }

  #drain(name: string): void {
    const queue = this.#queues.get(name);
    const next = queue?.shift();
    if (queue?.length === 0) this.#queues.delete(name);
    if (next !== undefined) this.#acquire(name, next);
  }
}
