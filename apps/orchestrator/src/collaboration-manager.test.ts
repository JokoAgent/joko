import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  CollaborationManager,
  type SkillAccessPolicy
} from "./collaboration-manager.js";
import { mkdtemp } from "./test-paths.js";

const roots: string[] = [];
const stores: OperationalStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CollaborationManager", () => {
  it("persists a non-constant actor and fences durable team and department scope changes", async () => {
    const { path, store } = await fixture();
    const manager = new CollaborationManager({ store, idFactory: sequence("actor-seed", "team-seed", "department-seed") });
    manager.initialize();

    const initial = manager.snapshot();
    expect(initial).toMatchObject({ available: true, revision: 1n, scopes: [] });
    expect(initial.actor?.id).toMatch(/^collaboration_actor_[a-f0-9]{32}$/u);
    expect(initial.actor?.id).not.toBe("local-user");

    const team = manager.createScope({ expectedCatalogRevision: 1n, kind: "team", name: "Platform" });
    expect(team).toMatchObject({ revision: 1n, kind: "team", name: "Platform" });
    expect(team.members).toEqual([{ actorId: initial.actor!.id, role: "administrator" }]);
    const department = manager.createScope({ expectedCatalogRevision: 2n, kind: "department", name: "Engineering" });
    expect(manager.snapshot()).toMatchObject({ revision: 3n, scopes: [{ id: team.id }, { id: department.id }] });
    expect(() => manager.createScope({ expectedCatalogRevision: 2n, kind: "team", name: "Stale" }))
      .toThrowError(expect.objectContaining({ code: "COLLABORATION_CHANGED" }));
    expect(() => manager.updateScope({ scopeId: team.id, expectedRevision: 1n, name: "Core platform" }))
      .not.toThrow();
    expect(() => manager.updateScope({ scopeId: team.id, expectedRevision: 1n, name: "Stale rename" }))
      .toThrowError(expect.objectContaining({ code: "COLLABORATION_CHANGED" }));

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopenedStore = new OperationalStore(path);
    stores.push(reopenedStore);
    const reopened = new CollaborationManager({ store: reopenedStore });
    reopened.initialize();
    expect(reopened.snapshot()).toMatchObject({
      available: true,
      revision: 4n,
      actor: { id: initial.actor!.id },
      scopes: [{ id: team.id, revision: 2n, name: "Core platform" }, { id: department.id }]
    });
  });

  it("authorizes only exact publisher and audience combinations and revisions access changes", async () => {
    const { store } = await fixture();
    const manager = new CollaborationManager({ store, idFactory: sequence("actor", "team", "department") });
    manager.initialize();
    const team = manager.createScope({ expectedCatalogRevision: 1n, kind: "team", name: "Platform" });
    const department = manager.createScope({ expectedCatalogRevision: 2n, kind: "department", name: "Engineering" });

    const personal = manager.authorizePublication({ publisher: "personal", visibility: "private", audienceScopeIds: [] });
    expect(personal).toMatchObject({ revision: 1n, publisher: { kind: "personal" }, visibility: "private" });
    expect(manager.canView(personal)).toBe(true);
    expect(manager.canManage(personal)).toBe(true);

    const restricted = manager.authorizePublication({
      publisher: "team",
      publisherScopeId: team.id,
      visibility: "department",
      audienceScopeIds: [department.id]
    });
    expect(restricted).toEqual({
      revision: 1n,
      publisher: { kind: "team", scopeId: team.id },
      visibility: "department",
      audienceScopeIds: [department.id]
    });
    expect(manager.canView(restricted)).toBe(true);
    expect(manager.canManage(restricted)).toBe(true);

    const publicTeam = manager.authorizePublication({
      publisher: "team",
      publisherScopeId: team.id,
      visibility: "public",
      audienceScopeIds: []
    }, restricted);
    expect(publicTeam.revision).toBe(2n);
    expect(manager.authorizePublication({
      publisher: "team",
      publisherScopeId: team.id,
      visibility: "public",
      audienceScopeIds: []
    }, publicTeam).revision).toBe(2n);

    expect(() => manager.authorizePublication({
      publisher: "personal",
      visibility: "department",
      audienceScopeIds: [department.id]
    })).toThrowError(expect.objectContaining({ code: "COLLABORATION_INVALID" }));
    expect(() => manager.authorizePublication({
      publisher: "team",
      publisherScopeId: team.id,
      visibility: "private",
      audienceScopeIds: []
    })).toThrowError(expect.objectContaining({ code: "COLLABORATION_INVALID" }));
    expect(() => manager.authorizePublication({
      publisher: "personal",
      visibility: "public",
      audienceScopeIds: []
    }, publicTeam)).toThrowError(expect.objectContaining({ code: "COLLABORATION_PERMISSION_DENIED" }));
  });

  it("retains corrupt identity bytes and fails closed for every restricted action", async () => {
    const { store } = await fixture();
    const corrupt = { format: 1, revision: "1", actor: { id: "constant", displayName: "Bad" }, scopes: "invalid" };
    store.setSetting("service", "orchestrator", "collaboration.directory", corrupt);
    const manager = new CollaborationManager({ store, idFactory: () => "must-not-be-used" });
    manager.initialize();

    expect(manager.snapshot()).toMatchObject({
      available: false,
      revision: 0n,
      scopes: [],
      recoveredFromCorruption: true
    });
    expect(store.findSetting("service", "orchestrator", "collaboration.directory")?.value).toEqual(corrupt);
    const publicPolicy: SkillAccessPolicy = {
      revision: 1n,
      publisher: { kind: "external", sourceId: "source" },
      visibility: "public",
      audienceScopeIds: []
    };
    const privatePolicy: SkillAccessPolicy = {
      revision: 1n,
      publisher: { kind: "personal", actorId: "someone" },
      visibility: "private",
      audienceScopeIds: []
    };
    expect(manager.canView(publicPolicy)).toBe(true);
    expect(manager.canView(privatePolicy)).toBe(false);
    expect(manager.canManage(privatePolicy)).toBe(false);
    expect(() => manager.publicationCapabilities())
      .toThrowError(expect.objectContaining({ code: "COLLABORATION_UNAVAILABLE" }));
    expect(() => manager.createScope({ expectedCatalogRevision: 0n, kind: "team", name: "No" }))
      .toThrowError(expect.objectContaining({ code: "COLLABORATION_UNAVAILABLE" }));
  });
});

async function fixture(): Promise<{ readonly path: string; readonly store: OperationalStore }> {
  const root = await mkdtemp(join(tmpdir(), "joko-collaboration-"));
  roots.push(root);
  const path = join(root, "operational.sqlite");
  const store = new OperationalStore(path);
  stores.push(store);
  return { path, store };
}

function sequence(...values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `fallback-${index}`;
}
