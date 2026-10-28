import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ lstat: vi.fn() }));
const recovery = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock("./managed-subagent-process-inventory.js", () => ({ readManagedSubagentRecoveryInventory: recovery.inventory }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof files>(), lstat: native.lstat
}));
import { managedSubagentSessionKey, stopAndRemoveManagedSubagentRuns, stopManagedSubagentRunsByProvider } from "./durable-subagent-runs.js";

let original: typeof files;
const roots: string[] = [];
beforeEach(async () => {
  original = await vi.importActual<typeof files>("node:fs/promises");
  native.lstat.mockImplementation(original.lstat);
  recovery.inventory.mockReset().mockResolvedValue(["node test-runner"]);
});
afterEach(async () => {
  native.lstat.mockImplementation(original.lstat);
  for (const root of roots.splice(0)) await original.rm(root, { recursive: true, force: true });
});

async function terminalRun() {
  const root = await original.realpath(await original.mkdtemp(join(tmpdir(), "joko-private-run-read-")));
  roots.push(root);
  const productSessionId = randomUUID(), runId = randomUUID();
  const directory = join(root, managedSubagentSessionKey(productSessionId), runId);
  await original.mkdir(directory, { recursive: true });
  const runnerScript = join(directory, "joko-managed-subagent-runner.cjs"), script = "// terminal fixture\n";
  const manifest = { format: 1, runId, launchToken: randomUUID(), productSessionId, taskId: "owned-task", runnerScript,
    runnerScriptSha256: createHash("sha256").update(script).digest("hex"), runnerInstanceId: randomUUID(), runnerPid: 0 };
  const statusPath = join(directory, "status.json");
  await Promise.all([
    original.writeFile(runnerScript, script),
    original.writeFile(statusPath, JSON.stringify({ ...manifest, state: "completed" })),
    original.writeFile(join(directory, "config.json"), JSON.stringify(manifest)),
    original.writeFile(join(directory, "owner.json"), JSON.stringify({ ...manifest, state: "reserved" }))
  ]);
  return { root, directory, statusPath, productSessionId };
}

describe("private background run status snapshots", () => {
  async function receiptedRun() {
    const run = await terminalRun();
    const config = JSON.parse(await original.readFile(join(run.directory, "config.json"), "utf8"));
    Object.assign(config, { runDir: run.directory, nativeSessionId: randomUUID(), route: { provider: "provider", model: "model", effort: "high" } });
    const runnerPid = 2_147_483_646;
    const receipt = { ...config, runnerPid, state: "completed", completedAt: Date.now(), result: "verified output" };
    await Promise.all([
      original.writeFile(join(run.directory, "config.json"), JSON.stringify(config)),
      original.writeFile(join(run.directory, "owner.json"), JSON.stringify({ ...config, state: "running", runnerPid })),
      original.writeFile(join(run.directory, "runner.claim.json"), JSON.stringify({ ...config, runnerPid })),
      original.writeFile(join(run.directory, "result.json"), JSON.stringify(receipt)),
      original.writeFile(run.statusPath, "{ damaged status")
    ]);
    return { ...run, config, receipt };
  }

  it.each(["corrupt", "missing"])("reconciles %s status only from an exact terminal receipt and fresh complete process inventory", async kind => {
    const run = await receiptedRun();
    if (kind === "missing") await original.rm(run.statusPath);
    await stopManagedSubagentRunsByProvider(run.root, "provider", 1000);
    expect(recovery.inventory).toHaveBeenCalledTimes(2);
    // Provider retirement keeps the damaged original as diagnostic evidence.
    if (kind === "corrupt") expect(await original.readFile(run.statusPath, "utf8")).toBe("{ damaged status");
    else await expect(original.lstat(run.statusPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await original.readFile(join(run.directory, "result.json"), "utf8"))).toEqual(run.receipt);
    await expect(original.lstat(join(run.directory, "control.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["runner", "child", "unreadable"])("retains a terminal receipt while the %s process inventory is unresolved", async kind => {
    const run = await receiptedRun();
    recovery.inventory.mockResolvedValue(kind === "unreadable" ? undefined
      : [`node ${kind === "runner" ? run.receipt.runId : run.config.nativeSessionId}`]);
    await expect(stopManagedSubagentRunsByProvider(run.root, "provider", 1000)).rejects.toMatchObject({ publicError: { code: "PI_SUBAGENT_STATUS_INVALID" } });
    expect(await original.readFile(run.statusPath, "utf8")).toBe("{ damaged status");
    expect((await original.lstat(run.directory)).isDirectory()).toBe(true);
  });

  it.each(["runId", "launchToken", "taskId", "nativeSessionId", "runnerInstanceId"])("rejects a terminal receipt with a substituted %s", async field => {
    const run = await receiptedRun();
    await original.writeFile(join(run.directory, "result.json"), JSON.stringify({ ...run.receipt, [field]: randomUUID() }));
    await expect(stopManagedSubagentRunsByProvider(run.root, "provider", 1000)).rejects.toMatchObject({ publicError: { code: "PI_SUBAGENT_STATUS_INVALID" } });
    expect(recovery.inventory).not.toHaveBeenCalled();
    expect(await original.readFile(run.statusPath, "utf8")).toBe("{ damaged status");
  });

  it.each([1, 2, 3])("retries an unlinked regular-file snapshot at observation %i before deleting a retired run", async observation => {
    const run = await terminalRun();
    let reads = 0;
    native.lstat.mockImplementation(async (path: string) => {
      const info = await original.lstat(path);
      if (path === run.statusPath && ++reads === observation) return Object.assign(Object.create(info) as Stats, { nlink: 0 });
      return info;
    });
    await stopAndRemoveManagedSubagentRuns(run.root, run.productSessionId, 1000);
    expect(reads).toBeGreaterThan(observation);
    await expect(original.lstat(run.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds a persistently unlinked snapshot without deleting its run", async () => {
    const run = await terminalRun();
    let reads = 0;
    native.lstat.mockImplementation(async (path: string) => {
      const info = await original.lstat(path);
      if (path !== run.statusPath) return info;
      reads += 1;
      return Object.assign(Object.create(info) as Stats, { nlink: 0 });
    });
    await expect(stopAndRemoveManagedSubagentRuns(run.root, run.productSessionId, 1000)).rejects.toMatchObject({ publicError: { code: "PI_SUBAGENT_STATUS_UNSAFE" } });
    expect(reads).toBe(8);
    expect((await original.lstat(run.directory)).isDirectory()).toBe(true);
  });

  it.each(["hard link", "symbolic link", "oversized file"])("continues to reject a %s without deleting its run", async kind => {
    const run = await terminalRun();
    const alias = join(run.root, "other-status.json");
    if (kind === "hard link") await original.link(run.statusPath, alias);
    else if (kind === "symbolic link") {
      native.lstat.mockImplementation(async (path: string) => {
        const info = await original.lstat(path);
        return path === run.statusPath ? Object.assign(Object.create(info) as Stats, { isSymbolicLink: () => true }) : info;
      });
    } else await original.writeFile(run.statusPath, "x".repeat(512 * 1024 + 1));
    await expect(stopAndRemoveManagedSubagentRuns(run.root, run.productSessionId, 1000)).rejects.toMatchObject({ publicError: { code: "PI_SUBAGENT_STATUS_UNSAFE" } });
    expect((await original.lstat(run.directory)).isDirectory()).toBe(true);
  });
});
