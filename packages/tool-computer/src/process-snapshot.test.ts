import { describe, expect, it, vi } from "vitest";

import type {
  ComputerCommandRequest,
  ComputerCommandResult,
  ComputerCommandRunner
} from "./process-runner.js";
import { ComputerProcessSnapshotReader } from "./process-snapshot.js";

describe("ComputerProcessSnapshotReader", () => {
  it("enriches windows with bounded host identity and redacts command credentials", async () => {
    const runner = runnerReturning(result(JSON.stringify({
      ProcessId: 4321,
      ParentProcessId: 4100,
      Name: "node.exe",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: "node.exe C:\\work\\repo\\app.js --token supersecret"
    })));
    const reader = new ComputerProcessSnapshotReader({
      platform: "win32",
      runner,
      pathExists: (candidate) => candidate.toLowerCase() === "c:\\work\\repo\\.git"
    });

    const payload = await reader.enrichAndFilter({
      ok: true,
      windows: [{ id: 7, pid: 4321, title: "Development server" }]
    }, {
      process_name: "node",
      workspace_root: "C:\\work\\repo"
    });

    expect(payload).toMatchObject({
      windows: [{
        pid: 4321,
        process: {
          pid: 4321,
          parent_pid: 4100,
          name: "node.exe",
          command: expect.stringContaining("--token [redacted]")
        },
        identity: {
          kind: "node-dev",
          workspace_root: "C:\\work\\repo"
        }
      }]
    });
    expect(JSON.stringify(payload)).not.toContain("supersecret");
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      command: "powershell.exe",
      timeoutMs: 4_000,
      maximumStdoutBytes: 2 * 1024 * 1024
    }));
  });

  it("marks process-filter enrichment unavailable instead of matching unverified data", async () => {
    const reader = new ComputerProcessSnapshotReader({
      platform: "linux",
      runner: runnerReturning(result("", "unavailable", 1))
    });

    await expect(reader.enrichAndFilter({
      data: { windows: [{ id: 1, pid: 99, title: "Editor" }] }
    }, { process_name: "node" })).resolves.toEqual({
      enrichment: "unavailable",
      data: { windows: [] }
    });
  });

  it("marks a safely truncated public process command instead of hiding the projection boundary", async () => {
    const runner = runnerReturning(result(JSON.stringify({
      ProcessId: 4321,
      ParentProcessId: 4100,
      Name: "node.exe",
      ExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
      CommandLine: `node.exe ${"x".repeat(20_000)}`
    })));
    const reader = new ComputerProcessSnapshotReader({ platform: "win32", runner });

    const payload = await reader.enrichAndFilter({
      ok: true,
      windows: [{ id: 7, pid: 4321, title: "Development server" }]
    }, {});
    const command = (payload as { windows: Array<{ process: { command: string } }> }).windows[0]!.process.command;
    expect(command).toHaveLength(16 * 1024);
    expect(command.endsWith("…")).toBe(true);
  });
});

function runnerReturning(response: ComputerCommandResult): ComputerCommandRunner & {
  readonly run: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async (_request: ComputerCommandRequest) => response)
  };
}

function result(stdout: string, stderr = "", exitCode: number | null = 0): ComputerCommandResult {
  return {
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode,
    signal: null
  };
}
