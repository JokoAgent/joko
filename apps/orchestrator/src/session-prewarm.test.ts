import { afterEach, expect, it, vi } from "vitest";
import { SessionPrewarmer } from "./session-prewarm.js";

afterEach(() => vi.useRealTimers());

it("budgets unused native owners and retains an uncertain close instead of opening a third Agent", async () => {
  const pool = new SessionPrewarmer({ maximum: 2 }), starts: string[] = [], closes: string[] = [];
  let confirmed = false;
  const start = (id: string) => pool.start(id, async () => { starts.push(id); return id; }, async stillUnused => {
    closes.push(id); return !stillUnused() || confirmed;
  });
  try {
    await start("first"); await start("second");
    expect(await start("third")).toBeUndefined();
    expect(starts).toEqual(["first", "second"]); expect(closes).toEqual(["first"]);
    confirmed = true; await start("third");
    expect(starts).toEqual(["first", "second", "third"]);
  } finally { pool.dispose(); }
});

it("coalesces a starting Agent and lets real input take it away from idle retirement", async () => {
  vi.useFakeTimers();
  const pool = new SessionPrewarmer({ idleMs: 100 }), close = vi.fn(async () => true);
  let finish!: () => void; const started = new Promise<void>(resolve => { finish = resolve; });
  const start = vi.fn(async () => { await started; return true; });
  const first = pool.start("task", start, close), same = pool.start("task", start, close);
  await Promise.resolve(); pool.used("task"); finish();
  await Promise.all([first, same]); await vi.advanceTimersByTimeAsync(200);
  expect(start).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled(); pool.dispose();
});

it("does not close a runtime when its original unused owner was taken by a send during inspection", async () => {
  const pool = new SessionPrewarmer({ maximum: 1 }); let inspected!: () => void;
  const wait = new Promise<void>(resolve => { inspected = resolve; }); let physicalCloses = 0;
  await pool.start("first", async () => true, async stillUnused => { await wait; if (!stillUnused()) return true; physicalCloses++; return true; });
  const second = pool.start("second", async () => true, async () => true);
  await Promise.resolve(); pool.used("first"); inspected(); await second;
  expect(physicalCloses).toBe(0); pool.dispose();
});
