import { expect, it } from "vitest";
import { type SimulatorCommandResult, type SimulatorCommandRunner } from "./environment.js";
import {
  collectSimulatorMemorySnapshot, parseSimulatorMemoryFreePercentage,
  SimulatorResourceScheduler, type SimulatorMemorySnapshot
} from "./resource.js";

const memory = (freePercentage: number | null, freeBytes = 4 * 1024 ** 3): SimulatorMemorySnapshot => ({
  source: freePercentage === null ? "node-os" : "macos-memory-pressure",
  freePercentage, freeBytes, totalBytes: 8 * 1024 ** 3
});

it("bounds the macOS memory probe and uses conservative bytes when pressure cannot be read", async () => {
  expect(parseSimulatorMemoryFreePercentage("System-wide memory free percentage: 19.5%\n")).toBe(19.5);
  expect(parseSimulatorMemoryFreePercentage("System-wide memory free percentage: 101%\n")).toBeNull();
  let calls = 0;
  const result: SimulatorCommandResult = { stdout: "System-wide memory free percentage: 23%", stderr: "", exitCode: 0 };
  const runner: SimulatorCommandRunner = { run: async (command, args, options) => {
    calls += 1;
    expect(command).toBe("/usr/bin/memory_pressure");
    expect(args).toEqual(["-Q"]);
    expect(options?.timeoutMs).toBe(5_000);
    return result;
  } };
  expect(await collectSimulatorMemorySnapshot({ platform: "darwin", runner,
    freeBytes: () => 100, totalBytes: () => 200 })).toEqual({
    source: "macos-memory-pressure", freePercentage: 23, freeBytes: 100, totalBytes: 200
  });
  expect(calls).toBe(1);
  expect(await collectSimulatorMemorySnapshot({ platform: "win32", runner,
    freeBytes: () => 100, totalBytes: () => 200 })).toEqual({
    source: "node-os", freePercentage: null, freeBytes: 100, totalBytes: 200
  });
  expect(calls).toBe(1);
  const unavailable: SimulatorCommandRunner = { run: async () => ({ ...result, timedOut: true }) };
  expect(await collectSimulatorMemorySnapshot({ platform: "darwin", runner: unavailable,
    freeBytes: () => 100, totalBytes: () => 200 })).toMatchObject({ source: "node-os", freePercentage: null });
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(collectSimulatorMemorySnapshot({ platform: "darwin", runner, signal: cancelled.signal }))
    .rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
  expect(calls).toBe(1);
});

it("serializes starts, enforces memory thresholds and hard limit, and releases only after confirmed stop", async () => {
  const physicallyRunning = new Set<string>();
  const observe = async () => [...physicallyRunning];
  let free = 10;
  const scheduler = new SimulatorResourceScheduler({ memoryProbe: async () => memory(free) });
  let entered!: () => void;
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const firstRelease = new Promise<void>(resolve => { release = resolve; });
  const first = scheduler.runStart("one", observe, async () => {
    entered(); await firstRelease; physicallyRunning.add("one"); return "one";
  });
  await firstEntered;
  let secondStarted = false;
  const second = scheduler.runStart("two", observe, async () => {
    secondStarted = true; physicallyRunning.add("two"); return "two";
  });
  await Promise.resolve();
  expect(secondStarted).toBe(false);
  release();
  expect(await first).toBe("one");
  expect(await second).toBe("two");
  expect(scheduler.snapshot()).toEqual({ runningCount: 2, softLimit: 2, hardLimit: 4 });
  await expect(scheduler.runStart("three", observe, async () => {
    throw new Error("must not start");
  })).rejects.toMatchObject({ code: "MEMORY_PRESSURE" });
  free = 20;
  for (const id of ["three", "four"]) {
    await scheduler.runStart(id, observe, async () => { physicallyRunning.add(id); });
  }
  expect(scheduler.snapshot().runningCount).toBe(4);
  await expect(scheduler.runStart("five", observe, async () => undefined))
    .rejects.toMatchObject({ code: "RESOURCE_LIMIT_REACHED" });
  await expect(scheduler.runStop("one", async () => { throw new Error("shutdown unknown"); }))
    .rejects.toThrow(/shutdown unknown/u);
  expect(scheduler.snapshot().runningCount).toBe(4);
  await scheduler.runStop("one", async () => { physicallyRunning.delete("one"); });
  expect(scheduler.snapshot().runningCount).toBe(3);
});

it("reobserves failed starts and reconstructs occupancy in a new scheduler", async () => {
  const physicallyRunning = new Set<string>();
  const observe = async () => [...physicallyRunning];
  const scheduler = new SimulatorResourceScheduler({ memoryProbe: async () => memory(30) });
  await expect(scheduler.runStart("one", observe, async () => {
    physicallyRunning.add("one");
    throw new Error("boot outcome unknown");
  })).rejects.toThrow(/unknown/u);
  expect(scheduler.snapshot().runningCount).toBe(1);
  await expect(scheduler.runStart("two", observe, async () => { throw new Error("boot failed"); }))
    .rejects.toThrow(/boot failed/u);
  expect(scheduler.snapshot().runningCount).toBe(1);
  const restarted = new SimulatorResourceScheduler({ memoryProbe: async () => memory(15), softLimit: 1, hardLimit: 2 });
  await expect(restarted.runStart("two", observe, async () => undefined))
    .rejects.toMatchObject({ code: "MEMORY_PRESSURE" });
  expect(restarted.snapshot().runningCount).toBe(1);
  physicallyRunning.delete("one");
  await restarted.runStart("two", observe, async () => { physicallyRunning.add("two"); });
  expect(restarted.snapshot().runningCount).toBe(1);
});

it("uses byte thresholds only when pressure is unavailable and fails closed on unknown observations", async () => {
  let bytes = 511 * 1024 ** 2;
  const running = new Set<string>();
  const observe = async () => [...running];
  const scheduler = new SimulatorResourceScheduler({ memoryProbe: async () => memory(null, bytes) });
  await expect(scheduler.runStart("one", observe, async () => undefined)).rejects.toMatchObject({ code: "MEMORY_PRESSURE" });
  bytes = 512 * 1024 ** 2;
  await scheduler.runStart("one", observe, async () => { running.add("one"); });
  bytes = 1.5 * 1024 ** 3 - 1;
  await expect(scheduler.runStart("two", observe, async () => undefined)).rejects.toMatchObject({ code: "MEMORY_PRESSURE" });
  bytes = 1.5 * 1024 ** 3;
  await scheduler.runStart("two", observe, async () => { running.add("two"); });
  bytes = 2.5 * 1024 ** 3 - 1;
  await expect(scheduler.runStart("three", observe, async () => undefined)).rejects.toMatchObject({ code: "MEMORY_PRESSURE" });
  await expect(scheduler.runStart("three", async () => { throw new Error("catalog unreadable"); }, async () => undefined))
    .rejects.toMatchObject({ code: "RESOURCE_STATE_UNKNOWN" });
  expect(scheduler.snapshot().runningCount).toBe(2);
  expect(() => new SimulatorResourceScheduler({ softLimit: 3, hardLimit: 2 })).toThrow(/limits/u);
});

it("drops a cancelled stop while it waits behind another instance start", async () => {
  const scheduler = new SimulatorResourceScheduler({ memoryProbe: async () => memory(30) });
  let entered!: () => void;
  const bootEntered = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const releaseBoot = new Promise<void>(resolve => { release = resolve; });
  const active = scheduler.runStart("one", async () => [], async () => { entered(); await releaseBoot; });
  await bootEntered;
  const controller = new AbortController();
  let stopped = false;
  const queued = scheduler.runStop("two", async () => { stopped = true; }, controller.signal);
  controller.abort();
  release();
  await active;
  await expect(queued).rejects.toMatchObject({ code: "MUTATION_CANCELLED" });
  expect(stopped).toBe(false);
});
