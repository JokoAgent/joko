// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareScheduleFailureDismissals,
  dismissScheduleFailure,
  readLatestDismissedScheduleFailure,
  scheduleFailureDismissalPrefix,
  type ScheduleFailureDismissal
} from "./schedule-failure-dismissal.js";

const prefix = scheduleFailureDismissalPrefix("owner", "session");

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("schedule failure dismissal storage", () => {
  it("uses a strict v1 identity and isolates owner and session records", () => {
    const failure = snapshot(1, "schedule", "run", "trigger");
    const otherOwner = scheduleFailureDismissalPrefix("other-owner", "session");
    const otherSession = scheduleFailureDismissalPrefix("owner", "other-session");
    dismissScheduleFailure(window.localStorage, prefix, failure);
    dismissScheduleFailure(window.localStorage, otherOwner, snapshot(2, "schedule", "run-2", "trigger-2"));
    dismissScheduleFailure(window.localStorage, otherSession, snapshot(3, "schedule", "run-3", "trigger-3"));

    expect(readLatestDismissedScheduleFailure(window.localStorage, prefix)).toEqual(failure);
    expect(readLatestDismissedScheduleFailure(window.localStorage, otherOwner)?.runId).toBe("run-2");
    expect(readLatestDismissedScheduleFailure(window.localStorage, otherSession)?.runId).toBe("run-3");
    const key = storageKeys().find((candidate) => candidate.startsWith(prefix));
    expect(key).toBe(`${prefix}[1,"schedule","run","trigger"]`);
    expect(window.localStorage.getItem(key!)).toBe("1");
  });

  it("orders equal timestamps by schedule, run and trigger identity", () => {
    const ordered = [
      snapshot(10, "b", "a", "a"),
      snapshot(10, "a", "z", "a"),
      snapshot(10, "a", "a", "z"),
      snapshot(10, "a", "a", "a")
    ].sort(compareScheduleFailureDismissals);
    expect(ordered).toEqual([
      snapshot(10, "a", "a", "a"),
      snapshot(10, "a", "a", "z"),
      snapshot(10, "a", "z", "a"),
      snapshot(10, "b", "a", "a")
    ]);
  });

  it("keeps one newest record after quiescence without touching unrelated storage", () => {
    window.localStorage.setItem("unrelated-preference", "keep");
    for (let index = 1; index <= 100; index += 1) {
      dismissScheduleFailure(
        window.localStorage,
        prefix,
        snapshot(index, "schedule", `run-${index}`, `trigger-${index}`)
      );
    }
    expect(storageKeys().filter((key) => key.startsWith(prefix))).toHaveLength(1);
    expect(readLatestDismissedScheduleFailure(window.localStorage, prefix))
      .toEqual(snapshot(100, "schedule", "run-100", "trigger-100"));
    expect(window.localStorage.getItem("unrelated-preference")).toBe("keep");
  });

  it("does not let a stale window replace a newer dismissal", () => {
    const older = snapshot(1, "schedule", "old", "old-trigger");
    const newer = snapshot(2, "schedule", "new", "new-trigger");
    dismissScheduleFailure(window.localStorage, prefix, newer);
    dismissScheduleFailure(window.localStorage, prefix, older);
    expect(readLatestDismissedScheduleFailure(window.localStorage, prefix)).toEqual(newer);
    expect(storageKeys().filter((key) => key.startsWith(prefix))).toHaveLength(1);
  });

  it.each(["before-scan", "during-cleanup"] as const)(
    "preserves a newer write interleaved %s",
    (point) => {
      const oldest = snapshot(1, "schedule", "oldest", "oldest-trigger");
      const current = snapshot(2, "schedule", "current", "current-trigger");
      const newest = snapshot(3, "schedule", "newest", "newest-trigger");
      dismissScheduleFailure(window.localStorage, prefix, oldest);
      if (point === "before-scan") {
        const setItem = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(function (this: Storage, key, value) {
          setItem.call(this, key, value);
          dismissScheduleFailure(this, prefix, newest);
        });
      } else {
        const removeItem = Storage.prototype.removeItem;
        vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(function (this: Storage, key) {
          dismissScheduleFailure(this, prefix, newest);
          removeItem.call(this, key);
        });
      }
      dismissScheduleFailure(window.localStorage, prefix, current);
      expect(readLatestDismissedScheduleFailure(window.localStorage, prefix)).toEqual(newest);
      expect(storageKeys().filter((key) => key.startsWith(prefix))).toHaveLength(1);
    }
  );

  it("ignores malformed current-prefix records and storage read faults", () => {
    window.localStorage.setItem(`${prefix}{`, "1");
    window.localStorage.setItem(`${prefix}[1,"schedule","run"]`, "1");
    window.localStorage.setItem(`${prefix}[1,"schedule","run","trigger"]`, "wrong-version");
    expect(readLatestDismissedScheduleFailure(window.localStorage, prefix)).toBeNull();
    vi.spyOn(Storage.prototype, "key").mockImplementationOnce(() => { throw new Error("blocked"); });
    expect(readLatestDismissedScheduleFailure(window.localStorage, prefix)).toBeNull();
    expect(storageKeys()).toHaveLength(3);
  });

  it("preserves the previous record on write failure and catches up after cleanup failure", () => {
    const older = snapshot(1, "schedule", "old", "old-trigger");
    const newer = snapshot(2, "schedule", "new", "new-trigger");
    dismissScheduleFailure(window.localStorage, prefix, older);
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
    expect(() => dismissScheduleFailure(window.localStorage, prefix, newer)).toThrow("quota");
    expect(readLatestDismissedScheduleFailure(window.localStorage, prefix)).toEqual(older);

    vi.spyOn(Storage.prototype, "removeItem").mockImplementationOnce(() => { throw new Error("unavailable"); });
    expect(() => dismissScheduleFailure(window.localStorage, prefix, newer)).toThrow("unavailable");
    expect(readLatestDismissedScheduleFailure(window.localStorage, prefix)).toEqual(newer);
    dismissScheduleFailure(window.localStorage, prefix, older);
    expect(readLatestDismissedScheduleFailure(window.localStorage, prefix)).toEqual(newer);
    expect(storageKeys().filter((key) => key.startsWith(prefix))).toHaveLength(1);
  });
});

function snapshot(
  completedAt: number,
  scheduleId: string,
  runId: string,
  triggerId: string
): ScheduleFailureDismissal {
  return { completedAt, scheduleId, runId, triggerId };
}

function storageKeys(): string[] {
  return Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
    .filter((key): key is string => key !== null);
}
