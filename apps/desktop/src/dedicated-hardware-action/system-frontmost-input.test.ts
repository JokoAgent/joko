import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SYSTEM_FRONTMOST_SCROLL_MAX_ELAPSED_MS,
  SYSTEM_FRONTMOST_WINDOWS_WHEEL_NOTCH,
  SystemFrontmostInputController,
  SystemFrontmostScrollPump,
  accumulateSystemFrontmostScrollNotches,
  createPlatformSystemFrontmostInput,
  type NativeSystemFrontmostInputHelper,
  type SystemFrontmostInputRunner,
  type SystemFrontmostInputTarget
} from "./system-frontmost-input.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function nativeTarget(
  nativeId: string,
  processId = 999,
  platform: SystemFrontmostInputTarget["platform"] = "linux"
): SystemFrontmostInputTarget {
  return Object.freeze({ platform, nativeId, processId }) as SystemFrontmostInputTarget;
}

function runner(overrides: Partial<SystemFrontmostInputRunner> = {}): SystemFrontmostInputRunner {
  return {
    postReturn: async () => undefined,
    captureTarget: () => nativeTarget("101"),
    postPaste: async () => undefined,
    postScroll: async () => undefined,
    ...overrides
  };
}

describe("platform system frontmost input", () => {
  it.each(["win32", "darwin", "linux"] as const)("requires the %s native helper", (platform) => {
    expect(createPlatformSystemFrontmostInput({
      platform, currentProcessId: 77
    })).toEqual({ status: "unsupported", reason: "helper-unavailable" });
  });

  it.each(["win32", "linux"] as const)("owns %s capture and fixed effects through the native helper", async (platform) => {
    let foreground = { nativeId: "4242", processId: 999 };
    const helper = {
      captureTarget: vi.fn<NativeSystemFrontmostInputHelper["captureTarget"]>(() => foreground),
      postReturn: vi.fn<NativeSystemFrontmostInputHelper["postReturn"]>(async () => undefined),
      postPaste: vi.fn<NativeSystemFrontmostInputHelper["postPaste"]>(async () => undefined),
      postScroll: vi.fn<NativeSystemFrontmostInputHelper["postScroll"]>(async () => undefined)
    };
    const resolved = createPlatformSystemFrontmostInput({
      platform,
      ...(platform === "win32" ? { windowsHelper: helper } : { linuxHelper: helper }),
      currentProcessId: 77
    });
    if (resolved.status !== "available") throw new Error("Expected native input support.");
    expect(resolved.wheelNotch).toBe(platform === "win32" ? SYSTEM_FRONTMOST_WINDOWS_WHEEL_NOTCH : 0);

    const target = resolved.runner.captureTarget();
    foreground = { nativeId: "5252", processId: 888 };
    await resolved.runner.postReturn(target);
    await resolved.runner.postScroll(target, 121.4);
    const postPasteWithIgnoredRuntimeExtra = resolved.runner.postPaste as unknown as (
      value: SystemFrontmostInputTarget,
      unexpectedText: string
    ) => Promise<void>;
    await postPasteWithIgnoredRuntimeExtra(target, "sensitive transcript");

    expect(target).toMatchObject({ platform, nativeId: "4242", processId: 999 });
    expect(Object.isFrozen(target)).toBe(true);
    expect(helper.captureTarget).toHaveBeenCalledOnce();
    expect(helper.postReturn.mock.calls).toEqual([[{ nativeId: "4242", processId: 999 }]]);
    expect(helper.postScroll.mock.calls).toEqual([[{ nativeId: "4242", processId: 999 }, 121]]);
    expect(helper.postPaste.mock.calls).toEqual([[{ nativeId: "4242", processId: 999 }]]);
    expect(Object.isFrozen(helper.postPaste.mock.calls[0]![0])).toBe(true);
    await expect(resolved.runner.postScroll(nativeTarget("not-decimal", 999, platform), 120)).rejects.toThrow(TypeError);
    await expect(resolved.runner.postReturn(nativeTarget("4242", 999, platform))).rejects.toThrow(TypeError);
    await expect(resolved.runner.postPaste(nativeTarget("4242", 999, platform))).rejects.toThrow(TypeError);
    expect(helper.postReturn).toHaveBeenCalledOnce();
    expect(helper.postScroll).toHaveBeenCalledOnce();
    expect(helper.postPaste).toHaveBeenCalledOnce();
  });

  it.each((["win32", "linux"] as const).flatMap((platform) => [
    { platform, identity: { nativeId: "0x4242", processId: 999 } },
    { platform, identity: { nativeId: "4242", processId: 0 } },
    { platform, identity: { nativeId: "4242", processId: 77 } }
  ]))("rejects invalid $platform helper capture $identity before any effect", ({ platform, identity }) => {
    const helper = {
      captureTarget: vi.fn(() => identity),
      postReturn: vi.fn(async () => undefined),
      postPaste: vi.fn(async () => undefined),
      postScroll: vi.fn(async () => undefined)
    } satisfies NativeSystemFrontmostInputHelper;
    const resolved = createPlatformSystemFrontmostInput({
      platform, ...(platform === "win32" ? { windowsHelper: helper } : { linuxHelper: helper }), currentProcessId: 77
    });
    if (resolved.status !== "available") throw new Error("Expected native input support.");
    expect(() => resolved.runner.captureTarget()).toThrow();
    expect(helper.captureTarget).toHaveBeenCalledOnce();
    expect(helper.postReturn).not.toHaveBeenCalled();
    expect(helper.postPaste).not.toHaveBeenCalled();
    expect(helper.postScroll).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"] as const)("fails a %s effect closed when native PID revalidation rejects", async (platform) => {
    let currentOwnerPid = 999;
    const revalidate = async (target: Readonly<{ nativeId: string; processId: number }>): Promise<void> => {
      if (target.processId !== currentOwnerPid) throw new Error("native PID mismatch");
    };
    const helper = {
      captureTarget: vi.fn(() => ({ nativeId: "4242", processId: currentOwnerPid })),
      postReturn: vi.fn(revalidate),
      postPaste: vi.fn(revalidate),
      postScroll: vi.fn<NativeSystemFrontmostInputHelper["postScroll"]>(revalidate)
    };
    const resolved = createPlatformSystemFrontmostInput({
      platform, ...(platform === "win32" ? { windowsHelper: helper } : { linuxHelper: helper }), currentProcessId: 77
    });
    if (resolved.status !== "available") throw new Error("Expected native input support.");
    const target = resolved.runner.captureTarget();
    currentOwnerPid = 1000;
    await expect(resolved.runner.postReturn(target)).rejects.toThrow("PID mismatch");
    await expect(resolved.runner.postScroll(target, 120)).rejects.toThrow("PID mismatch");
    await expect(resolved.runner.postPaste(target)).rejects.toThrow("PID mismatch");
    expect(helper.captureTarget).toHaveBeenCalledOnce();
    expect(helper.postReturn.mock.calls).toEqual([[{ nativeId: "4242", processId: 999 }]]);
    expect(helper.postScroll.mock.calls).toEqual([[{ nativeId: "4242", processId: 999 }, 120]]);
    expect(helper.postPaste.mock.calls).toEqual([[{ nativeId: "4242", processId: 999 }]]);
  });

  it("reports an unknown Linux native Return result once without recapture or replay", async () => {
    const failure = new Error("Native effect outcome unknown.");
    const helper = {
      captureTarget: vi.fn(() => ({ nativeId: "314", processId: 999 })),
      postReturn: vi.fn(async () => { throw failure; }),
      postPaste: vi.fn(async () => undefined),
      postScroll: vi.fn(async () => undefined)
    } satisfies NativeSystemFrontmostInputHelper;
    const resolved = createPlatformSystemFrontmostInput({ platform: "linux", linuxHelper: helper, currentProcessId: 77 });
    if (resolved.status !== "available") throw new Error("Expected Linux input support.");
    const failures: unknown[] = [];
    const controller = new SystemFrontmostInputController(resolved.runner, { onFailure: (error) => failures.push(error) });
    expect(controller.handle(submit())).toBe(true);
    await flush();
    await flush();
    expect(helper.captureTarget).toHaveBeenCalledOnce();
    expect(helper.postReturn).toHaveBeenCalledExactlyOnceWith({ nativeId: "314", processId: 999 });
    expect(helper.postPaste).not.toHaveBeenCalled();
    expect(helper.postScroll).not.toHaveBeenCalled();
    expect(failures).toEqual([failure]);
  });

  it("requires an injected macOS helper with explicit atomic/captured-target semantics", async () => {
    expect(createPlatformSystemFrontmostInput({ platform: "darwin" }))
      .toEqual({ status: "unsupported", reason: "helper-unavailable" });
    expect(createPlatformSystemFrontmostInput({ platform: "aix" }))
      .toEqual({ status: "unsupported", reason: "platform" });

    const helper = {
      postReturn: vi.fn(async () => undefined),
      captureTarget: vi.fn(() => ({ nativeId: "55", processId: 999 })),
      postPaste: vi.fn(async () => undefined),
      postScroll: vi.fn(async () => undefined)
    } satisfies NativeSystemFrontmostInputHelper;
    const resolved = createPlatformSystemFrontmostInput({ platform: "darwin", macHelper: helper });
    if (resolved.status !== "available") throw new Error("Expected injected macOS input support.");
    const target = resolved.runner.captureTarget();
    await resolved.runner.postReturn(target);
    await resolved.runner.postPaste(target);
    await resolved.runner.postScroll(target, -75.8);
    expect(helper.postReturn).toHaveBeenCalledOnce();
    expect(helper.captureTarget).toHaveBeenCalledOnce();
    expect(helper.postReturn).toHaveBeenCalledWith({ nativeId: "55", processId: 999 });
    expect(helper.postPaste).toHaveBeenCalledWith({ nativeId: "55", processId: 999 });
    expect(helper.postScroll).toHaveBeenCalledWith({ nativeId: "55", processId: 999 }, -76);
  });
});

describe("system frontmost scroll pump", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accumulates signed 120-unit Windows wheel notches", () => {
    let state = accumulateSystemFrontmostScrollNotches(0, 42);
    expect(state).toEqual({ remainder: 42, deltaY: 0 });
    state = accumulateSystemFrontmostScrollNotches(state.remainder, 42);
    expect(state).toEqual({ remainder: 84, deltaY: 0 });
    state = accumulateSystemFrontmostScrollNotches(state.remainder, 42);
    expect(state).toEqual({ remainder: 6, deltaY: 120 });
    expect(accumulateSystemFrontmostScrollNotches(0, -126)).toEqual({ remainder: -6, deltaY: -120 });
  });

  it("captures once on press and fixes every post to that target", async () => {
    let foreground = "101";
    let now = 1_000;
    const posts: Array<readonly [string, number]> = [];
    const captureTarget = vi.fn(() => nativeTarget(foreground));
    const pump = new SystemFrontmostScrollPump(runner({
      captureTarget,
      postScroll: async (target, delta) => { posts.push([target.nativeId, delta]); }
    }), { now: () => now });

    expect(pump.start("up", 1)).toBe(true);
    await flush();
    foreground = "202";
    now += 16;
    pump.tick();
    await flush();
    expect(pump.move("down", 1)).toBe(true);
    now += 16;
    pump.tick();
    await flush();

    expect(captureTarget).toHaveBeenCalledOnce();
    expect(posts.map(([target]) => target)).toEqual(["101", "101"]);
    expect(posts[0]?.[1]).toBeGreaterThan(0);
    expect(posts[1]?.[1]).toBeLessThan(0);
    pump.stop();
  });

  it("posts only complete Windows notches and clears the remainder on stop", async () => {
    let now = 1_000;
    const posted: number[] = [];
    const pump = new SystemFrontmostScrollPump(runner({
      postScroll: async (_target, delta) => { posted.push(delta); }
    }), { now: () => now, wheelNotch: SYSTEM_FRONTMOST_WINDOWS_WHEEL_NOTCH });
    pump.start("down", 1);
    await flush();
    for (let index = 0; index < 3; index += 1) {
      now += 16;
      pump.tick();
      await flush();
    }
    expect(posted).toEqual([-120]);

    pump.stop();
    pump.start("down", 1);
    await flush();
    now += 16;
    pump.tick();
    await flush();
    expect(posted).toEqual([-120]);
    pump.stop();
  });

  it("allows at most one asynchronous OS post and never queues missed ticks", async () => {
    let now = 100;
    const first = deferred<void>();
    const posted: Array<readonly [string, number]> = [];
    const postScroll = vi.fn((target: SystemFrontmostInputTarget, delta: number) => {
      posted.push([target.nativeId, delta]);
      return posted.length === 1 ? first.promise : Promise.resolve();
    });
    const pump = new SystemFrontmostScrollPump(runner({ postScroll }), { now: () => now });
    pump.start("up", 1);
    await flush();
    now += 16;
    pump.tick();
    await flush();
    expect(posted).toEqual([["101", 42]]);

    now += 100;
    pump.tick();
    pump.tick();
    expect(postScroll).toHaveBeenCalledOnce();
    first.resolve();
    await flush();
    now += 16;
    pump.tick();
    await flush();
    expect(posted).toEqual([["101", 42], ["101", 260]]);
    pump.stop();
  });

  it("fails a synchronous capture without admitting or queueing a stream", () => {
    const captureTarget = vi.fn(() => { throw new Error("capture denied"); });
    const postScroll = vi.fn(async () => undefined);
    const failures: unknown[] = [];
    const pump = new SystemFrontmostScrollPump(runner({ captureTarget, postScroll }), {
      onFailure: (error) => failures.push(error)
    });
    expect(pump.start("up", 1)).toBe(false);
    expect(captureTarget).toHaveBeenCalledOnce();
    pump.tick();
    expect(postScroll).not.toHaveBeenCalled();
    expect(pump.active()).toBe(false);
    expect(failures).toHaveLength(1);
  });

  it("caps elapsed time and stops an admitted stream on watchdog expiry", async () => {
    let now = 1_000;
    const posted: number[] = [];
    const first = new SystemFrontmostScrollPump(runner({
      postScroll: async (_target, delta) => { posted.push(delta); }
    }), { now: () => now });
    first.start("up", 1);
    await flush();
    now += 5_000;
    first.tick();
    await flush();
    expect(posted).toEqual([Math.round(2_600 * SYSTEM_FRONTMOST_SCROLL_MAX_ELAPSED_MS / 1_000)]);
    first.stop();

    const postScroll = vi.fn(async () => undefined);
    const stopped: string[] = [];
    const pending = new SystemFrontmostScrollPump(runner({ postScroll }), {
      onStop: (reason) => stopped.push(reason)
    });
    pending.start("up", 1);
    await vi.advanceTimersByTimeAsync(DEDICATED_WATCHDOG_MS);
    const postedBeforeManualTick = postScroll.mock.calls.length;
    pending.tick();
    expect(postScroll).toHaveBeenCalledTimes(postedBeforeManualTick);
    expect(stopped).toEqual(["watchdog"]);
  });

  it("fails closed on capture or post failure without replay", async () => {
    const captureFailures: unknown[] = [];
    const captureStops: string[] = [];
    const capture = new SystemFrontmostScrollPump(runner({
      captureTarget: () => { throw new Error("capture denied"); }
    }), {
      onFailure: (error) => captureFailures.push(error),
      onStop: (reason) => captureStops.push(reason)
    });
    expect(capture.start("up", 1)).toBe(false);
    expect(capture.active()).toBe(false);
    expect(captureFailures).toHaveLength(1);
    expect(captureStops).toEqual([]);

    let now = 10;
    const postFailures: unknown[] = [];
    const post = vi.fn(async () => { throw new Error("post denied"); });
    const output = new SystemFrontmostScrollPump(runner({ postScroll: post }), {
      now: () => now,
      onFailure: (error) => postFailures.push(error)
    });
    output.start("down", 1);
    await flush();
    now += 16;
    output.tick();
    await flush();
    await flush();
    output.tick();
    expect(output.active()).toBe(false);
    expect(post).toHaveBeenCalledOnce();
    expect(postFailures).toHaveLength(1);
  });

  it("rejects invalid and dead-zone input instead of starting or retaining a stream", async () => {
    const stopped: string[] = [];
    const captureTarget = vi.fn(() => nativeTarget("101"));
    const pump = new SystemFrontmostScrollPump(runner({ captureTarget }), {
      onStop: (reason) => stopped.push(reason)
    });
    expect(pump.start("up", 0.5)).toBe(false);
    expect(captureTarget).not.toHaveBeenCalled();
    expect(pump.start("up", 1)).toBe(true);
    await flush();
    expect(pump.move("up", 1.01)).toBe(false);
    expect(pump.active()).toBe(false);
    expect(stopped).toEqual(["invalid-input"]);
  });
});

const DEDICATED_WATCHDOG_MS = 10_000;

describe("system frontmost input controller", () => {
  it("consumes only fixed submit and press-owned continuous-scroll events", async () => {
    const postReturn = vi.fn(async () => undefined);
    const captureTarget = vi.fn(() => nativeTarget("101"));
    const value = runner({ postReturn, captureTarget });
    const pump = new SystemFrontmostScrollPump(value);
    const controller = new SystemFrontmostInputController(value, { scrollPump: pump });

    expect(controller.handle(submit())).toBe(true);
    expect(controller.handle({ ...submit(), phase: "release" })).toBe(false);
    expect(controller.handle({
      kind: "button", phase: "press", action: { kind: "composer-text", text: "do not inject" }
    })).toBe(false);
    expect(controller.handle({
      kind: "button", phase: "press", action: { kind: "fixed-link", linkId: "documentation" }
    })).toBe(false);
    expect(controller.handle({ kind: "button", phase: "press", action: { kind: "voice" } })).toBe(false);
    expect(controller.handle({ kind: "scroll", phase: "move", direction: "down", distance: 0.8 })).toBe(true);
    expect(captureTarget).toHaveBeenCalledOnce();
    expect(controller.handle({ kind: "scroll", phase: "press", direction: "down", distance: 0.8 })).toBe(true);
    await flush();
    expect(captureTarget).toHaveBeenCalledTimes(2);
    expect(controller.handle({ kind: "scroll", phase: "cancel" })).toBe(true);
    await flush();
    expect(postReturn).toHaveBeenCalledOnce();
  });

  it("drops a Return cancelled before its atomic call and never queues repeated Return", async () => {
    const pending = deferred<void>();
    const postReturn = vi.fn(() => pending.promise);
    const controller = new SystemFrontmostInputController(runner({ postReturn }));

    expect(controller.handle(submit())).toBe(true);
    controller.cancel();
    await flush();
    expect(postReturn).not.toHaveBeenCalled();

    expect(controller.handle(submit())).toBe(true);
    expect(controller.handle(submit())).toBe(true);
    await flush();
    expect(postReturn).toHaveBeenCalledOnce();
    controller.cancel();
    expect(controller.handle(submit())).toBe(true);
    await flush();
    expect(postReturn).toHaveBeenCalledOnce();
    pending.resolve();
    await flush();
  });

  it("rejects Return synchronously when atomic target capture fails", () => {
    const captureTarget = vi.fn(() => { throw new Error("capture denied"); });
    const postReturn = vi.fn(async () => undefined);
    const failures: unknown[] = [];
    const controller = new SystemFrontmostInputController(runner({ captureTarget, postReturn }), {
      onFailure: (error) => failures.push(error)
    });
    expect(controller.handle(submit())).toBe(false);
    expect(captureTarget).toHaveBeenCalledOnce();
    expect(postReturn).not.toHaveBeenCalled();
    expect(failures).toHaveLength(1);
  });

  it("reports one atomic Return failure without retry", async () => {
    const failures: unknown[] = [];
    const postReturn = vi.fn(async () => { throw new Error("return denied"); });
    const controller = new SystemFrontmostInputController(runner({ postReturn }), {
      onFailure: (error) => failures.push(error)
    });
    controller.handle(submit());
    await flush();
    await flush();
    expect(postReturn).toHaveBeenCalledOnce();
    expect(failures).toHaveLength(1);
  });
});

function submit() {
  return {
    kind: "button" as const,
    phase: "press" as const,
    action: { kind: "command" as const, command: "submit" as const }
  };
}
