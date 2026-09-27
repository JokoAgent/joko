import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableProcessOwner, type ProcessIdentitySupervisor } from "./process-owner.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DurableProcessOwner", () => {
  it("claims and independently releases multiple exact children in one generation", async () => {
    const root = await temporaryRoot();
    const owner = new DurableProcessOwner({
      rootDirectory: root,
      instanceId: "backend-instance",
      generation: 4,
      recoverStale: false,
      supervisor: supervisor()
    });
    await owner.prepare(50);

    const first = owner.claimSync(101);
    const second = owner.claimSync(202);
    expect(await readdir(join(root, "4"))).toHaveLength(2);

    await Promise.all([
      owner.releaseAfterExit(second),
      owner.releaseAfterExit(first)
    ]);
    expect(await readdir(root)).toEqual([]);
  });

  it("recovers every stale exact lease before admitting a new generation", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "8");
    await mkdir(directory);
    const leases = [
      { token: "11111111-1111-4111-8111-111111111111", pid: 301 },
      { token: "22222222-2222-4222-8222-222222222222", pid: 302 }
    ] as const;
    for (const lease of leases) {
      await writeFile(join(directory, `owner-${lease.token}.json`), JSON.stringify({
        format: 1,
        instanceId: "backend-instance",
        generation: 8,
        ownerToken: lease.token,
        pid: lease.pid,
        processIdentity: `identity-${lease.pid}`
      }));
    }
    const terminate = vi.fn(async () => "terminated" as const);
    const owner = new DurableProcessOwner({
      rootDirectory: root,
      instanceId: "backend-instance",
      generation: 9,
      recoverStale: true,
      supervisor: supervisor(terminate)
    });

    await owner.prepare(75);

    expect(terminate.mock.calls).toEqual([
      [301, "identity-301", 75],
      [302, "identity-302", 75]
    ]);
    expect(await readdir(root)).toEqual([]);
  });

  it("recovers a safely empty generation left by deferred Windows cleanup", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "8"));
    const owner = new DurableProcessOwner({
      rootDirectory: root,
      instanceId: "backend-instance",
      generation: 9,
      recoverStale: true,
      supervisor: supervisor()
    });

    await owner.prepare(75);

    expect(await readdir(root)).toEqual([]);
  });

  it("samples only exact current leases and drops a lease released during inspection", async () => {
    const root = await temporaryRoot();
    let finishInspection: ((value: readonly [{ readonly pid: number; readonly cpuPercent: number; readonly memoryKb: number; readonly processCount: number }]) => void) | undefined;
    const inspect = vi.fn(() => new Promise<readonly [{ readonly pid: number; readonly cpuPercent: number; readonly memoryKb: number; readonly processCount: number }]>((resolve) => {
      finishInspection = resolve;
    }));
    const owner = new DurableProcessOwner({
      rootDirectory: root,
      instanceId: "backend-instance",
      generation: 4,
      recoverStale: false,
      supervisor: { ...supervisor(), inspect }
    });
    await owner.prepare(50);
    const lease = owner.claimSync(101);

    const pending = owner.inspect([lease]);
    expect(inspect).toHaveBeenCalledWith([{ pid: 101, expectedIdentity: "identity-101" }]);
    await owner.releaseAfterExit(lease);
    finishInspection?.([{ pid: 101, cpuPercent: 3.5, memoryKb: 2_048, processCount: 2 }]);

    await expect(pending).resolves.toEqual([]);
  });

  it("returns the opaque owner token with validated display-safe metrics", async () => {
    const root = await temporaryRoot();
    const owner = new DurableProcessOwner({
      rootDirectory: root,
      instanceId: "backend-instance",
      generation: 4,
      recoverStale: false,
      supervisor: {
        ...supervisor(),
        inspect: async () => [{ pid: 202, cpuPercent: 4.5, memoryKb: 4_096, processCount: 3 }]
      }
    });
    await owner.prepare(50);
    const lease = owner.claimSync(202);

    await expect(owner.inspect([lease])).resolves.toEqual([{
      ownerToken: lease.ownerToken,
      pid: 202,
      cpuPercent: 4.5,
      memoryKb: 4_096,
      processCount: 3
    }]);
  });

  it("reports a stale birth identity and consumes its lease without replay", async () => {
    const root = await temporaryRoot();
    const owner = new DurableProcessOwner({
      rootDirectory: root,
      instanceId: "backend-instance",
      generation: 4,
      recoverStale: false,
      supervisor: supervisor(vi.fn(async () => "identity_mismatch" as const))
    });
    await owner.prepare(50);
    const lease = owner.claimSync(303);

    await expect(owner.retireLeaseWithOutcome(lease, 50)).resolves.toBe("identity_mismatch");
    await expect(owner.retireLeaseWithOutcome(lease, 50)).resolves.toBe("not_running");
    expect(await readdir(root)).toEqual([]);
  });
});

function supervisor(
  terminate: ProcessIdentitySupervisor["terminate"] = vi.fn(async () => "terminated" as const)
): ProcessIdentitySupervisor {
  return {
    capture: async (pid) => `identity-${pid}`,
    captureSync: (pid) => `identity-${pid}`,
    terminate
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-process-owner-"));
  roots.push(root);
  return root;
}
