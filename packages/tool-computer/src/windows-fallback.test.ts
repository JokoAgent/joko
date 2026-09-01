import { describe, expect, it, vi } from "vitest";

import type { ComputerCommandRequest, ComputerCommandRunner } from "./process-runner.js";
import { callWindowsComputerFallback, parseWindowsComputerSnapshot } from "./windows-fallback.js";

const SNAPSHOT = JSON.stringify([
  {
    window_id: 100,
    pid: 7,
    title: "Editor - Project",
    process_name: "Editor",
    executable_path: "D:\\Project\\Editor.exe",
    on_screen: true,
    minimized: false,
    bounds: { x: 10, y: 20, width: 900, height: 600 }
  },
  {
    window_id: 101,
    pid: 8,
    title: "Terminal",
    process_name: "Terminal",
    executable_path: "C:\\Tools\\Terminal.exe",
    on_screen: false,
    minimized: true,
    bounds: { x: -20, y: 0, width: 700, height: 500 }
  }
]);

describe("Windows computer automation fallback", () => {
  it("parses only bounded visible-window records", () => {
    expect(parseWindowsComputerSnapshot(SNAPSHOT)).toEqual([
      expect.objectContaining({
        window_id: 100,
        pid: 7,
        title: "Editor - Project",
        bounds: { x: 10, y: 20, width: 900, height: 600 }
      }),
      expect.objectContaining({ window_id: 101, minimized: true })
    ]);
    expect(parseWindowsComputerSnapshot('[{"pid":"bad"}]')).toEqual([]);
  });

  it("applies read-only process, query, workspace, and on-screen filters", async () => {
    const runner = snapshotRunner();

    const result = await callWindowsComputerFallback(runner, "list_windows", {
      process_name: "edit",
      query: "project",
      workspace_root: "D:\\Project",
      on_screen_only: true
    });

    expect(result).toMatchObject({
      ok: true,
      source: "win32_fallback",
      windows: [expect.objectContaining({ pid: 7, process_name: "Editor" })]
    });
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      command: "powershell.exe",
      timeoutMs: 4_000,
      maximumStdoutBytes: 2 * 1024 * 1024
    }));
  });

  it("deduplicates the application view by process", async () => {
    const runner = snapshotRunner();

    await expect(callWindowsComputerFallback(runner, "list_apps", {})).resolves.toMatchObject({
      apps: [
        expect.objectContaining({ pid: 7, name: "Editor", running: true }),
        expect.objectContaining({ pid: 8, name: "Terminal", running: true })
      ]
    });
  });
});

function snapshotRunner(): ComputerCommandRunner & { readonly run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (_request: ComputerCommandRequest) => ({
    stdout: SNAPSHOT,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    signal: null
  }));
  return { run };
}
