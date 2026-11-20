import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BrowserTransferState } from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { BrowserTransferCoordinator } from "./browser-transfers.js";
import { OperationalBrowserState } from "./operational-browser-state.js";

const publicationFaults = vi.hoisted(() => ({
  copied: undefined as (() => Promise<void>) | undefined,
  rename: undefined as ((source: string, destination: string) => Error | undefined) | undefined,
  opened: undefined as ((path: string) => Promise<void>) | undefined
}));

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      await fs.copyFile(...args);
      await publicationFaults.copied?.();
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const error = publicationFaults.rename?.(String(args[0]), String(args[1]));
      if (error !== undefined) throw error;
      return fs.rename(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      try {
        await publicationFaults.opened?.(String(args[0]));
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }
  };
});

const cleanupPaths: string[] = [];
const publicationStores: OperationalStore[] = [];

afterEach(async () => {
  publicationFaults.copied = undefined;
  publicationFaults.rename = undefined;
  publicationFaults.opened = undefined;
  for (const store of publicationStores.splice(0).reverse()) store.close();
  for (const path of cleanupPaths.splice(0).reverse()) await rm(path, { recursive: true, force: true });
});

async function publicationFixture(now = Date.now) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "joko-artifact-publication-")));
  cleanupPaths.push(directory);
  const store = new OperationalStore(join(directory, "orchestrator.db"));
  publicationStores.push(store);
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"),
    repository: new OperationalArtifactRepository(store), ingestRoots: [directory], now });
  await artifacts.initialize();
  const data = Buffer.from("An immutable published Artifact.");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const storagePath = join(directory, "artifacts", "blobs", sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  await mkdir(dirname(storagePath), { recursive: true });
  return { directory, store, artifacts, data, storagePath };
}

describe("ArtifactStore publication", () => {
  it.each([
    ["PDF", "application/pdf", ".pdf", Buffer.from("%PDF-1.7\nA fixed PDF attachment byte fixture\n%%EOF\n")],
    ["GIF", "image/gif", ".gif", Buffer.from("47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b", "hex")]
  ] as const)("presents an immutable %s through a durable native suffix until its last storage reference expires", async (_label, mimeType, suffix, bytes) => {
    let now = 1_000;
    const f = await publicationFixture(() => now);
    const uploaded = await f.artifacts.ingestBytes(bytes, { fileName: `fixture${suffix}`, mimeType, expiresAt: 2_000 });
    const shared = await f.artifacts.ingestBytes(bytes, { fileName: "retained.bin", mimeType: "application/octet-stream", expiresAt: 3_000 });
    const original = await f.artifacts.resolveBlobPath(uploaded);
    expect(await f.artifacts.resolveNativeInputFile(shared, mimeType)).toBe(original);
    const paths = await Promise.all([f.artifacts.resolveNativeInputFile(uploaded, mimeType), f.artifacts.resolveNativeInputFile(uploaded, mimeType)]);
    const nativeFile = `${await realpath(original)}${suffix}`;
    expect(paths).toEqual([nativeFile, nativeFile]);
    expect(await readFile(nativeFile)).toEqual(bytes);
    expect(await readFile(original)).toEqual(bytes);
    expect(await f.artifacts.resolveBlobPath(uploaded)).toBe(original);
    expect(await readdir(join(f.directory, "artifacts", "incoming"))).toEqual([]);

    await writeFile(nativeFile, Buffer.alloc(bytes.length));
    await expect(f.artifacts.resolveNativeInputFile(uploaded, mimeType)).rejects.toThrow(/content changed/u);
    await writeFile(nativeFile, bytes);
    now = 2_500;
    expect(await f.artifacts.garbageCollect()).toBe(0);
    expect(await readFile(nativeFile)).toEqual(bytes);
    now = 3_500;
    expect(await f.artifacts.garbageCollect()).toBe(1);
    await expect(readFile(nativeFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(original)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains both original Browser download names after two staged copies fail and the ledger is reopened", async () => {
    const f = await publicationFixture();
    const provider = { generation: 7, acquireAgentLease: vi.fn(), releaseAgentLease: vi.fn(), uploadFiles: vi.fn(), recover: vi.fn() };
    const repository = new OperationalBrowserState(f.store);
    const transfers = new BrowserTransferCoordinator({ artifacts: f.artifacts, provider, repository });
    const names = ["first-report.txt", "second-report.txt"];
    publicationFaults.copied = async () => { throw new Error("Fixture copy failure"); };
    const original = [];
    for (const fileName of names) {
      const source = join(f.directory, fileName);
      await writeFile(source, `Original bytes for ${fileName}`);
      original.push(await transfers.ingestDownload({ pageId: "page-7-1", generation: provider.generation, fileName,
        assertCurrent: () => undefined, stage: async () => source, cancel: async () => undefined }));
    }
    expect(original.map(record => record.fileName)).toEqual(names);
    const reopened = new BrowserTransferCoordinator({ artifacts: f.artifacts, provider, repository: new OperationalBrowserState(f.store) });
    for (const record of original) {
      const receipt = reopened.get(record.browserTransferId);
      expect(receipt).toEqual(record);
      expect(receipt).toMatchObject({ fileName: record.fileName, state: BrowserTransferState.FAILED,
        error: { code: "BROWSER_DOWNLOAD_INGEST_FAILED" } });
      expect(receipt?.blob).toBeUndefined();
      expect(receipt?.artifact).toBeUndefined();
      expect(receipt?.cancellable).toBe(false);
    }
    expect(f.store.listArtifacts({ limit: 100 })).toEqual([]);
    expect(await readdir(join(f.directory, "artifacts", "incoming"))).toEqual([]);
  });

  it("keeps a Browser download fenced when restart happens after the original bytes are staged", async () => {
    const f = await publicationFixture();
    const source = join(f.directory, "browser-download");
    await writeFile(source, f.data);
    let finishCopy!: () => void;
    let copied!: () => void;
    const afterCopy = new Promise<void>(resolve => { copied = resolve; });
    const copyGate = new Promise<void>(resolve => { finishCopy = resolve; });
    publicationFaults.copied = () => { copied(); return copyGate; };
    const provider = { generation: 7, acquireAgentLease: vi.fn(), releaseAgentLease: vi.fn(), uploadFiles: vi.fn(),
      async recover() { this.generation += 1; } };
    const repository = new OperationalBrowserState(f.store);
    const transfers = new BrowserTransferCoordinator({ artifacts: f.artifacts, provider, repository });
    const ingesting = transfers.ingestDownload({ pageId: "page-7-1", generation: provider.generation, fileName: "report.txt",
      assertCurrent: () => undefined, stage: async () => source, cancel: async () => undefined });
    try {
      await Promise.race([afterCopy, ingesting.then(() => { throw new Error("The Browser ingest did not reach the staged copy."); })]);
      const incoming = join(f.directory, "artifacts", "incoming");
      const staged = await readdir(incoming);
      expect(staged).toHaveLength(1);
      expect(await readFile(join(incoming, staged[0]!))).toEqual(f.data);
      const original = transfers.list()[0]!;
      expect(original.state).toBe(BrowserTransferState.RUNNING);
      await transfers.recover();
      const retired = transfers.get(original.browserTransferId)!;
      expect(retired).toMatchObject({ state: BrowserTransferState.FAILED, error: { code: "BROWSER_GENERATION_FENCED" } });
      finishCopy();
      expect(await ingesting).toEqual(retired);
      expect(transfers.list({ pageId: "page-7-1" })).toEqual([retired]);
      expect(repository.list("browser")).toMatchObject([{ id: original.browserTransferId, state: BrowserTransferState.FAILED }]);
      expect(retired.blob).toBeUndefined();
      expect(retired.artifact).toBeUndefined();
      expect(f.store.listArtifacts({ limit: 100 })).toEqual([]);
      expect(await readdir(incoming)).toEqual([]);
    } finally {
      finishCopy();
      await ingesting;
    }
  });

  it("authenticates an existing Blob after a failed rename and reuses its permanent identity", async () => {
    const f = await publicationFixture();
    await writeFile(f.storagePath, f.data);
    publicationFaults.rename = (_source, destination) => destination === f.storagePath
      ? Object.assign(new Error("Publication rename is blocked."), { code: "EACCES" }) : undefined;
    const first = await f.artifacts.ingestBytes(f.data, { fileName: "published.txt", mimeType: "text/plain" });
    const second = await f.artifacts.ingestBytes(f.data, { fileName: "published.txt", mimeType: "text/plain" });
    expect(second).toEqual(first);
    expect(f.store.listArtifacts({ limit: 100 })).toHaveLength(1);
    expect(Buffer.from((await f.artifacts.readBlob(second)).data)).toEqual(f.data);
    expect(await readdir(join(f.directory, "artifacts", "incoming"))).toEqual([]);
  });

  it("rejects a directory at the Blob identity without registering an unreadable Artifact or removing its contents", async () => {
    const f = await publicationFixture();
    await mkdir(f.storagePath);
    const occupant = join(f.storagePath, "owner.txt");
    await writeFile(occupant, "Retain this directory.");
    await expect(f.artifacts.ingestBytes(f.data)).rejects.toThrow("private regular file");
    expect(f.store.listArtifacts({ limit: 100 })).toEqual([]);
    expect((await lstat(f.storagePath)).isDirectory()).toBe(true);
    expect(await readFile(occupant, "utf8")).toBe("Retain this directory.");
    expect(await readdir(join(f.directory, "artifacts", "incoming"))).toEqual([]);
  });

  it("rejects same-size corrupt content when the correct staged file cannot replace it", async () => {
    const f = await publicationFixture();
    const corrupt = Buffer.alloc(f.data.byteLength, 0x78);
    await writeFile(f.storagePath, corrupt);
    publicationFaults.rename = (_source, destination) => destination === f.storagePath
      ? Object.assign(new Error("Publication rename is blocked."), { code: "EACCES" }) : undefined;
    await expect(f.artifacts.ingestBytes(f.data)).rejects.toThrow("Publication rename is blocked.");
    expect(f.store.listArtifacts({ limit: 100 })).toEqual([]);
    expect(await readFile(f.storagePath)).toEqual(corrupt);
    expect(await readdir(join(f.directory, "artifacts", "incoming"))).toEqual([]);
  });

  it.each([false, true])("rechecks a replacement encountered during publication, with identical bytes=%s", async identical => {
    const f = await publicationFixture();
    const replacement = identical ? f.data : Buffer.alloc(f.data.byteLength, 0x78);
    const original = `${f.storagePath}.original`;
    let opened = 0;
    publicationFaults.opened = async path => {
      if (path !== f.storagePath || ++opened !== 1) return;
      await rename(path, original);
      await writeFile(path, replacement);
    };
    const incoming = f.artifacts.ingestBytes(f.data);
    if (identical) {
      const artifact = await incoming;
      expect(opened).toBe(2);
      expect(Buffer.from((await f.artifacts.readBlob(artifact)).data)).toEqual(f.data);
      expect(f.store.listArtifacts({ limit: 100 })).toHaveLength(1);
    } else {
      await expect(incoming).rejects.toThrow("publication verification");
      expect(f.store.listArtifacts({ limit: 100 })).toEqual([]);
    }
    expect(await readFile(original)).toEqual(f.data);
    expect(await readFile(f.storagePath)).toEqual(replacement);
  });
});

describe("ArtifactStore garbage collection", () => {
  it("resolves dispatch input only during its owning send and releases the file after the run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-dispatch-"));
    cleanupPaths.push(directory);
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [directory]
    });
    await artifacts.initialize();
    const owner = new AbortController();
    const staged = artifacts.createDispatchInputArtifacts(() => owner.signal.throwIfAborted());
    const bytes = Buffer.from("private dispatch input\n");
    try {
      const blob = await staged.stage(bytes, { fileName: "history.txt", mimeType: "text/plain" });
      expect(store.listArtifacts()).toEqual([]);
      await expect(artifacts.resolveBlobPath(blob)).rejects.toThrow();
      await expect(artifacts.readBlob(blob)).rejects.toThrow();
      const path = await staged.run(async () => {
        const resolved = await artifacts.resolveBlobPath(blob);
        expect((await artifacts.readBlob(blob)).data).toEqual(bytes);
        await expect(artifacts.readBlob({ ...blob, byteLength: 1 })).rejects.toThrow();
        await expect(artifacts.get(blob.id)).rejects.toThrow();
        await expect(artifacts.createDownloadTicket(blob.id)).rejects.toThrow();
        owner.abort(new Error("Dispatch ownership ended."));
        await expect(artifacts.readBlob(blob)).rejects.toThrow("Dispatch ownership ended.");
        return resolved;
      });
      await expect(artifacts.resolveBlobPath(blob)).rejects.toThrow();
      expect(await readFile(path)).toEqual(bytes);
      await staged.release();
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await staged.release();
      store.close();
    }
  });

  it("infers supported text filenames at ingestion and preserves an explicitly declared Blob type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-text-"));
    cleanupPaths.push(directory);
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [directory]
    });
    await artifacts.initialize();
    const bytes = Buffer.from("source text\n");
    try {
      for (const fileName of ["main.zig", "events.jsonl", "movie.srt", "Gemfile", ".env", "production.env.local"]) {
        const source = join(directory, fileName);
        await writeFile(source, bytes);
        const inferred = await artifacts.ingestPath(source);
        expect(inferred).toMatchObject({ fileName, mimeType: "text/plain", byteLength: bytes.length });
        const fromBytes = await artifacts.ingestBytes(bytes, { fileName });
        expect(fromBytes).toEqual(inferred);
        const declared = await artifacts.ingestBytes(bytes, { fileName, mimeType: "application/octet-stream" });
        expect(declared).toMatchObject({ fileName, mimeType: "application/octet-stream", sha256: inferred.sha256 });
        expect(declared.id).not.toBe(inferred.id);
      }
    } finally { store.close(); }
  });

  it("ingests service-produced bytes as a private durable artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-bytes-"));
    cleanupPaths.push(directory);
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [directory]
    });
    await artifacts.initialize();

    const artifact = await artifacts.ingestBytes(Buffer.from("png fixture"), {
      fileName: "page-1.png",
      mimeType: "image/png",
      expiresAt: Date.now() + 60_000
    });

    expect(artifact).toMatchObject({ fileName: "page-1.png", mimeType: "image/png", byteLength: 11 });
    await expect(artifacts.readBlob(artifact)).resolves.toMatchObject({ mimeType: "image/png" });
    const ticket = await artifacts.createDownloadTicket(artifact.id);
    const download = await artifacts.openDownload(ticket.ticketId, ticket.secret);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("png fixture");
    await expect(artifacts.openDownload(ticket.ticketId, ticket.secret)).rejects.toThrow();
    store.close();
  });

  it("fences concurrent ingests of identical bytes under each caller's authority", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-fenced-bytes-"));
    cleanupPaths.push(directory);
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    try {
      const repo = new OperationalArtifactRepository(store);
      const find = repo.findPermanentArtifact.bind(repo);
      let firstRead!: () => void;
      let releaseFirstRead!: () => void;
      const first = new Promise<void>(resolve => { firstRead = resolve; });
      const release = new Promise<void>(resolve => { releaseFirstRead = resolve; });
      let reads = 0;
      repo.findPermanentArtifact = async input => {
        if (++reads === 1) { firstRead(); await release; }
        return find(input);
      };
      const artifacts = new ArtifactStore({
        rootDirectory: join(directory, "artifacts"), repository: repo, ingestRoots: [directory]
      });
      await artifacts.initialize();
      const bytes = Buffer.from("portable task bytes");
      const owner = new AbortController();
      const retired = artifacts.ingestBytes(bytes, { assertCurrent: () => owner.signal.throwIfAborted() });
      const rejected = expect(retired).rejects.toThrow("Export authority changed.");
      await first;
      const stillCurrent = artifacts.ingestBytes(bytes);
      owner.abort(new Error("Export authority changed."));
      releaseFirstRead();
      await rejected;
      const result = await stillCurrent;
      expect(store.listArtifacts().map(record => record.blob.id)).toEqual([result.id]);
      expect(reads).toBe(2);
      await expect(artifacts.readBlob(result)).resolves.toMatchObject({ data: bytes });
    } finally {
      store.close();
    }
  });

  it("reuses a permanent BlobRef for identical content across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-stable-"));
    cleanupPaths.push(directory);
    const store = new OperationalStore(join(directory, "orchestrator.db"));
    const createArtifacts = () => new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [directory]
    });
    const source = join(directory, "pi-image.png");
    await writeFile(source, "same image bytes");

    const firstStore = createArtifacts();
    await firstStore.initialize();
    const first = await firstStore.ingestPath(source, { fileName: "pi-image.png", mimeType: "image/png" });
    const restartedStore = createArtifacts();
    await restartedStore.initialize();
    const rehydrated = await restartedStore.ingestPath(source, { fileName: "pi-image.png", mimeType: "image/png" });

    expect(rehydrated).toEqual(first);
    expect(store.listArtifacts({ limit: 100 })).toHaveLength(1);
    store.close();
  });

  it("keeps shared content while any live artifact still references its storage key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-gc-"));
    cleanupPaths.push(directory);
    let now = 1_000;
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => now });
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [directory],
      now: () => now
    });
    await artifacts.initialize();
    const firstPath = join(directory, "first.txt");
    const secondPath = join(directory, "second.txt");
    await writeFile(firstPath, "shared content");
    await writeFile(secondPath, "shared content");
    const expiring = await artifacts.ingestPath(firstPath, { expiresAt: 1_500 });
    const permanent = await artifacts.ingestPath(secondPath);
    expect(expiring.storagePath).toBe(permanent.storagePath);

    now = 2_000;
    expect(await artifacts.garbageCollect()).toBe(0);
    await expect(artifacts.readBlob(permanent)).resolves.toMatchObject({ mimeType: "text/plain" });
    expect(store.findArtifact(expiring.id)).toBeUndefined();
    expect(store.findArtifact(permanent.id)?.storageKey).toBe(permanent.storagePath);
    store.close();
  });

  it("keeps shared content referenced by the 100001st live Artifact", { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-gc-boundary-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "orchestrator.db");
    let now = 1_000;
    let store = new OperationalStore(databasePath, { now: () => now });
    let artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [directory],
      now: () => now
    });
    await artifacts.initialize();
    const permanent = await artifacts.ingestBytes(Buffer.from("boundary-shared-content"));
    now = 2_000;
    const expiring = await artifacts.ingestBytes(Buffer.from("boundary-shared-content"), { expiresAt: 2_500 });
    expect(expiring.storagePath).toBe(permanent.storagePath);
    store.close();

    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        WITH digits(value) AS (
          VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
        ), numbers(value) AS (
          SELECT ones.value + tens.value * 10 + hundreds.value * 100 +
            thousands.value * 1000 + ten_thousands.value * 10000 + 1
          FROM digits AS ones
          CROSS JOIN digits AS tens
          CROSS JOIN digits AS hundreds
          CROSS JOIN digits AS thousands
          CROSS JOIN digits AS ten_thousands
        )
        INSERT INTO artifacts(
          id, sha256, byte_length, mime_type, file_name, storage_key,
          session_id, run_id, metadata_json, created_at, deleted_at, revision
        )
        SELECT
          'filler-' || value,
          printf('%064x', value),
          0,
          'application/octet-stream',
          NULL,
          ? || value,
          NULL,
          NULL,
          '{}',
          2100 + value,
          NULL,
          1
        FROM numbers
        WHERE value <= 100000
      `).run(`${join(directory, "filler-")}:`);
    } finally {
      database.close();
    }
    store = new OperationalStore(databasePath, { now: () => now });
    artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [directory],
      now: () => now
    });
    await artifacts.initialize();
    try {
      expect(store.listArtifacts({ limit: 100_000 }).some((record) => record.blob.id === permanent.id)).toBe(false);

      now = 3_000;
      expect(await artifacts.garbageCollect()).toBe(0);
      await expect(artifacts.readBlob(permanent)).resolves.toMatchObject({
        data: Buffer.from("boundary-shared-content")
      });
      expect(store.findArtifact(expiring.id)).toBeUndefined();
      expect(store.findArtifact(permanent.id)?.storageKey).toBe(permanent.storagePath);
    } finally {
      store.close();
    }
  });

  it("collects a shared storage object once after every artifact reference expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-gc-shared-"));
    cleanupPaths.push(directory);
    let now = 1_000;
    const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => now });
    const artifacts = new ArtifactStore({
      rootDirectory: join(directory, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [directory],
      now: () => now
    });
    await artifacts.initialize();
    const firstPath = join(directory, "first-expiring.txt");
    const secondPath = join(directory, "second-expiring.txt");
    await writeFile(firstPath, "shared expiring content");
    await writeFile(secondPath, "shared expiring content");
    const first = await artifacts.ingestPath(firstPath, { expiresAt: 1_500 });
    const second = await artifacts.ingestPath(secondPath, { expiresAt: 1_600 });
    expect(first.storagePath).toBe(second.storagePath);

    now = 2_000;
    expect(await artifacts.garbageCollect()).toBe(1);
    expect(store.findArtifact(first.id)).toBeUndefined();
    expect(store.findArtifact(second.id)).toBeUndefined();
    store.close();
  });
});
