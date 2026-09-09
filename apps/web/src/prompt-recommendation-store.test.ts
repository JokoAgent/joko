import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionView } from "./model.js";
import { PROMPT_RECOMMENDATION_SETTLE_MS, PromptRecommendationStore, promptRecommendationOwnerKey, type PromptRecommendationFence } from "./prompt-recommendation-store.js";

afterEach(() => vi.useRealTimers());

describe("PromptRecommendationStore", () => {
  it("keys ownership by connection, locale, routing revisions, and the recommendation switch", () => {
    const common = { deviceId: "device-a", name: "Local", origin: "http://127.0.0.1:4318", serverId: "server-a" } as const;
    const profile = { ...common, id: "profile-a" };
    const routing = { locale: "en", revision: 1n, runtimeRevision: "runtime-one", enabled: true } as const;
    const original = promptRecommendationOwnerKey(profile, routing);
    expect(promptRecommendationOwnerKey({ ...profile }, { ...routing })).toBe(original);
    expect(promptRecommendationOwnerKey({ ...profile, id: "profile-b" }, routing)).not.toBe(original);
    expect(promptRecommendationOwnerKey({ ...profile, serverId: "server-b" }, routing)).not.toBe(original);
    for (const next of [{ ...routing, locale: "zh-CN" as const }, { ...routing, revision: 2n }, { ...routing, runtimeRevision: "runtime-two" }, { ...routing, enabled: false }]) {
      expect(promptRecommendationOwnerKey(profile, next)).not.toBe(original);
    }
    expect(promptRecommendationOwnerKey(undefined, routing)).toBeUndefined();
  });

  it("captures a background Session completion, waits 500ms, and predicts only when that Session is revisited", async () => {
    vi.useFakeTimers();
    const store = new PromptRecommendationStore();
    store.observe([session("background", "running", 1)], enabled);
    store.observe([session("background", "idle", 2)], enabled);

    await vi.advanceTimersByTimeAsync(PROMPT_RECOMMENDATION_SETTLE_MS - 1);
    expect(store.inspect("background")?.phase).toBe("settling");
    await vi.advanceTimersByTimeAsync(1);
    expect(store.inspect("background")).toMatchObject({ phase: "candidate", updatedAt: 2 });

    const request = vi.fn(async () => "Continue with the focused tests.");
    // Mounting/returning to the Session consumes the candidate and owns the RPC.
    store.request("background", 0n, 2, request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.recommendation("background", 0n, 2)).toBe("Continue with the focused tests."));
  });

  it("waits for every background task to finish, then requests exactly once after the 500ms settle", async () => {
    vi.useFakeTimers();
    const store = new PromptRecommendationStore();
    const idle = session("session-a", "idle", 2);
    const request = vi.fn(async () => "Continue after the subagent finishes.");

    // An owner snapshot may first observe an idle foreground Session while a
    // capability-reported background task is still active.
    store.observe([idle], enabled, [
      backgroundTask("background-a", "running"),
      backgroundTask("background-b", "waiting")
    ]);
    await vi.advanceTimersByTimeAsync(PROMPT_RECOMMENDATION_SETTLE_MS * 2);
    store.request("session-a", 0n, 2, request);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(store.inspect("session-a")).toBeUndefined();

    store.observe([idle], enabled, [
      backgroundTask("background-a", "completed"),
      backgroundTask("background-b", "waiting")
    ]);
    await vi.advanceTimersByTimeAsync(PROMPT_RECOMMENDATION_SETTLE_MS * 2);
    store.request("session-a", 0n, 2, request);
    expect(request).not.toHaveBeenCalled();

    // Only the final typed terminal event is the aggregate busy -> idle edge.
    store.observe([idle], enabled, [
      backgroundTask("background-a", "completed"),
      backgroundTask("background-b", "completed")
    ]);
    await vi.advanceTimersByTimeAsync(PROMPT_RECOMMENDATION_SETTLE_MS - 1);
    store.request("session-a", 0n, 2, request);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    store.request("session-a", 0n, 2, request);
    store.request("session-a", 0n, 2, request);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(store.recommendation("session-a", 0n, 2))
      .toBe("Continue after the subagent finishes."));
  });

  it("debounces terminal snapshot pushes for a full 500ms settle window", async () => {
    vi.useFakeTimers();
    const store = new PromptRecommendationStore();
    store.observe([session("session-a", "running", 1)], enabled);
    store.observe([session("session-a", "idle", 2)], enabled);
    await vi.advanceTimersByTimeAsync(300);
    store.observe([session("session-a", "idle", 3)], enabled);
    await vi.advanceTimersByTimeAsync(499);
    expect(store.inspect("session-a")?.phase).toBe("settling");
    await vi.advanceTimersByTimeAsync(1);
    expect(store.inspect("session-a")).toMatchObject({ phase: "candidate", updatedAt: 3 });
  });

  it("keeps one ready recommendation while ordinary text temporarily hides it", async () => {
    vi.useFakeTimers();
    const store = new PromptRecommendationStore(1);
    store.observe([session("session-a", "running", 1)], enabled);
    store.observe([session("session-a", "idle", 2)], enabled);
    await vi.advanceTimersByTimeAsync(1);
    store.request("session-a", 0n, 2, async () => "Run the tests.");
    await vi.waitFor(() => expect(store.recommendation("session-a", 0n, 2)).toBe("Run the tests."));

    // Text visibility is a Composer predicate and does not dismiss store state.
    expect(store.recommendation("session-a", 0n, 2)).toBe("Run the tests.");
    expect(store.recommendation("session-a", 0n, 2)).toBe("Run the tests.");
  });

  it("drops an out-of-order response after a newer run and preserves the newer Session fence", async () => {
    vi.useFakeTimers();
    const store = new PromptRecommendationStore(1);
    store.observe([session("session-a", "running", 1)], enabled);
    store.observe([session("session-a", "idle", 2)], enabled);
    await vi.advanceTimersByTimeAsync(1);
    const old = deferred<string>();
    store.request("session-a", 0n, 2, () => old.promise);
    await Promise.resolve();

    store.observe([session("session-a", "running", 3)], enabled);
    store.observe([session("session-a", "idle", 4)], enabled);
    await vi.advanceTimersByTimeAsync(1);
    const fresh = deferred<string>();
    store.request("session-a", 0n, 4, () => fresh.promise);
    await Promise.resolve();
    fresh.resolve("New recommendation.");
    await vi.waitFor(() => expect(store.recommendation("session-a", 0n, 4)).toBe("New recommendation."));
    old.resolve("Stale recommendation.");
    await Promise.resolve();

    expect(store.recommendation("session-a", 0n, 4)).toBe("New recommendation.");
    expect(store.recommendation("session-a", 0n, 2)).toBeUndefined();
  });

  it("clears every candidate immediately when the authoritative setting becomes disabled", async () => {
    vi.useFakeTimers();
    const store = new PromptRecommendationStore(1);
    store.observe([session("session-a", "running", 1)], enabled);
    store.observe([session("session-a", "idle", 2)], enabled);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.inspect("session-a")?.phase).toBe("candidate");

    let signal: AbortSignal | undefined;
    store.request("session-a", 0n, 2, (_fence, nextSignal) => { signal = nextSignal; return new Promise(() => undefined); });
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);

    store.observe([session("session-a", "idle", 2)], { enabled: false, available: true });
    expect(store.inspect("session-a")).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it("does not carry a colliding Session id across connection-owner reset", async () => {
    vi.useFakeTimers();
    const store = new PromptRecommendationStore(1);
    store.observe([session("same-id", "running", 1)], enabled);
    store.observe([session("same-id", "idle", 2)], enabled);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.inspect("same-id")?.phase).toBe("candidate");

    store.reset();
    store.observe([session("same-id", "idle", 2)], enabled);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.inspect("same-id")).toBeUndefined();
  });

  it("retires queued, pending, and ready predictions across owner ABA without charging idle sessions again", async () => {
    vi.useFakeTimers();
    const store = new PromptRecommendationStore(1);
    for (const phase of ["queued", "pending", "ready"] as const) {
      store.setOwner("owner-a");
      store.observe([session("same-id", "running", 1)], enabled);
      store.observe([session("same-id", "idle", 2)], enabled);
      await vi.advanceTimersByTimeAsync(1);
      const result = deferred<string>();
      const request = vi.fn((_fence: PromptRecommendationFence, _signal: AbortSignal) => result.promise);
      store.request("same-id", 0n, 2, request);
      if (phase !== "queued") await Promise.resolve();
      if (phase === "ready") {
        result.resolve("Old ready text");
        await vi.waitFor(() => expect(store.recommendation("same-id", 0n, 2)).toBe("Old ready text"));
      }
      store.setOwner("owner-b");
      if (phase === "pending") expect(request.mock.calls[0]?.[1].aborted).toBe(true);
      store.observe([session("same-id", "idle", 2)], enabled);
      store.setOwner("owner-a");
      store.observe([session("same-id", "idle", 2)], enabled);
      result.resolve("Late old text");
      await vi.advanceTimersByTimeAsync(2);
      store.request("same-id", 0n, 2, request);
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
      expect(store.inspect("same-id")).toBeUndefined();
      store.setOwner("owner-a");
      store.observe([session("same-id", "running", 3)], enabled);
      store.observe([session("same-id", "idle", 4)], enabled);
      await vi.advanceTimersByTimeAsync(1);
      store.request("same-id", 0n, 4, async () => "New natural completion");
      await vi.waitFor(() => expect(store.recommendation("same-id", 0n, 4)).toBe("New natural completion"));
      store.reset();
    }
  });
});

const enabled = { enabled: true, available: true } as const;

function session(id: string, state: SessionView["state"], updatedAt: number): SessionView {
  return {
    id,
    backendId: "pi",
    targetId: "target-a",
    name: id,
    state,
    pinned: false,
    archived: false,
    generation: 0n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt
  };
}

function backgroundTask(id: string, state: "running" | "waiting" | "completed") {
  return { id, sessionId: "session-a", state } as const;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
