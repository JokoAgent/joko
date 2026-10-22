import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OperationalStore } from "./operational-store.js";
import { ProviderGroupStore, type ProviderGroupMember } from "./provider-group-store.js";
import { ProviderGroupUsageStore } from "./provider-group-usage-store.js";

const key = { backendId: "native", providerId: "provider" };
const member = (id: string): ProviderGroupMember => ({ key: id, kind: "local", nodeId: "node", displayName: id,
  backendId: id, nativeBackendId: id, providerId: "provider", capacity: 4, weight: 1, paused: false });
const config = (members: readonly ProviderGroupMember[]) => ({ strategy: "ordered" as const, autoSwitch: true, members });
const attribution = { group: key, memberKey: "a", nodeId: "node", nodeName: "Node", partyId: "owner", partyName: "Owner", agentKind: "native", backendId: "a", providerId: "provider", modelId: "model" };
const summary = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 17,
  costMicros: 135, currencyCode: "USD", estimated: true, tokensComplete: true, costComplete: false } as const;
it("commits configuration, removed-task release and recoverable reshare intent in the same durable CAS", () => {
  const root = mkdtempSync(join(tmpdir(), "joko-group-store-")), path = join(root, "store.db"); let db = new OperationalStore(path);
  try {
    let groups = new ProviderGroupStore(db, "owner"); const first = groups.update(key, config([member("a"), member("b")]), 0n);
    groups.commitBinding("task", { group: key, groupRevision: "1", memberKey: "a", backendId: "a", providerId: "provider", modelId: "model" }, first.revision);
    expect(() => groups.update(key, config([member("b")]), 0n)).toThrow("revision");
    const removed = groups.update(key, config([member("b")]), 1n); expect(groups.bindingRecord("task")).toEqual({ format: 1, sessionId: "task", released: true });
    const oldIntent = removed.cleanup[0]!; expect(oldIntent.removedMembers).toEqual([member("a")]);
    db.close(); db = new OperationalStore(path); groups = new ProviderGroupStore(db, "owner");
    expect(groups.binding("task")).toBeUndefined(); expect(groups.pendingCleanup()).toHaveLength(1);
    const deleted = groups.update(key, undefined, 2n); expect(deleted.config).toBeUndefined(); expect(deleted.cleanup).toHaveLength(2);
    groups.acknowledgeCleanup(key, oldIntent.id); expect(groups.snapshot(key).cleanup.map(row => row.id)).toEqual([deleted.cleanup[1]!.id]);
    groups.update(key, config([member("a")]), 3n); expect(groups.bindingRecord("task")?.released).toBe(true);
    expect(new ProviderGroupStore(db, "other-owner").snapshot(key).revision).toBe(0n);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
it("preserves the four current strategies and exact soft-capacity and weight bounds", () => {
  const db = new OperationalStore(":memory:"); try {
    const groups = new ProviderGroupStore(db, "owner");
    for (const patch of [{ capacity: 0 }, { capacity: 17 }, { weight: 0 }, { weight: 101 }, { capacity: 1.5 }]) expect(() => groups.update(key, config([{ ...member("a"), ...patch }]), 0n)).toThrow();
    expect(() => groups.update(key, { ...config([member("a")]), strategy: "usage" as "ordered" }, 0n)).toThrow();
    expect(groups.update(key, config([{ ...member("a"), capacity: 16, weight: 100 }]), 0n).config?.members[0]).toMatchObject({ capacity: 16, weight: 100 });
    expect(groups.update(key, config([]), 1n).config).toBeUndefined();
  } finally { db.close(); }
});
it("attributes actual SDK usage before dispatch and folds a completion once across restarts", () => {
  const root = mkdtempSync(join(tmpdir(), "joko-group-usage-")), path = join(root, "store.db"); let db = new OperationalStore(path);
  try {
    let usage = new ProviderGroupUsageStore(db, "owner"); usage.capture("run", [attribution]);
    expect(() => usage.capture("run", [{ ...attribution, memberKey: "later-member" }])).toThrow("changed");
    const at = Date.UTC(2026, 9, 22); expect(usage.finish("run", summary, at)).toBe(true);
    db.close(); db = new OperationalStore(path); usage = new ProviderGroupUsageStore(db, "owner"); expect(usage.finish("run", summary, at + 1)).toBe(false);
    expect(usage.rows({ group: key })).toEqual([{ ...attribution, ...summary, day: "2026-10-22", turns: 1, lastAt: at }]);
    expect(usage.rows({ group: key, partyId: "someone-else" })).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
it("replaces complete per-source reports without doubling usage or accepting older sequence numbers", () => {
  const db = new OperationalStore(":memory:"); try {
    const usage = new ProviderGroupUsageStore(db, "owner"), row = { ...attribution, ...summary, day: "2026-10-22", turns: 1, lastAt: Date.UTC(2026, 9, 22) };
    expect(usage.replaceReported("source-a", 2n, row.day, [row])).toBe(true); expect(usage.replaceReported("source-a", 2n, row.day, [row])).toBe(false);
    usage.replaceReported("source-b", 1n, row.day, [{ ...row, turns: 2 }]); usage.replaceReported("source-a", 3n, row.day, []);
    expect(usage.rows({ group: key })).toEqual([{ ...row, turns: 2 }]);
    expect(usage.nextSequence("reports", 200)).toBe(200000n); expect(usage.nextSequence("reports", 100)).toBe(200001n);
  } finally { db.close(); }
});
