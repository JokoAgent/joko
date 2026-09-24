import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { WdaProcessExecutor, type WdaProcessClock, type WdaProcessGroupControl } from "./wda-child-process.js";
import type { WdaCommandPlan } from "./wda-build-plan.js";

const UDID = "A0123456-1234-1234-1234-123456789ABC";
const base = { checkoutPath: "/private/joko/source", derivedDataPath: "/private/joko/derived",
  cacheRoot: "/private/joko/cache", instanceId: "instance-1", simulatorUdid: UDID,
  architecture: "arm64" as const, controlPort: 8100, mjpegPort: 9100 };

function mockChild(pid = 42): { child: ChildProcess; stdout: PassThrough; stderr: PassThrough; close(code: number | null): void } {
  const emitter = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(emitter, { pid, stdout, stderr });
  return { child: emitter, stdout, stderr, close: code => emitter.emit("close", code, null) };
}

it("uses one exact Xcode plan with a filtered child environment and rejects other platforms", async () => {
  const calls: WdaCommandPlan[] = [];
  const fake = mockChild();
  const executor = new WdaProcessExecutor({ ...base, platform: "darwin", hostEnvironment: {
    HOME: "/Users/test", API_TOKEN: "secret" }, spawnProcess: plan => {
    calls.push(plan);
    queueMicrotask(() => fake.close(0));
    return fake.child;
  }, group: { isAlive: () => false, signal: () => { throw new Error("no residual group"); } } });
  await executor.build();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ command: "/usr/bin/xcodebuild", cwd: base.checkoutPath,
    env: { HOME: "/Users/test", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  expect(calls[0]?.args).toContain("build-for-testing");
  expect(calls[0]?.args).toContain(`platform=iOS Simulator,id=${UDID},arch=arm64`);
  expect(JSON.stringify(calls[0])).not.toContain("secret");
  const failed = mockChild(44);
  const failure = new WdaProcessExecutor({ ...base, platform: "darwin",
    spawnProcess: () => { queueMicrotask(() => failed.close(65)); return failed.child; },
    group: { isAlive: () => false, signal: () => { throw new Error("no residual group"); } } });
  await expect(failure.build()).rejects.toMatchObject({ code: "BUILD_FAILED" });
  const unsupported = new WdaProcessExecutor({ ...base, platform: "win32",
    spawnProcess: () => { throw new Error("must not spawn"); } });
  await expect(unsupported.build()).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM" });
  expect(() => unsupported.launch()).toThrow(/macOS/u);
});

it("retires the owned process group on cancellation and timeout without leaking child output", async () => {
  const fake = mockChild();
  const signals: string[] = [];
  let alive = true;
  const group: WdaProcessGroupControl = { isAlive: () => alive, signal: (_pid, signal) => {
    signals.push(signal);
    alive = false;
    fake.close(null);
  } };
  const controller = new AbortController();
  const executor = new WdaProcessExecutor({ ...base, platform: "darwin", buildTimeoutMs: 20,
    spawnProcess: () => fake.child, group });
  const cancelled = executor.build(controller.signal);
  fake.stderr.write("/private/credential should stay private");
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ code: "CANCELLED" });
  expect(signals).toEqual(["SIGINT"]);

  const timed = mockChild(43);
  let timedAlive = true;
  const timeout = new WdaProcessExecutor({ ...base, platform: "darwin", buildTimeoutMs: 5,
    spawnProcess: () => timed.child,
    group: { isAlive: () => timedAlive, signal: () => { timedAlive = false; timed.close(null); } } });
  await expect(timeout.build()).rejects.toMatchObject({ code: "BUILD_TIMEOUT" });
  expect(timedAlive).toBe(false);
});

it("escalates only its known group and caps a real child process output buffer", async () => {
  const fake = mockChild(52);
  const sent: string[] = [];
  let alive = true;
  let now = 0;
  const clock: WdaProcessClock = { now: () => now, sleep: async ms => { now += ms; } };
  const group: WdaProcessGroupControl = { isAlive: pid => {
    expect(pid).toBe(52);
    return alive;
  }, signal: (pid, signal) => {
    expect(pid).toBe(52);
    sent.push(signal);
    if (signal === "SIGKILL") { alive = false; fake.close(null); }
  } };
  const executor = new WdaProcessExecutor({ ...base, platform: "darwin", spawnProcess: () => fake.child,
    group, clock });
  const child = executor.launch();
  await child.stop();
  await child.stop();
  expect(sent).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  expect((await child.exited).code).toBeNull();

  let nodeChild: ChildProcess | undefined;
  const nodeExecutor = new WdaProcessExecutor({ ...base, platform: "darwin", spawnProcess: () => {
    nodeChild = spawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(1024*1024));setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return nodeChild;
  }, group: { isAlive: () => nodeChild?.exitCode === null && nodeChild?.signalCode === null,
    signal: (_pid, signal) => { nodeChild?.kill(signal); } } });
  const real = nodeExecutor.launch();
  try {
    const deadline = Date.now() + 2_000;
    while (real.bufferedLogBytes === 0 && Date.now() < deadline && !real.isExited) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(real.bufferedLogBytes).toBeGreaterThan(0);
    expect(real.bufferedLogBytes).toBeLessThanOrEqual(256 * 1024);
  } finally {
    await real.stop();
  }
  expect((await real.exited).signal).not.toBeNull();
});
