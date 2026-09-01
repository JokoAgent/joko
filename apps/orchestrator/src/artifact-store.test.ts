import { rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0).reverse()) await rm(path, { recursive: true, force: true });
});

describe("ArtifactStore garbage collection", () => {
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
