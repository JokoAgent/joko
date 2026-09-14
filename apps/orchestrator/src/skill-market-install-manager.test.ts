import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { OperationalStore } from "@joko/store";
import { create as createTarArchive } from "tar";
import { afterEach, describe, expect, it } from "vitest";

import { PiResourceManager } from "./resource-manager.js";
import {
  SkillMarketManager,
  type SkillMarketCatalogItem,
  type SkillMarketEntryIdentity
} from "./skill-market-manager.js";
import { SkillMutationCoordinator } from "./skill-mutation-coordinator.js";

const roots: string[] = [];
const stores: OperationalStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SkillMarketManager installation plans", () => {
  it("holds the shared install slot, rolls back a rejected outer commit, and requires downgrade confirmation", async () => {
    const fixture = await createFixture();
    const sourceRoot = await writeMarket(fixture.root, "market", "1.0.0", "Version one.\n");
    const source = await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const entry = catalogEntry(fixture.market, 1n);

    const firstPlan = await fixture.market.createInstallPlan("connection-a", entryIdentity(entry), {
      backendId: "pi",
      scope: "global"
    });
    const secondPlan = await fixture.market.createInstallPlan("connection-b", entryIdentity(entry), {
      backendId: "pi",
      scope: "global"
    });
    expect(firstPlan).toMatchObject({
      resourcePreview: { action: "install", name: "writer" },
      confirmationReasons: [],
      requiresConfirmation: false
    });
    expect(publicJson(firstPlan)).not.toContain(fixture.root);
    await expect(fixture.market.getInstallPlan("connection-b", firstPlan.id)).rejects.toMatchObject({
      code: "INSTALL_PLAN_NOT_FOUND"
    });

    const firstPrepared = await fixture.market.prepareInstall({
      connectionId: "connection-a",
      planId: firstPlan.id,
      expectedCandidateRevision: firstPlan.resourcePreview.candidateRevision,
      confirmReplacement: false
    });
    await expect(fixture.market.prepareInstall({
      connectionId: "connection-b",
      planId: secondPlan.id,
      expectedCandidateRevision: secondPlan.resourcePreview.candidateRevision,
      confirmReplacement: false
    })).rejects.toMatchObject({ code: "MUTATION_BUSY" });

    await expect(firstPrepared.complete((finalize) => fixture.store.transaction((store) => {
      finalize(store);
      throw new Error("outer operation rejected");
    }))).rejects.toThrow(/outer operation rejected/u);
    expect(fixture.resources.list({ kind: "skill" })).toEqual([]);

    const secondPrepared = await fixture.market.prepareInstall({
      connectionId: "connection-b",
      planId: secondPlan.id,
      expectedCandidateRevision: secondPlan.resourcePreview.candidateRevision,
      confirmReplacement: false
    });
    const installed = await secondPrepared.complete((finalize) => fixture.store.transaction((store) => {
      finalize(store);
      return secondPrepared.mutation.value;
    }));
    expect(installed).toMatchObject({
      sourceKind: "skill_market",
      version: "1.0.0",
      skillMarket: { sourceId: source.id, entryId: entry.id }
    });
    expect(publicJson(installed)).not.toContain(fixture.root);
    expect(catalogEntry(fixture.market, 1n).installStatuses).toEqual([{
      resourceId: installed.id,
      resourceRevision: installed.versionNumber,
      backendId: "pi",
      scope: "global",
      state: "installed",
      installedVersion: "1.0.0"
    }]);

    await writeMarket(fixture.root, "market", "1.0.0", "Mutated same-version content.\n", sourceRoot);
    const sameVersionSource = await fixture.market.refresh(source.id, source.revision);
    expect(catalogEntry(fixture.market, 2n).installStatuses).toMatchObject([{
      resourceId: installed.id,
      state: "conflict",
      installedVersion: "1.0.0"
    }]);

    await writeMarket(fixture.root, "market", "1.1.0", "New market content.\n", sourceRoot);
    const newerSource = await fixture.market.refresh(source.id, sameVersionSource.revision);
    expect(catalogEntry(fixture.market, 3n).installStatuses).toMatchObject([{
      resourceId: installed.id,
      state: "update_available",
      installedVersion: "1.0.0"
    }]);

    await writeMarket(fixture.root, "market", "0.9.0", "Older market content.\n", sourceRoot);
    const refreshed = await fixture.market.refresh(source.id, newerSource.revision);
    const older = catalogEntry(fixture.market, 4n);
    expect(older.installStatuses).toMatchObject([{ resourceId: installed.id, state: "conflict" }]);
    const downgrade = await fixture.market.createInstallPlan("connection-a", entryIdentity(older), {
      backendId: "pi",
      scope: "global"
    });
    expect(downgrade).toMatchObject({
      resourcePreview: { action: "update", currentResource: { version: "1.0.0" } },
      confirmationReasons: ["DOWNGRADE"],
      requiresConfirmation: true
    });
    await expect(fixture.market.prepareInstall({
      connectionId: "connection-a",
      planId: downgrade.id,
      expectedCandidateRevision: downgrade.resourcePreview.candidateRevision,
      confirmReplacement: false
    })).rejects.toMatchObject({ code: "INSTALL_PLAN_CHANGED" });
    const downgradePrepared = await fixture.market.prepareInstall({
      connectionId: "connection-a",
      planId: downgrade.id,
      expectedCandidateRevision: downgrade.resourcePreview.candidateRevision,
      confirmReplacement: true
    });
    await downgradePrepared.cancel();
    expect(fixture.resources.get(installed.id)).toMatchObject({ version: "1.0.0" });
    expect(refreshed.revision).toBe(4n);
  });

  it("fences a prepared candidate when its source refreshes before commit", async () => {
    const fixture = await createFixture();
    const sourceRoot = await writeMarket(fixture.root, "stale", "1.0.0", "Initial.\n");
    const source = await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const entry = catalogEntry(fixture.market, 1n);
    const plan = await fixture.market.createInstallPlan("connection-a", entryIdentity(entry), {
      backendId: "pi",
      scope: "global"
    });
    const prepared = await fixture.market.prepareInstall({
      connectionId: "connection-a",
      planId: plan.id,
      expectedCandidateRevision: plan.resourcePreview.candidateRevision,
      confirmReplacement: false
    });

    await writeMarket(fixture.root, "stale", "1.1.0", "Refreshed.\n", sourceRoot);
    await fixture.market.refresh(source.id, source.revision);
    await expect(prepared.complete((finalize) => fixture.store.transaction((store) => finalize(store))))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(fixture.resources.list({ kind: "skill" })).toEqual([]);

    const current = catalogEntry(fixture.market, 2n);
    const retry = await fixture.market.createInstallPlan("connection-b", entryIdentity(current), {
      backendId: "pi",
      scope: "global"
    });
    const retryPrepared = await fixture.market.prepareInstall({
      connectionId: "connection-b",
      planId: retry.id,
      expectedCandidateRevision: retry.resourcePreview.candidateRevision,
      confirmReplacement: false
    });
    await retryPrepared.cancel();
  });

  it("expires open plans and discards a prepared plan when its connection closes", async () => {
    let now = 1_000;
    const fixture = await createFixture({ now: () => now, installPlanTtlMs: 1_000 });
    const sourceRoot = await writeMarket(fixture.root, "lifetime", "1.0.0", "Lifetime.\n");
    await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const entry = catalogEntry(fixture.market, 1n);
    const expired = await fixture.market.createInstallPlan("connection-a", entryIdentity(entry), {
      backendId: "pi",
      scope: "global"
    });
    now = 2_000;
    await expect(fixture.market.getInstallPlan("connection-a", expired.id)).rejects.toMatchObject({
      code: "INSTALL_PLAN_NOT_FOUND"
    });

    now = 3_000;
    const active = await fixture.market.createInstallPlan("connection-a", entryIdentity(entry), {
      backendId: "pi",
      scope: "global"
    });
    const prepared = await fixture.market.prepareInstall({
      connectionId: "connection-a",
      planId: active.id,
      expectedCandidateRevision: active.resourcePreview.candidateRevision,
      confirmReplacement: false
    });
    await fixture.market.closeConnection("connection-a");
    await expect(fixture.market.getInstallPlan("connection-a", active.id)).rejects.toMatchObject({
      code: "INSTALL_PLAN_NOT_FOUND"
    });
    await prepared.cancel();
    expect(fixture.resources.list({ kind: "skill" })).toEqual([]);
    expect(await readdir(join(fixture.cacheRoot, "plans"))).toEqual([]);
  });
});

async function createFixture(options: {
  readonly now?: () => number;
  readonly installPlanTtlMs?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-skill-market-install-"));
  roots.push(root);
  const store = new OperationalStore(join(root, "operational.sqlite"));
  stores.push(store);
  registerBackend(store);
  const resources = new PiResourceManager({ store, managedRoot: join(root, "managed"), now: options.now });
  await resources.initialize();
  const mutationCoordinator = new SkillMutationCoordinator();
  const cacheRoot = join(root, "cache");
  const market = new SkillMarketManager({
    store,
    cacheRoot,
    resources,
    mutationCoordinator,
    ...options
  });
  await market.initialize();
  return { root, cacheRoot, store, resources, market, mutationCoordinator };
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

async function writeMarket(root: string, name: string, version: string, content: string, existing?: string): Promise<string> {
  const sourceRoot = existing ?? join(root, `source-${name}`);
  await rm(sourceRoot, { recursive: true, force: true });
  await mkdir(join(sourceRoot, ".agents", "skills"), { recursive: true });
  const packageRoot = join(root, `package-${name}-${version}`);
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "SKILL.md"), content, "utf8");
  const archivePath = join(sourceRoot, "writer.tgz");
  await createTarArchive({ file: archivePath, cwd: packageRoot, gzip: true, portable: true, prefix: "package/" }, ["SKILL.md"]);
  const archive = await readFile(archivePath);
  await writeFile(join(sourceRoot, ".agents", "skills", "marketplace.json"), `${JSON.stringify({
    format: 1,
    name,
    displayName: `${name} display`,
    entries: [{
      slug: "writer",
      name: "Writer",
      author: "Joko test",
      description: "Writing helper",
      category: "Writing",
      tags: ["writing"],
      version,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      downloads: 1,
      trendScore: 1,
      archive: "writer.tgz",
      compressedBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex")
    }]
  }, null, 2)}\n`, "utf8");
  return sourceRoot;
}

function catalogEntry(market: SkillMarketManager, revision: bigint): SkillMarketCatalogItem {
  return market.listCatalog({ expectedRevision: revision, sort: "updated", offset: 0, pageSize: 10 }).items[0]!;
}

function entryIdentity(entry: SkillMarketCatalogItem): SkillMarketEntryIdentity {
  return {
    sourceId: entry.sourceId,
    sourceRevision: entry.sourceRevision,
    entryId: entry.id,
    entryRevision: entry.revision,
    contentRevision: entry.contentRevision
  };
}

function publicJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
