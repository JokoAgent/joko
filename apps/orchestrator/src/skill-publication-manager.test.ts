import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { SkillMarketManager } from "./skill-market-manager.js";
import {
  SkillPublicationManager,
  skillPublicationJobId,
  type SkillPublicationJob,
  type SkillPublicationManagerOptions
} from "./skill-publication-manager.js";
import { PiResourceManager } from "./resource-manager.js";
import { CollaborationManager } from "./collaboration-manager.js";
import { mkdtemp } from "./test-paths.js";

const roots: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })));
});

describe("SkillPublicationManager", () => {
  it("publishes a real installed Skill through durable phases and makes its staged version immediately installable", async () => {
    const phases: string[] = [];
    const f = await fixture({ afterStatePersisted: (job) => { phases.push(job.state); } });
    const preview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    expect(preview).toMatchObject({
      mode: "first",
      suggestedSlug: "sample-skill",
      suggestedVersion: "1.0.0",
      personalPublisherAvailable: true,
      teamPublisherAvailable: false,
      publicVisibilityAvailable: true,
      departmentVisibilityAvailable: false,
      privateVisibilityAvailable: true
    });
    expect(stringifyWithBigInts(preview)).not.toContain(f.root);

    const job = await startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      author: "Joko test",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-first");
    f.publisher.begin(job.id);
    const completed = await f.publisher.wait(job.id);
    expect(completed).toMatchObject({
      state: "published",
      verdict: "passed",
      result: { version: "1.0.0" },
      cancellable: false
    });
    expect(completed.gates.every((gate) => gate.status === "passed")).toBe(true);
    expect(phases).toEqual(expect.arrayContaining(["snapshotting", "packaging", "scanning", "committing", "published"]));

    const entry = f.market.listCatalog({
      expectedRevision: completed.result!.sourceRevision,
      sort: "updated",
      offset: 0,
      pageSize: 10
    }).items[0]!;
    const marketPreview = await f.market.openPreview("connection-publication", {
      sourceId: entry.sourceId,
      sourceRevision: entry.sourceRevision,
      entryId: entry.id,
      entryRevision: entry.revision,
      contentRevision: entry.contentRevision
    });
    const manifest = await f.market.readPreviewFile({
      connectionId: "connection-publication",
      previewId: marketPreview.id,
      expectedSnapshotRevision: marketPreview.snapshotRevision,
      key: "SKILL.md"
    });
    expect(manifest.content).toContain("version: 1.0.0");
    expect(await readFile(join(f.skillSource, "SKILL.md"), "utf8")).not.toContain("version:");
  });

  it("blocks a sensitive path with a bounded machine verdict and leaves the source unchanged", async () => {
    const f = await fixture({ sensitive: true });
    const preview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    const job = await startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-sensitive");
    f.publisher.begin(job.id);
    const completed = await f.publisher.wait(job.id);
    expect(completed).toMatchObject({ state: "blocked", verdict: "blocked" });
    expect(completed.gates.find((gate) => gate.id === "sensitive_content")).toMatchObject({
      status: "blocked",
      issues: [{ code: "SENSITIVE_PATH", path: ".env" }]
    });
    expect(f.market.snapshot()).toMatchObject({ revision: 1n, sources: [{ entryCount: 0 }] });
    expect(stringifyWithBigInts(completed)).not.toContain("actual-secret-value");
  });

  it("cancels during packaging before final switch and resumes a persisted pending job after process restart", async () => {
    let publisher: SkillPublicationManager | undefined;
    let cancelled = false;
    const f = await fixture({
      afterStatePersisted: async (job) => {
        if (!cancelled && job.state === "packaging") {
          cancelled = true;
          await publisher!.cancel(job.id, job.revision);
        }
      }
    });
    publisher = f.publisher;
    const preview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    const cancelledJob = await startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-cancel");
    f.publisher.begin(cancelledJob.id);
    await expect(f.publisher.wait(cancelledJob.id)).resolves.toMatchObject({ state: "cancelled" });
    expect(f.market.snapshot()).toMatchObject({ revision: 1n, sources: [{ entryCount: 0 }] });

    const pending = await startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-restart");
    await f.publisher.close();
    await f.market.close();
    f.store.close();
    closers.splice(closers.indexOf(f.close), 1);

    const store = new OperationalStore(f.databasePath);
    const resources = new PiResourceManager({ store, managedRoot: f.managedRoot });
    await resources.initialize();
    const collaboration = new CollaborationManager({ store });
    collaboration.initialize();
    const market = new SkillMarketManager({ store, cacheRoot: f.marketCache, resources, collaboration });
    await market.initialize();
    const reopened = new SkillPublicationManager({
      store,
      resources,
      market,
      collaboration,
      rootDirectory: f.publicationRoot
    });
    await reopened.initialize();
    closers.push(async () => {
      await reopened.close();
      await market.close();
      store.close();
    });
    await expect(reopened.wait(pending.id)).resolves.toMatchObject({ state: "published", result: { version: "1.0.0" } });
  });

  it("enforces later-version metadata while preserving the first category and creation identity", async () => {
    const f = await fixture();
    const firstPreview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    const first = await startFromPreview(f.publisher, firstPreview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      category: "Writing",
      tags: ["review"],
      version: "1.0.0"
    }, "publish-version-first");
    await expect(startFromPreview(f.publisher, firstPreview, first.metadata, "publish-concurrent"))
      .rejects.toThrow("active publication");
    f.publisher.begin(first.id);
    const firstCompleted = await f.publisher.wait(first.id);
    const firstEntry = f.market.getCurrentEntry(firstCompleted.result!.sourceId, firstCompleted.result!.entryId);

    const nextPreview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: firstCompleted.result!.sourceId,
      expectedSourceRevision: firstCompleted.result!.sourceRevision,
      slug: "sample-skill"
    });
    expect(nextPreview).toMatchObject({
      mode: "version",
      suggestedVersion: "1.0.1",
      existingEntry: { id: firstCompleted.result!.entryId, version: "1.0.0" }
    });
    await expect(startFromPreview(f.publisher, nextPreview, {
      ...first.metadata,
      version: "1.0.0",
      changelog: "Same version."
    }, "publish-same-version")).rejects.toThrow("greater than 1.0.0");
    await expect(startFromPreview(f.publisher, nextPreview, {
      ...first.metadata,
      version: "0.9.0",
      changelog: "Lower version."
    }, "publish-lower-version")).rejects.toThrow("greater than 1.0.0");
    await expect(startFromPreview(f.publisher, nextPreview, {
      ...first.metadata,
      version: "1.0.1"
    }, "publish-missing-changelog")).rejects.toThrow("changelog is required");

    const next = await startFromPreview(f.publisher, nextPreview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A more useful sample.",
      tags: [],
      version: "1.0.1",
      changelog: "Improve the exact instructions."
    }, "publish-version-next");
    f.publisher.begin(next.id);
    const completed = await f.publisher.wait(next.id);
    const entry = f.market.getCurrentEntry(completed.result!.sourceId, completed.result!.entryId);
    expect(entry).toMatchObject({
      id: firstEntry.id,
      revision: 2n,
      version: "1.0.1",
      category: "Writing",
      tags: [],
      createdAt: firstEntry.createdAt,
      changelog: "Improve the exact instructions."
    });
  });

  it("blocks a changed local destination at the source-authority gate, then reuses the uncommitted version on retry", async () => {
    const f = await fixture();
    const manifestPath = join(f.marketRoot, ".agents", "skills", "marketplace.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const preview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    const first = await startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-source-drift");
    await writeFile(manifestPath, `${originalManifest}\n`, "utf8");
    f.publisher.begin(first.id);
    const blocked = await f.publisher.wait(first.id);
    expect(blocked).toMatchObject({ state: "blocked", verdict: "blocked" });
    expect(blocked.gates.find((gate) => gate.id === "source_authority")).toMatchObject({
      status: "blocked",
      issues: [{ code: "SOURCE_AUTHORITY_CHANGED" }]
    });
    expect(f.market.snapshot()).toMatchObject({ revision: 1n, sources: [{ entryCount: 0 }] });

    await writeFile(manifestPath, originalManifest, "utf8");
    const retry = await f.publisher.retry(
      blocked.id,
      blocked.revision,
      skillPublicationJobId("publish-source-drift-retry")
    );
    f.publisher.begin(retry.id);
    await expect(f.publisher.wait(retry.id)).resolves.toMatchObject({
      state: "published",
      attempt: 2,
      retryOfJobId: blocked.id,
      result: { version: "1.0.0" }
    });
  });

  it("streams large UTF-8 assets through the sensitive-material gate without exposing the matched value", async () => {
    const secret = "password=abcdefghijklmnopqrstuvwxyz012345";
    const large = Buffer.concat([Buffer.alloc(2 * 1024 * 1024 + 128, 0x78), Buffer.from(`\n${secret}\n`, "utf8")]);
    const f = await fixture({ files: { "references/large.txt": large } });
    const preview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    const job = await startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-large-secret");
    f.publisher.begin(job.id);
    const blocked = await f.publisher.wait(job.id);
    expect(blocked.gates.find((gate) => gate.id === "sensitive_content")).toMatchObject({
      status: "blocked",
      issues: [{ code: "SECRET_MATERIAL", path: "references/large.txt" }]
    });
    expect(stringifyWithBigInts(blocked)).not.toContain(secret);
  });

  it.each(["pending", "snapshotting", "scanning", "committing"] as const)(
    "cancels during %s without changing the source manifest or catalog",
    async (phase) => {
      let publisher: SkillPublicationManager | undefined;
      let requested = false;
      const f = await fixture({
        afterStatePersisted: async (job) => {
          if (!requested && job.state === phase) {
            requested = true;
            await publisher!.cancel(job.id, job.revision);
          }
        }
      });
      publisher = f.publisher;
      const manifestPath = join(f.marketRoot, ".agents", "skills", "marketplace.json");
      const manifest = await readFile(manifestPath, "utf8");
      const preview = await f.publisher.preview({
        resourceId: f.resource.id,
        expectedResourceRevision: f.resource.versionNumber,
        sourceId: f.source.id,
        expectedSourceRevision: f.source.revision
      });
      const job = await startFromPreview(f.publisher, preview, {
        slug: "sample-skill",
        name: "Sample Skill",
        description: "A useful sample.",
        tags: [],
        version: "1.0.0"
      }, `publish-cancel-${phase}`);
      if (phase === "pending") await f.publisher.cancel(job.id, job.revision);
      else f.publisher.begin(job.id);
      await expect(f.publisher.wait(job.id)).resolves.toMatchObject({ state: "cancelled", cancellable: false });
      expect(await readFile(manifestPath, "utf8")).toBe(manifest);
      expect(await readdir(join(f.marketRoot, ".agents", "skills"))).toEqual(["marketplace.json"]);
      expect(f.market.snapshot()).toMatchObject({ revision: 1n, sources: [{ entryCount: 0 }] });
    }
  );

  it("rejects a package-owned Skill before acquiring publication content", async () => {
    const f = await fixture();
    let acquired = false;
    const resources = {
      get: () => ({ ...f.resource, sourceKind: "npm" as const }),
      acquireSkillContent: async (...args: Parameters<PiResourceManager["acquireSkillContent"]>) => {
        acquired = true;
        return f.resources.acquireSkillContent(...args);
      },
      get maximumFiles() { return f.resources.maximumFiles; },
      get maximumBytes() { return f.resources.maximumBytes; }
    } as unknown as PiResourceManager;
    const publisher = new SkillPublicationManager({
      store: f.store,
      resources,
      market: f.market,
      collaboration: f.collaboration,
      rootDirectory: join(f.root, "package-publications"),
      scopeId: "package-publication"
    });
    await publisher.initialize();
    closers.push(() => publisher.close());
    await expect(publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    })).rejects.toThrow("independently managed local Skills");
    expect(acquired).toBe(false);
  });

  it("rejects Resource entity drift before creating a durable publication job", async () => {
    const f = await fixture();
    const preview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    await f.resources.setEnabled(f.resource.id, true);
    await expect(startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-resource-drift")).rejects.toThrow(/changed|revision/iu);
    expect(f.publisher.list()).toEqual([]);
  });

  it("keeps a final-switched job reconciling through Store failure and completes it after restart", async () => {
    let failNextTransaction = false;
    let failures = 2;
    const f = await fixture({
      afterStatePersisted: (current) => {
        if (failures > 0 && (current.state === "committing" || current.state === "reconciling")) {
          failNextTransaction = true;
        }
      }
    });
    const preview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    const job = await startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-reconcile-restart");
    const originalTransaction = f.store.transaction.bind(f.store);
    f.store.transaction = <T>(callback: (store: OperationalStore) => T): T => {
      if (failNextTransaction) {
        failNextTransaction = false;
        failures -= 1;
        throw new Error("simulated publication Store interruption");
      }
      return originalTransaction(callback);
    };
    f.publisher.begin(job.id);
    const interrupted = await f.publisher.wait(job.id);
    expect(interrupted).toMatchObject({ state: "reconciling", cancellable: false });
    await expect(f.publisher.cancel(interrupted.id, interrupted.revision)).rejects.toThrow("must finish reconciliation");

    f.store.transaction = originalTransaction;
    await f.publisher.close();
    await f.market.close();
    f.store.close();
    closers.splice(closers.indexOf(f.close), 1);

    const store = new OperationalStore(f.databasePath);
    const resources = new PiResourceManager({ store, managedRoot: f.managedRoot });
    await resources.initialize();
    const collaboration = new CollaborationManager({ store });
    collaboration.initialize();
    const market = new SkillMarketManager({ store, cacheRoot: f.marketCache, resources, collaboration });
    await market.initialize();
    const publisher = new SkillPublicationManager({
      store,
      resources,
      market,
      collaboration,
      rootDirectory: f.publicationRoot
    });
    await publisher.initialize();
    closers.push(async () => {
      await publisher.close();
      await market.close();
      store.close();
    });
    const completed = await publisher.wait(job.id);
    expect(completed).toMatchObject({ state: "published", verdict: "passed", result: { version: "1.0.0" } });
    expect(market.getCurrentEntry(completed.result!.sourceId, completed.result!.entryId)).toMatchObject({ version: "1.0.0" });
  });

  it("retains a completed publication as durable history after a clean restart", async () => {
    const f = await fixture();
    const preview = await f.publisher.preview({
      resourceId: f.resource.id,
      expectedResourceRevision: f.resource.versionNumber,
      sourceId: f.source.id,
      expectedSourceRevision: f.source.revision
    });
    const job = await startFromPreview(f.publisher, preview, {
      slug: "sample-skill",
      name: "Sample Skill",
      description: "A useful sample.",
      tags: [],
      version: "1.0.0"
    }, "publish-clean-restart");
    f.publisher.begin(job.id);
    const published = await f.publisher.wait(job.id);
    await f.publisher.close();
    await f.market.close();
    f.store.close();
    closers.splice(closers.indexOf(f.close), 1);

    const store = new OperationalStore(f.databasePath);
    const resources = new PiResourceManager({ store, managedRoot: f.managedRoot });
    await resources.initialize();
    const collaboration = new CollaborationManager({ store });
    collaboration.initialize();
    const market = new SkillMarketManager({ store, cacheRoot: f.marketCache, resources, collaboration });
    await market.initialize();
    const publisher = new SkillPublicationManager({
      store,
      resources,
      market,
      collaboration,
      rootDirectory: f.publicationRoot
    });
    await publisher.initialize();
    closers.push(async () => {
      await publisher.close();
      await market.close();
      store.close();
    });
    expect(publisher.recoveredFromCorruption).toBe(false);
    expect(publisher.list()).toMatchObject([{
      id: published.id,
      state: "published",
      result: { version: "1.0.0" }
    }]);
  });
});

async function fixture(options: {
  readonly sensitive?: boolean;
  readonly files?: Readonly<Record<string, string | Buffer>>;
  readonly afterStatePersisted?: SkillPublicationManagerOptions["afterStatePersisted"];
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-skill-publication-"));
  roots.push(root);
  const databasePath = join(root, "operational.sqlite");
  const managedRoot = join(root, "managed");
  const marketCache = join(root, "market-cache");
  const publicationRoot = join(root, "publications");
  const store = new OperationalStore(databasePath);
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
  const resources = new PiResourceManager({ store, managedRoot });
  await resources.initialize();
  const skillSource = join(root, "skill-source");
  await mkdir(skillSource, { recursive: true });
  await writeFile(join(skillSource, "SKILL.md"), "---\nname: sample-skill\ndescription: A useful sample\n---\n# Sample\n", "utf8");
  if (options.sensitive) await writeFile(join(skillSource, ".env"), "API_KEY=actual-secret-value\n", "utf8");
  for (const [key, content] of Object.entries(options.files ?? {})) {
    const path = join(skillSource, ...key.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const discovered = await resources.discover({
    id: "skill-global-sample",
    backendId: "pi",
    kind: "skill",
    scope: "managed",
    source: { kind: "local", path: skillSource },
    name: "sample-skill"
  });
  const approved = await resources.approve(discovered.id, discovered.discoveredRevision, "connection-publication");
  const resource = await resources.install(approved.id);
  const marketRoot = join(root, "local-market");
  await mkdir(join(marketRoot, ".agents", "skills"), { recursive: true });
  await writeFile(join(marketRoot, ".agents", "skills", "marketplace.json"), `${JSON.stringify({
    format: 1,
    name: "local-publishing",
    displayName: "Local publishing",
    entries: []
  }, undefined, 2)}\n`, "utf8");
  const collaboration = new CollaborationManager({ store, idFactory: () => "publication-test-actor" });
  collaboration.initialize();
  const market = new SkillMarketManager({ store, cacheRoot: marketCache, resources, collaboration });
  await market.initialize();
  const source = await market.add({ kind: "local", path: marketRoot }, 0n);
  const publication = new SkillPublicationManager({
    store,
    resources,
    market,
    collaboration,
    rootDirectory: publicationRoot,
    ...(options.afterStatePersisted === undefined ? {} : { afterStatePersisted: options.afterStatePersisted })
  });
  await publication.initialize();
  const close = async () => {
    await publication.close();
    await market.close();
    try { store.close(); } catch { /* already closed */ }
  };
  closers.push(close);
  return {
    root,
    databasePath,
    managedRoot,
    marketCache,
    publicationRoot,
    marketRoot,
    store,
    resources,
    skillSource,
    market,
    collaboration,
    source,
    publisher: publication,
    resource,
    close
  };
}

async function startFromPreview(
  publisher: SkillPublicationManager,
  preview: Awaited<ReturnType<SkillPublicationManager["preview"]>>,
  metadata: Parameters<SkillPublicationManager["start"]>[0]["metadata"],
  seed: string
): Promise<SkillPublicationJob> {
  return publisher.start({
    jobId: skillPublicationJobId(seed),
    resourceId: preview.authority.resourceId,
    expectedResourceRevision: preview.authority.resourceRevision,
    expectedObservedRevision: preview.authority.observedRevision,
    sourceId: preview.authority.sourceId,
    expectedSourceRevision: preview.authority.sourceRevision,
    expectedSourceContentRevision: preview.authority.sourceContentRevision,
    ...(preview.authority.existingEntryId === undefined ? {} : { expectedExistingEntryId: preview.authority.existingEntryId }),
    expectedCollaborationRevision: preview.collaborationRevision,
    metadata,
    publisher: "personal",
    visibility: "public",
    audienceScopeIds: []
  });
}

function stringifyWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested);
}
