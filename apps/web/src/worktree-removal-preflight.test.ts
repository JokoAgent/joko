import { afterEach, describe, expect, test, vi } from "vitest";

import {
  prefetchWorktreeRemovalPreflight,
  resetWorktreeRemovalPreflightCache,
  resolveWorktreeRemovalPreflight,
  summarizeWorktreeRemovalPreflights,
  summarizeSessionArchivePreflights
} from "./worktree-removal-preflight.js";

afterEach(() => resetWorktreeRemovalPreflightCache());

describe("worktree removal preflight", () => {
  test("always refreshes exact automation bindings and never reuses a cached dirty result", async () => {
    const read = vi.fn(async () => ({ hasWorktree: true, dirty: true,
      activeBoundScheduleCount: 1, activeBoundScheduleNames: ["Nightly"], archiveConfirmation: "a".repeat(64) }));
    await resolveWorktreeRemovalPreflight("owner", "task", read);
    const summary = await summarizeSessionArchivePreflights(["task", "task"], read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ dirty: 1, activeBoundScheduleCount: 1,
      activeBoundScheduleNames: ["Nightly"], archiveConfirmations: { task: "a".repeat(64) }, archiveUnavailable: false });
    read.mockRejectedValueOnce(new Error("offline"));
    expect(await summarizeSessionArchivePreflights(["task"], read)).toMatchObject({ archiveUnavailable: true, unknown: 1 });
  });

  test("bounds stalled archive queries and aborts their original reader", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const result = summarizeSessionArchivePreflights(["task"], async (_id, active) => {
        signal = active;
        return new Promise<never>(() => undefined);
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await result).toMatchObject({ archiveUnavailable: true, unknown: 1 });
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  test("reuses only a settled dirty preview and scopes it to the connected owner", async () => {
    const read = vi.fn(async () => ({ hasWorktree: true, dirty: true }));

    expect(await resolveWorktreeRemovalPreflight("owner-a", "session-a", read)).toBe("dirty");
    expect(await resolveWorktreeRemovalPreflight("owner-a", "session-a", read)).toBe("dirty");
    expect(read).toHaveBeenCalledTimes(1);

    expect(await resolveWorktreeRemovalPreflight("owner-b", "session-a", read)).toBe("dirty");
    expect(read).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ hasWorktree: false, dirty: false }, "clean"],
    [{ hasWorktree: true, dirty: false }, "clean"]
  ] as const)("rechecks a settled non-dirty preview %#", async (preview, expected) => {
    const read = vi.fn(async () => preview);
    prefetchWorktreeRemovalPreflight("owner", "session", read);
    await Promise.resolve();

    expect(await resolveWorktreeRemovalPreflight("owner", "session", read)).toBe(expected);
    expect(read).toHaveBeenCalledTimes(2);
  });

  test("keeps failures unknown and summarizes each task identity once", async () => {
    const read = vi.fn(async (sessionId: string) => {
      if (sessionId === "unknown") throw new Error("offline");
      return { hasWorktree: true, dirty: sessionId === "dirty" };
    });

    expect(await summarizeWorktreeRemovalPreflights(
      "owner",
      ["clean", "dirty", "unknown", "dirty"],
      read
    )).toEqual({ clean: 1, dirty: 1, unknown: 1 });
    expect(read).toHaveBeenCalledTimes(3);
    expect(await resolveWorktreeRemovalPreflight("owner", "unknown", read)).toBe("unknown");
    expect(read).toHaveBeenCalledTimes(4);
  });

  test("fails closed for an impossible preview and a synchronous reader failure", async () => {
    expect(await resolveWorktreeRemovalPreflight("owner", "impossible", async () => ({
      hasWorktree: false,
      dirty: true
    }))).toBe("unknown");
    expect(await resolveWorktreeRemovalPreflight("owner", "throw", () => {
      throw new Error("transport setup failed");
    })).toBe("unknown");
  });
});
