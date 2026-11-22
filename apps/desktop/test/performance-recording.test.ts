import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopPerformanceRecording } from "../src/performance-recording.js";

describe("desktop performance recording", () => {
  it("keeps timing aggregates for the originating renderer and restricts stop and report recovery", async () => {
    await withRecording(async ({ recording, trace, reveal, root }) => {
      let destroyed = false;
      const source = { ...windowSource("task", "owner"), isCurrent: () => !destroyed, destroyed: () => destroyed };
      const main = windowSource("main", "owner", true);
      const other = windowSource("other", "another-owner", true);
      await recording.start(source);
      expect(trace.startRecording).toHaveBeenCalledWith(expect.objectContaining({ included_process_ids: [10], enable_argument_filter: true }));
      expect(recording.state(source)).toBe("recording");
      expect(recording.state(main)).toBe("busy");
      await expect(recording.stop(main)).rejects.toThrow("window that started");
      await recording.stop(source);
      expect(recording.state(source)).toBe("ready");
      expect(() => recording.reveal(main)).toThrow("no performance report");
      recording.reveal(source);
      const files = await readdir(join(root, "reports"));
      const report = await readFile(join(root, "reports", files[0]!), "utf8");
      expect(JSON.parse(report).rendererEvents).toEqual({ FunctionCall: { count: 1, totalMs: 2.5, maximumMs: 2.5 } });
      expect(report).not.toContain("private-message");
      expect(await readdir(root)).toEqual(["reports"]);
      destroyed = true;
      expect(() => recording.reveal(other)).toThrow("no performance report");
      expect(() => recording.reveal(windowSource("second-task", "owner"))).toThrow("no performance report");
      recording.reveal(main);
      expect(reveal).toHaveBeenCalledTimes(2);
    });
  });

  it("discards a recording retired during stop and then allows another owner to start", async () => {
    await withRecording(async ({ recording, root }) => {
      const source = windowSource("task", "owner");
      const next = windowSource("task", "new-owner");
      await recording.start(source);
      const stopping = recording.stop(source);
      recording.retire(next);
      recording.retire(source);
      await stopping;
      expect(await readdir(root)).toEqual([]);
      expect(recording.state(source)).toBe("idle");
      await recording.start(next);
      await recording.stop(next);
      expect(recording.state(next)).toBe("ready");
    });
  });
});

function windowSource(id: string, owner: string, main = false) {
  return { id, owner, main, pid: 10, isCurrent: () => true, destroyed: () => false };
}

async function withRecording(assert: (fixture: ReturnType<typeof recordingFixture>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "joko-performance-test-"));
  try { await assert(recordingFixture(root)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function recordingFixture(root: string) {
  const trace = {
    startRecording: vi.fn(async () => undefined),
    stopRecording: vi.fn(async (target?: string) => {
      if (!target) throw new Error("No recording path");
      await writeFile(target, JSON.stringify({ traceEvents: [
        { pid: 10, ph: "X", name: "FunctionCall", dur: 2500, args: { label: "private-message" } },
        { pid: 11, ph: "X", name: "FunctionCall", dur: 10000 },
        { pid: 10, ph: "X", name: "private-message", dur: 3000 }
      ] }));
      return target;
    })
  };
  const reveal = vi.fn();
  return { recording: new DesktopPerformanceRecording(trace, () => root, () => join(root, "reports"), reveal), trace, reveal, root };
}
