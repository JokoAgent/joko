import { describe, expect, it, vi } from "vitest";
import {
  createDefaultPiManagedProcessSupervisor,
  parsePosixProcessTable,
  parseWindowsProcessTable,
  terminateFrozenPosixTree,
  type PiProcessTableRow,
  type PiProcessTableSnapshot
} from "./runtime-process.js";

function row(input: Partial<PiProcessTableRow> & Pick<PiProcessTableRow, "pid" | "ppid">): PiProcessTableRow {
  return {
    pid: input.pid,
    ppid: input.ppid,
    state: input.state ?? "S",
    commandLower: input.commandLower ?? "pi --mode rpc",
    memoryKb: input.memoryKb ?? 0,
    cpuPercent: input.cpuPercent === undefined ? 0 : input.cpuPercent,
    cpuTimeMs: input.cpuTimeMs === undefined ? null : input.cpuTimeMs,
    startIdentity: input.startIdentity === undefined ? `birth-${input.pid}` : input.startIdentity
  };
}

function snapshot(rows: readonly PiProcessTableRow[]): PiProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  for (const process of rows) {
    const children = childrenByParent.get(process.ppid);
    if (children === undefined) childrenByParent.set(process.ppid, [process.pid]);
    else children.push(process.pid);
  }
  return { rows, childrenByParent };
}

describe("managed runtime process supervision", () => {
  it("parses POSIX and Windows scans without exposing them through the public usage shape", () => {
    const posix = parsePosixProcessTable(
      "12 1 S 2.5 2048 Mon Aug 25 04:00:00 2026 /opt/pi --mode rpc\n"
    );
    expect(posix.rows).toEqual([expect.objectContaining({
      pid: 12,
      ppid: 1,
      cpuPercent: 2.5,
      memoryKb: 2048,
      startIdentity: "Mon Aug 25 04:00:00 2026"
    })]);

    const windows = parseWindowsProcessTable(
      "44|12|1048576|25000000|638917200000000000|C:\\pi.exe --mode rpc\n"
    );
    expect(windows.rows).toEqual([expect.objectContaining({
      pid: 44,
      ppid: 12,
      memoryKb: 1024,
      cpuTimeMs: 2500,
      startIdentity: "638917200000000000"
    })]);
  });

  it("aggregates the complete owned tree and excludes the OS console helper only from the visible count", async () => {
    const processTable = snapshot([
      row({ pid: 100, ppid: 1, cpuPercent: 10, memoryKb: 100 }),
      row({ pid: 101, ppid: 100, cpuPercent: 4, memoryKb: 50 }),
      row({
        pid: 102,
        ppid: 101,
        cpuPercent: 1,
        memoryKb: 20,
        commandLower: "\\??\\c:\\windows\\system32\\conhost.exe 0x4"
      }),
      row({ pid: 900, ppid: 1, cpuPercent: 99, memoryKb: 999 })
    ]);
    const supervisor = createDefaultPiManagedProcessSupervisor({
      platform: "linux",
      captureIdentity: async (pid) => pid === 100 ? "owned-birth" : undefined,
      captureIdentitySync: () => undefined,
      scan: async () => processTable,
      scanSync: () => processTable
    });

    await expect(supervisor.inspect?.([{ pid: 100, expectedIdentity: "owned-birth" }])).resolves.toEqual([{
      pid: 100,
      cpuPercent: 15,
      memoryKb: 170,
      processCount: 2
    }]);
    await expect(supervisor.inspect?.([{ pid: 100, expectedIdentity: "reused-birth" }])).resolves.toEqual([]);
  });

  it("derives Windows CPU from cumulative time and resets the baseline across PID reuse", async () => {
    let at = 1_000;
    let current = snapshot([row({
      pid: 200,
      ppid: 1,
      cpuPercent: null,
      cpuTimeMs: 1_000,
      startIdentity: "birth-a"
    })]);
    const supervisor = createDefaultPiManagedProcessSupervisor({
      platform: "win32",
      now: () => at,
      captureIdentity: async () => "private-fence",
      captureIdentitySync: () => "private-fence",
      scan: async () => current,
      scanSync: () => current,
      killWindowsTree: () => true
    });

    expect((await supervisor.inspect?.([{ pid: 200, expectedIdentity: "private-fence" }]))?.[0]?.cpuPercent).toBe(0);
    at = 6_000;
    current = snapshot([row({
      pid: 200,
      ppid: 1,
      cpuPercent: null,
      cpuTimeMs: 2_500,
      startIdentity: "birth-a"
    })]);
    expect((await supervisor.inspect?.([{ pid: 200, expectedIdentity: "private-fence" }]))?.[0]?.cpuPercent).toBe(30);

    at = 12_000;
    current = snapshot([row({
      pid: 200,
      ppid: 1,
      cpuPercent: null,
      cpuTimeMs: 100,
      startIdentity: "birth-b"
    })]);
    expect((await supervisor.inspect?.([{ pid: 200, expectedIdentity: "private-fence" }]))?.[0]?.cpuPercent).toBe(0);
  });

  it("freezes parents before descendants and kills descendants before the root", () => {
    const scans = [
      snapshot([
        row({ pid: 10, ppid: 1, state: "S" }),
        row({ pid: 11, ppid: 10, state: "S" }),
        row({ pid: 12, ppid: 11, state: "S" })
      ]),
      snapshot([
        row({ pid: 10, ppid: 1, state: "T" }),
        row({ pid: 11, ppid: 10, state: "S" }),
        row({ pid: 12, ppid: 11, state: "S" })
      ]),
      snapshot([
        row({ pid: 10, ppid: 1, state: "T" }),
        row({ pid: 11, ppid: 10, state: "T" }),
        row({ pid: 12, ppid: 11, state: "S" })
      ]),
      snapshot([
        row({ pid: 10, ppid: 1, state: "T" }),
        row({ pid: 11, ppid: 10, state: "T" }),
        row({ pid: 12, ppid: 11, state: "T" })
      ])
    ];
    const calls: string[] = [];

    expect(terminateFrozenPosixTree({
      rootPid: 10,
      expectedIdentity: "private-fence",
      captureIdentitySync: () => "private-fence",
      scan: () => scans.shift()!,
      signal: (pid, signal) => calls.push(`${signal}:${pid}`)
    })).toBe("terminated");
    expect(calls).toEqual([
      "SIGSTOP:10",
      "SIGSTOP:11",
      "SIGSTOP:12",
      "SIGKILL:12",
      "SIGKILL:11",
      "SIGKILL:10"
    ]);
  });

  it("fails closed on root identity changes and never resumes the replacement PID", () => {
    const processTable = snapshot([row({ pid: 10, ppid: 1, state: "S" })]);
    const identities = ["private-fence", "replacement-fence"];
    const calls: string[] = [];

    expect(terminateFrozenPosixTree({
      rootPid: 10,
      expectedIdentity: "private-fence",
      captureIdentitySync: () => identities.shift(),
      scan: () => processTable,
      signal: (pid, signal) => calls.push(`${signal}:${pid}`)
    })).toBe("identity_mismatch");
    expect(calls).toEqual(["SIGSTOP:10"]);
  });

  it("restores only processes newly stopped by a failed POSIX termination", () => {
    const scans = [
      snapshot([
        row({ pid: 10, ppid: 1, state: "S" }),
        row({ pid: 11, ppid: 10, state: "T" })
      ]),
      snapshot([
        row({ pid: 10, ppid: 1, state: "R" }),
        row({ pid: 11, ppid: 10, state: "T" })
      ])
    ];
    const calls: string[] = [];

    expect(() => terminateFrozenPosixTree({
      rootPid: 10,
      expectedIdentity: "private-fence",
      captureIdentitySync: () => "private-fence",
      scan: () => scans.shift()!,
      signal: (pid, signal) => calls.push(`${signal}:${pid}`)
    })).toThrow("stopped state");
    expect(calls).toEqual(["SIGSTOP:10", "SIGCONT:10"]);
  });

  it("rechecks Windows birth identity synchronously before terminating the tree", async () => {
    const killWindowsTree = vi.fn(() => true);
    const reused = createDefaultPiManagedProcessSupervisor({
      platform: "win32",
      captureIdentity: async () => "replacement-fence",
      captureIdentitySync: () => "replacement-fence",
      scan: async () => snapshot([]),
      scanSync: () => snapshot([]),
      killWindowsTree
    });
    await expect(reused.terminate(88, "private-fence", 100)).resolves.toBe("identity_mismatch");
    expect(killWindowsTree).not.toHaveBeenCalled();

    const identities = ["private-fence", "private-fence"];
    const owned = createDefaultPiManagedProcessSupervisor({
      platform: "win32",
      captureIdentity: async () => undefined,
      captureIdentitySync: () => identities.shift(),
      scan: async () => snapshot([]),
      scanSync: () => snapshot([]),
      killWindowsTree
    });
    await expect(owned.terminate(88, "private-fence", 100)).resolves.toBe("terminated");
    expect(killWindowsTree).toHaveBeenCalledWith(88, 100);
  });
});
