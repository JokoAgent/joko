import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  ExtensionSourceManager,
  type ExtensionSourceDescriptor,
  type ExtensionSourceEntryDescriptor
} from "./extension-source-manager.js";
import {
  PiResourceManager,
  type PiExtensionSourcePackageInput,
  type PreparedPiExtensionPackageMutation
} from "./resource-manager.js";
import { mkdtemp } from "./test-paths.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `joko-extension-package-${label}-`));
  roots.push(root);
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "0.84.2",
    health: "healthy",
    adapterKind: "pi",
    instanceGeneration: 3,
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
  const sources = new ExtensionSourceManager({
    store,
    cacheRoot: join(root, "source-cache"),
    homeDirectory: root
  });
  const resources = new PiResourceManager({ store, managedRoot: join(root, "managed") });
  await sources.initialize();
  await resources.initialize();
  return { root, store, sources, resources };
}

async function writeCatalog(root: string, catalogName: string, version: string, marker: string): Promise<string> {
  const packageRoot = join(root, "packages", "review");
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await mkdir(join(packageRoot, "extensions"), { recursive: true });
  await writeFile(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: catalogName,
    plugins: [{ name: "Review", source: "packages/review" }]
  }), "utf8");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "@sample/review",
    version,
    description: "Review package",
    peerDependencies: { "@earendil-works/pi-coding-agent": "^0.84.0" },
    scripts: { postinstall: "node setup.js" },
    pi: { extensions: ["extensions/index.ts"] }
  }), "utf8");
  await writeFile(
    join(packageRoot, "extensions", "index.ts"),
    `export default function setup(pi) { pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("review", ${JSON.stringify(marker)})); }\n`,
    "utf8"
  );
  return packageRoot;
}

function sourceLeaseInput(source: ExtensionSourceDescriptor, entry: ExtensionSourceEntryDescriptor) {
  return {
    sourceId: source.id,
    sourceRevision: source.revision,
    entryId: entry.id,
    contentRevision: entry.contentRevision
  };
}

function packageInput(
  source: ExtensionSourceDescriptor,
  entry: ExtensionSourceEntryDescriptor,
  packageRoot: string
): PiExtensionSourcePackageInput {
  return {
    resourceId: entry.resourceId,
    backendId: "pi",
    sourceId: source.id,
    sourceRevision: source.revision,
    sourceIdentity: source.sourceIdentity,
    sourceDisplay: source.sourceDisplay,
    packageRelativePath: entry.packageRelativePath,
    packageContentRevision: entry.packageContentRevision,
    packageName: entry.packageName,
    ...(entry.version === undefined ? {} : { version: entry.version }),
    bindingName: entry.bindingName,
    bindingOrdinal: entry.bindingOrdinal,
    packageRoot
  };
}

async function prepare(
  sources: ExtensionSourceManager,
  resources: PiResourceManager,
  source: ExtensionSourceDescriptor,
  options: {
    readonly expectedAction: "install" | "update" | "replace";
    readonly currentId?: string;
    readonly currentVersion?: bigint;
    readonly allowSourceReplacement?: boolean;
  }
): Promise<PreparedPiExtensionPackageMutation> {
  const entry = source.entries[0]!;
  return sources.withEntry(sourceLeaseInput(source, entry), async (leasedEntry, packageRoot) =>
    resources.prepareExtensionPackage({
      ...packageInput(source, leasedEntry, packageRoot),
      approvedByConnectionId: "connection-1",
      expectedAction: options.expectedAction,
      ...(options.currentId === undefined ? {} : { expectedCurrentResourceId: options.currentId }),
      ...(options.currentVersion === undefined ? {} : { expectedCurrentResourceVersion: options.currentVersion }),
      allowSourceReplacement: options.allowSourceReplacement ?? false
    }));
}

async function commit(
  store: OperationalStore,
  resources: PiResourceManager,
  prepared: PreparedPiExtensionPackageMutation
) {
  return resources.completePreparedMutation(prepared.mutation, (finalize) => store.transaction((tx) => {
    finalize(tx);
    return prepared.mutation.value;
  }));
}

describe("Extension Source package Resource lifecycle", () => {
  it("previews exact dependency facts, installs disabled, preserves enablement on update, and rolls a failed commit back", async () => {
    const { root, store, sources, resources } = await fixture("update");
    let activeStore: OperationalStore | undefined = store;
    try {
      const catalogRoot = join(root, "catalog");
      await writeCatalog(catalogRoot, "review-catalog", "1.0.0", "v1");
      let source = await sources.add({ kind: "local", path: catalogRoot }, 0n);
      const entry = source.entries[0]!;
      const preview = await sources.withEntry(sourceLeaseInput(source, entry), (leasedEntry, packageRoot) =>
        resources.previewExtensionPackage(packageInput(source, leasedEntry, packageRoot)));
      expect(preview).toMatchObject({
        action: "install",
        resourceId: entry.resourceId,
        backendId: "pi",
        packageName: "@sample/review",
        availableVersion: "1.0.0",
        sourceReplacement: false,
        preservesEnabled: false,
        runtimeRequirements: [{ packageName: "@earendil-works/pi-coding-agent", compatible: true }],
        warnings: ["lifecycle-scripts-disabled"],
        disabledLifecycleScripts: ["postinstall"]
      });

      const installed = await commit(store, resources, await prepare(sources, resources, source, { expectedAction: "install" }));
      expect(installed).toMatchObject({
        id: entry.resourceId,
        state: "installed",
        enabled: false,
        sourceKind: "extension_source",
        packageIdentity: "@sample/review",
        extensionSource: { sourceId: source.id, sourceRevision: 1n, packageRelativePath: "packages/review" },
        requiresExtensionApproval: false
      });
      await resources.setEnabled(installed.id, true);

      await writeCatalog(catalogRoot, "review-catalog", "2.0.0", "v2");
      source = await sources.refresh(source.id, source.revision);
      const current = resources.get(installed.id);
      const updatePreview = await sources.withEntry(sourceLeaseInput(source, source.entries[0]!), (leasedEntry, packageRoot) =>
        resources.previewExtensionPackage(packageInput(source, leasedEntry, packageRoot)));
      expect(updatePreview).toMatchObject({
        action: "update",
        installedVersion: "1.0.0",
        availableVersion: "2.0.0",
        sourceReplacement: false,
        preservesEnabled: true,
        currentResource: { resourceId: installed.id, resourceVersion: current.versionNumber }
      });
      const updated = await commit(store, resources, await prepare(sources, resources, source, {
        expectedAction: "update",
        currentId: installed.id,
        currentVersion: current.versionNumber
      }));
      expect(updated).toMatchObject({ version: "2.0.0", enabled: true, requiresExtensionApproval: false });

      await writeCatalog(catalogRoot, "review-catalog", "3.0.0", "v3");
      source = await sources.refresh(source.id, source.revision);
      const beforeRollback = resources.get(installed.id);
      const pending = await prepare(sources, resources, source, {
        expectedAction: "update",
        currentId: installed.id,
        currentVersion: beforeRollback.versionNumber
      });
      await expect(resources.completePreparedMutation(pending.mutation, (finalize) => store.transaction((tx) => {
        finalize(tx);
        throw new Error("operation commit failed");
      }))).rejects.toThrow(/commit failed/u);
      expect(resources.get(installed.id)).toEqual(beforeRollback);
      const installedManifests = await findNamedFiles(join(root, "managed", "packages"), "package.json");
      expect(installedManifests).toHaveLength(1);
      expect(JSON.parse(await readFile(installedManifests[0]!, "utf8"))).toMatchObject({ version: "2.0.0" });

      store.close();
      activeStore = undefined;
      const restartedStore = new OperationalStore(join(root, "orchestrator.db"));
      activeStore = restartedStore;
      const restartedSources = new ExtensionSourceManager({
        store: restartedStore,
        cacheRoot: join(root, "source-cache"),
        homeDirectory: root
      });
      const restartedResources = new PiResourceManager({ store: restartedStore, managedRoot: join(root, "managed") });
      await restartedSources.initialize();
      await restartedResources.initialize();
      expect(restartedSources.get(source.id)).toMatchObject({ revision: 3n, contentRevision: source.contentRevision });
      expect(restartedResources.get(installed.id)).toMatchObject({
        version: "2.0.0",
        enabled: true,
        packageIdentity: "@sample/review",
        extensionSource: {
          sourceId: source.id,
          sourceRevision: 2n,
          packageRelativePath: "packages/review"
        }
      });
    } finally {
      activeStore?.close();
    }
  });

  it("requires explicit source replacement and atomically retires the old package Resource", async () => {
    const { root, store, sources, resources } = await fixture("replace");
    try {
      const firstRoot = join(root, "first-catalog");
      await writeCatalog(firstRoot, "first", "1.0.0", "first");
      const first = await sources.add({ kind: "local", path: firstRoot }, 0n);
      const installed = await commit(store, resources, await prepare(sources, resources, first, { expectedAction: "install" }));
      await resources.setEnabled(installed.id, true);

      const secondRoot = join(root, "second-catalog");
      await writeCatalog(secondRoot, "second", "2.0.0", "second");
      const second = await sources.add({ kind: "local", path: secondRoot }, 1n);
      const secondEntry = second.entries[0]!;
      const replacement = await sources.withEntry(sourceLeaseInput(second, secondEntry), (leasedEntry, packageRoot) =>
        resources.previewExtensionPackage(packageInput(second, leasedEntry, packageRoot)));
      expect(replacement).toMatchObject({
        action: "replace",
        resourceId: secondEntry.resourceId,
        sourceReplacement: true,
        preservesEnabled: true,
        currentResource: { resourceId: installed.id, resourceVersion: resources.get(installed.id).versionNumber }
      });
      await expect(prepare(sources, resources, second, {
        expectedAction: "replace",
        currentId: installed.id,
        currentVersion: resources.get(installed.id).versionNumber
      })).rejects.toThrow(/explicit confirmation/u);

      const replacementPlan = await prepare(sources, resources, second, {
        expectedAction: "replace",
        currentId: installed.id,
        currentVersion: resources.get(installed.id).versionNumber,
        allowSourceReplacement: true
      });
      const replaced = await commit(store, resources, replacementPlan);
      expect(replaced).toMatchObject({ id: secondEntry.resourceId, version: "2.0.0", enabled: true });
      expect(resources.get(installed.id)).toMatchObject({ state: "removed", enabled: false });
      expect(resources.list().filter((item) => item.state !== "removed")).toHaveLength(1);
      expect(await findNamedFiles(join(root, "managed", "packages"), "package.json")).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

async function findNamedFiles(root: string, name: string): Promise<readonly string[]> {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === name) matches.push(path);
    }
  };
  await visit(root);
  return matches.sort((left, right) => left.localeCompare(right, "en"));
}
