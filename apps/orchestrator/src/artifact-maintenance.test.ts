import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { OperationalStore, type ArtifactRecord } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactMaintenance,
  ArtifactMaintenanceScanExpiredError
} from "./artifact-maintenance.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";

const cleanupPaths: string[] = [];
const openStores: OperationalStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0).reverse()) store.close();
  for (const path of cleanupPaths.splice(0).reverse()) await rm(path, { recursive: true, force: true });
});

describe("ArtifactMaintenance", () => {
  it("reports unique live storage and removes expired references before their blobs", async () => {
    const fixture = await createFixture(1_000);
    const permanent = await fixture.artifacts.ingestBytes(Buffer.from("permanent"));
    const expiring = await fixture.artifacts.ingestBytes(Buffer.from("temporary"), { expiresAt: 1_500 });

    expect(await fixture.maintenance.stats()).toEqual({
      referenceCount: 2,
      uniqueBlobCount: 2,
      totalBytes: 18,
      cacheReferenceCount: 1,
      cacheBytes: 9,
      temporaryFileCount: 0,
      temporaryBytes: 0
    });

    fixture.setNow(2_000);
    const scan = await fixture.maintenance.scan();
    expect(scan).toMatchObject({
      expiredReferenceCount: 1,
      orphanBlobCount: 1,
      orphanBlobBytes: 9,
      cleanableBytes: 9,
      missingBlobCount: 0
    });
    const result = await completedCleanup(fixture.maintenance, scan.token);
    expect(result).toEqual({
      expiredReferencesDeleted: 1,
      blobsRemoved: 1,
      temporaryFilesRemoved: 0,
      freedBytes: 9,
      skipped: 0
    });
    expect(fixture.store.findArtifact(expiring.id)).toBeUndefined();
    expect(fixture.store.findArtifact(permanent.id)?.storageKey).toBe(permanent.storagePath);
    await expect(stat(expiring.storagePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(permanent.storagePath)).resolves.toMatchObject({ size: 9 });
  });

  it("finds unreferenced blobs and old incoming files without exposing their paths", async () => {
    const fixture = await createFixture(100_000);
    const orphanBytes = Buffer.from("unreferenced");
    const digest = createHash("sha256").update(orphanBytes).digest("hex");
    const orphan = join(fixture.root, "blobs", digest.slice(0, 2), digest.slice(2, 4), digest);
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, orphanBytes);
    const incoming = join(fixture.root, "incoming", "abandoned-upload");
    await writeFile(incoming, "old upload");
    await utimes(incoming, new Date(1_000), new Date(1_000));

    const scan = await fixture.maintenance.scan();
    expect(scan).toMatchObject({
      orphanBlobCount: 1,
      orphanBlobBytes: 12,
      temporaryFileCount: 1,
      temporaryBytes: 10,
      cleanableBytes: 22
    });
    expect(JSON.stringify(scan)).not.toContain(fixture.root);

    const result = await completedCleanup(fixture.maintenance, scan.token);
    expect(result).toMatchObject({ blobsRemoved: 1, temporaryFilesRemoved: 1, freedBytes: 22 });
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(incoming)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects cleanup when a candidate changes after confirmation", async () => {
    const fixture = await createFixture(100_000);
    const bytes = Buffer.from("candidate");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const orphan = join(fixture.root, "blobs", digest.slice(0, 2), digest.slice(2, 4), digest);
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, bytes);
    const scan = await fixture.maintenance.scan();

    await writeFile(orphan, "candidate changed");
    await expect(fixture.maintenance.beginCleanup(scan.token)).rejects.toThrow(/changed after the scan/u);
    await expect(stat(orphan)).resolves.toMatchObject({ size: 17 });
  });

  it("expires confirmation tokens and returns the same durable job after a lost reply", async () => {
    const fixture = await createFixture(100_000, 1_000);
    const scan = await fixture.maintenance.scan();
    fixture.setNow(scan.expiresAt);
    await expect(fixture.maintenance.beginCleanup(scan.token)).rejects.toBeInstanceOf(ArtifactMaintenanceScanExpiredError);

    const fresh = await fixture.maintenance.scan();
    await expect(completedCleanup(fixture.maintenance, fresh.token)).resolves.toMatchObject({ freedBytes: 0 });
    await expect(fixture.maintenance.beginCleanup(fresh.token)).resolves.toMatchObject({
      maintenanceId: fresh.token, status: "completed"
    });
  });

  it("protects expired references whose content is still present in a client draft", async () => {
    const fixture = await createFixture(1_000);
    const artifact = await fixture.artifacts.ingestBytes(Buffer.from("draft attachment"), { expiresAt: 1_500 });
    fixture.setNow(2_000);

    const scan = await fixture.maintenance.scan([artifact.sha256]);
    expect(scan).toMatchObject({ expiredReferenceCount: 0, protectedReferenceCount: 1, cleanableBytes: 0 });
    await expect(fixture.maintenance.stats([artifact.sha256])).resolves.toMatchObject({ referenceCount: 1, uniqueBlobCount: 1 });
    await expect(completedCleanup(fixture.maintenance, scan.token, [artifact.sha256]))
      .resolves.toMatchObject({ expiredReferencesDeleted: 0 });
    expect(fixture.store.findArtifact(artifact.id)).toBeDefined();
    await expect(stat(artifact.storagePath)).resolves.toMatchObject({ size: 16 });
  });

  it("reconciles missing and structurally unsafe entries without deleting them", async () => {
    const fixture = await createFixture(1_000);
    const artifact = await fixture.artifacts.ingestBytes(Buffer.from("missing"));
    await rm(artifact.storagePath, { force: true });
    const unsafe = join(fixture.root, "blobs", "unexpected-entry");
    await writeFile(unsafe, "keep");

    expect(await fixture.maintenance.reconcile()).toEqual({
      healthy: false,
      missingBlobCount: 1,
      orphanBlobCount: 0,
      unsafeEntryCount: 1
    });
    await expect(stat(unsafe)).resolves.toMatchObject({ size: 4 });
  });

  it("fails closed when an unrecognized quarantine entry is present", async () => {
    const fixture = await createFixture(100_000);
    const unknown = join(fixture.root, ".maintenance-trash", "unknown-file");
    await writeFile(unknown, "unverified bytes");
    const scan = await fixture.maintenance.scan();
    expect(scan.unsafeEntryCount).toBe(1);
    await expect(fixture.maintenance.beginCleanup(scan.token)).rejects.toThrow(/changed after the scan/u);
    await expect(stat(unknown)).resolves.toMatchObject({ size: 16 });
  });

  it("resumes a claimed quarantine receipt after reopening the file-backed Store", async () => {
    const fixture = await createFixture(100_000);
    const bytes = Buffer.from("recover orphan");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const orphan = join(fixture.root, "blobs", digest.slice(0, 2), digest.slice(2, 4), digest);
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, bytes);
    const { token, quarantine } = await stageQuarantinedCleanup(fixture.maintenance, fixture.store, fixture.root, orphan);
    fixture.store.close();

    const reopened = new OperationalStore(fixture.store.filePath, { now: () => 100_000 });
    openStores.push(reopened);
    const recovered = new ArtifactMaintenance({ store: reopened, rootDirectory: fixture.root,
      now: () => 100_000, temporaryFileMinimumAgeMs: 60_000 });
    await recovered.initialize();

    expect(recovered.getCleanup(token)).toMatchObject({ status: "completed", result: { blobsRemoved: 1, freedBytes: bytes.length } });
    await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recovered.reconcile()).resolves.toMatchObject({ healthy: true, unsafeEntryCount: 0 });
  });

  it("restores a quarantined blob when a live reference appears before final deletion", async () => {
    const fixture = await createFixture(100_000);
    const bytes = Buffer.from("late live reference");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const orphan = join(fixture.root, "blobs", digest.slice(0, 2), digest.slice(2, 4), digest);
    await mkdir(dirname(orphan), { recursive: true });
    await writeFile(orphan, bytes);
    const { token, quarantine } = await stageQuarantinedCleanup(fixture.maintenance, fixture.store, fixture.root, orphan);
    fixture.store.putArtifact({ id: "late-reference", sha256: digest, byteLength: bytes.length,
      mimeType: "application/octet-stream", storageKey: orphan });
    fixture.store.close();

    const reopened = new OperationalStore(fixture.store.filePath, { now: () => 100_000 });
    openStores.push(reopened);
    const recovered = new ArtifactMaintenance({ store: reopened, rootDirectory: fixture.root,
      now: () => 100_000, temporaryFileMinimumAgeMs: 60_000 });
    await recovered.initialize();

    expect(recovered.getCleanup(token)).toMatchObject({ status: "completed", result: { blobsRemoved: 0, skipped: 1 } });
    expect(reopened.hasLiveArtifactStorageKey(orphan)).toBe(true);
    await expect(stat(orphan)).resolves.toMatchObject({ size: bytes.length });
    await expect(stat(quarantine)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps references beyond the first storage page live during maintenance scans", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-artifact-maintenance-paged-"));
    cleanupPaths.push(directory);
    const root = join(directory, "artifacts");
    const blobs = join(root, "blobs");
    const firstBytes = Buffer.from("first-page");
    const lastBytes = Buffer.from("last-page");
    const firstDigest = createHash("sha256").update(firstBytes).digest("hex");
    const lastDigest = createHash("sha256").update(lastBytes).digest("hex");
    const firstPath = join(blobs, firstDigest.slice(0, 2), firstDigest.slice(2, 4), firstDigest);
    const lastPath = join(blobs, lastDigest.slice(0, 2), lastDigest.slice(2, 4), lastDigest);
    await mkdir(dirname(firstPath), { recursive: true });
    await mkdir(dirname(lastPath), { recursive: true });
    await writeFile(firstPath, firstBytes);
    await writeFile(lastPath, lastBytes);

    const first = artifactRecord("artifact-first", firstDigest, firstBytes.byteLength, firstPath);
    const last = artifactRecord("artifact-last", lastDigest, lastBytes.byteLength, lastPath);
    const pageOffsets: number[] = [];
    const store = {
      listArtifacts: (options: { readonly offset?: number }) => {
        const offset = options.offset ?? 0;
        pageOffsets.push(offset);
        if (offset === 0) return Array<ArtifactRecord>(100_000).fill(first);
        if (offset === 100_000) return [last];
        return [];
      }
    } as unknown as OperationalStore;
    const maintenance = new ArtifactMaintenance({
      store,
      rootDirectory: root,
      now: () => 1_000,
      temporaryFileMinimumAgeMs: 60_000
    });

    await expect(maintenance.stats()).resolves.toMatchObject({
      referenceCount: 100_001,
      uniqueBlobCount: 2,
      totalBytes: 19
    });
    await expect(maintenance.reconcile()).resolves.toMatchObject({ orphanBlobCount: 0, missingBlobCount: 0 });
    expect(pageOffsets).toEqual([0, 100_000, 0, 100_000]);
  });
});

async function stageQuarantinedCleanup(
  maintenance: ArtifactMaintenance,
  store: OperationalStore,
  root: string,
  orphan: string
): Promise<{ readonly token: string; readonly quarantine: string }> {
  const scan = await maintenance.scan();
  const durable = store.getMaintenanceScan<{ readonly orphanBlobs: readonly { readonly path: string; readonly relativePath: string }[] }>("artifact", scan.token);
  const identity = durable.payload.orphanBlobs[0];
  if (identity === undefined) throw new Error("Expected an orphan candidate.");
  const effectId = createHash("sha256").update(identity.relativePath).digest("hex");
  const quarantineRelativePath = join(".maintenance-trash", scan.token, effectId);
  const quarantine = join(root, quarantineRelativePath);
  store.transaction((transaction) => {
    transaction.claimMaintenanceScan("artifact", scan.token, 100_000);
    transaction.createMaintenanceJob({ id: scan.token, kind: "artifact", scanId: scan.token,
      phase: "quarantining", percent: 10, cancellable: false,
      payload: { expiredReferencesDeleted: 0 }, createdAt: 100_000,
      effects: [{ id: effectId, kind: "artifact_blob", state: "claimed",
        payload: { identity, quarantineRelativePath } }] });
  });
  await mkdir(dirname(quarantine), { recursive: true });
  await rename(orphan, quarantine);
  return { token: scan.token, quarantine };
}

async function completedCleanup(
  maintenance: ArtifactMaintenance,
  token: string,
  protectedSha256: readonly string[] = []
) {
  await maintenance.beginCleanup(token, protectedSha256);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = maintenance.getCleanup(token);
    if (job?.status === "completed" && job.result !== undefined) return job.result;
    if (job?.status !== "running") throw new Error(`Artifact cleanup failed: ${job?.status ?? "missing"}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Artifact cleanup did not finish.");
}

function artifactRecord(id: string, sha256: string, byteLength: number, storageKey: string): ArtifactRecord {
  return {
    blob: { id, sha256, byteLength, mimeType: "application/octet-stream" },
    storageKey,
    metadata: {},
    createdAt: 1,
    revision: 1n
  } as ArtifactRecord;
}

async function createFixture(initialNow: number, scanTokenTtlMs = 5 * 60_000): Promise<{
  readonly root: string;
  readonly store: OperationalStore;
  readonly artifacts: ArtifactStore;
  readonly maintenance: ArtifactMaintenance;
  readonly setNow: (value: number) => void;
}> {
  const directory = await mkdtemp(join(tmpdir(), "joko-artifact-maintenance-"));
  cleanupPaths.push(directory);
  let now = initialNow;
  const store = new OperationalStore(join(directory, "orchestrator.db"), { now: () => now });
  openStores.push(store);
  const root = join(directory, "artifacts");
  const artifacts = new ArtifactStore({
    rootDirectory: root,
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [directory],
    now: () => now
  });
  const maintenance = new ArtifactMaintenance({
    store,
    rootDirectory: root,
    now: () => now,
    temporaryFileMinimumAgeMs: 60_000,
    scanTokenTtlMs
  });
  await artifacts.initialize();
  await maintenance.initialize();
  return { root, store, artifacts, maintenance, setNow: (value) => { now = value; } };
}
