import { expect, it } from "vitest";
import { EMPTY_SESSION_VISIT_HISTORY, sessionVisitTarget, updateSessionVisitHistory } from "./session-visit-history.js";
import { effectiveAppShortcutCombos, matchesAppShortcutEvent } from "./app-shortcuts.js";

it("navigates between tasks across other pages and cuts forward history after a branching visit", () => {
  const owner = "connected-owner";
  const available = new Set(["a", "b", "c"]);
  let history = updateSessionVisitHistory(EMPTY_SESSION_VISIT_HISTORY, owner, available, "a", undefined);
  history = updateSessionVisitHistory(history, owner, available, undefined, undefined);
  expect(sessionVisitTarget(history, owner, undefined, -1)?.id).toBe("a");
  expect(sessionVisitTarget(history, owner, undefined, 1)).toBeUndefined();
  history = updateSessionVisitHistory(history, owner, available, "b", undefined);
  const previous = sessionVisitTarget(history, owner, "b", -1)!;
  expect(previous.id).toBe("a");
  history = updateSessionVisitHistory(history, owner, available, previous.id, previous);
  expect(sessionVisitTarget(history, owner, "a", 1)?.id).toBe("b");
  history = updateSessionVisitHistory(history, owner, available, "c", undefined);
  expect(history.ids).toEqual(["a", "c"]);
  expect(sessionVisitTarget(history, owner, "c", 1)).toBeUndefined();
  expect(sessionVisitTarget(history, "other-owner", "c", -1)).toBeUndefined();
  history = updateSessionVisitHistory(history, owner, new Set(["c"]), "c", undefined);
  expect(sessionVisitTarget(history, owner, "c", -1)).toBeUndefined();
});

it("resolves rebindings through the common shortcut registry", () => {
  expect(effectiveAppShortcutCombos("session-history-back", {}, "darwin")[0]).toMatchObject({ code: "BracketLeft", meta: true });
  expect(effectiveAppShortcutCombos("session-history-forward", {}, "win32")[0]).toMatchObject({ code: "BracketRight", ctrl: true });
  const [rebound] = effectiveAppShortcutCombos("session-history-back", {
    "session-history-back": { code: "KeyJ", alt: true, ctrl: false, shift: false, meta: false }
  }, "win32");
  expect(matchesAppShortcutEvent({ code: "KeyJ", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, rebound!)).toBe(true);
});
