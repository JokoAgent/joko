import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { create as createTarArchive } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { PiResourceManager } from "./resource-manager.js";
import { SessionHost } from "./session-host.js";
import { SkillMarketManager } from "./skill-market-manager.js";
import { SkillMarketSyncManager } from "./skill-market-sync-manager.js";
import { SkillMutationCoordinator } from "./skill-mutation-coordinator.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Connect Skill market boundary", () => {
  it("provides revision-fenced catalog pages and connection-private path-free archive previews", async () => {
    const fixture = await createFixture();
    const firstRoot = await writeMarket(fixture.root, "first-market", [
      { slug: "writer", name: "Writer", version: "1.0.0", content: "Writer instructions.\n" },
      { slug: "reviewer", name: "Reviewer", version: "1.0.0", content: "Review instructions.\n" }
    ]);
    const added = await submit(fixture, "add-first-market", {
      case: "addSkillMarketSource",
      value: create(contract.AddSkillMarketSourceMutationSchema, {
        source: { kind: { case: "local", value: { serverPath: firstRoot } } },
        expectedCatalogRevision: { value: 0n }
      })
    });
    expect(added.operation?.state).toBe(contract.OperationState.SUCCEEDED);

    const sources = await invoke<contract.ListSkillMarketSourcesResponse>(
      fixture.services.skill.listSkillMarketSources,
      { page: { pageSize: 1 } }
    );
    expect(sources.sources).toHaveLength(1);
    expect(sources.sources[0]).toMatchObject({
      kind: contract.SkillMarketSourceKind.LOCAL,
      state: contract.SkillMarketSourceState.READY,
      entryCount: 2
    });
    expectPathPrivate(sources, fixture.root);

    await expect(invoke(fixture.services.skill.listSkillMarketCatalog, {
      sort: 999,
      page: { pageSize: 1 }
    })).rejects.toMatchObject({ code: 3 });

    const firstPage = await invoke<contract.ListSkillMarketCatalogResponse>(
      fixture.services.skill.listSkillMarketCatalog,
      {
        expectedCatalogRevision: sources.catalogRevision,
        sort: contract.SkillMarketSort.UPDATED,
        page: { pageSize: 1 }
      }
    );
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.page?.nextPageToken).not.toBe("");
    expect(firstPage.page?.totalSize).toBe(2n);
    expectPathPrivate(firstPage, fixture.root);

    const preview = await invoke<contract.OpenSkillMarketPreviewResponse>(
      fixture.services.skill.openSkillMarketPreview,
      { identity: firstPage.entries[0]!.identity }
    );
    expect(preview.preview?.files).toBe(2n);
    expectPathPrivate(preview, fixture.root);

    fixture.connectionId = OTHER_CONNECTION_ID;
    await expect(invoke(fixture.services.skill.listSkillMarketPreviewFiles, {
      previewId: preview.preview!.previewId,
      expectedSnapshotRevision: preview.preview!.snapshotRevision,
      page: { pageSize: 500 }
    })).rejects.toMatchObject({ code: 5 });
    fixture.connectionId = CONNECTION_ID;

    const files = await invoke<contract.ListSkillMarketPreviewFilesResponse>(
      fixture.services.skill.listSkillMarketPreviewFiles,
      {
        previewId: preview.preview!.previewId,
        expectedSnapshotRevision: preview.preview!.snapshotRevision,
        page: { pageSize: 500 }
      }
    );
    expect(files.files.map((file) => file.key)).toEqual(["guide.md", "SKILL.md"]);
    const read = await invoke<contract.ReadSkillMarketPreviewFileResponse>(
      fixture.services.skill.readSkillMarketPreviewFile,
      {
        previewId: preview.preview!.previewId,
        expectedSnapshotRevision: preview.preview!.snapshotRevision,
        key: "SKILL.md"
      }
    );
    expect(read.file).toMatchObject({
      previewable: true,
      content: firstPage.entries[0]!.slug === "writer" ? "Writer instructions.\n" : "Review instructions.\n"
    });
    expectPathPrivate({ files, read }, fixture.root);

    const secondRoot = await writeMarket(fixture.root, "second-market", [
      { slug: "planner", name: "Planner", version: "1.0.0", content: "Plan.\n" }
    ]);
    await submit(fixture, "add-second-market", {
      case: "addSkillMarketSource",
      value: create(contract.AddSkillMarketSourceMutationSchema, {
        source: { kind: { case: "local", value: { serverPath: secondRoot } } },
        expectedCatalogRevision: sources.catalogRevision
      })
    });
    await expect(invoke(fixture.services.skill.listSkillMarketCatalog, {
      sort: contract.SkillMarketSort.UPDATED,
      page: { pageSize: 1, pageToken: firstPage.page!.nextPageToken }
    })).rejects.toMatchObject({ code: 10 });
  });

  it("installs an exact plan, publishes the Skill result, and exposes durable sync control", async () => {
    const fixture = await createFixture();
    const sourceRoot = await writeMarket(fixture.root, "install-market", [
      { slug: "writer", name: "Writer", version: "1.0.0", content: "Installed instructions.\n" }
    ]);
    await fixture.market.add({ kind: "local", path: sourceRoot }, 0n);
    const catalog = await invoke<contract.ListSkillMarketCatalogResponse>(
      fixture.services.skill.listSkillMarketCatalog,
      { sort: contract.SkillMarketSort.UPDATED, page: { pageSize: 100 } }
    );
    const entry = catalog.entries[0]!;

    await expect(invoke(fixture.services.skill.createSkillMarketInstallPlan, {
      identity: entry.identity,
      target: { backendId: "pi", scope: 999 }
    })).rejects.toMatchObject({ code: 3 });

    const planned = await invoke<contract.CreateSkillMarketInstallPlanResponse>(
      fixture.services.skill.createSkillMarketInstallPlan,
      {
        identity: entry.identity,
        target: { backendId: "pi", scope: contract.ResourceScope.GLOBAL }
      }
    );
    expect(planned.plan).toMatchObject({
      entry: { slug: "writer", version: "1.0.0" },
      preview: { action: contract.SkillMarketInstallAction.INSTALL, availableVersion: "1.0.0" },
      requiresConfirmation: false
    });
    expectPathPrivate(planned, fixture.root);

    fixture.connectionId = OTHER_CONNECTION_ID;
    await expect(invoke(fixture.services.skill.getSkillMarketInstallPlan, {
      planId: planned.plan!.planId
    })).rejects.toMatchObject({ code: 5 });
    fixture.connectionId = CONNECTION_ID;

    const installed = await submit(fixture, "install-market-plan", {
      case: "installSkillMarketPlan",
      value: create(contract.InstallSkillMarketPlanMutationSchema, {
        planId: planned.plan!.planId,
        expectedCandidateRevision: planned.plan!.preview!.candidateRevision,
        confirmReplacement: false
      })
    });
    expect(installed.operation?.result?.payload.case).toBe("skill");
    if (installed.operation?.result?.payload.case !== "skill") throw new Error("Expected installed Skill result.");
    const skill = installed.operation.result.payload.value.skill!;
    expect(skill).toMatchObject({ name: "writer", enabled: false });
    expect(fixture.resources.get(skill.skillId)).toMatchObject({ sourceKind: "skill_market", version: "1.0.0" });
    expect(fixture.refreshPiGeneration).toHaveBeenCalledTimes(1);
    const installedCatalog = await invoke<contract.ListSkillMarketCatalogResponse>(
      fixture.services.skill.listSkillMarketCatalog,
      { sort: contract.SkillMarketSort.UPDATED, page: { pageSize: 100 } }
    );
    expect(installedCatalog.entries[0]?.installStatuses).toMatchObject([{
      resourceId: skill.skillId,
      resourceRevision: skill.entityVersion?.revision,
      backendId: "pi",
      scope: contract.ResourceScope.GLOBAL,
      state: contract.SkillMarketInstallStatusState.INSTALLED,
      installedVersion: "1.0.0"
    }]);
    expectPathPrivate(installedCatalog, fixture.root);

    const enabled = await submit(fixture, "enable-market-sync", {
      case: "enableSkillMarketSync",
      value: create(contract.EnableSkillMarketSyncMutationSchema, {
        resourceId: skill.skillId,
        expectedResourceRevision: skill.entityVersion?.revision,
        target: { backendId: "pi", scope: contract.ResourceScope.GLOBAL }
      })
    });
    expect(enabled.operation?.state).toBe(contract.OperationState.SUCCEEDED);
    const policies = await invoke<contract.ListSkillMarketSyncPoliciesResponse>(
      fixture.services.skill.listSkillMarketSyncPolicies,
      { page: { pageSize: 100 } }
    );
    expect(policies.policies).toMatchObject([{
      resourceId: skill.skillId,
      enabled: true,
      baseline: { installedVersion: "1.0.0" }
    }]);
    expectPathPrivate(policies, fixture.root);

    const queued = await submit(fixture, "queue-market-sync", {
      case: "enqueueSkillMarketSync",
      value: create(contract.EnqueueSkillMarketSyncMutationSchema, {
        resourceId: skill.skillId,
        expectedPolicyRevision: policies.policies[0]!.revision
      })
    });
    expect(queued.operation?.state).toBe(contract.OperationState.SUCCEEDED);
    const job = fixture.sync.listJobs({ resourceId: skill.skillId })[0]!;
    await fixture.sync.wait(job.id);
    const projected = await invoke<contract.GetSkillMarketSyncJobResponse>(
      fixture.services.skill.getSkillMarketSyncJob,
      { jobId: job.id }
    );
    expect(projected.job).toMatchObject({
      state: contract.SkillMarketSyncJobState.UP_TO_DATE,
      outcome: contract.SkillMarketSyncOutcome.ALREADY_CURRENT,
      policyResourceId: skill.skillId
    });
    expectPathPrivate(projected, fixture.root);
  });
});

const CONNECTION_ID = "connection-skill-market";
const OTHER_CONNECTION_ID = "connection-skill-market-other";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-connect-skill-market-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "0.84.4",
    health: "healthy",
    adapterKind: "pi",
    instanceGeneration: 1,
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
  const resources = new PiResourceManager({ store, managedRoot: join(root, "managed") });
  await resources.initialize();
  const mutations = new SkillMutationCoordinator();
  const market = new SkillMarketManager({
    store,
    cacheRoot: join(root, "market-cache"),
    resources,
    mutationCoordinator: mutations
  });
  await market.initialize();
  const sync = new SkillMarketSyncManager({ store, resources, market });
  await sync.initialize();
  const sessionHost = new SessionHost(store, {} as never, []);
  const refreshPiGeneration = vi.fn(async () => undefined);
  const owner = store.createConnection({ id: CONNECTION_ID, name: "Market owner", authKeyDigest: "digest-market-owner" });
  const other = store.createConnection({ id: OTHER_CONNECTION_ID, name: "Market other", authKeyDigest: "digest-market-other" });
  const state = { connectionId: CONNECTION_ID };
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: {
      authenticate: () => state.connectionId === CONNECTION_ID ? owner : other,
      fence: () => undefined,
      onRevoked: () => () => undefined
    },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost,
    scheduler: {},
    adapters: [],
    piResources: resources,
    skillMarket: market,
    skillMarketSync: sync,
    refreshPiGeneration,
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  const services = createConnectServices(application);
  cleanups.push(async () => {
    await sync.close();
    await market.close();
    await sessionHost.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return Object.assign(state, { root, store, resources, market, sync, services, refreshPiGeneration });
}

async function writeMarket(
  fixtureRoot: string,
  marketName: string,
  entries: readonly { readonly slug: string; readonly name: string; readonly version: string; readonly content: string }[]
): Promise<string> {
  const sourceRoot = join(fixtureRoot, marketName);
  await mkdir(join(sourceRoot, ".agents", "skills"), { recursive: true });
  const manifestEntries = [];
  for (const entry of entries) {
    const packageRoot = join(fixtureRoot, `${marketName}-${entry.slug}-package`);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "SKILL.md"), entry.content, "utf8");
    await writeFile(join(packageRoot, "guide.md"), `${entry.name} guide.\n`, "utf8");
    const archivePath = join(sourceRoot, `${entry.slug}.tgz`);
    await createTarArchive(
      { file: archivePath, cwd: packageRoot, gzip: true, portable: true, prefix: "package/" },
      ["SKILL.md", "guide.md"]
    );
    const archive = await readFile(archivePath);
    manifestEntries.push({
      slug: entry.slug,
      name: entry.name,
      author: "Joko test",
      description: `${entry.name} description`,
      category: "Writing",
      tags: ["writing"],
      version: entry.version,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      downloads: 10,
      trendScore: 2,
      archive: `${entry.slug}.tgz`,
      compressedBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex")
    });
  }
  await writeFile(join(sourceRoot, ".agents", "skills", "marketplace.json"), `${JSON.stringify({
    format: 1,
    name: marketName,
    displayName: `${marketName} display`,
    entries: manifestEntries
  }, null, 2)}\n`, "utf8");
  return sourceRoot;
}

async function submit(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  operationId: string,
  payload: contract.OperationMutation["payload"]
): Promise<contract.SubmitOperationResponse> {
  return invoke(fixture.services.operation.submitOperation, {
    operationId,
    connectionId: fixture.connectionId,
    mutation: create(contract.OperationMutationSchema, { payload })
  });
}

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (input: unknown, context: unknown) => T | Promise<T>)(request, {
    requestHeader: new Headers(),
    signal: new AbortController().signal
  });
}

function expectPathPrivate(value: unknown, root: string): void {
  const serialized = JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
  expect(serialized).not.toContain(root);
  expect(serialized).not.toContain(root.replaceAll("\\", "\\\\"));
}
