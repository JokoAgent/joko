import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";

const publicationFaults = vi.hoisted(() => ({
  rename: undefined as ((source: string, destination: string) => Error | undefined) | undefined,
  opened: undefined as ((path: string) => Promise<void>) | undefined
}));

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs,
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
  publicationFaults.rename = undefined;
  publicationFaults.opened = undefined;
  for (const store of publicationStores.splice(0).reverse()) store.close();
  for (const path of cleanupPaths.splice(0).reverse()) await rm(path, { recursive: true, force: true });
});

async function publicationFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "joko-artifact-publication-")));
  cleanupPaths.push(directory);
  const store = new OperationalStore(join(directory, "orchestrator.db"));
  publicationStores.push(store);
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"),
    repository: new OperationalArtifactRepository(store), ingestRoots: [directory] });
  await artifacts.initialize();
  const data = Buffer.from("An immutable published Artifact.");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const storagePath = join(directory, "artifacts", "blobs", sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  await mkdir(dirname(storagePath), { recursive: true });
  return { directory, store, artifacts, data, storagePath };
}

describe("ArtifactStore publication", () => {
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
