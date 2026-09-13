import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VISION_BRIDGE_FALLBACK_DURATION_MS,
  VISION_BRIDGE_EXIT_DURATION_MS,
  VISION_BRIDGE_MAX_ACTIVE,
  VISION_BRIDGE_UNAVAILABLE_DURATION_MS,
  VISION_BRIDGE_WARNING_DEDUP_MS,
  VisionBridgeToastStore
} from "./vision-bridge-toast-store.js";

afterEach(() => vi.useRealTimers());

describe("VisionBridgeToastStore", () => {
  it("keeps recognizing feedback per Session and fades only that loading toast after first output", async () => {
    vi.useFakeTimers();
    const store = new VisionBridgeToastStore();
    store.apply(effect("recognizing", "session-a", "start-a", 2));
    store.apply(effect("recognizing", "session-b", "start-b", 1));
    expect(store.getSnapshot()).toEqual([
      { eventId: "start-b", sessionId: "session-b", kind: "recognizing", imageCount: 1 },
      { eventId: "start-a", sessionId: "session-a", kind: "recognizing", imageCount: 2 }
    ]);

    store.apply(effect("clear", "session-a", "output-a"));
    expect(store.getSnapshot()).toEqual([
      { eventId: "start-b", sessionId: "session-b", kind: "recognizing", imageCount: 1 },
      { eventId: "start-a", sessionId: "session-a", kind: "recognizing", imageCount: 2, exiting: true }
    ]);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot()).toEqual([
      { eventId: "start-b", sessionId: "session-b", kind: "recognizing", imageCount: 1 }
    ]);
  });

  it("shows fallback for 5 seconds, unavailable for 6 seconds, and deduplicates warnings for 2 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const store = new VisionBridgeToastStore();
    store.apply(effect("recognizing", "session-a", "start"));
    store.apply(effect("fallback", "session-a", "fallback-1"));
    expect(store.getSnapshot()[0]?.kind).toBe("fallback");
    store.apply(effect("fallback", "session-a", "fallback-duplicate"), 10_000 + VISION_BRIDGE_WARNING_DEDUP_MS - 1);
    expect(store.getSnapshot()[0]?.eventId).toBe("fallback-1");

    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_FALLBACK_DURATION_MS);
    expect(store.getSnapshot()[0]?.exiting).toBe(true);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot()).toEqual([]);
    store.apply(effect("unavailable", "session-a", "unavailable-1"), 20_000);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_UNAVAILABLE_DURATION_MS - 1);
    expect(store.getSnapshot()[0]?.kind).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot()[0]?.exiting).toBe(true);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("does not let output clear a timed warning and reset clears all owner-local state", () => {
    vi.useFakeTimers();
    const store = new VisionBridgeToastStore();
    store.apply(effect("fallback", "session-a", "fallback"));
    store.apply(effect("clear", "session-a", "first-output"));
    expect(store.getSnapshot()[0]?.kind).toBe("fallback");
    store.reset();
    expect(store.getSnapshot()).toEqual([]);
  });

  it("fades an old recognizing toast while replacement and warning toasts enter independently", async () => {
    vi.useFakeTimers();
    const store = new VisionBridgeToastStore();
    store.apply(effect("recognizing", "session-a", "recognizing-old"));
    store.apply(effect("recognizing", "session-a", "recognizing-new"));
    expect(store.getSnapshot().map((toast) => [toast.eventId, toast.exiting === true])).toEqual([
      ["recognizing-new", false],
      ["recognizing-old", true]
    ]);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot().map((toast) => toast.eventId)).toEqual(["recognizing-new"]);

    store.apply(effect("fallback", "session-a", "fallback"));
    expect(store.getSnapshot().map((toast) => [toast.eventId, toast.exiting === true])).toEqual([
      ["fallback", false],
      ["recognizing-new", true]
    ]);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot().map((toast) => toast.eventId)).toEqual(["fallback"]);
  });

  it("keeps timed warnings independent from a later recognizing toast and from one another", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    const store = new VisionBridgeToastStore();
    store.apply(effect("fallback", "session-a", "fallback-1"));
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_WARNING_DEDUP_MS);
    store.apply(effect("fallback", "session-a", "fallback-2"));
    store.apply(effect("recognizing", "session-a", "next-turn", 2));
    expect(store.getSnapshot().map((toast) => toast.eventId)).toEqual([
      "next-turn",
      "fallback-2",
      "fallback-1"
    ]);

    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_FALLBACK_DURATION_MS - VISION_BRIDGE_WARNING_DEDUP_MS);
    expect(store.getSnapshot().find((toast) => toast.eventId === "fallback-1")?.exiting).toBe(true);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot().map((toast) => toast.eventId)).toEqual(["next-turn", "fallback-2"]);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_WARNING_DEDUP_MS - VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot().find((toast) => toast.eventId === "fallback-2")?.exiting).toBe(true);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot().map((toast) => toast.eventId)).toEqual(["next-turn"]);
  });

  it("pauses and resumes a timed warning while it is hovered", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(40_000);
    const store = new VisionBridgeToastStore();
    store.apply(effect("fallback", "session-a", "hovered"));
    await vi.advanceTimersByTimeAsync(4_000);
    store.pause("hovered");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getSnapshot()[0]?.eventId).toBe("hovered");
    store.resume("hovered");
    await vi.advanceTimersByTimeAsync(999);
    expect(store.getSnapshot()[0]?.exiting).not.toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(store.getSnapshot()[0]?.exiting).toBe(true);
  });

  it("admits at most three active toasts and promotes the FIFO queue after exit", async () => {
    vi.useFakeTimers();
    const store = new VisionBridgeToastStore();
    for (let index = 1; index <= VISION_BRIDGE_MAX_ACTIVE + 1; index += 1) {
      store.apply(effect("recognizing", `session-${index}`, `toast-${index}`));
    }
    expect(store.getSnapshot().map((toast) => toast.eventId)).toEqual(["toast-3", "toast-2", "toast-1"]);

    store.apply(effect("clear", "session-2", "output-2"));
    expect(store.getSnapshot().map((toast) => [toast.eventId, toast.exiting === true])).toEqual([
      ["toast-3", false],
      ["toast-2", true],
      ["toast-1", false]
    ]);
    await vi.advanceTimersByTimeAsync(VISION_BRIDGE_EXIT_DURATION_MS);
    expect(store.getSnapshot().map((toast) => toast.eventId)).toEqual(["toast-4", "toast-3", "toast-1"]);
  });
});

function effect(
  kind: "recognizing" | "fallback" | "unavailable" | "clear",
  sessionId: string,
  eventId: string,
  imageCount?: number
) {
  return { kind, sessionId, eventId, ...(imageCount === undefined ? {} : { imageCount }) } as const;
}
