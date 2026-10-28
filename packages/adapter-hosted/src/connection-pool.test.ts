import { expect, it, vi } from "vitest";
import { HostedAgentConnectionPool, type HostedAgentPoolMember } from "./connection-pool.js";

it("keeps the default disabled, trims oldest eligible native owners at 80 percent, and retains an unconfirmed closure", async () => {
  let minutes = 0, now = 120_000;
  const pool = new HostedAgentConnectionPool({ idleMinutes: () => minutes, maxRuns: () => 5, now: () => now });
  const owners = Array.from({ length: 4 }, (_, i) => {
    let occupied = true;
    const release = vi.fn(async () => { if (i === 0) throw new Error("Unknown native closure."); occupied = false; return true; });
    const member: HostedAgentPoolMember = { occupiesSlot: () => occupied, isIdle: () => true, lastActivityAt: () => i * 1000, release };
    pool.register(member); return { member, release };
  });
  try {
    await pool.trim(); expect(pool.occupied()).toBe(4); expect(owners[0]!.release).not.toHaveBeenCalled();
    minutes = 1; await pool.trim(); expect(owners[0]!.release).toHaveBeenCalledOnce(); expect(owners[1]!.release).toHaveBeenCalledOnce();
    expect(pool.occupied()).toBe(3); expect(owners[2]!.release).not.toHaveBeenCalled();
    now = 180_000; expect(await pool.releaseForRetry()).toBe(true); expect(pool.occupied()).toBe(2);
  } finally { pool.close(); }
});

it("does not proactively trim small capacities and makes room only for an open, without terminating a busy member", async () => {
  const pool = new HostedAgentConnectionPool({ idleMinutes: () => 1, maxRuns: () => 2, now: () => 120_000 });
  let occupied = true;
  const idle = vi.fn(async () => { occupied = false; return true; }), busy = vi.fn(async () => true);
  pool.register({ occupiesSlot: () => true, isIdle: () => false, lastActivityAt: () => 0, release: busy });
  pool.register({ occupiesSlot: () => occupied, isIdle: () => true, lastActivityAt: () => 0, release: idle });
  try { await pool.trim(); expect(idle).not.toHaveBeenCalled(); await pool.beforeOpen(); expect(idle).toHaveBeenCalledOnce(); expect(busy).not.toHaveBeenCalled(); }
  finally { pool.close(); }
});
