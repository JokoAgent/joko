import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RoutineState } from "@joko/core";
import { PartnerRoutineStore } from "./partner-routine-store.js";

const roots: string[] = []; afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const empty = (): RoutineState => ({ version: 1, routines: [], runs: [], next: {}, receipts: {}, pausedPartnerIds: [], retiredRoutineIds: [] });
describe("Partner routine file authority", () => {
  it("reopens an atomic current snapshot without temporary files and rejects sensitive writes without replacing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-routine-store-")); roots.push(root); const store = new PartnerRoutineStore(root);
    expect(await store.load()).toBeNull(); const state = empty(); await store.save(state);
    const next = empty(); next.routines = [{ id: "rule-one", partnerId: "partner-one", revision: 1, createdAt: 1, updatedAt: 1, name: "Check", prompt: "Review status", enabled: true, silentWhenIdle: false, triggers: [{ id: "interval", kind: "interval", intervalMs: 60000 }] }];
    await store.save(next); expect(await new PartnerRoutineStore(root).load()).toEqual(next); expect(await readdir(root)).toEqual(["routines.json"]);
    next.routines[0]!.prompt = "Authorization: Bearer live-routine-secret";
    await expect(store.save(next)).rejects.toThrow("credentials"); expect(await readFile(join(root, "routines.json"), "utf8")).not.toContain("live-routine-secret");
    expect((await store.load())?.routines[0]?.prompt).toBe("Review status");
  });
  it("fails closed on incomplete, malformed or unsupported snapshots rather than starting an empty scheduler", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-routine-invalid-")); roots.push(root); const store = new PartnerRoutineStore(root);
    for (const value of [{ ...empty(), version: 2 }, { version: 1, routines: [], runs: [] }, { ...empty(), pausedPartnerIds: null }]) {
      await writeFile(join(root, "routines.json"), JSON.stringify(value)); await expect(store.load()).rejects.toThrow("current v1");
    }
    await writeFile(join(root, "routines.json"), "{"); await expect(store.load()).rejects.toThrow();
  });
});
