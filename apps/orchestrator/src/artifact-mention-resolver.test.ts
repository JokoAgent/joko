import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { createArtifactMentionResolver } from "./artifact-mention-resolver.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it("resolves the committed task Artifact and rejects foreign, unowned, expired, or deleted identities", async () => {
  const f = await fixture();
  const owned = await f.ingest("owned", "one");
  const foreign = await f.ingest("foreign", "two");
  const unowned = await f.ingest("unowned");
  const expired = await f.ingest("expired", "one", 1);
  const deleted = await f.ingest("deleted", "one");
  f.store.deleteArtifact(deleted.id);
  const resolved = await f.resolve(owned.id, f.context, new AbortController().signal);
  expect(resolved.blob).toEqual(f.store.getArtifact(owned.id).blob);
  expect(resolved.path).toBe(owned.storagePath);
  expect(resolved.assertCurrent).not.toThrow();
  for (const id of [foreign.id, unowned.id, expired.id, deleted.id, "missing", "../foreign"])
    await expect(f.resolve(id, f.context, new AbortController().signal)).rejects.toThrow();
  expect(f.resolveBlobPath).toHaveBeenCalledTimes(1);
});

it.each(["deleted", "archived", "target", "worktree", "generation", "backend", "cancelled"] as const)(
  "retires the original authority when %s changes during byte resolution", async (change) => {
    const f = await fixture(change === "worktree");
    const owned = await f.ingest("owned", "one");
    const abort = new AbortController();
    let release!: (path: string) => void;
    f.resolveBlobPath.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = f.resolve(owned.id, f.context, abort.signal);
    const rejected = expect(pending).rejects.toThrow();
    expect(f.resolveBlobPath).toHaveBeenCalledOnce();
    if (change === "deleted") f.store.deleteArtifact(owned.id);
    else if (change === "archived") f.store.updateSession("one", { archived: true });
    else if (change === "target") f.store.upsertTarget({ ...f.context.target, trusted: false });
    else if (change === "worktree") f.store.updateSessionWorktreeState("one", "preserved");
    else if (change === "generation") f.store.updateSession("one", { binding: { ...f.context.binding!, generation: 2 } });
    else if (change === "backend") f.retireBackend();
    else abort.abort();
    release(owned.storagePath);
    await rejected;
  }
);

it("checks the retained canonical record again after file preparation", async () => {
  const f = await fixture();
  const owned = await f.ingest("owned", "one");
  const resolved = await f.resolve(owned.id, f.context, new AbortController().signal);
  f.store.deleteArtifact(owned.id);
  expect(resolved.assertCurrent).toThrow();
});

async function fixture(withWorktree = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-artifact-mention-")));
  const store = new OperationalStore(join(root, "store.db"));
  cleanup.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const backend = new FakeBackendAdapter(PI_LIKE_PROFILE);
  store.upsertBackend(await backend.describe());
  const target = { id: "target", backendId: backend.id, displayName: "Workspace", workspaceRoot: root, managed: false, trusted: true };
  store.upsertTarget(target);
  for (const id of ["one", "two"]) store.createSession({
    id, targetId: target.id, backendId: backend.id, title: id, binding: { opaqueRef: `native/${id}`, generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1,
    ...(withWorktree && id === "one" ? { worktree: {
      leaseId: `lease-${id}`, workspaceId: "workspace-one", path: root, repositoryRoot: root, branch: id,
      sourceRef: "HEAD", sourceCommit: "a".repeat(40), sourceStrategy: "head" as const, sourceRefreshed: false,
      state: "active" as const, acquiredAt: 1, updatedAt: 1
    } } : {})
  });
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize();
  const context: AdapterContext = {
    sessionId: "one", generation: 1, binding: store.getSession("one").descriptor.binding, target,
    signal: new AbortController().signal, emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }),
    artifactCapacityBytes: 256 * 1024 * 1024, storeArtifact: async () => { throw new Error("Not used."); }
  };
  let backendCurrent = true;
  const resolveBlobPath = vi.fn((blob: Parameters<ArtifactStore["resolveBlobPath"]>[0]) => artifacts.resolveBlobPath(blob));
  const resolve = createArtifactMentionResolver({ store, artifacts: { resolveBlobPath },
    resolveTarget: (session) => store.getTarget(session.descriptor.targetId).descriptor,
    assertBackendCurrent: () => { if (!backendCurrent) throw new Error("Retired Backend."); }
  });
  return { store, context, resolve, resolveBlobPath, retireBackend: () => { backendCurrent = false; },
    ingest: async (name: string, sessionId?: string, expiresAt?: number) => {
      const artifact = await artifacts.ingestBytes(Buffer.from(name), { fileName: `${name}.txt`, mimeType: "text/plain", expiresAt: expiresAt ?? Date.now() + 60_000 });
      if (sessionId !== undefined && expiresAt === undefined) store.transaction(() => store.adoptSessionArtifact({ blob: store.getArtifact(artifact.id).blob, sessionId }));
      return artifact;
    }
  };
}
