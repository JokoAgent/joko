import { PermissionMode, QueueDeliveryMode } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import type { MobilePlainStorageDriver } from "./connection-storage";
import { plainTextMobileComposerDraft } from "./mobile-composer-document";
import { MobileTaskOutboxStore, mobileTaskOutboxOwnerMatches, type MobileTaskOutboxRecord } from "./mobile-task-outbox";

function input(id = "input-one"): MobileTaskOutboxRecord {
  return { id, operationId: id, owner: { profileId: "phone", origin: "http://192.168.1.20:4318", serverId: "node",
    connectionId: "connection", deviceId: "device" }, sessionId: "session", backendId: "backend", targetId: "target",
    runtimeGeneration: "8", createdAt: 1_000, deliveryMode: QueueDeliveryMode.PROMPT, permissionMode: PermissionMode.ASK,
    planMode: false, input: plainTextMobileComposerDraft(id), storageIds: [], state: "queued", attempted: false };
}

function memory() {
  const values = new Map<string, string>();
  let fail = false, beforeWrite: (() => Promise<void>) | undefined;
  const driver: MobilePlainStorageDriver = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) {
      if (fail) throw new Error("Storage write failed");
      await beforeWrite?.(); values.set(key, value);
    },
    async removeItem(key) { values.delete(key); }
  };
  return { driver, values, fail(value: boolean) { fail = value; }, hold(value?: () => Promise<void>) { beforeWrite = value; } };
}

describe("durable mobile task outbox storage", () => {
  it("publishes ownership only after the durable write and preserves existing records on failure", async () => {
    const f = memory(), store = new MobileTaskOutboxStore(f.driver); await store.load();
    let writing!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { writing = resolve; });
    f.hold(() => { writing(); return new Promise<void>(resolve => { release = resolve; }); });
    const adding = store.add(input()); await reached;
    expect(store.records).toEqual([]); expect(f.values.size).toBe(0); release(); const saved = await adding;
    expect(store.records).toEqual([saved]); f.hold(); f.fail(true);
    await expect(store.add(input("input-two"))).rejects.toThrow("Storage write failed");
    await expect(store.update(saved, { state: "failed", failureKind: "preparation", error: "Unavailable" })).rejects.toThrow("Storage write failed");
    await expect(store.remove(saved)).rejects.toThrow("Storage write failed");
    expect(store.records).toEqual([saved]);
    const restarted = new MobileTaskOutboxStore(f.driver); await restarted.load(); expect(restarted.records).toEqual([saved]);
  });

  it("serializes concurrent ownership changes and rejects a stale record occurrence", async () => {
    const f = memory(), store = new MobileTaskOutboxStore(f.driver);
    await Promise.all([store.add(input()), store.add(input("input-two"))]);
    expect(store.records.map(item => item.id)).toEqual(["input-one", "input-two"]);
    const original = store.records[0]!;
    const results = await Promise.allSettled([
      store.update(original, { state: "failed", failureKind: "preparation", error: "First update" }),
      store.update(original, { state: "restoring" })
    ]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(store.records[0]).toMatchObject({ state: "failed", error: "First update" });
    await expect(store.remove(original)).rejects.toThrow("changed");
    const restarted = new MobileTaskOutboxStore(f.driver); await restarted.load(); expect(restarted.records).toEqual(store.records);
  });

  it("restores multiple task owners without merging their input or retaining credential material", async () => {
    const f = memory(), store = new MobileTaskOutboxStore(f.driver), first = input();
    const withCredential = { ...first, owner: { ...first.owner, authKey: "must-stay-protected" } };
    await store.add(withCredential);
    await store.add({ ...input("input-two"), sessionId: "another-session" });
    await store.add({ ...input("input-three"), owner: { ...first.owner, profileId: "tablet", connectionId: "tablet-connection", deviceId: "tablet-device" } });
    expect([...f.values.values()].join("")).not.toContain("must-stay-protected");
    expect([...f.values.values()].join("")).not.toContain("authKey");
    const restarted = new MobileTaskOutboxStore(f.driver); await restarted.load();
    expect(restarted.records.map(item => [item.id, item.owner.profileId, item.sessionId, item.input.text])).toEqual([
      ["input-one", "phone", "session", "input-one"], ["input-two", "phone", "another-session", "input-two"],
      ["input-three", "tablet", "session", "input-three"]
    ]);
    await restarted.clearProfile("phone");
    expect(restarted.records.map(item => item.id)).toEqual(["input-three"]);
    const final = new MobileTaskOutboxStore(f.driver); await final.load(); expect(final.records).toEqual(restarted.records);
  });

  it("requires every exact profile, origin, node, connection and device field", () => {
    const owner = input().owner;
    expect(mobileTaskOutboxOwnerMatches(owner, { ...owner })).toBe(true);
    for (const field of ["profileId", "origin", "serverId", "connectionId", "deviceId"] as const) {
      expect(mobileTaskOutboxOwnerMatches(owner, { ...owner, [field]: `other-${field}` })).toBe(false);
    }
  });

  it("rejects duplicate record and operation identities without overwriting the first input", async () => {
    const f = memory(), store = new MobileTaskOutboxStore(f.driver); const first = await store.add(input());
    await expect(store.add({ ...input("input-two"), id: first.id })).rejects.toThrow("already retained");
    await expect(store.add({ ...input("input-two"), operationId: first.operationId })).rejects.toThrow("already retained");
    expect(store.records).toEqual([first]);
    const second = await store.add(input("input-two"));
    await expect(store.update(second, { operationId: first.operationId })).rejects.toThrow("already retained");
    expect(store.records).toEqual([first, second]);
  });

  it("keeps a possible earlier admission through an explicit queued retry, and rejects impossible delivery markers", async () => {
    const f = memory(), store = new MobileTaskOutboxStore(f.driver); let record = await store.add(input());
    await expect(store.update(record, { state: "confirming" })).rejects.toThrow("delivery state");
    record = await store.update(record, { state: "confirming", attempted: true });
    record = await store.update(record, { state: "failed", failureKind: "not-admitted" });
    record = await store.update(record, { state: "queued", attempted: true, failureKind: undefined });
    expect(record).toMatchObject({ attempted: true, state: "queued", operationId: "input-one" });
    await expect(store.add({ ...input("invalid-staging"), state: "staging", attempted: true })).rejects.toThrow("delivery state");
    await expect(store.add({ ...input("invalid-failure"), state: "failed" })).rejects.toThrow("delivery state");
    await expect(store.add({ ...input("invalid-cause"), failureKind: "rejected" })).rejects.toThrow("delivery state");
    const restarted = new MobileTaskOutboxStore(f.driver); await restarted.load(); expect(restarted.records[0]).toEqual(record);
  });

  it("requires dispatched attachments to retain the committed Blob identity", async () => {
    const f = memory(), store = new MobileTaskOutboxStore(f.driver), base = input();
    const attachment = { state: "local" as const, attachmentId: "private-copy", kind: "file" as const,
      fileName: "note.txt", mediaType: "text/plain", byteSize: 4, sha256Hex: "a".repeat(64), capturedAtUnixMs: 1_000 };
    await expect(store.add({ ...base, state: "confirming", attempted: true,
      input: { ...base.input, attachments: [attachment] }, storageIds: [attachment.attachmentId] })).rejects.toThrow("committed attachments");
    const saved = await store.add({ ...base, state: "confirming", attempted: true,
      input: { ...base.input, attachments: [{ ...attachment, state: "uploaded", blobId: "blob-one" }] }, storageIds: [attachment.attachmentId] });
    expect(saved.input.attachments[0]).toMatchObject({ state: "uploaded", blobId: "blob-one" });
  });

  it("cold-restores only the exact original typed account choice and keeps credentials outside the record", async () => {
    const f = memory(), store = new MobileTaskOutboxStore(f.driver);
    const choice = { suggestionKey: `rebalance_${"a".repeat(64)}`, remember: true };
    const record = await store.add({ ...input(), providerGroupRebalance: choice });
    const restarted = new MobileTaskOutboxStore(f.driver); await restarted.load();
    expect(restarted.records[0]?.providerGroupRebalance).toEqual(choice);
    for (const invalid of [{ suggestionKey: "other", remember: true }, { ...choice, authKey: "private" },
      { suggestionKey: choice.suggestionKey, remember: "true" }]) {
      await expect(store.add({ ...input("invalid-choice"), providerGroupRebalance: invalid as typeof choice })).rejects.toThrow(/original confirmation/u);
    }
    expect(store.records).toEqual([record]);
  });

  it("rejects damaged current data without silently deleting retained input", async () => {
    const f = memory(), store = new MobileTaskOutboxStore(f.driver); await store.add(input());
    const key = [...f.values.keys()][0]!, original = f.values.get(key)!;
    const parsed = JSON.parse(original) as { records: MobileTaskOutboxRecord[] };
    parsed.records.push(parsed.records[0]!); const damaged = JSON.stringify(parsed); f.values.set(key, damaged);
    const restarted = new MobileTaskOutboxStore(f.driver); await expect(restarted.load()).rejects.toThrow("invalid identities");
    expect(restarted.records).toEqual([]); expect(f.values.get(key)).toBe(damaged);
  });
});
