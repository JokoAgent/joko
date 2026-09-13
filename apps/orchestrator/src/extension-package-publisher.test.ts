import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { list as listTarArchive } from "tar";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import {
  ExtensionPackagePublisher,
  type ExtensionPackageExportAuthority,
  type ExtensionPackageExportJob
} from "./extension-package-publisher.js";
import { PiResourceManager } from "./resource-manager.js";
import { mkdtemp } from "./test-paths.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface FixtureOptions {
  readonly afterStatePersisted?: (job: ExtensionPackageExportJob) => void | Promise<void>;
  readonly maximumFiles?: number;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-extension-export-"));
  roots.push(root);
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "0.84.4",
    health: "healthy",
    adapterKind: "pi",
    instanceGeneration: 4,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map([["runtime.resources", {
      key: "runtime.resources",
      supported: true,
      options: ["extension", "package"]
    }]]),
    models: [],
    tools: [],
    diagnostics: []
  });
  const resources = new PiResourceManager({
    store,
    managedRoot: join(root, "managed"),
    maximumFiles: options.maximumFiles ?? 64,
    maximumBytes: 1024 * 1024
  });
  await resources.initialize();
  const source = join(root, "source");
  await writePackage(source, "1.2.3", "one");
  const discovered = await resources.discover({
    id: "resource-package",
    backendId: "pi",
    kind: "package",
    scope: "managed",
    source: { kind: "local", path: source },
    version: "1.2.3"
  });
  await resources.approve(discovered.id, discovered.discoveredRevision, "connection-1");
  const resource = await resources.install(discovered.id);
  const artifacts = new ArtifactStore({
    rootDirectory: join(root, "artifacts"),
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [root]
  });
  await artifacts.initialize();
  const publisher = new ExtensionPackagePublisher({
    store,
    resources,
    artifacts,
    rootDirectory: join(root, "exports"),
    ...(options.afterStatePersisted === undefined ? {} : { afterStatePersisted: options.afterStatePersisted })
  });
  await publisher.initialize();
  return { root, store, resources, artifacts, publisher, source, resource };
}

async function writePackage(root: string, version: string, marker: string): Promise<void> {
  await mkdir(join(root, "extensions"), { recursive: true });
  await mkdir(join(root, "empty", "nested"), { recursive: true });
  await mkdir(join(root, "node_modules", "sample-dependency"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@sample/exportable",
    version,
    description: "Export fixture",
    peerDependencies: { "@earendil-works/pi-coding-agent": "^0.84.0" },
    pi: { extensions: ["extensions/index.js"] }
  }), "utf8");
  await writeFile(join(root, "extensions", "index.js"), `export default ${JSON.stringify(marker)};\n`, "utf8");
  await writeFile(join(root, ".package-note"), `${marker}\n`, "utf8");
  await writeFile(join(root, "node_modules", "sample-dependency", "package.json"), JSON.stringify({
    name: "sample-dependency",
    version: "1.0.0"
  }), "utf8");
}

function authority(f: Awaited<ReturnType<typeof fixture>>): ExtensionPackageExportAuthority {
  const resource = f.resources.get(f.resource.id);
  const backend = f.store.getBackend(resource.backendId);
  return {
    extensionId: "extension_0123456789abcdef0123456789abcdef",
    extensionRevision: 7n,
    resourceId: resource.id,
    resourceRevision: resource.versionNumber,
    discoveredRevision: resource.discoveredRevision,
    backendId: resource.backendId,
    backendRevision: backend.revision,
    backendGeneration: backend.descriptor.instanceGeneration,
    packageName: resource.packageIdentity!,
    ...(resource.version === undefined ? {} : { packageVersion: resource.version })
  };
}

function authorityAssertion(
  f: Awaited<ReturnType<typeof fixture>>,
  expected: ExtensionPackageExportAuthority
): () => void {
  return () => {
    const resource = f.resources.get(expected.resourceId);
    const backend = f.store.getBackend(expected.backendId);
    if (
      resource.versionNumber !== expected.resourceRevision
      || resource.discoveredRevision !== expected.discoveredRevision
      || resource.packageIdentity !== expected.packageName
      || resource.version !== expected.packageVersion
      || backend.revision !== expected.backendRevision
      || backend.descriptor.instanceGeneration !== expected.backendGeneration
    ) throw new Error("Export authority changed.");
  };
}

async function start(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  exportAuthority = authority(f)
): Promise<void> {
  const prepared = await f.publisher.prepareStart({ exportId: id, authority: exportAuthority });
  await f.publisher.completePreparedMutation(prepared, (finalize) => f.store.transaction((transaction) => {
    finalize(transaction);
  }));
  f.publisher.begin(id, authorityAssertion(f, exportAuthority));
}

describe("ExtensionPackagePublisher", () => {
  it("creates a deterministic standard package Artifact, re-verifies it, and restores ready state", async () => {
    const f = await fixture();
    let activeStore: OperationalStore | undefined = f.store;
    try {
      const phases: string[] = [];
      const publisher = new ExtensionPackagePublisher({
        store: f.store,
        resources: f.resources,
        artifacts: f.artifacts,
        rootDirectory: join(f.root, "second-exports"),
        afterStatePersisted: (job) => { phases.push(job.state); }
      });
      await publisher.initialize();
      const run = async (id: string) => {
        const exportAuthority = authority(f);
        const prepared = await publisher.prepareStart({ exportId: id, authority: exportAuthority });
        await publisher.completePreparedMutation(prepared, (finalize) => f.store.transaction((transaction) => {
          finalize(transaction);
        }));
        publisher.begin(id, authorityAssertion(f, exportAuthority));
        return publisher.wait(id);
      };
      const first = await run("export-one");
      const second = await run("export-two");
      expect(first.state, first.error).toBe("ready");
      expect(first).toMatchObject({
        state: "ready",
        archiveFormat: "npm-tar-gzip",
        fileName: "sample-exportable-1.2.3.tgz",
        files: 4,
        authority: { packageName: "@sample/exportable", packageVersion: "1.2.3" },
        artifact: { mimeType: "application/gzip" }
      });
      expect(first.artifact?.sha256).toBe(second.artifact?.sha256);
      expect(phases).toEqual([
        "snapshotting", "packaging", "verifying", "ready",
        "snapshotting", "packaging", "verifying", "ready"
      ]);
      const blob = await f.artifacts.readBlob(first.artifact!);
      const archivePath = join(f.root, "inspect.tgz");
      await writeFile(archivePath, blob.data);
      const paths: string[] = [];
      await listTarArchive({ file: archivePath, onReadEntry: (entry) => { paths.push(entry.path); } });
      expect(paths).toEqual([
        "package/.package-note",
        "package/empty/",
        "package/empty/nested/",
        "package/extensions/",
        "package/extensions/index.js",
        "package/node_modules/",
        "package/node_modules/sample-dependency/",
        "package/node_modules/sample-dependency/package.json",
        "package/package.json"
      ]);

      await publisher.close();
      f.store.close();
      activeStore = undefined;
      const restartedStore = new OperationalStore(join(f.root, "orchestrator.db"));
      activeStore = restartedStore;
      const restartedResources = new PiResourceManager({
        store: restartedStore,
        managedRoot: join(f.root, "managed"),
        maximumFiles: 64,
        maximumBytes: 1024 * 1024
      });
      await restartedResources.initialize();
      const restartedArtifacts = new ArtifactStore({
        rootDirectory: join(f.root, "artifacts"),
        repository: new OperationalArtifactRepository(restartedStore),
        ingestRoots: [f.root]
      });
      await restartedArtifacts.initialize();
      const restarted = new ExtensionPackagePublisher({
        store: restartedStore,
        resources: restartedResources,
        artifacts: restartedArtifacts,
        rootDirectory: join(f.root, "second-exports")
      });
      await restarted.initialize();
      expect(restarted.get("export-one")).toEqual(first);
      expect(restarted.recoveredFromCorruption).toBe(false);
    } finally {
      activeStore?.close();
    }
  });

  it("keeps a leased generation through concurrent update and fails the stale export before ready", async () => {
    let releasePackaging!: () => void;
    let packagingReached!: () => void;
    const atPackaging = new Promise<void>((resolve) => { packagingReached = resolve; });
    const continuePackaging = new Promise<void>((resolve) => { releasePackaging = resolve; });
    const f = await fixture({
      afterStatePersisted: async (job) => {
        if (job.state !== "packaging") return;
        packagingReached();
        await continuePackaging;
      }
    });
    try {
      await start(f, "stale-export");
      await atPackaging;
      await writeFile(join(f.source, "extensions", "index.js"), "export default 'two';\n", "utf8");
      await writeFile(join(f.source, "package.json"), JSON.stringify({
        name: "@sample/exportable",
        version: "2.0.0",
        peerDependencies: { "@earendil-works/pi-coding-agent": "^0.84.0" },
        pi: { extensions: ["extensions/index.js"] }
      }), "utf8");
      await f.resources.discover({
        id: f.resource.id,
        backendId: "pi",
        kind: "package",
        scope: "managed",
        source: { kind: "local", path: f.source },
        version: "2.0.0"
      });
      await f.resources.update(f.resource.id, { approvedByConnectionId: "connection-1" });
      expect(await countNamedFiles(join(f.root, "managed"), "package.json")).toBe(4);
      releasePackaging();
      await expect(f.publisher.wait("stale-export")).resolves.toMatchObject({
        state: "failed",
        error: expect.stringMatching(/changed|authority/u)
      });
      expect(await countNamedFiles(join(f.root, "managed"), "package.json")).toBe(2);
      expect(f.resources.get(f.resource.id)).toMatchObject({ version: "2.0.0" });
    } finally {
      releasePackaging?.();
      await f.publisher.close();
      f.store.close();
    }
  });

  it("atomically cancels active work and recovers interrupted or corrupted state without false ready", async () => {
    let releasePackaging!: () => void;
    let packagingReached!: () => void;
    const atPackaging = new Promise<void>((resolve) => { packagingReached = resolve; });
    const continuePackaging = new Promise<void>((resolve) => { releasePackaging = resolve; });
    const f = await fixture({
      afterStatePersisted: async (job) => {
        if (job.state !== "packaging") return;
        packagingReached();
        await continuePackaging;
      }
    });
    let activeStore: OperationalStore | undefined = f.store;
    try {
      await start(f, "cancel-export");
      await atPackaging;
      const observed = f.publisher.get("cancel-export");
      const cancellation = await f.publisher.prepareCancel(observed.id, observed.revision);
      await f.publisher.completePreparedMutation(cancellation, (finalize) => f.store.transaction((transaction) => {
        finalize(transaction);
      }));
      f.publisher.abort(observed.id);
      releasePackaging();
      const cancelled = await f.publisher.wait(observed.id);
      expect(cancelled).toMatchObject({ state: "cancelled" });
      expect(cancelled.artifact).toBeUndefined();

      const interruptedAuthority = authority(f);
      const pending = await f.publisher.prepareStart({ exportId: "restart-export", authority: interruptedAuthority });
      await f.publisher.completePreparedMutation(pending, (finalize) => f.store.transaction((transaction) => {
        finalize(transaction);
      }));
      await f.publisher.close();
      f.store.close();
      activeStore = undefined;

      const restartedStore = new OperationalStore(join(f.root, "orchestrator.db"));
      activeStore = restartedStore;
      const restartedResources = new PiResourceManager({
        store: restartedStore,
        managedRoot: join(f.root, "managed"),
        maximumFiles: 64,
        maximumBytes: 1024 * 1024
      });
      await restartedResources.initialize();
      const restartedArtifacts = new ArtifactStore({
        rootDirectory: join(f.root, "artifacts"),
        repository: new OperationalArtifactRepository(restartedStore),
        ingestRoots: [f.root]
      });
      await restartedArtifacts.initialize();
      const restarted = new ExtensionPackagePublisher({
        store: restartedStore,
        resources: restartedResources,
        artifacts: restartedArtifacts,
        rootDirectory: join(f.root, "exports")
      });
      await restarted.initialize();
      expect(restarted.get("restart-export")).toMatchObject({
        state: "failed",
        error: expect.stringMatching(/restart/u)
      });

      restartedStore.setSetting("service", "orchestrator", "extension_package_exports", {
        format: 1,
        records: [{ unexpected: true }]
      });
      const recovered = new ExtensionPackagePublisher({
        store: restartedStore,
        resources: restartedResources,
        artifacts: restartedArtifacts,
        rootDirectory: join(f.root, "recovered-exports")
      });
      await recovered.initialize();
      expect(recovered.list()).toEqual([]);
      expect(recovered.recoveredFromCorruption).toBe(true);
    } finally {
      releasePackaging?.();
      activeStore?.close();
    }
  });

  it("does not publish ready when the final state write fails", async () => {
    const f = await fixture();
    try {
      let armed = false;
      const original = f.store.setSetting.bind(f.store);
      vi.spyOn(f.store, "setSetting").mockImplementation((...args: Parameters<typeof f.store.setSetting>) => {
        if (armed) {
          armed = false;
          throw new Error("state persistence failed");
        }
        return original(...args);
      });
      const publisher = new ExtensionPackagePublisher({
        store: f.store,
        resources: f.resources,
        artifacts: f.artifacts,
        rootDirectory: join(f.root, "persistence-exports"),
        afterStatePersisted: (job) => { if (job.state === "verifying") armed = true; }
      });
      await publisher.initialize();
      const exportAuthority = authority(f);
      const prepared = await publisher.prepareStart({ exportId: "persist-export", authority: exportAuthority });
      await publisher.completePreparedMutation(prepared, (finalize) => f.store.transaction((transaction) => {
        finalize(transaction);
      }));
      publisher.begin("persist-export", authorityAssertion(f, exportAuthority));
      const failed = await publisher.wait("persist-export");
      expect(failed).toMatchObject({
        state: "failed",
        error: "state persistence failed"
      });
      expect(failed.artifact).toBeUndefined();
    } finally {
      await f.publisher.close();
      f.store.close();
    }
  });

  it("rolls back an uncommitted start and fails closed on installed links or capacity drift", async () => {
    const f = await fixture({ maximumFiles: 4 });
    try {
      const exportAuthority = authority(f);
      const abandoned = await f.publisher.prepareStart({ exportId: "rolled-back", authority: exportAuthority });
      await expect(f.publisher.completePreparedMutation(abandoned, () => {
        throw new Error("operation commit failed");
      })).rejects.toThrow("operation commit failed");
      expect(f.publisher.list()).toEqual([]);

      const packageRoot = await findInstalledPackageRoot(join(f.root, "managed"));
      await writeFile(join(packageRoot, "over-limit.txt"), "extra", "utf8");
      await start(f, "capacity-export", exportAuthority);
      await expect(f.publisher.wait("capacity-export")).resolves.toMatchObject({
        state: "failed",
        error: expect.stringMatching(/limit|maximum|changed|files/u)
      });

      await rm(join(packageRoot, "over-limit.txt"));
      const outside = join(f.root, "outside-link-target");
      await mkdir(outside);
      await symlink(outside, join(packageRoot, "linked-directory"), process.platform === "win32" ? "junction" : "dir");
      await start(f, "linked-export", exportAuthority);
      await expect(f.publisher.wait("linked-export")).resolves.toMatchObject({
        state: "failed",
        error: expect.stringMatching(/link|symbolic|junction|changed/u)
      });
    } finally {
      await f.publisher.close();
      f.store.close();
    }
  });

  it("downgrades a ready job when its persisted Artifact bytes are missing", async () => {
    const f = await fixture();
    try {
      await start(f, "missing-artifact");
      const ready = await f.publisher.wait("missing-artifact");
      expect(ready.state, ready.error).toBe("ready");
      const storagePath = await f.artifacts.resolveBlobPath(ready.artifact!);
      await rm(storagePath);

      const restarted = new ExtensionPackagePublisher({
        store: f.store,
        resources: f.resources,
        artifacts: f.artifacts,
        rootDirectory: join(f.root, "missing-artifact-restart")
      });
      await restarted.initialize();
      const recovered = restarted.get("missing-artifact");
      expect(recovered).toMatchObject({
        state: "failed",
        error: expect.stringMatching(/artifact|missing|unavailable/iu)
      });
      expect(recovered.artifact).toBeUndefined();
    } finally {
      await f.publisher.close();
      f.store.close();
    }
  });
});

async function countNamedFiles(root: string, name: string): Promise<number> {
  let count = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === name) count += 1;
    }
  };
  await visit(root);
  return count;
}

async function findInstalledPackageRoot(root: string): Promise<string> {
  let found: string | undefined;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      const manifestPath = join(path, "package.json");
      const manifest = await readFile(manifestPath, "utf8").then(
        (text) => JSON.parse(text) as { readonly name?: unknown },
        () => undefined
      );
      if (manifest?.name === "@sample/exportable") {
        if (found !== undefined) throw new Error("Fixture has multiple installed package roots.");
        found = path;
      }
      await visit(path);
    }
  };
  await visit(root);
  if (found === undefined) throw new Error("Fixture installed package root was not found.");
  return found;
}
