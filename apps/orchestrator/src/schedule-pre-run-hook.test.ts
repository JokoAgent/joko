import { rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  durableSchedulePreRunHookResult,
  executeSchedulePreRunHook,
  resolveScheduleHookCommand,
  resolveSchedulePreRunHookTimeout,
  schedulePreRunFailureSummary,
  schedulePreRunSkipSummary,
  type SchedulePreRunHookPayload
} from "./schedule-pre-run-hook.js";

const payload: SchedulePreRunHookPayload = {
  event: "schedule-pre-run",
  scheduleId: "schedule-1",
  scheduleName: "Check first",
  runId: "run-1",
  firedAt: 1_700_000_000_000
};

describe("executeSchedulePreRunHook", () => {
  it.each([
    [0, "passed", "run"],
    [2, "skipped", "skip"],
    [3, "failed", "block"]
  ] as const)("maps exit %i to %s/%s", async (exitCode, status, decision) => {
    const result = await executeSchedulePreRunHook({
      command: nodeEval(`process.exit(${exitCode})`),
      stdinPayload: payload
    });
    expect(result).toMatchObject({ exitCode, status, decision, timedOut: false, aborted: false });
  });

  it("passes the structured schedule context on stdin", async () => {
    const source = "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const v=JSON.parse(d);console.log(v.event+':'+v.scheduleId);process.exit(v.scheduleId==='schedule-1'?2:1)})";
    const result = await executeSchedulePreRunHook({ command: nodeEval(source), stdinPayload: payload });
    expect(result).toMatchObject({ status: "skipped", decision: "skip", exitCode: 2 });
    expect(result.stdout).toContain("schedule-pre-run:schedule-1");
  });

  it("captures and byte-bounds stdout and stderr independently", async () => {
    const result = await executeSchedulePreRunHook({
      command: nodeEval("process.stdout.write('x'.repeat(9000));process.stderr.write('y'.repeat(9000))"),
      stdinPayload: payload
    });
    expect(Buffer.byteLength(result.stdout)).toBe(8 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBe(8 * 1024);
    expect(result).toMatchObject({ status: "passed", stdoutTruncated: true, stderrTruncated: true });
  });

  it("fails closed on timeout and stops well before the child delay", async () => {
    const started = Date.now();
    const result = await executeSchedulePreRunHook({
      command: nodeEval("setTimeout(()=>process.exit(2),30000)"),
      timeoutMs: 250,
      stdinPayload: payload
    });
    expect(result).toMatchObject({ status: "timed_out", decision: "block", timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("returns an immediate aborted block without spawning when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeSchedulePreRunHook({
      command: nodeEval("process.exit(0)"),
      signal: controller.signal,
      stdinPayload: payload
    });
    expect(result).toEqual({
      status: "aborted",
      decision: "block",
      exitCode: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      aborted: true
    });
  });

  it("tree-stops a running gate when its schedule is cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = executeSchedulePreRunHook({
      command: nodeEval("setTimeout(()=>process.exit(0),30000)"),
      timeoutMs: 60_000,
      signal: controller.signal,
      stdinPayload: payload
    });
    setTimeout(() => controller.abort(), 250);
    const result = await pending;
    expect(result).toMatchObject({ status: "aborted", decision: "block", aborted: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);

  it("folds spawn failures into a structured blocked result", async () => {
    const result = await executeSchedulePreRunHook({
      command: nodeEval("process.exit(0)"),
      cwd: "Z:/this/path/does/not/exist/schedule-hook",
      stdinPayload: payload
    });
    expect(result).toMatchObject({ status: "failed", decision: "block", exitCode: null });
    expect(result.spawnError ?? result.error).toBeTruthy();
  });

  it("uses a stable bundled-runtime alias for installed scripts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-hook-runtime-"));
    const script = join(directory, "gate.mjs");
    try {
      await writeFile(script, "process.exit(2);\n", "utf8");
      const resolved = resolveScheduleHookCommand(`joko-node "${script}"`);
      expect(resolved.command).toBe(`"${process.execPath}" "${script}"`);
      const result = await executeSchedulePreRunHook({
        command: `joko-node "${script}"`,
        stdinPayload: payload
      });
      expect(result).toMatchObject({ status: "skipped", exitCode: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("pre-run hook projections", () => {
  it("enables timeouts only for explicit positive finite values", () => {
    expect(resolveSchedulePreRunHookTimeout(undefined)).toBeUndefined();
    expect(resolveSchedulePreRunHookTimeout(Number.NaN)).toBeUndefined();
    expect(resolveSchedulePreRunHookTimeout(0)).toBeUndefined();
    expect(resolveSchedulePreRunHookTimeout(-1)).toBeUndefined();
    expect(resolveSchedulePreRunHookTimeout(400.9)).toBe(400);
  });

  it("builds bounded summaries and strips raw command output at persistence boundaries", () => {
    const result = {
      status: "skipped",
      decision: "skip",
      exitCode: 2,
      durationMs: 14,
      stdout: `first line ${"x".repeat(250)}\nsecond line api_key=sk-secret-value`,
      stderr: "debug password=hunter2",
      stdoutTruncated: true,
      stderrTruncated: false,
      timedOut: false,
      aborted: false
    } as const;
    expect(schedulePreRunSkipSummary(result)).toMatch(/^Pre-run hook exit 2 — 14ms — first line/u);
    expect(schedulePreRunSkipSummary(result).length).toBeLessThan(250);
    expect(schedulePreRunFailureSummary({ ...result, status: "failed", decision: "block", exitCode: 1 }))
      .toBe("Pre-run hook failed with exit code 1.");
    const durable = durableSchedulePreRunHookResult(result);
    expect(durable).not.toHaveProperty("stdout");
    expect(durable).not.toHaveProperty("stderr");
    expect(JSON.stringify(durable)).not.toContain("sk-secret-value");
    expect(JSON.stringify(durable)).not.toContain("hunter2");
  });
});

function nodeEval(source: string): string {
  return `"${process.execPath}" -e "${source}"`;
}
