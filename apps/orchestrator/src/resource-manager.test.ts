import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";

import type { PiPackageAcquisition, PiPackageAcquisitionRequest } from "./resource-acquisition.js";
import { PiResourceManager } from "./resource-manager.js";

class FakeAcquisition implements PiPackageAcquisition {
  readonly requests: PiPackageAcquisitionRequest[] = [];

  async acquire(request: PiPackageAcquisitionRequest) {
    this.requests.push({ ...request, source: { ...request.source } });
    const packageRoot = join(request.destinationRoot, "package");
    await mkdir(packageRoot, { recursive: true });
    const sourceVersion = request.source.kind === "npm"
      ? request.source.versionSpec ?? "latest"
      : request.source.kind === "git"
        ? request.source.ref ?? "HEAD"
        : "local";
    const extensionPackage = request.source.kind === "npm" && request.source.packageName === "extension-package";
    const dependencyRoot = join(packageRoot, "node_modules", "fake-runtime-dependency");
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({
      name: "fake-package",
      version: sourceVersion,
      dependencies: { "fake-runtime-dependency": "1.0.0" },
      ...(extensionPackage
        ? {
            peerDependencies: { "@earendil-works/pi-coding-agent": "^0.84.0" },
            scripts: { postinstall: "node setup.js" },
            pi: { extensions: ["extensions/index.ts"] }
          }
        : { pi: { skills: ["skills"] } })
    }), "utf8");
    if (extensionPackage) {
      await mkdir(join(packageRoot, "extensions"), { recursive: true });
      await writeFile(
        join(packageRoot, "extensions", "index.ts"),
        `export default function setup(pi) { pi.on("session_start", (_event, ctx) => { ctx.ui.setStatus("version", ${JSON.stringify(sourceVersion)}); ctx.ui.setHeader(() => undefined); }); }\n`,
        "utf8"
      );
    } else {
      await mkdir(join(packageRoot, "skills", "sample"), { recursive: true });
      await writeFile(join(packageRoot, "skills", "sample", "SKILL.md"), "# Sample\n", "utf8");
    }
    await writeFile(join(packageRoot, "index.cjs"), "module.exports = require('fake-runtime-dependency');\n", "utf8");
    await writeFile(join(dependencyRoot, "package.json"), JSON.stringify({ name: "fake-runtime-dependency", version: "1.0.0", main: "index.cjs" }), "utf8");
    await writeFile(join(dependencyRoot, "index.cjs"), `module.exports = ${JSON.stringify(`dependency:${sourceVersion}`)};\n`, "utf8");
    await writeFile(join(packageRoot, "source.txt"), `${request.source.kind}:${sourceVersion}\n`, "utf8");
    return { rootPath: packageRoot, version: sourceVersion };
  }
}

async function fixture(acquisition?: PiPackageAcquisition, backendVersion = "latest-installed") {
  const root = await mkdtemp(join(tmpdir(), "joko-resource-manager-"));
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: backendVersion,
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  const manager = new PiResourceManager({
    store,
    managedRoot: join(root, "managed"),
    ...(acquisition === undefined ? {} : { acquisition })
  });
  await manager.initialize();
  return { root, store, manager };
}

function registerTarget(store: OperationalStore, input: { readonly id: string; readonly root: string; readonly trusted: boolean }): void {
  store.upsertTarget({
    id: input.id,
    backendId: "pi",
    displayName: input.id,
    workspaceRoot: input.root,
    managed: false,
    trusted: input.trusted
  });
}

describe("PiResourceManager", () => {
  it("requires a matching approval revision before install and fences modified installed content", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "skill-source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Safe skill\n", "utf8");
    const discovered = await manager.discover({
      id: "managed-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source },
      name: "Safe skill"
    });

    await expect(manager.install(discovered.id)).rejects.toThrow(/approved/u);
    await expect(manager.approve(discovered.id, "sha256:stale", "connection-1")).rejects.toThrow(/stale/u);
    await manager.approve(discovered.id, discovered.discoveredRevision, "connection-1");
    const installed = await manager.install(discovered.id);
    await manager.setEnabled(installed.id, true);
    const snapshot = await manager.runtimeSnapshot("pi");
    expect(snapshot.skills).toHaveLength(1);
    expect(snapshot.resources).toMatchObject([{
      id: discovered.id,
      state: "approved",
      revision: discovered.discoveredRevision,
      runtimePath: snapshot.skills[0]
    }]);
    expect(snapshot.resources[0]?.resourceVersion).toBe(manager.get(discovered.id).versionNumber);
    expect(await readFile(join(snapshot.skills[0]!, "SKILL.md"), "utf8")).toContain("Safe skill");

    await writeFile(join(snapshot.skills[0]!, "SKILL.md"), "tampered\n", "utf8");
    await expect(manager.runtimeSnapshot("pi")).rejects.toThrow(/changed|fenced/u);
    expect(stringify(store.listSettings())).not.toContain("# Safe skill");
    store.close();
  });

  it("does not authorize a project skill until its exact canonical tree is approved and enabled", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "workspace");
    const skillRoot = join(workspace, ".pi", "skills");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "# Project skill\n", "utf8");
    registerTarget(store, { id: "target-1", root: workspace, trusted: true });
    const candidate = { scope: ".pi" as const, sourcePath: skillRoot, workspaceRoot: workspace };
    expect(await manager.approveProjectSkill(candidate)).toBe(false);
    const discovered = await manager.discover({
      id: "project-skill",
      backendId: "pi",
      targetId: "target-1",
      kind: "skill",
      scope: "project",
      source: { kind: "local", path: skillRoot },
      workspaceRoot: workspace
    });
    await manager.approve(discovered.id, discovered.discoveredRevision, "connection-1");
    expect(await manager.approveProjectSkill(candidate)).toBe(false);
    await manager.setEnabled(discovered.id, true);
    expect(await manager.approveProjectSkill(candidate)).toBe(true);
    await writeFile(join(skillRoot, "SKILL.md"), "changed after approval\n", "utf8");
    expect(await manager.approveProjectSkill(candidate)).toBe(false);
    store.close();
  });

  it("treats a loaded observation for an older installed revision as a no-op", async () => {
    const { root, store, manager } = await fixture();
    registerTarget(store, { id: "target-runtime", root, trusted: true });
    store.createSession({
      id: "session-runtime",
      backendId: "pi",
      targetId: "target-runtime",
      title: "Runtime",
      binding: { opaqueRef: "native/runtime.jsonl", generation: 3 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    const source = join(root, "versioned-extension.js");
    await writeFile(source, "export default function v1() {}\n", "utf8");
    const discovered = await manager.discover({
      id: "versioned-extension",
      backendId: "pi",
      kind: "extension",
      scope: "managed",
      source: { kind: "local", path: source },
      name: "Versioned extension"
    });
    await manager.approve(discovered.id, discovered.discoveredRevision, "connection-1");
    await manager.install(discovered.id);
    await manager.setEnabled(discovered.id, true);
    const [captured] = (await manager.runtimeSnapshot("pi")).resources;
    const observation = {
      discoveredRevision: captured!.revision!,
      resourceVersion: captured!.resourceVersion!,
      sessionId: "session-runtime",
      runtimeGeneration: 3
    };
    const loaded = await manager.markLoaded(discovered.id, true, undefined, observation);
    expect(loaded.state).toBe("loaded");

    // Same content, but a later disable/enable is a different installed
    // incarnation. The old runtime may not promote it again.
    await manager.setEnabled(discovered.id, false);
    await manager.setEnabled(discovered.id, true);
    const sameContentFenced = await manager.markLoaded(discovered.id, true, undefined, observation);
    expect(sameContentFenced.state).toBe("installed");

    const [beforeRestart] = (await manager.runtimeSnapshot("pi")).resources;
    const preRestartObservation = {
      discoveredRevision: beforeRestart!.revision!,
      resourceVersion: beforeRestart!.resourceVersion!,
      sessionId: "session-runtime",
      runtimeGeneration: 3
    };
    const session = store.getSession("session-runtime");
    store.updateSession("session-runtime", {
      binding: { ...session.descriptor.binding, generation: 4 }
    }, session.revision);
    const oldGenerationFenced = await manager.markLoaded(discovered.id, true, undefined, preRestartObservation);
    expect(oldGenerationFenced.state).toBe("installed");

    await writeFile(source, "export default function v2() {}\n", "utf8");
    const replacement = await manager.update(discovered.id, { approvedByConnectionId: "connection-1" });
    await manager.setEnabled(replacement.id, true);
    const fenced = await manager.markLoaded(replacement.id, true, undefined, observation);

    expect(fenced.discoveredRevision).toBe(replacement.discoveredRevision);
    expect(fenced.discoveredRevision).not.toBe(observation.discoveredRevision);
    expect(fenced.state).toBe("installed");
    expect(manager.get(replacement.id).state).toBe("installed");
    store.close();
  });

  it("discovers conventional project resources only for an explicitly trusted Target and keeps discovery inert", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
    await mkdir(join(workspace, ".pi", "skills", "review"), { recursive: true });
    await mkdir(join(workspace, ".pi", "prompts"), { recursive: true });
    await mkdir(join(workspace, ".pi", "themes"), { recursive: true });
    await writeFile(join(workspace, ".pi", "extensions", "audit.ts"), "export default () => {};\n", "utf8");
    await writeFile(join(workspace, ".pi", "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await writeFile(join(workspace, ".pi", "prompts", "review.md"), "Review this.\n", "utf8");
    await writeFile(join(workspace, ".pi", "themes", "night.json"), "{}\n", "utf8");
    registerTarget(store, { id: "target-project", root: workspace, trusted: false });

    await expect(manager.discoverProjectResources({ backendId: "pi", targetId: "target-project" })).rejects.toThrow(/trusted/u);
    registerTarget(store, { id: "target-project", root: workspace, trusted: true });
    const discovered = await manager.discoverProjectResources({ backendId: "pi", targetId: "target-project" });
    expect(discovered.map((resource) => resource.kind).sort()).toEqual(["extension", "prompt", "skill", "theme"]);
    expect(discovered.every((resource) => resource.state === "awaiting_approval" && !resource.enabled)).toBe(true);
    const theme = discovered.find((resource) => resource.kind === "theme");
    expect(theme).toMatchObject({
      canToggle: false,
      postMutationNotice: true,
      resourceDetails: [{
        kind: "theme",
        compatibility: "unsupported",
        compatibilityIssues: ["theme-control"]
      }]
    });
    expect((await manager.targetRuntimeSnapshot("pi", "target-project")).resources).toEqual([]);

    const same = await manager.discoverProjectResources({ backendId: "pi", targetId: "target-project" });
    expect(same.map((resource) => resource.id)).toEqual(discovered.map((resource) => resource.id));
    expect(same.map((resource) => resource.versionNumber)).toEqual(discovered.map((resource) => resource.versionNumber));
    await manager.approve(theme!.id, theme!.discoveredRevision, "connection-owner");
    await expect(manager.setEnabled(theme!.id, true)).rejects.toThrow(/headless-compatible/u);
    store.close();
  });

  it("fences approved project resources immediately when Target trust is revoked", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "workspace");
    const skill = join(workspace, ".pi", "skills", "safe");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Safe\n", "utf8");
    registerTarget(store, { id: "target-trust", root: workspace, trusted: true });
    const [resource] = await manager.discoverProjectResources({ backendId: "pi", targetId: "target-trust" });
    await manager.approve(resource!.id, resource!.discoveredRevision, "connection-owner");
    await manager.setEnabled(resource!.id, true);
    expect((await manager.targetRuntimeSnapshot("pi", "target-trust")).skills).toHaveLength(1);

    registerTarget(store, { id: "target-trust", root: workspace, trusted: false });
    await expect(manager.targetRuntimeSnapshot("pi", "target-trust")).rejects.toThrow(/not trusted/u);
    await expect(manager.setEnabled(resource!.id, true)).rejects.toThrow(/not trusted/u);
    store.close();
  });

  it("fails closed when a resource tree contains a symlink", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "unsafe-resource");
    const outside = join(root, "outside.txt");
    await mkdir(source);
    await writeFile(outside, "outside", "utf8");
    try {
      await symlink(outside, join(source, "alias.txt"), "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        store.close();
        return;
      }
      throw error;
    }
    await expect(manager.discover({
      backendId: "pi",
      kind: "extension",
      scope: "managed",
      source: { kind: "local", path: source }
    })).rejects.toThrow(/symlink|junction/u);
    store.close();
  });

  it("keeps npm/git acquisition inert until owner approval and supports install, update, and remove", async () => {
    const acquisition = new FakeAcquisition();
    const { store, manager } = await fixture(acquisition);
    const npm = await manager.discoverPackage({
      id: "npm-package",
      backendId: "pi",
      scope: "global",
      source: { kind: "npm", packageName: "@joko/example", versionSpec: "1.0.0" }
    });
    expect(acquisition.requests).toEqual([]);
    await expect(manager.install(npm.id)).rejects.toThrow(/approved/u);
    expect(acquisition.requests).toEqual([]);

    await manager.approve(npm.id, npm.discoveredRevision, "owner-connection");
    const installed = await manager.install(npm.id);
    expect(acquisition.requests).toHaveLength(1);
    expect(acquisition.requests[0]).toMatchObject({ action: "install", source: { kind: "npm", versionSpec: "1.0.0" } });
    expect(installed.version).toBe("1.0.0");

    const updated = await manager.update(npm.id, {
      requestedVersion: "2.0.0",
      approvedByConnectionId: "owner-connection"
    });
    expect(acquisition.requests).toHaveLength(2);
    expect(acquisition.requests[1]).toMatchObject({ action: "update", source: { kind: "npm", versionSpec: "2.0.0" } });
    expect(updated.version).toBe("2.0.0");
    await manager.setEnabled(npm.id, true);
    const [packagePath] = (await manager.runtimeSnapshot("pi")).packages;
    expect(createRequire(join(packagePath!, "index.cjs"))(join(packagePath!, "index.cjs"))).toBe("dependency:2.0.0");
    expect((await manager.remove(npm.id)).state).toBe("removed");

    const git = await manager.discoverPackage({
      id: "git-package",
      backendId: "pi",
      scope: "managed",
      source: { kind: "git", repositoryUrl: "https://example.test/org/repo.git", ref: "v1" }
    });
    await manager.approve(git.id, git.discoveredRevision, "owner-connection");
    await manager.install(git.id);
    await manager.update(git.id, {
      source: { kind: "git", repositoryUrl: "https://example.test/org/repo.git", ref: "v2" },
      approvedByConnectionId: "owner-connection"
    });
    expect(acquisition.requests.slice(-2)).toMatchObject([
      { action: "install", source: { kind: "git", ref: "v1" } },
      { action: "update", source: { kind: "git", ref: "v2" } }
    ]);
    expect((await manager.remove(git.id)).state).toBe("removed");
    store.close();
  });

  it("requires a fresh installed-byte approval whenever an acquired extension package changes", async () => {
    const acquisition = new FakeAcquisition();
    const { store, manager } = await fixture(acquisition, "0.84.2");
    const discovered = await manager.discoverPackage({
      id: "extension-package",
      backendId: "pi",
      scope: "global",
      source: { kind: "npm", packageName: "extension-package", versionSpec: "1.0.0" }
    });
    await manager.approve(discovered.id, discovered.discoveredRevision, "owner-connection");
    const installed = await manager.install(discovered.id);

    expect(installed).toMatchObject({
      state: "installed",
      canToggle: true,
      requiresExtensionApproval: true,
      postMutationNotice: true,
      warnings: ["lifecycle-scripts-disabled"],
      disabledLifecycleScripts: ["postinstall"],
      runtimeRequirements: [{ compatible: true }]
    });
    expect(installed.extensionContentFingerprint).toBe(installed.discoveredRevision);
    expect(installed.resourceDetails).toMatchObject([{
      kind: "extension",
      compatibility: "partial",
      adaptedApis: ["setStatus"],
      unsupportedApis: ["setHeader"],
      compatibilityIssues: ["tui-layout"]
    }]);
    await expect(manager.setEnabled(installed.id, true)).rejects.toThrow(/fingerprint|approved/u);

    const contentApproved = await manager.approve(installed.id, installed.discoveredRevision, "owner-connection");
    expect(contentApproved.requiresExtensionApproval).toBe(false);
    await manager.setEnabled(contentApproved.id, true);

    const updated = await manager.update(contentApproved.id, {
      requestedVersion: "2.0.0",
      approvedByConnectionId: "owner-connection"
    });
    expect(updated.version).toBe("2.0.0");
    expect(updated.requiresExtensionApproval).toBe(true);
    expect(updated.extensionContentFingerprint).not.toBe(installed.extensionContentFingerprint);
    await expect(manager.setEnabled(updated.id, true)).rejects.toThrow(/fingerprint|approved/u);
    store.close();
  });

  it("requires trusted project ownership before acquisition and exposes all four scopes", async () => {
    const acquisition = new FakeAcquisition();
    const { root, store, manager } = await fixture(acquisition);
    const workspace = join(root, "workspace-project-package");
    await mkdir(workspace);
    registerTarget(store, { id: "target-package", root: workspace, trusted: false });

    await expect(manager.discoverPackage({
      id: "project-npm",
      backendId: "pi",
      targetId: "target-package",
      scope: "project",
      source: { kind: "npm", packageName: "same-package", versionSpec: "2.0.0" }
    })).rejects.toThrow(/not trusted/u);
    expect(acquisition.requests).toEqual([]);

    registerTarget(store, { id: "target-package", root: workspace, trusted: true });
    const project = await manager.discoverPackage({
      id: "project-npm",
      backendId: "pi",
      targetId: "target-package",
      scope: "project",
      source: { kind: "npm", packageName: "same-package", versionSpec: "2.0.0" }
    });
    expect(acquisition.requests).toEqual([]);
    await expect(manager.install(project.id)).rejects.toThrow(/approved/u);
    expect(acquisition.requests).toEqual([]);
    await manager.approve(project.id, project.discoveredRevision, "owner-connection");
    await manager.install(project.id);
    await manager.setEnabled(project.id, true);

    for (const scope of ["user", "global", "managed"] as const) {
      const source = join(root, `${scope}-resource.js`);
      await writeFile(source, `export default ${JSON.stringify(scope)};\n`, "utf8");
      const discovered = await manager.discover({
        backendId: "pi",
        kind: "extension",
        scope,
        source: { kind: "local", path: source }
      });
      await manager.approve(discovered.id, discovered.discoveredRevision, "owner-connection");
      await manager.install(discovered.id);
    }
    expect(new Set(manager.list().map((item) => item.scope))).toEqual(new Set(["user", "global", "project", "managed"]));
    expect((await manager.targetRuntimeSnapshot("pi", "target-package")).resources).toMatchObject([
      { id: "project-npm", source: "npm:same-package" }
    ]);
    store.close();
  });

  it("rejects credential-bearing typed sources before persistence or acquisition", async () => {
    const acquisition = new FakeAcquisition();
    const { store, manager } = await fixture(acquisition);
    const canary = "PI_RES_CREDENTIAL_CANARY";
    await expect(manager.discoverPackage({
      backendId: "pi",
      scope: "global",
      source: { kind: "git", repositoryUrl: `https://${canary}@example.test/org/repo.git` }
    })).rejects.toThrow(/credentials/u);
    expect(acquisition.requests).toEqual([]);
    expect(stringify(store.listSettings())).not.toContain(canary);
    store.close();
  });

  it("rejects persisted resources missing fields from the current catalog shape", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "strict-catalog-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Strict catalog\n", "utf8");
    await manager.discover({
      id: "strict-catalog-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    const catalog = store.getSetting<{
      readonly format: 1;
      readonly records: readonly Record<string, unknown>[];
    }>("service", "orchestrator", "pi_resource_catalog").value;
    const record = catalog.records[0]!;

    for (const field of [
      "resourceDetails",
      "runtimeRequirements",
      "warnings",
      "disabledLifecycleScripts",
      "canToggle",
      "requiresExtensionApproval",
      "postMutationNotice",
      "canonicalPathFingerprint",
      "discoveredRevision"
    ] as const) {
      const { [field]: _missing, ...incomplete } = record;
      store.setSetting("service", "orchestrator", "pi_resource_catalog", { format: 1, records: [incomplete] });
      const reloaded = new PiResourceManager({ store, managedRoot: join(root, "managed") });
      await expect(reloaded.initialize()).rejects.toThrow(/malformed/u);
    }
    store.close();
  });
});

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
