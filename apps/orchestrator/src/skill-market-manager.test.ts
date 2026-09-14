import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { OperationalStore } from "@joko/store";
import { create as createTarArchive } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SkillMarketError,
  SkillMarketManager,
  type SkillMarketEntryIdentity,
  type SkillMarketGitExecutor,
  type SkillMarketPublicationIntent
} from "./skill-market-manager.js";
import type { SkillAccessPolicy } from "./collaboration-manager.js";

const roots: string[] = [];
const stores: OperationalStore[] = [];

function personalAccess(): SkillAccessPolicy {
  return {
    revision: 1n,
    publisher: { kind: "personal", actorId: "collaboration_actor_test" },
    visibility: "public",
    audienceScopeIds: []
  };
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* already closed */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SkillMarketManager", () => {
  it("adds a real local source and provides fenced catalog, detail, and connection-private file preview", async () => {
    const fixture = await createFixture();
    const sourceRoot = await createMarketSource(fixture.root, "alpha", [{
      slug: "writer",
      name: "Writing helper",
      version: "1.0.0",
      category: "Writing",
      downloads: 12,
      trendScore: 4,
      files: {
        "SKILL.md": "---\nname: writer\n---\nWrite clearly.\n",
        "references/guide.md": "A concise guide.\n",
        "assets/data.bin": Buffer.from([0, 255, 1])
      }
    }, {
      slug: "reviewer",
      name: "Review helper",
      version: "2.0.0",
      category: "Engineering",
      downloads: 200,
      trendScore: 2,
      files: { "SKILL.md": "Review carefully.\n" }
    }]);

    const source = await fixture.manager.add({ kind: "local", path: sourceRoot }, 0n);
    expect(source).toMatchObject({ revision: 1n, kind: "local", name: "alpha", state: "ready", entryCount: 2 });
    expect(source.display).toBe(basename(sourceRoot));
    expect(publicJson(source)).not.toContain(sourceRoot);

    const page = fixture.manager.listCatalog({ expectedRevision: 1n, query: "writing", category: "Writing", sort: "downloads", offset: 0, pageSize: 1 });
    expect(page).toMatchObject({ revision: 1n, total: 1, sourceCount: 1, categories: ["Engineering", "Writing"] });
    expect(page.items[0]).toMatchObject({ slug: "writer", version: "1.0.0", sourceRevision: 1n });
    expect(page.nextOffset).toBeUndefined();
    expect(() => fixture.manager.listCatalog({ expectedRevision: 0n, sort: "created", offset: 0, pageSize: 10 }))
      .toThrowError(expect.objectContaining({ code: "CATALOG_CHANGED" }));

    const entry = page.items[0]!;
    const identity = entryIdentity(entry);
    expect(fixture.manager.getEntry(identity)).toEqual(entry);
    const preview = await fixture.manager.openPreview("connection-a", identity);
    expect(preview).toMatchObject({ entry: { id: entry.id }, files: 3 });
    expect(publicJson(preview)).not.toContain(sourceRoot);

    const firstFiles = await fixture.manager.listPreviewFiles({
      connectionId: "connection-a",
      previewId: preview.id,
      expectedSnapshotRevision: preview.snapshotRevision,
      offset: 0,
      pageSize: 2
    });
    expect(firstFiles.total).toBe(5);
    expect(firstFiles.items).toHaveLength(2);
    expect(firstFiles.nextOffset).toBe(2);
    await expect(fixture.manager.listPreviewFiles({
      connectionId: "connection-b",
      previewId: preview.id,
      expectedSnapshotRevision: preview.snapshotRevision,
      offset: 0,
      pageSize: 10
    })).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });

    await expect(fixture.manager.readPreviewFile({
      connectionId: "connection-a",
      previewId: preview.id,
      expectedSnapshotRevision: preview.snapshotRevision,
      key: "references/guide.md"
    })).resolves.toMatchObject({ previewable: true, content: "A concise guide.\n" });
    await expect(fixture.manager.readPreviewFile({
      connectionId: "connection-a",
      previewId: preview.id,
      expectedSnapshotRevision: preview.snapshotRevision,
      key: "assets/data.bin"
    })).resolves.toMatchObject({ previewable: false, unavailableReason: "BINARY" });
    await fixture.manager.closeConnection("connection-a");
    await expect(fixture.manager.listPreviewFiles({
      connectionId: "connection-a",
      previewId: preview.id,
      expectedSnapshotRevision: preview.snapshotRevision,
      offset: 0,
      pageSize: 10
    })).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
  });

  it("keeps the last good catalog on refresh failure and monotonically revisions a stable entry identity", async () => {
    const fixture = await createFixture();
    const sourceRoot = await createMarketSource(fixture.root, "updates", [{
      slug: "writer",
      name: "Writer",
      version: "1.0.0",
      category: "Writing",
      files: { "SKILL.md": "Version one.\n" }
    }]);
    const source = await fixture.manager.add({ kind: "local", path: sourceRoot }, 0n);
    const original = fixture.manager.listCatalog({ expectedRevision: 1n, sort: "updated", offset: 0, pageSize: 10 }).items[0]!;
    const stalePreview = await fixture.manager.openPreview("connection-a", entryIdentity(original));

    await createMarketSource(fixture.root, "updates", [{
      slug: "writer",
      name: "Writer",
      version: "1.1.0",
      category: "Writing",
      files: { "SKILL.md": "Version two.\n" }
    }], sourceRoot);
    const refreshed = await fixture.manager.refresh(source.id, source.revision);
    expect(refreshed.revision).toBe(2n);
    const updated = fixture.manager.listCatalog({ expectedRevision: 2n, sort: "updated", offset: 0, pageSize: 10 }).items[0]!;
    expect(updated).toMatchObject({ id: original.id, revision: 2n, version: "1.1.0" });
    await expect(fixture.manager.listPreviewFiles({
      connectionId: "connection-a",
      previewId: stalePreview.id,
      expectedSnapshotRevision: stalePreview.snapshotRevision,
      offset: 0,
      pageSize: 10
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });

    const manifestPath = join(sourceRoot, ".agents", "skills", "marketplace.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: Array<{ sha256: string }> };
    manifest.entries[0]!.sha256 = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(fixture.manager.refresh(source.id, 2n)).rejects.toMatchObject({ code: "SOURCE_ARCHIVE_INVALID" });
    const failed = fixture.manager.snapshot();
    expect(failed).toMatchObject({ revision: 3n, sources: [{ id: source.id, revision: 3n, state: "error", entryCount: 1 }] });
    const retained = fixture.manager.listCatalog({ expectedRevision: 3n, sort: "updated", offset: 0, pageSize: 10 }).items[0]!;
    expect(retained).toMatchObject({ id: original.id, revision: 2n, version: "1.1.0", sourceState: "error" });
    const retainedLease = await fixture.manager.acquireEntry({ ...entryIdentity(retained), sourceRevision: 3n });
    retainedLease.release();
  });

  it.each([
    ["backslash path", [{ path: "package\\SKILL.md", type: "0", content: Buffer.from("bad") }]],
    ["symbolic link", [{ path: "package/SKILL.md", type: "2", content: Buffer.alloc(0) }]],
    ["missing manifest", [{ path: "package/readme.md", type: "0", content: Buffer.from("bad") }]],
    ["path traversal", [{ path: "package/../SKILL.md", type: "0", content: Buffer.from("bad") }]],
    ["special file", [{ path: "package/SKILL.md", type: "6", content: Buffer.alloc(0) }]]
  ])("rejects an archive with %s", async (_label, rawEntries) => {
    const fixture = await createFixture();
    const sourceRoot = join(fixture.root, `bad-${String(_label).replaceAll(" ", "-")}`);
    await mkdir(join(sourceRoot, ".agents", "skills"), { recursive: true });
    const archive = join(sourceRoot, "bad.tgz");
    await writeFile(archive, makeRawTgz(rawEntries));
    const bytes = await readFile(archive);
    await writeManifest(sourceRoot, "bad", [{
      slug: "bad",
      name: "Bad",
      version: "1.0.0",
      category: "Testing",
      archive: "bad.tgz",
      compressedBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }]);
    await expect(fixture.manager.add({ kind: "local", path: sourceRoot }, 0n)).rejects.toMatchObject({ code: "SOURCE_ARCHIVE_INVALID" });
    expect(fixture.manager.snapshot()).toMatchObject({ revision: 0n, sources: [] });
  });

  it("holds an immutable Git generation until its exact entry lease releases and survives store restart", async () => {
    let revision = "a".repeat(40);
    let remoteRoot = "";
    const git: SkillMarketGitExecutor = async (args, options) => {
      if (args[0] === "--version") return { stdout: "git version 2.45.1\n", stderr: "" };
      if (args[0] === "clone") {
        const destination = args.at(-1)!;
        await cp(remoteRoot, destination, { recursive: true });
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse") return { stdout: `${revision}\n`, stderr: "" };
      if (args[0] === "checkout" || args[0] === "sparse-checkout") return { stdout: "", stderr: "" };
      throw new Error(`unexpected git call ${args.join(" ")} in ${options.cwd ?? ""}`);
    };
    const fixture = await createFixture({ git });
    remoteRoot = await createMarketSource(fixture.root, "git-market", [{
      slug: "one",
      name: "One",
      version: "1.0.0",
      category: "General",
      files: { "SKILL.md": "One.\n" }
    }]);
    const manager = fixture.manager;
    const source = await manager.add({ kind: "git", repositoryUrl: "https://example.invalid/skills.git", sparsePaths: [] }, 0n);
    const entry = manager.listCatalog({ expectedRevision: 1n, sort: "created", offset: 0, pageSize: 10 }).items[0]!;
    const lease = await manager.acquireEntry(entryIdentity(entry));
    const firstVersions = await generationDirectories(fixture.cacheRoot);
    expect(firstVersions).toHaveLength(1);

    await createMarketSource(fixture.root, "git-market", [{
      slug: "one",
      name: "One",
      version: "1.1.0",
      category: "General",
      files: { "SKILL.md": "Two.\n" }
    }], remoteRoot);
    revision = "b".repeat(40);
    await manager.refresh(source.id, 1n);
    expect(await generationDirectories(fixture.cacheRoot)).toHaveLength(2);
    await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    lease.release();
    await vi.waitFor(async () => expect(await generationDirectories(fixture.cacheRoot)).toHaveLength(1));

    await manager.close();
    fixture.store.close();
    const reopenedStore = new OperationalStore(fixture.databasePath);
    const reopened = new SkillMarketManager({ store: reopenedStore, cacheRoot: fixture.cacheRoot, git });
    await reopened.initialize();
    expect(reopened.snapshot()).toMatchObject({ revision: 2n, sources: [{ id: source.id, revision: 2n, state: "ready" }] });
    expect(reopened.listCatalog({ expectedRevision: 2n, sort: "updated", offset: 0, pageSize: 10 }).items[0]).toMatchObject({ version: "1.1.0", revision: 2n });
    await reopened.remove(source.id, 2n);
    expect(reopened.snapshot()).toMatchObject({ revision: 3n, sources: [] });
    await reopened.close();
    reopenedStore.close();
  });

  it("expires previews and rejects duplicate sources without leaking local paths", async () => {
    let now = 1_000;
    const fixture = await createFixture({ now: () => now, previewTtlMs: 1_000 });
    const sourceRoot = await createMarketSource(fixture.root, "expiry", [{
      slug: "one",
      name: "One",
      version: "1.0.0",
      category: "General",
      files: { "SKILL.md": "One.\n" }
    }]);
    await fixture.manager.add({ kind: "local", path: sourceRoot }, 0n);
    await expect(fixture.manager.add({ kind: "local", path: sourceRoot }, 1n)).rejects.toMatchObject({ code: "SOURCE_DUPLICATE" });
    const entry = fixture.manager.listCatalog({ expectedRevision: 1n, sort: "trending", offset: 0, pageSize: 10 }).items[0]!;
    const preview = await fixture.manager.openPreview("connection-a", entryIdentity(entry));
    now = 2_000;
    await expect(fixture.manager.listPreviewFiles({
      connectionId: "connection-a",
      previewId: preview.id,
      expectedSnapshotRevision: preview.snapshotRevision,
      offset: 0,
      pageSize: 10
    })).rejects.toMatchObject({ code: "PREVIEW_NOT_FOUND" });
  });

  it("publishes first and later versions into an exact local source and adopts the job atomically with the catalog", async () => {
    let now = Date.parse("2026-03-01T00:00:00Z");
    const fixture = await createFixture({ now: () => now });
    const sourceRoot = await createMarketSource(fixture.root, "published", []);
    const source = await fixture.manager.add({ kind: "local", path: sourceRoot }, 0n);
    const firstArchive = await createPublicationArchive(fixture.root, "first", {
      "SKILL.md": "---\nname: writer\nversion: 1.0.0\n---\nWrite clearly.\n"
    });
    let firstIntent: SkillMarketPublicationIntent | undefined;
    const first = await fixture.manager.commitLocalPublication({
      jobId: `skill_publication_${"1".repeat(32)}`,
      sourceId: source.id,
      expectedSourceRevision: source.revision,
      expectedSourceContentRevision: source.contentRevision,
      metadata: {
        slug: "writer",
        name: "Writer",
        author: "Joko test",
        description: "Writes clearly.",
        tags: [],
        version: "1.0.0"
      },
      access: personalAccess(),
      ...firstArchive
    }, {
      beforeSwitch: (intent) => {
        firstIntent = intent;
        fixture.store.setSetting("service", "test", "publication_intent", intent);
      },
      finalize: (store, result) => {
        store.setSetting("service", "test", "publication_result", { entryId: result.entry.id });
        return "adopted";
      }
    });
    expect(first.value).toBe("adopted");
    expect(firstIntent).toBeDefined();
    expect(first.result).toMatchObject({
      source: { revision: 2n, entryCount: 1 },
      entry: { slug: "writer", version: "1.0.0", tags: [], revision: 1n }
    });
    expect(first.result.entry.category).toBeUndefined();
    expect(fixture.store.findSetting("service", "test", "publication_result")?.value).toEqual({ entryId: first.result.entry.id });
    const firstCreatedAt = first.result.entry.createdAt;

    now = Date.parse("2026-04-01T00:00:00Z");
    const secondArchive = await createPublicationArchive(fixture.root, "second", {
      "SKILL.md": "---\nname: writer\nversion: 1.1.0\n---\nWrite even more clearly.\n"
    });
    const second = await fixture.manager.commitLocalPublication({
      jobId: `skill_publication_${"2".repeat(32)}`,
      sourceId: first.result.source.id,
      expectedSourceRevision: first.result.source.revision,
      expectedSourceContentRevision: first.result.source.contentRevision,
      expectedExistingEntryId: first.result.entry.id,
      metadata: {
        slug: "writer",
        name: "Writer",
        author: "Joko test",
        description: "Writes even more clearly.",
        tags: [],
        version: "1.1.0",
        changelog: "Improve the writing guidance."
      },
      access: personalAccess(),
      ...secondArchive
    }, {
      beforeSwitch: () => undefined,
      finalize: (_store, result) => result.entry.version
    });
    expect(second.value).toBe("1.1.0");
    expect(second.result.entry).toMatchObject({
      id: first.result.entry.id,
      revision: 2n,
      version: "1.1.0",
      changelog: "Improve the writing guidance.",
      createdAt: firstCreatedAt,
      updatedAt: now
    });
    const manifest = JSON.parse(await readFile(join(sourceRoot, ".agents", "skills", "marketplace.json"), "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(manifest.entries).toEqual([expect.objectContaining({
      slug: "writer",
      version: "1.1.0",
      changelog: "Improve the writing guidance."
    })]);
    expect(await readdir(join(sourceRoot, "archives", "writer"))).toHaveLength(2);
  });

  it("recovers a final-switched local publication without reacquiring its original private archive", async () => {
    const fixture = await createFixture();
    const sourceRoot = await createMarketSource(fixture.root, "recovery", []);
    const source = await fixture.manager.add({ kind: "local", path: sourceRoot }, 0n);
    const archive = await createPublicationArchive(fixture.root, "recover", {
      "SKILL.md": "---\nname: recovered\nversion: 1.0.0\n---\nRecovered.\n"
    });
    const metadata = {
      slug: "recovered",
      name: "Recovered",
      description: "Recovered Skill.",
      tags: ["recovery"],
      version: "1.0.0"
    } as const;
    let intent: SkillMarketPublicationIntent | undefined;
    await expect(fixture.manager.commitLocalPublication({
      jobId: `skill_publication_${"3".repeat(32)}`,
      sourceId: source.id,
      expectedSourceRevision: source.revision,
      expectedSourceContentRevision: source.contentRevision,
      metadata,
      access: personalAccess(),
      ...archive
    }, {
      beforeSwitch: (value) => { intent = value; },
      afterFinalSwitch: () => { throw new Error("simulated process loss after manifest switch"); },
      finalize: () => undefined
    })).rejects.toThrow("simulated process loss");
    expect(fixture.manager.snapshot()).toMatchObject({ revision: 1n, sources: [{ entryCount: 0 }] });

    const recovered = await fixture.manager.recoverLocalPublication({
      jobId: `skill_publication_${"3".repeat(32)}`,
      sourceId: source.id,
      expectedSourceContentRevision: source.contentRevision,
      metadata,
      access: personalAccess(),
      intent: intent!
    }, (store, result) => {
      store.setSetting("service", "test", "recovered_publication", { entryId: result.entry.id });
      return true;
    });
    expect(recovered).toMatchObject({ committed: true, value: true, result: { entry: { slug: "recovered", version: "1.0.0" } } });
    expect(fixture.manager.snapshot()).toMatchObject({ revision: 2n, sources: [{ entryCount: 1 }] });
    expect(await readdir(join(sourceRoot, ".agents", "skills"))).toEqual(["marketplace.json"]);
  });

  it("removes a pre-final archive but preserves a conflicting recovery file for diagnosis", async () => {
    const fixture = await createFixture();
    const sourceRoot = await createMarketSource(fixture.root, "pre-final-failure", []);
    const source = await fixture.manager.add({ kind: "local", path: sourceRoot }, 0n);
    const archive = await createPublicationArchive(fixture.root, "pre-final-failure", {
      "SKILL.md": "---\nname: conflicted\nversion: 1.0.0\n---\nConflicted.\n"
    });
    const jobId = `skill_publication_${"4".repeat(32)}`;
    const suffix = createHash("sha256").update(jobId).digest("hex").slice(0, 24);
    const conflict = join(sourceRoot, ".agents", "skills", `.joko-publish-${suffix}.next`);
    const manifestPath = join(sourceRoot, ".agents", "skills", "marketplace.json");
    const before = await readFile(manifestPath, "utf8");
    await expect(fixture.manager.commitLocalPublication({
      jobId,
      sourceId: source.id,
      expectedSourceRevision: source.revision,
      expectedSourceContentRevision: source.contentRevision,
      metadata: {
        slug: "conflicted",
        name: "Conflicted",
        description: "Conflicted Skill.",
        tags: [],
        version: "1.0.0"
      },
      access: personalAccess(),
      ...archive
    }, {
      beforeSwitch: async () => { await writeFile(conflict, "external recovery content", "utf8"); },
      finalize: () => undefined
    })).rejects.toMatchObject({ code: "PUBLICATION_CHANGED" });
    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect(await readFile(conflict, "utf8")).toBe("external recovery content");
    expect(await readdir(join(sourceRoot, "archives")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })).toEqual([]);
    expect(fixture.manager.snapshot()).toMatchObject({ revision: 1n, sources: [{ entryCount: 0 }] });
  });
});

interface MarketEntryFixture {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly category: string;
  readonly downloads?: number;
  readonly trendScore?: number;
  readonly files: Readonly<Record<string, string | Buffer>>;
}

async function createFixture(options: {
  readonly now?: () => number;
  readonly previewTtlMs?: number;
  readonly git?: SkillMarketGitExecutor;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-skill-market-"));
  roots.push(root);
  const databasePath = join(root, "operational.sqlite");
  const cacheRoot = join(root, "cache");
  const store = new OperationalStore(databasePath);
  stores.push(store);
  const manager = new SkillMarketManager({ store, cacheRoot, ...options });
  await manager.initialize();
  return { root, databasePath, cacheRoot, store, manager };
}

async function createMarketSource(root: string, name: string, entries: readonly MarketEntryFixture[], existing?: string): Promise<string> {
  const sourceRoot = existing ?? join(root, `source-${name}`);
  await rm(sourceRoot, { recursive: true, force: true });
  await mkdir(join(sourceRoot, ".agents", "skills"), { recursive: true });
  const manifestEntries = [];
  for (const [index, entry] of entries.entries()) {
    const skillRoot = join(root, `skill-${name}-${entry.slug}-${index}`);
    await rm(skillRoot, { recursive: true, force: true });
    for (const [key, content] of Object.entries(entry.files)) {
      const path = join(skillRoot, ...key.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const archiveName = `${entry.slug}.tgz`;
    const archivePath = join(sourceRoot, archiveName);
    const topLevel = [...new Set(Object.keys(entry.files).map((key) => key.split("/")[0]!))];
    await createTarArchive({ file: archivePath, cwd: skillRoot, gzip: true, portable: true, prefix: "package/" }, topLevel);
    const archive = await readFile(archivePath);
    manifestEntries.push({
      slug: entry.slug,
      name: entry.name,
      author: "Joko test",
      description: `${entry.name} description`,
      category: entry.category,
      tags: [entry.category.toLocaleLowerCase("en-US")],
      version: entry.version,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: entry.version === "1.0.0" ? "2026-01-01T00:00:00Z" : "2026-02-01T00:00:00Z",
      downloads: entry.downloads ?? 0,
      trendScore: entry.trendScore ?? 0,
      archive: archiveName,
      compressedBytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex")
    });
  }
  await writeManifest(sourceRoot, name, manifestEntries);
  return sourceRoot;
}

async function createPublicationArchive(
  root: string,
  label: string,
  files: Readonly<Record<string, string | Buffer>>
): Promise<{ readonly archivePath: string; readonly archiveBytes: number; readonly archiveSha256: string }> {
  const working = join(root, `publication-${label}`);
  const skillRoot = join(working, "skill");
  await mkdir(skillRoot, { recursive: true });
  for (const [key, content] of Object.entries(files)) {
    const path = join(skillRoot, ...key.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const archivePath = join(working, "package.tgz");
  const topLevel = [...new Set(Object.keys(files).map((key) => key.split("/")[0]!))];
  await createTarArchive({
    file: archivePath,
    cwd: skillRoot,
    gzip: true,
    portable: true,
    noMtime: true,
    prefix: "package/"
  }, topLevel);
  const bytes = await readFile(archivePath);
  return {
    archivePath,
    archiveBytes: bytes.length,
    archiveSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function writeManifest(sourceRoot: string, name: string, entries: readonly Record<string, unknown>[]): Promise<void> {
  await mkdir(join(sourceRoot, ".agents", "skills"), { recursive: true });
  await writeFile(join(sourceRoot, ".agents", "skills", "marketplace.json"), `${JSON.stringify({
    format: 1,
    name,
    displayName: `${name} display`,
    entries: entries.map((entry) => ({
      author: "Joko test",
      description: "Test Skill description",
      tags: ["testing"],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      downloads: 0,
      trendScore: 0,
      ...entry
    }))
  }, null, 2)}\n`, "utf8");
}

function entryIdentity(entry: {
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly id: string;
  readonly revision: bigint;
  readonly contentRevision: string;
}): SkillMarketEntryIdentity {
  return {
    sourceId: entry.sourceId,
    sourceRevision: entry.sourceRevision,
    entryId: entry.id,
    entryRevision: entry.revision,
    contentRevision: entry.contentRevision
  };
}

function makeRawTgz(entries: readonly { readonly path: string; readonly type: string; readonly content: Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    writeOctal(header, 0o644, 100, 8);
    writeOctal(header, 0, 108, 8);
    writeOctal(header, 0, 116, 8);
    writeOctal(header, entry.content.length, 124, 12);
    writeOctal(header, 0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(entry.type, 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, entry.content, Buffer.alloc((512 - entry.content.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function writeOctal(target: Buffer, value: number, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  target.write(text, offset, length - 1, "ascii");
  target[offset + length - 1] = 0;
}

async function generationDirectories(cacheRoot: string): Promise<readonly string[]> {
  const sourcesRoot = join(cacheRoot, "sources");
  const slots = await readdir(sourcesRoot).catch(() => []);
  const result: string[] = [];
  for (const slot of slots) {
    const versions = join(sourcesRoot, slot, "versions");
    for (const generation of await readdir(versions).catch(() => [])) {
      const path = join(versions, generation);
      if ((await stat(path)).isDirectory()) result.push(path);
    }
  }
  return result;
}

function publicJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
