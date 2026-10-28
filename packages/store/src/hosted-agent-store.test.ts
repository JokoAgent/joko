import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { HostedAgentStore, type HostedNativeSessionOwner } from "./hosted-agent-store.js";
import { OperationalStore } from "./operational-store.js";

const owner: HostedNativeSessionOwner = { authorityId: "approved-share", deviceId: "task-device", sessionId: "task", targetId: "workspace",
  nativeSessionId: "source-owned-native-id", backendId: "native", trust: "guest" };
const binding = { opaqueRef: "private-native-reference", nativeSessionId: "native-sdk-identity", generation: 1 };
it("restores the exact native binding after SQLite restart and fences its previous process lease", () => {
  const root = mkdtempSync(join(tmpdir(), "joko-hosted-store-")), path = join(root, "operations.sqlite");
  let database = new OperationalStore(path);
  try {
    let store = new HostedAgentStore(database); const first = store.claim(owner, "first-process", "create");
    store.bind(first.key, "first-process", binding); store.close(first.key, "first-process"); database.close(); database = new OperationalStore(path); store = new HostedAgentStore(database);
    const resumed = store.claim(owner, "second-process", "resume"); expect(resumed.binding).toEqual(binding);
    expect(() => store.assertLease(first.key, "first-process")).toThrow("changed");
    expect(() => store.claim(owner, "other-process", "create")).toThrow("cannot");
    for (const change of [{ authorityId: "another-share" }, { deviceId: "another-device" }, { trust: "owner" as const }, { sessionId: "another-task" }]) {
      expect(() => store.claim({ ...owner, ...change }, "other-process", "resume")).toThrow("cannot");
    }
  } finally { database.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); rmSync(root, { recursive: true, force: true }); }
});
it("keeps an uncertain native creation reserved instead of creating a second native context", () => {
  const database = new OperationalStore(":memory:");
  try {
    const store = new HostedAgentStore(database), value = store.claim(owner, "opening", "create"); store.close(value.key, "opening");
    expect(store.find(value.key)?.state).toBe("creating");
    expect(() => store.claim(owner, "again", "create")).toThrow("cannot"); expect(() => store.claim(owner, "again", "resume")).toThrow("cannot");
  } finally { database.close(); }
});
it("retains pending, completed and failed native receipts through restart without confusing conflicting call bodies", () => {
  const root = mkdtempSync(join(tmpdir(), "joko-hosted-call-store-")), path = join(root, "operations.sqlite"); let database = new OperationalStore(path);
  const hash = "1".repeat(64), otherHash = "2".repeat(64);
  try {
    let store = new HostedAgentStore(database); const session = store.claim(owner, "first-process", "create"); store.bind(session.key, "first-process", binding);
    store.claimCall(session.key, "first-process", "uncertain-send", hash);
    store.claimCall(session.key, "first-process", "completed-write", hash); store.finishCall(session.key, "first-process", "completed-write", hash, { ok: true, value: { accepted: true } });
    store.claimCall(session.key, "first-process", "failed-control", hash); store.finishCall(session.key, "first-process", "failed-control", hash, { ok: false });
    database.close(); database = new OperationalStore(path); store = new HostedAgentStore(database); store.claim(owner, "second-process", "resume");
    expect(store.claimCall(session.key, "second-process", "uncertain-send", hash).state).toBe("pending");
    expect(store.claimCall(session.key, "second-process", "completed-write", hash)).toMatchObject({ state: "completed", resultJson: '{"accepted":true}' });
    expect(store.claimCall(session.key, "second-process", "failed-control", hash).state).toBe("failed");
    expect(() => store.claimCall(session.key, "second-process", "uncertain-send", otherHash)).toThrow("conflicts");
    expect(() => store.finishCall(session.key, "first-process", "uncertain-send", hash, { ok: true, value: null })).toThrow("changed");
  } finally { database.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); rmSync(root, { recursive: true, force: true }); }
});
it("rejects incompatible stored native metadata instead of adding a compatibility reader", () => {
  const database = new OperationalStore(":memory:");
  try {
    const store = new HostedAgentStore(database), session = store.claim(owner, "process", "create");
    database.setSetting("service", "native-hosted.v1", `session:${session.key}`, { ...session, legacyReference: "unused" });
    expect(() => store.find(session.key)).toThrow("unknown");
  } finally { database.close(); }
});
it("fences only the exact cleanup lease and removes its native receipts with the binding", () => {
  const database = new OperationalStore(":memory:"); try {
    const store = new HostedAgentStore(database), session = store.claim(owner, "original", "create"); store.bind(session.key, "original", binding);
    store.claimCall(session.key, "original", "send", "1".repeat(64)); store.close(session.key, "original");
    store.claim(owner, "replacement", "resume"); expect(() => store.beginPurge(session.key, "original")).toThrow("changed");
    store.close(session.key, "replacement"); store.beginPurge(session.key, "replacement");
    expect(() => store.claim(owner, "another", "resume")).toThrow("cannot"); expect(() => store.finishPurge(session.key, "original")).toThrow("changed");
    store.finishPurge(session.key, "replacement"); expect(store.find(session.key)).toBeUndefined(); expect(store.call(session.key, "send")).toBeUndefined();
  } finally { database.close(); }
});

it("retains exact native lineage and derivation ownership through restart, and permits resumption only after Product adoption", () => {
  const root = mkdtempSync(join(tmpdir(), "joko-hosted-derive-")), path = join(root, "operations.sqlite"); let database = new OperationalStore(path);
  try {
    let store = new HostedAgentStore(database); const source = store.claim(owner, "source-process", "create"); store.bind(source.key, source.leaseId, binding);
    const childOwner = { ...owner, sessionId: "child-task", nativeSessionId: "child-alias" };
    const child = store.prepareDerivation(source.key, source.leaseId, childOwner, { operationId: "native-fork-call", kind: "fork", providerId: "provider", modelId: "model" });
    const childBinding = { ...binding, opaqueRef: "actual-native-child", nativeSessionId: "actual-child" };
    store.updateDerivation(child.key, child.leaseId, {}, childBinding);
    const reordered = { generation: childBinding.generation, opaqueRef: childBinding.opaqueRef, nativeSessionId: childBinding.nativeSessionId };
    expect(store.updateDerivation(child.key, child.leaseId, {}, reordered).binding).toEqual(childBinding);
    for (const change of [{ opaqueRef: "another-reference" }, { nativeSessionId: "another-child" }, { generation: childBinding.generation + 1 }]) {
      expect(() => store.updateDerivation(child.key, child.leaseId, {}, { ...childBinding, ...change })).toThrow("binding conflicts");
      expect(store.find(child.key)?.binding).toEqual(childBinding);
    }
    store.updateDerivation(child.key, child.leaseId, { state: "settled", nativeAdopted: true });
    expect(() => store.claim(childOwner, "premature-process", "resume")).toThrow("cannot");
    database.close(); database = new OperationalStore(path); store = new HostedAgentStore(database);
    const recovered = store.find(child.key)!; expect(recovered).toMatchObject({ storageKey: source.key, binding: childBinding,
      derivation: { sourceKey: source.key, sourceBinding: binding, operationId: "native-fork-call", state: "settled", adopted: false } });
    expect(store.updateDerivation(child.key, recovered.leaseId, {}, reordered).binding).toEqual(childBinding);
    store.updateDerivation(child.key, recovered.leaseId, { adopted: true });
    const resumed = store.claim(childOwner, "child-process", "resume"); expect(resumed.storageKey).toBe(source.key); expect(resumed.binding).toEqual(childBinding);
    expect(() => store.updateDerivation(child.key, recovered.leaseId, { cleanupRequested: true })).toThrow("changed");
  } finally { database.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); rmSync(root, { recursive: true, force: true }); }
});

it("fences late derivation delivery after a confirmed unstarted cleanup and never recreates that child alias", () => {
  const database = new OperationalStore(":memory:");
  try {
    const store = new HostedAgentStore(database), source = store.claim(owner, "source-process", "create"); store.bind(source.key, source.leaseId, binding);
    const childOwner = { ...owner, sessionId: "cancelled-child", nativeSessionId: "cancelled-alias" };
    store.cancelUnstartedDerivation(childOwner, store.find(source.key)!, "cancelled-native-call", "clone");
    expect(() => store.prepareDerivation(source.key, source.leaseId, childOwner, { operationId: "cancelled-native-call", kind: "clone", providerId: "provider", modelId: "model" })).toThrow("conflicts");
    expect(() => store.claim(childOwner, "late-process", "create")).toThrow("cannot"); expect(store.find(store.key(childOwner))?.derivation?.state).toBe("cleaned");
  } finally { database.close(); }
});
