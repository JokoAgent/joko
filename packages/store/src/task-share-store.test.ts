import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OperationalStore } from "./operational-store.js";
import { TaskShareStore, type TaskShareGuestProof } from "./task-share-store.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-task-share-store-")), path = join(directory, "store.sqlite");
  let store = new OperationalStore(path);
  store.upsertBackend({ id: "backend", displayName: "Backend", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "backend", displayName: "Target", workspaceRoot: directory, managed: false, trusted: true });
  store.createSession({ id: "session", backendId: "backend", targetId: "target", title: "Task", binding: { opaqueRef: "native", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const shares = () => new TaskShareStore(store);
  shares().create({ shareId: "share", sessionId: "session", invitationSha256Hex: "a".repeat(64) });
  const joinMember = (suffix: string) => {
    shares().join({ shareId: "share", shareGeneration: 1, invitationSha256Hex: "a".repeat(64), memberId: `member-${suffix}`, intentId: `join-${suffix}`,
      credentialSha256Hex: suffix.repeat(64), displayName: `Member ${suffix}`, homeServerId: "home", homeDeviceId: `device-${suffix}` });
    return { shareId: "share", shareGeneration: 1, memberId: `member-${suffix}`, memberGeneration: 1, credentialSha256Hex: suffix.repeat(64) } satisfies TaskShareGuestProof;
  };
  return { get store() { return store; }, shares, joinMember, reopen: () => { store.close(); store = new OperationalStore(path); } };
}
it("retains exact membership across restart and fences revoked members before receipt replay", () => {
  const f = fixture(), proof = f.joinMember("b");
  f.store.transaction(() => { f.shares().admit(proof, "request", { value: 1 }); f.shares().settle(proof, "request", { value: 1 }, { status: "completed", responseHex: "01" }); });
  f.reopen(); expect(f.shares().authorize(proof).member.memberId).toBe(proof.memberId);
  expect(f.shares().receipt(proof, "request", { value: 1 })?.responseHex).toBe("01");
  f.shares().remove("share", proof.memberId);
  expect(() => f.shares().receipt(proof, "request", { value: 1 })).toThrow(/revoked/);
  expect(f.store.listConnections()).toHaveLength(0);
});
it("rolls admission, author and the existing Queue back together and never changes an author", () => {
  const f = fixture(), proof = f.joinMember("b"), author = f.shares().author(proof);
  expect(() => f.store.transaction(() => { f.shares().recordAuthor("request", author); f.shares().admit(proof, "request", {}); throw new Error("rollback"); })).toThrow("rollback");
  expect(f.shares().getAuthorForOperation("request")).toBeUndefined(); expect(f.shares().receipt(proof, "request", {})).toBeUndefined();
  f.shares().recordAuthor("request", author);
  expect(() => f.shares().recordAuthor("request", { ...author, memberId: "other" })).toThrow(/immutable/);
});
it("uses the same Queue edit and dispatch lock while keeping guest and Connection principals separate", () => {
  const f = fixture(), first = f.joinMember("b"), other = f.joinMember("c");
  f.store.createConnection({ id: "owner", name: "Owner", device: { kind: "web", defaultName: "Task participant" }, authKeyDigest: "d".repeat(64) });
  f.store.runOperation({ id: "input", kind: "send_input", body: { sessionId: "session" } }, () => {
    f.store.createRun({ id: "run", sessionId: "session", source: "user", state: "queued", createdAt: 2 });
    f.store.createAttempt({ id: "attempt", runId: "run", ordinal: 1, generation: 1, startedAt: 2 });
    f.store.enqueueQueueItem({ id: "queue", sessionId: "session", runId: "run", attemptId: "attempt", operationId: "input", disposition: "prompt", body: { text: "draft", images: [], files: [], mentions: [], disposition: "prompt" } });
    f.shares().recordAuthor("input", f.shares().author(first));
  });
  const lockToken = "controlled-lock-token";
  f.store.setTaskShareQueueItemEditLock({ proof: first, queueItemId: "queue", lockToken, locked: true, ttlMs: 30_000 });
  expect(f.store.getQueueItem("queue").editLocked).toBe(true);
  expect(() => f.store.setTaskShareQueueItemEditLock({ proof: other, queueItemId: "queue", lockToken, locked: true })).toThrow(/own pending/);
  expect(() => f.store.setQueueItemEditLock({ queueItemId: "queue", connectionId: "owner", lockToken, locked: true })).toThrow(/already being edited/);
  f.store.editQueueItem({ queueItemId: "queue", taskShare: first, lockToken, body: { text: "updated", images: [], files: [], mentions: [], disposition: "prompt" }, traceId: "edit" });
  f.reopen(); expect(f.store.getQueueItem("queue").editLocked).toBe(true);
  f.shares().remove("share", first.memberId);
  expect(() => f.store.editQueueItem({ queueItemId: "queue", taskShare: first, lockToken, body: { text: "late", images: [], files: [], mentions: [], disposition: "prompt" }, traceId: "late" })).toThrow();
  f.store.expireQueueLocks({ sessionId: "session", at: Date.now() + 60_000 });
  expect(f.store.getQueueItem("queue").editLocked).toBe(false);
  expect(f.store.getQueueItem("queue").body.text).toBe("updated");
});
