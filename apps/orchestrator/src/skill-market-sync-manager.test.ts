import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { create as createTarArchive } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PiResourceManager, type PiMarketSkillTargetInput, type PiResourceDescriptor } from "./resource-manager.js";
import { SkillManager } from "./skill-manager.js";
import { SkillMarketManager, type SkillMarketCatalogItem } from "./skill-market-manager.js";
import { SkillMarketSyncManager, type SkillMarketSyncJob } from "./skill-market-sync-manager.js";
import { SkillMutationCoordinator } from "./skill-mutation-coordinator.js";

const roots: string[] = [];
const stores: OperationalStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SkillMarketSyncManager", () => {
  it("adopts only a semantic upgrade, preserves a later enable choice, and blocks downgrade", async () => {
    const onResourceCommitted = vi.fn(async () => undefined);
    const fixture = await createFixture({ onResourceCommitted });
    const sourceRoot = await writeMarket(fixture.root, "upgrade", [{ slug: "writer", version: "1.0.0", content: "One.\n" }]);
    const source = await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const installed = await installCurrent(fixture, source.id, "writer", GLOBAL_TARGET, "install-a");
    const policy = await fixture.sync.enable({
      resourceId: installed.id,
      expectedResourceVersion: installed.versionNumber,
      target: GLOBAL_TARGET
    });
    expect(publicJson(policy)).not.toContain(fixture.root);

    const enabled = await fixture.resources.setEnabled(installed.id, true);
    expect(enabled.enabled).toBe(true);
    await writeMarket(fixture.root, "upgrade", [{ slug: "writer", version: "2.0.0", content: "Two.\n" }], sourceRoot);
    await fixture.market.refresh(source.id, source.revision);
    const update = await fixture.sync.enqueue(installed.id, policy.revision);
    fixture.sync.begin(update.id);
    await expect(fixture.sync.wait(update.id)).resolves.toMatchObject({ state: "succeeded", outcome: "UPDATED", availableVersion: "2.0.0" });
    expect(onResourceCommitted).toHaveBeenCalledWith({ resourceId: installed.id, backendId: "pi" });
    const upgraded = fixture.resources.get(installed.id);
    expect(upgraded).toMatchObject({ version: "2.0.0", enabled: true });
    expect(await installedSkillText(fixture.resources)).toBe("Two.\n");

    const currentPolicy = fixture.sync.getPolicy(installed.id);
    expect(currentPolicy).toMatchObject({ enabled: true, baseline: { installedVersion: "2.0.0" } });
    const currentJob = await fixture.sync.enqueue(installed.id, currentPolicy.revision);
    fixture.sync.begin(currentJob.id);
    await expect(fixture.sync.wait(currentJob.id)).resolves.toMatchObject({ state: "up_to_date", outcome: "ALREADY_CURRENT" });

    await writeMarket(fixture.root, "upgrade", [{ slug: "writer", version: "1.5.0", content: "Older.\n" }], sourceRoot);
    const sourceAtTwo = fixture.market.getSource(source.id);
    await fixture.market.refresh(source.id, sourceAtTwo.revision);
    const downgradePolicy = fixture.sync.getPolicy(installed.id);
    const downgrade = await fixture.sync.enqueue(installed.id, downgradePolicy.revision);
    fixture.sync.begin(downgrade.id);
    await expect(fixture.sync.wait(downgrade.id)).resolves.toMatchObject({
      state: "blocked",
      outcome: "DOWNGRADE_BLOCKED"
    });
    expect(fixture.resources.get(installed.id)).toMatchObject({ version: "2.0.0", enabled: true });
    expect(await installedSkillText(fixture.resources)).toBe("Two.\n");
  });

  it("never overwrites dirty content and disables its policy after exact Resource removal", async () => {
    const fixture = await createFixture();
    const sourceRoot = await writeMarket(fixture.root, "dirty", [{ slug: "writer", version: "1.0.0", content: "One.\n" }]);
    const source = await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const installed = await installCurrent(fixture, source.id, "writer", GLOBAL_TARGET, "install-dirty");
    const policy = await fixture.sync.enable({ resourceId: installed.id, expectedResourceVersion: installed.versionNumber, target: GLOBAL_TARGET });
    const enabled = await fixture.resources.setEnabled(installed.id, true);

    const editedRoot = join(fixture.root, "edited");
    await mkdir(editedRoot);
    await writeFile(join(editedRoot, "SKILL.md"), "Local edit.\n", "utf8");
    const lease = await fixture.resources.acquireSkillContent({ resourceId: installed.id, expectedResourceVersion: enabled.versionNumber });
    const edited = await fixture.resources.prepareReplaceSkillContent({
      resourceId: installed.id,
      expectedResourceVersion: enabled.versionNumber,
      expectedObservedRevision: lease.observedRevision,
      candidateRoot: editedRoot,
      changedByConnectionId: "local-editor"
    });
    await lease.release();
    await fixture.resources.completePreparedMutation(edited, (finalize) => fixture.store.transaction((store) => finalize(store)));

    await writeMarket(fixture.root, "dirty", [{ slug: "writer", version: "2.0.0", content: "Two.\n" }], sourceRoot);
    await fixture.market.refresh(source.id, source.revision);
    const dirtyJob = await fixture.sync.enqueue(installed.id, policy.revision);
    fixture.sync.begin(dirtyJob.id);
    await expect(fixture.sync.wait(dirtyJob.id)).resolves.toMatchObject({ state: "blocked", outcome: "DIRTY_CONTENT" });
    expect(await installedSkillText(fixture.resources)).toBe("Local edit.\n");

    const current = fixture.resources.get(installed.id);
    const currentLease = await fixture.resources.acquireSkillContent({ resourceId: current.id, expectedResourceVersion: current.versionNumber });
    const recovery = join(fixture.root, "recovery");
    await mkdir(recovery);
    await currentLease.release();
    const removal = await fixture.resources.prepareRemoveSkillContent({
      resourceId: current.id,
      expectedResourceVersion: current.versionNumber,
      expectedObservedRevision: currentLease.observedRevision,
      recoveryDestination: recovery
    });
    await fixture.resources.completePreparedMutation(removal, (finalize) => fixture.store.transaction((store) => finalize(store)));

    const removedJob = await fixture.sync.enqueue(installed.id, fixture.sync.getPolicy(installed.id).revision);
    fixture.sync.begin(removedJob.id);
    await expect(fixture.sync.wait(removedJob.id)).resolves.toMatchObject({ state: "blocked", outcome: "RESOURCE_REMOVED" });
    expect(fixture.sync.getPolicy(installed.id)).toMatchObject({ enabled: false, disabledReason: "resource_removed" });
  });

  it("persists explicit cancellation and recovers interrupted running work as pending revalidation", async () => {
    const runningGate = deferred<void>();
    let pauseRunning = true;
    const fixture = await createFixture({
      afterJobPersisted: async (job) => {
        if (pauseRunning && job.state === "running") await runningGate.promise;
      }
    });
    const sourceRoot = await writeMarket(fixture.root, "restart", [{ slug: "writer", version: "1.0.0", content: "One.\n" }]);
    const source = await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const installed = await installCurrent(fixture, source.id, "writer", GLOBAL_TARGET, "install-restart");
    const policy = await fixture.sync.enable({ resourceId: installed.id, expectedResourceVersion: installed.versionNumber, target: GLOBAL_TARGET });
    await writeMarket(fixture.root, "restart", [{ slug: "writer", version: "2.0.0", content: "Two.\n" }], sourceRoot);
    await fixture.market.refresh(source.id, source.revision);

    const cancelled = await fixture.sync.enqueue(installed.id, policy.revision);
    fixture.sync.begin(cancelled.id);
    await waitForJobState(fixture.sync, cancelled.id, "running");
    const cancelling = await fixture.sync.cancel(cancelled.id, fixture.sync.getJob(cancelled.id).revision);
    expect(cancelling.state).toBe("cancelling");
    pauseRunning = false;
    runningGate.resolve();
    await expect(fixture.sync.wait(cancelled.id)).resolves.toMatchObject({ state: "cancelled", outcome: "CANCELLED" });
    expect(fixture.resources.get(installed.id)).toMatchObject({ version: "1.0.0" });

    const restartGate = deferred<void>();
    pauseRunning = true;
    const secondFixtureSync = new SkillMarketSyncManager({
      store: fixture.store,
      resources: fixture.resources,
      market: fixture.market,
      afterJobPersisted: async (job) => {
        if (pauseRunning && job.state === "running") await restartGate.promise;
      }
    });
    await secondFixtureSync.initialize();
    const retry = await secondFixtureSync.retry(cancelled.id, secondFixtureSync.getJob(cancelled.id).revision);
    secondFixtureSync.begin(retry.id);
    await waitForJobState(secondFixtureSync, retry.id, "running");
    const closing = secondFixtureSync.close();
    pauseRunning = false;
    restartGate.resolve();
    await closing;
    expect(secondFixtureSync.getJob(retry.id).state).toBe("pending_revalidation");

    await fixture.market.close();
    fixture.store.close();
    const reopenedStore = new OperationalStore(fixture.databasePath);
    stores.push(reopenedStore);
    const reopenedResources = new PiResourceManager({ store: reopenedStore, managedRoot: fixture.managedRoot });
    await reopenedResources.initialize();
    const reopenedMarket = new SkillMarketManager({
      store: reopenedStore,
      cacheRoot: fixture.cacheRoot,
      resources: reopenedResources,
      mutationCoordinator: new SkillMutationCoordinator()
    });
    await reopenedMarket.initialize();
    const reopenedSync = new SkillMarketSyncManager({ store: reopenedStore, resources: reopenedResources, market: reopenedMarket });
    await reopenedSync.initialize();
    expect(reopenedSync.getJob(retry.id).state).toBe("pending_revalidation");
    reopenedSync.beginPending();
    await expect(reopenedSync.wait(retry.id)).resolves.toMatchObject({ state: "succeeded", outcome: "UPDATED" });
    expect(reopenedResources.get(installed.id)).toMatchObject({ version: "2.0.0" });
    await reopenedSync.close();
    await reopenedMarket.close();
  });

  it("isolates source loss from another policy in the same scheduled batch", async () => {
    const fixture = await createFixture();
    const firstRoot = await writeMarket(fixture.root, "first", [{ slug: "writer", version: "1.0.0", content: "Writer one.\n" }]);
    const secondRoot = await writeMarket(fixture.root, "second", [{ slug: "reviewer", version: "1.0.0", content: "Reviewer one.\n" }]);
    const firstSource = await fixture.market.add({ kind: "local", path: firstRoot }, 0n);
    const secondSource = await fixture.market.add({ kind: "local", path: secondRoot }, 1n);
    const writer = await installCurrent(fixture, firstSource.id, "writer", GLOBAL_TARGET, "install-writer");
    const reviewer = await installCurrent(fixture, secondSource.id, "reviewer", GLOBAL_TARGET, "install-reviewer");
    await fixture.sync.enable({ resourceId: writer.id, expectedResourceVersion: writer.versionNumber, target: GLOBAL_TARGET });
    await fixture.sync.enable({ resourceId: reviewer.id, expectedResourceVersion: reviewer.versionNumber, target: GLOBAL_TARGET });

    await writeMarket(fixture.root, "first", [{ slug: "writer", version: "2.0.0", content: "Writer two.\n" }], firstRoot);
    await fixture.market.refresh(firstSource.id, firstSource.revision);
    await fixture.market.remove(secondSource.id, secondSource.revision);
    const jobs = await fixture.sync.enqueueAll();
    expect(jobs).toHaveLength(2);
    fixture.sync.beginPending();
    const results = await Promise.all(jobs.map((job) => fixture.sync.wait(job.id)));
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ policyResourceId: writer.id, state: "succeeded", outcome: "UPDATED" }),
      expect.objectContaining({ policyResourceId: reviewer.id, state: "blocked", outcome: "OWNER_CHANGED" })
    ]));
    expect(fixture.resources.get(writer.id)).toMatchObject({ version: "2.0.0" });
    expect(fixture.resources.get(reviewer.id)).toMatchObject({ version: "1.0.0" });
  });

  it("fails closed when exact project Target trust changes before dispatch", async () => {
    const fixture = await createFixture();
    const workspace = join(fixture.root, "workspace");
    await mkdir(workspace);
    registerTarget(fixture.store, "target-a", workspace, true);
    const target: PiMarketSkillTargetInput = { backendId: "pi", scope: "project", targetId: "target-a" };
    const sourceRoot = await writeMarket(fixture.root, "target", [{ slug: "writer", version: "1.0.0", content: "One.\n" }]);
    const source = await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const installed = await installCurrent(fixture, source.id, "writer", target, "install-project");
    const policy = await fixture.sync.enable({ resourceId: installed.id, expectedResourceVersion: installed.versionNumber, target });
    await writeMarket(fixture.root, "target", [{ slug: "writer", version: "2.0.0", content: "Two.\n" }], sourceRoot);
    await fixture.market.refresh(source.id, source.revision);
    registerTarget(fixture.store, "target-a", workspace, false);

    const job = await fixture.sync.enqueue(installed.id, policy.revision);
    fixture.sync.begin(job.id);
    await expect(fixture.sync.wait(job.id)).resolves.toMatchObject({ state: "blocked", outcome: "TARGET_CHANGED" });
    expect(fixture.resources.get(installed.id)).toMatchObject({ version: "1.0.0" });
    expect(await readFile(join(workspace, ".agents", "skills", "writer", "SKILL.md"), "utf8")).toBe("One.\n");
  });

  it("terminates sync in the same exact Local Skill removal transaction and rolls both back together", async () => {
    const fixture = await createFixture();
    const sourceRoot = await writeMarket(fixture.root, "remove", [{ slug: "writer", version: "1.0.0", content: "One.\n" }]);
    const source = await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const installed = await installCurrent(fixture, source.id, "writer", GLOBAL_TARGET, "install-remove");
    await fixture.sync.enable({ resourceId: installed.id, expectedResourceVersion: installed.versionNumber, target: GLOBAL_TARGET });
    const skills = new SkillManager({
      store: fixture.store,
      resources: fixture.resources,
      rootDirectory: join(fixture.root, "skill-content"),
      mutations: fixture.mutationCoordinator,
      removalParticipant: { prepare: (resource) => fixture.sync.prepareResourceRemoval(resource) }
    });
    await skills.initialize();
    const detail = await skills.openSkill("connection-remove", installed.id, installed.versionNumber);
    const rejected = await skills.prepareDelete({
      connectionId: "connection-remove",
      sessionId: detail.sessionId,
      confirmation: "writer"
    });
    await expect(skills.completePreparedMutation(rejected, (finalize) => fixture.store.transaction((store) => {
      finalize(store);
      throw new Error("reject combined removal");
    }))).rejects.toThrow(/reject combined removal/u);
    expect(fixture.resources.get(installed.id).state).toBe("installed");
    expect(fixture.sync.getPolicy(installed.id)).toMatchObject({ enabled: true });

    const accepted = await skills.prepareDelete({
      connectionId: "connection-remove",
      sessionId: detail.sessionId,
      confirmation: "writer"
    });
    await skills.completePreparedMutation(accepted, (finalize) => fixture.store.transaction((store) => finalize(store)));
    expect(fixture.resources.get(installed.id).state).toBe("removed");
    expect(fixture.sync.getPolicy(installed.id)).toMatchObject({ enabled: false, disabledReason: "resource_removed" });
    await skills.close();
  });
});

const GLOBAL_TARGET: PiMarketSkillTargetInput = { backendId: "pi", scope: "global" };

async function createFixture(options: {
  readonly afterJobPersisted?: (job: SkillMarketSyncJob) => void | Promise<void>;
  readonly onResourceCommitted?: (resource: { readonly resourceId: string; readonly backendId: string }) => void | Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-skill-market-sync-"));
  roots.push(root);
  const databasePath = join(root, "operational.sqlite");
  const managedRoot = join(root, "managed");
  const cacheRoot = join(root, "market-cache");
  const store = new OperationalStore(databasePath);
  stores.push(store);
  registerBackend(store);
  const resources = new PiResourceManager({ store, managedRoot });
  await resources.initialize();
  const mutationCoordinator = new SkillMutationCoordinator();
  const market = new SkillMarketManager({ store, cacheRoot, resources, mutationCoordinator });
  await market.initialize();
  const sync = new SkillMarketSyncManager({ store, resources, market, ...options });
  await sync.initialize();
  return { root, databasePath, managedRoot, cacheRoot, store, resources, market, sync, mutationCoordinator };
}

async function installCurrent(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  sourceId: string,
  slug: string,
  target: PiMarketSkillTargetInput,
  connectionId: string
): Promise<PiResourceDescriptor> {
  const entry = fixture.market.getCurrentEntry(sourceId, fixture.market.listCatalog({
    expectedRevision: fixture.market.snapshot().revision,
    query: slug,
    sort: "updated",
    offset: 0,
    pageSize: 100
  }).items.find((candidate) => candidate.sourceId === sourceId && candidate.slug === slug)!.id);
  const plan = await fixture.market.createInstallPlan(connectionId, entryIdentity(entry), target);
  const prepared = await fixture.market.prepareInstall({
    connectionId,
    planId: plan.id,
    expectedCandidateRevision: plan.resourcePreview.candidateRevision,
    confirmReplacement: false
  });
  return prepared.complete((finalize) => fixture.store.transaction((store) => {
    finalize(store);
    return prepared.mutation.value;
  }));
}

function entryIdentity(entry: SkillMarketCatalogItem) {
  return {
    sourceId: entry.sourceId,
    sourceRevision: entry.sourceRevision,
    entryId: entry.id,
    entryRevision: entry.revision,
    contentRevision: entry.contentRevision
  };
}

async function writeMarket(
  root: string,
  name: string,
  entries: readonly { readonly slug: string; readonly version: string; readonly content: string }[],
  existing?: string
): Promise<string> {
  const sourceRoot = existing ?? join(root, `source-${name}`);
  await rm(sourceRoot, { recursive: true, force: true });
  await mkdir(join(sourceRoot, ".agents", "skills"), { recursive: true });
  const manifestEntries = [];
  for (const entry of entries) {
    const packageRoot = join(root, `package-${name}-${entry.slug}-${entry.version}`);
    await rm(packageRoot, { recursive: true, force: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "SKILL.md"), entry.content, "utf8");
    const archivePath = join(sourceRoot, `${entry.slug}.tgz`);
    await createTarArchive({ file: archivePath, cwd: packageRoot, gzip: true, portable: true, prefix: "package/" }, ["SKILL.md"]);
    const archive = await readFile(archivePath);
    manifestEntries.push({
      slug: entry.slug,
      name: entry.slug,
      author: "Joko test",
      description: `${entry.slug} helper`,
      category: "Testing",
      tags: ["testing"],
      version: entry.version,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: entry.version === "1.0.0" ? "2026-01-01T00:00:00Z" : "2026-02-01T00:00:00Z",
      downloads: 1,
      trendScore: 1,
      archive: `${entry.slug}.tgz`,
      compressedBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex")
    });
  }
  await writeFile(join(sourceRoot, ".agents", "skills", "marketplace.json"), `${JSON.stringify({
    format: 1,
    name,
    displayName: `${name} display`,
    entries: manifestEntries
  }, null, 2)}\n`, "utf8");
  return sourceRoot;
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

async function installedSkillText(resources: PiResourceManager): Promise<string> {
  const snapshot = await resources.runtimeSnapshot("pi");
  return readFile(join(snapshot.skills[0]!, "SKILL.md"), "utf8");
}

async function waitForJobState(sync: SkillMarketSyncManager, jobId: string, state: SkillMarketSyncJob["state"]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sync.getJob(jobId).state === state) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${state}.`);
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function publicJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
