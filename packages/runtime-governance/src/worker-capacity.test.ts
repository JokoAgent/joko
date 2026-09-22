import { describe, expect, it, vi } from "vitest";

import { createWorkerCapacityController, WorkerHardLimitError } from "./worker-capacity.js";

describe("worker capacity controller", () => {
  it("returns a soft warning and hard-rejects before a worker starts", async () => {
    const controller = createWorkerCapacityController({
      readSettings: () => ({ workerSoftLimit: 2, workerHardLimit: 2, workerIdleReleaseMinutes: 0 }),
      releaseIdleWorker: () => undefined,
      idFactory: (() => { let id = 0; return () => `lease-${++id}`; })()
    });
    expect((await controller.acquire("owner", "one")).softLimitReached).toBe(false);
    expect((await controller.acquire("owner", "two")).softLimitReached).toBe(true);
    await expect(controller.acquire("owner", "three")).rejects.toBeInstanceOf(WorkerHardLimitError);
    await controller.close();
  });

  it("closes an actually idle worker before freeing its capacity", async () => {
    let now = 1_000;
    const released = vi.fn(async () => undefined);
    const controller = createWorkerCapacityController({
      readSettings: () => ({ workerSoftLimit: 1, workerHardLimit: 2, workerIdleReleaseMinutes: 1 }),
      releaseIdleWorker: released,
      now: () => now,
      idFactory: () => "lease-one"
    });
    const lease = await controller.acquire("owner", "one");
    expect(controller.markIdle(lease.leaseId)).toBe(true);
    now += 60_001;
    await expect(controller.sweepIdle()).resolves.toEqual([lease.leaseId]);
    expect(released).toHaveBeenCalledWith(lease);
    expect(controller.snapshot()).toMatchObject({ active: 0, idle: 0 });
    await controller.close();
  });

  it("keeps capacity occupied when idle shutdown cannot be confirmed", async () => {
    let now = 1_000;
    const controller = createWorkerCapacityController({
      readSettings: () => ({ workerSoftLimit: 1, workerHardLimit: 1, workerIdleReleaseMinutes: 1 }),
      releaseIdleWorker: async () => { throw new Error("still running"); },
      now: () => now,
      idFactory: () => "lease-one"
    });
    const lease = await controller.acquire("owner", "one");
    controller.markIdle(lease.leaseId);
    now += 60_001;
    await expect(controller.sweepIdle()).rejects.toThrow("still running");
    expect(controller.snapshot()).toMatchObject({ active: 0, idle: 1 });
    await controller.close();
  });

  it("restores durable workers beyond a lowered limit and blocks only new admission", async () => {
    const ids = ["restored-1", "restored-2", "new"];
    const controller = createWorkerCapacityController({
      readSettings: () => ({ workerSoftLimit: 1, workerHardLimit: 1, workerIdleReleaseMinutes: 10 }),
      releaseIdleWorker: () => undefined,
      now: () => 10_000,
      idFactory: () => ids.shift()!
    });
    const first = controller.restore({
      ownerId: "goal-1",
      workerId: "worker-1",
      state: "active",
      acquiredAt: 1
    });
    const second = controller.restore({
      ownerId: "goal-2",
      workerId: "worker-2",
      state: "idle",
      acquiredAt: 2,
      idleSince: 3
    });
    expect(first.softLimitReached).toBe(true);
    expect(second.softLimitReached).toBe(true);
    expect(controller.snapshot()).toMatchObject({ active: 1, idle: 1, hardLimit: 1 });
    await expect(controller.acquire("goal-3", "worker-3")).rejects.toBeInstanceOf(WorkerHardLimitError);
    await controller.close();
  });
});
