import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  PiResourceManager,
  type PiMarketSkillPreview,
  type PiMarketSkillSourceInput,
  type PiMarketSkillTargetInput,
  type PreparedPiMarketSkillMutation
} from "./resource-manager.js";

const roots: string[] = [];
const stores: OperationalStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PiResourceManager Skill market adoption", () => {
  it("publishes immutable global generations, preserves enablement, exposes path-free provenance, and fences dirty updates", async () => {
    const fixture = await createFixture();
    const v1 = await createSkill(fixture.root, "candidate-v1", "Version one.\n", { "notes.txt": "old\n" });
    const sourceV1 = marketSource(v1, "1.0.0", "a", "b");
    const target: PiMarketSkillTargetInput = { backendId: "pi", scope: "global" };
    const preview = await fixture.manager.previewMarketSkill({ ...sourceV1, ...target });
    expect(preview).toMatchObject({ action: "install", scope: "global", name: "writer", diffAvailable: true });
    expect(preview.currentResource).toBeUndefined();
    expect(preview.changes.map((change) => [change.key, change.kind])).toEqual(expect.arrayContaining([
      ["SKILL.md", "added"],
      ["notes.txt", "added"]
    ]));
    expect(preview.changes).toHaveLength(2);
    expect(publicJson(preview)).not.toContain(fixture.root);

    const installed = await adopt(fixture, await prepare(fixture.manager, sourceV1, target, preview));
    expect(installed).toMatchObject({
      id: preview.resourceId,
      sourceKind: "skill_market",
      scope: "global",
      state: "installed",
      enabled: false,
      version: "1.0.0",
      skillMarket: {
        sourceId: sourceV1.sourceId,
        sourceRevision: 1n,
        entryId: sourceV1.entryId,
        entryRevision: 1n,
        entryContentRevision: sourceV1.entryContentRevision
      }
    });
    expect(publicJson(installed)).not.toContain(v1);
    await fixture.manager.setEnabled(installed.id, true);

    const v2 = await createSkill(fixture.root, "candidate-v2", "Version two.\n", { "new.txt": "new\n" });
    const sourceV2 = marketSource(v2, "1.1.0", "a", "b", 2n, 2n, "d");
    const updatePreview = await fixture.manager.previewMarketSkill({ ...sourceV2, ...target });
    expect(updatePreview).toMatchObject({
      action: "update",
      preservesEnabled: true,
      currentResource: { resourceId: installed.id, dirty: false, version: "1.0.0" }
    });
    expect(updatePreview.changes.map((change) => [change.key, change.kind])).toEqual(expect.arrayContaining([
      ["SKILL.md", "modified"],
      ["new.txt", "added"],
      ["notes.txt", "deleted"]
    ]));
    expect(updatePreview.changes).toHaveLength(3);

    const beforeRollback = fixture.manager.get(installed.id);
    const preparedRollback = await prepare(fixture.manager, sourceV2, target, updatePreview);
    await expect(fixture.manager.completePreparedMutation(preparedRollback.mutation, (finalize) => fixture.store.transaction((transaction) => {
      finalize(transaction);
      throw new Error("simulated outer failure");
    }))).rejects.toThrow(/simulated outer failure/u);
    expect(fixture.manager.get(installed.id)).toEqual(beforeRollback);
    expect(await runtimeSkillText(fixture.manager)).toBe("Version one.\n");

    const updatePreviewAfterRollback = await fixture.manager.previewMarketSkill({ ...sourceV2, ...target });
    const updated = await adopt(fixture, await prepare(fixture.manager, sourceV2, target, updatePreviewAfterRollback));
    expect(updated).toMatchObject({ version: "1.1.0", enabled: true, state: "installed", versionNumber: 3n });
    expect(await runtimeSkillText(fixture.manager)).toBe("Version two.\n");

    const edited = await createSkill(fixture.root, "candidate-edited", "Locally edited.\n");
    const lease = await fixture.manager.acquireSkillContent({ resourceId: updated.id, expectedResourceVersion: updated.versionNumber });
    const localMutation = await fixture.manager.prepareReplaceSkillContent({
      resourceId: updated.id,
      expectedResourceVersion: updated.versionNumber,
      expectedObservedRevision: lease.observedRevision,
      candidateRoot: edited,
      changedByConnectionId: "connection-local"
    });
    await lease.release();
    await fixture.manager.completePreparedMutation(localMutation, (finalize) => fixture.store.transaction((transaction) => finalize(transaction)));
    const dirtyPreview = await fixture.manager.previewMarketSkill({ ...sourceV2, ...target });
    expect(dirtyPreview).toMatchObject({ action: "update", currentResource: { dirty: true } });
    await expect(prepare(fixture.manager, sourceV2, target, dirtyPreview, false)).rejects.toThrow(/explicit confirmation/u);
  });

  it("atomically replaces an unregistered project directory and restores it when the Store commit fails", async () => {
    const fixture = await createFixture();
    const workspace = join(fixture.root, "workspace-conflict");
    const destination = join(workspace, ".agents", "skills", "writer");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "Unregistered old content.\n", "utf8");
    registerTarget(fixture.store, "target-conflict", workspace, true);
    const candidate = await createSkill(fixture.root, "project-candidate", "Market content.\n");
    const source = marketSource(candidate, "1.0.0", "a", "b");
    const target: PiMarketSkillTargetInput = { backendId: "pi", scope: "project", targetId: "target-conflict" };

    const preview = await fixture.manager.previewMarketSkill({ ...source, ...target });
    expect(preview).toMatchObject({ action: "replace", unregisteredDestination: true, relativeParent: ".agents/skills", diffAvailable: true });
    expect(preview.changes).toMatchObject([{ key: "SKILL.md", kind: "modified", binary: false }]);
    await expect(prepare(fixture.manager, source, target, preview, false)).rejects.toThrow(/explicit confirmation/u);

    const prepared = await prepare(fixture.manager, source, target, preview, true);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("Market content.\n");
    await expect(fixture.manager.completePreparedMutation(prepared.mutation, (finalize) => fixture.store.transaction((transaction) => {
      finalize(transaction);
      throw new Error("store rejected");
    }))).rejects.toThrow(/store rejected/u);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("Unregistered old content.\n");
    expect(fixture.manager.list({ kind: "skill" })).toEqual([]);

    const retryPreview = await fixture.manager.previewMarketSkill({ ...source, ...target });
    const installed = await adopt(fixture, await prepare(fixture.manager, source, target, retryPreview, true));
    expect(installed).toMatchObject({ scope: "project", targetId: "target-conflict", state: "approved", enabled: false });
    expect(installed.skillMarket).toBeDefined();
    await fixture.manager.setEnabled(installed.id, true);
    expect((await fixture.manager.targetRuntimeSnapshot("pi", "target-conflict")).skills).toEqual([destination]);
  });

  it("rolls back an interrupted project update on restart and supports a trusted custom Target-relative parent", async () => {
    const fixture = await createFixture();
    const workspace = join(fixture.root, "workspace-restart");
    await mkdir(workspace);
    registerTarget(fixture.store, "target-restart", workspace, true);
    const target: PiMarketSkillTargetInput = {
      backendId: "pi",
      scope: "project",
      targetId: "target-restart",
      relativeParent: "tools/team-skills"
    };
    const v1 = marketSource(await createSkill(fixture.root, "restart-v1", "One.\n"), "1.0.0", "a", "b");
    const firstPreview = await fixture.manager.previewMarketSkill({ ...v1, ...target });
    const first = await adopt(fixture, await prepare(fixture.manager, v1, target, firstPreview));
    const destination = join(workspace, "tools", "team-skills", "writer");
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("One.\n");

    const v2 = marketSource(await createSkill(fixture.root, "restart-v2", "Two.\n"), "2.0.0", "a", "b", 2n, 2n, "e");
    const updatePreview = await fixture.manager.previewMarketSkill({ ...v2, ...target });
    await prepare(fixture.manager, v2, target, updatePreview);
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("Two.\n");

    fixture.store.close();
    const reopenedStore = new OperationalStore(fixture.databasePath);
    stores.push(reopenedStore);
    const recovered = new PiResourceManager({ store: reopenedStore, managedRoot: fixture.managedRoot });
    await recovered.initialize();
    expect(recovered.get(first.id)).toMatchObject({ version: "1.0.0", versionNumber: first.versionNumber });
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe("One.\n");
    expect((await readdirSafe(join(fixture.managedRoot, ".skill-market-transactions"))).length).toBe(0);
  });

  it("rejects untrusted Targets and source replacement without exact confirmation", async () => {
    const fixture = await createFixture();
    const workspace = join(fixture.root, "workspace-untrusted");
    await mkdir(workspace);
    registerTarget(fixture.store, "target-untrusted", workspace, false);
    const source = marketSource(await createSkill(fixture.root, "untrusted", "No.\n"), "1.0.0", "a", "b");
    await expect(fixture.manager.previewMarketSkill({ ...source, backendId: "pi", scope: "project", targetId: "target-untrusted" }))
      .rejects.toThrow(/trusted/u);

    const globalTarget: PiMarketSkillTargetInput = { backendId: "pi", scope: "global" };
    const firstPreview = await fixture.manager.previewMarketSkill({ ...source, ...globalTarget });
    await adopt(fixture, await prepare(fixture.manager, source, globalTarget, firstPreview));
    const otherSource = marketSource(await createSkill(fixture.root, "other-source", "Other.\n"), "1.0.0", "c", "d");
    const replacement = await fixture.manager.previewMarketSkill({ ...otherSource, ...globalTarget });
    expect(replacement).toMatchObject({ action: "replace", sourceReplacement: true });
    await expect(prepare(fixture.manager, otherSource, globalTarget, replacement, false)).rejects.toThrow(/explicit confirmation/u);
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-market-resource-"));
  roots.push(root);
  const databasePath = join(root, "operational.sqlite");
  const managedRoot = join(root, "managed");
  const store = new OperationalStore(databasePath);
  stores.push(store);
  registerBackend(store);
  const manager = new PiResourceManager({ store, managedRoot });
  await manager.initialize();
  return { root, databasePath, managedRoot, store, manager };
}

function registerBackend(store: OperationalStore): void {
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "0.84.4",
    health: "healthy",
    adapterKind: "pi",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map([["runtime.resources", {
      key: "runtime.resources",
      supported: true,
      options: ["extension", "skill", "prompt", "package"]
    }]]),
    models: [],
    tools: [],
    diagnostics: []
  });
}

function registerTarget(store: OperationalStore, id: string, workspaceRoot: string, trusted: boolean): void {
  store.upsertTarget({ id, backendId: "pi", displayName: id, workspaceRoot, managed: false, trusted });
}

async function createSkill(root: string, name: string, manifest: string, extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), manifest, "utf8");
  for (const [key, content] of Object.entries(extra)) {
    const file = join(path, ...key.split("/"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return path;
}

function marketSource(
  candidateRoot: string,
  version: string,
  sourceSeed: string,
  entrySeed: string,
  sourceRevision = 1n,
  entryRevision = 1n,
  contentSeed = "c"
): PiMarketSkillSourceInput {
  return {
    sourceId: `skill_market_source_${sourceSeed.repeat(32).slice(0, 32)}`,
    sourceRevision,
    entryId: `skill_market_entry_${entrySeed.repeat(32).slice(0, 32)}`,
    entryRevision,
    entryContentRevision: `sha256:${contentSeed.repeat(64).slice(0, 64)}`,
    sourceName: "Test market",
    slug: "writer",
    version,
    candidateRoot
  };
}

async function prepare(
  manager: PiResourceManager,
  source: PiMarketSkillSourceInput,
  target: PiMarketSkillTargetInput,
  preview: PiMarketSkillPreview,
  allowReplacement = true
): Promise<PreparedPiMarketSkillMutation> {
  return manager.prepareMarketSkill({
    ...source,
    ...target,
    approvedByConnectionId: "connection-owner",
    expectedAction: preview.action,
    expectedResourceId: preview.resourceId,
    ...(preview.currentResource === undefined
      ? {}
      : {
          expectedCurrentResourceId: preview.currentResource.resourceId,
          expectedCurrentResourceVersion: preview.currentResource.resourceVersion,
          expectedCurrentObservedRevision: preview.currentResource.observedRevision
        }),
    expectedUnregisteredDestination: preview.unregisteredDestination,
    allowReplacement
  });
}

async function adopt(
  fixture: { readonly manager: PiResourceManager; readonly store: OperationalStore },
  prepared: PreparedPiMarketSkillMutation
) {
  return fixture.manager.completePreparedMutation(prepared.mutation, (finalize) => fixture.store.transaction((transaction) => {
    finalize(transaction);
    return prepared.mutation.value;
  }));
}

async function runtimeSkillText(manager: PiResourceManager): Promise<string> {
  const snapshot = await manager.runtimeSnapshot("pi");
  expect(snapshot.skills).toHaveLength(1);
  return readFile(join(snapshot.skills[0]!, "SKILL.md"), "utf8");
}

async function readdirSafe(path: string): Promise<readonly string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(path).catch(() => []);
}

function publicJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
