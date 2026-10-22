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
