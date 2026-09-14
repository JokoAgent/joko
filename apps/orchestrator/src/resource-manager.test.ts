import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

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
  registerBackend(store, "pi", "Pi", backendVersion);
  const manager = new PiResourceManager({
    store,
    managedRoot: join(root, "managed"),
    ...(acquisition === undefined ? {} : { acquisition })
  });
  await manager.initialize();
  return { root, store, manager };
}

function registerBackend(
  store: OperationalStore,
  id: string,
  displayName = id,
  version = "latest-installed"
): void {
  store.upsertBackend({
    id,
    displayName,
    version,
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
}

function registerTarget(store: OperationalStore, input: {
  readonly id: string;
  readonly root: string;
  readonly trusted: boolean;
  readonly backendId?: string;
}): void {
  store.upsertTarget({
    id: input.id,
    backendId: input.backendId ?? "pi",
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

  it("keeps prepared discovery inert and restores memory when the enclosing Store transaction rolls back", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "prepared-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Prepared\n", "utf8");
    const settingBefore = store.findSetting("service", "orchestrator", "pi_resource_catalog");

    const prepared = await manager.prepareDiscover({
      id: "prepared-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    expect(prepared.value).toMatchObject({ id: "prepared-skill", state: "awaiting_approval" });
    expect(manager.list()).toEqual([]);
    expect(store.findSetting("service", "orchestrator", "pi_resource_catalog")).toEqual(settingBefore);

    await expect(manager.completePreparedMutation(prepared, () => undefined)).rejects.toThrow(/did not adopt/u);

    await expect(manager.completePreparedMutation(prepared, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      expect(manager.get("prepared-skill").state).toBe("awaiting_approval");
      throw new Error("outer commit failed");
    }))).rejects.toThrow(/outer commit failed/u);
    expect(manager.list()).toEqual([]);
    expect(store.findSetting("service", "orchestrator", "pi_resource_catalog")).toEqual(settingBefore);

    const adopted = await manager.completePreparedMutation(prepared, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      return prepared.value;
    }));
    expect(adopted.id).toBe("prepared-skill");
    expect(manager.get("prepared-skill").versionNumber).toBe(1n);
    await expect(manager.completePreparedMutation(prepared, () => undefined)).rejects.toThrow(/already completed/u);
    store.close();
  });

  it("stages approval and enablement until their exact catalog incarnations are adopted", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "prepared-lifecycle-workspace");
    const source = join(workspace, ".pi", "skills", "prepared-lifecycle");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Lifecycle\n", "utf8");
    registerTarget(store, { id: "prepared-lifecycle-target", root: workspace, trusted: true });
    const discovered = await manager.discover({
      id: "prepared-lifecycle",
      backendId: "pi",
      targetId: "prepared-lifecycle-target",
      kind: "skill",
      scope: "project",
      source: { kind: "local", path: source },
      workspaceRoot: workspace
    });

    const approval = await manager.prepareApprove(discovered.id, discovered.discoveredRevision, "connection-owner");
    expect(manager.get(discovered.id).state).toBe("awaiting_approval");
    await manager.completePreparedMutation(approval, (finalize) => store.transaction((transaction) => finalize(transaction)));
    expect(manager.get(discovered.id)).toMatchObject({ state: "approved", enabled: false });

    const enablement = await manager.prepareSetEnabled(discovered.id, true);
    expect(manager.get(discovered.id).enabled).toBe(false);
    await manager.completePreparedMutation(enablement, (finalize) => store.transaction((transaction) => finalize(transaction)));
    expect(manager.get(discovered.id)).toMatchObject({ state: "approved", enabled: true });
    store.close();
  });

  it("allows archived Targets but fences prepared project discovery when the Target is deleted", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "archived-target-workspace");
    const prompt = join(workspace, ".pi", "prompts", "archived.md");
    await mkdir(join(workspace, ".pi", "prompts"), { recursive: true });
    await writeFile(prompt, "Archived remains addressable.\n", "utf8");
    registerTarget(store, { id: "archived-resource-target", root: workspace, trusted: true });
    const descriptor = store.getTarget("archived-resource-target").descriptor;
    store.upsertTarget(descriptor, { state: "archived" });

    const prepared = await manager.prepareDiscoverProjectResources({
      backendId: "pi",
      targetId: descriptor.id,
      kinds: ["prompt"]
    });
    expect(prepared.value).toHaveLength(1);
    store.upsertTarget(descriptor, { state: "archived", deletedAt: 10 });
    await expect(manager.completePreparedMutation(prepared, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
    }))).rejects.toThrow(/deleted/u);
    expect(manager.list()).toEqual([]);
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

    const kinds = ["extension", "skill", "prompt", "theme"] as const;
    await expect(manager.discoverProjectResources({ backendId: "pi", targetId: "target-project", kinds })).rejects.toThrow(/trusted/u);
    registerTarget(store, { id: "target-project", root: workspace, trusted: true });
    const discovered = await manager.discoverProjectResources({ backendId: "pi", targetId: "target-project", kinds });
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

    const same = await manager.discoverProjectResources({ backendId: "pi", targetId: "target-project", kinds });
    expect(same.map((resource) => resource.id)).toEqual(discovered.map((resource) => resource.id));
    expect(same.map((resource) => resource.versionNumber)).toEqual(discovered.map((resource) => resource.versionNumber));
    await manager.approve(theme!.id, theme!.discoveredRevision, "connection-owner");
    await expect(manager.setEnabled(theme!.id, true)).rejects.toThrow(/headless-compatible/u);
    store.close();
  });

  it("adopts a prepared project discovery batch atomically when a later candidate becomes stale", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "atomic-discovery-workspace");
    const prompts = join(workspace, ".pi", "prompts");
    await mkdir(prompts, { recursive: true });
    const firstPath = join(prompts, "a.md");
    const lastPath = join(prompts, "z.md");
    await writeFile(firstPath, "First\n", "utf8");
    await writeFile(lastPath, "Last v1\n", "utf8");
    registerTarget(store, { id: "atomic-discovery-target", root: workspace, trusted: true });

    const prepared = await manager.prepareDiscoverProjectResources({
      backendId: "pi",
      targetId: "atomic-discovery-target",
      kinds: ["prompt"]
    });
    expect(prepared.value.map((resource) => resource.name)).toEqual(["a.md", "z.md"]);
    expect(manager.list()).toEqual([]);

    await writeFile(lastPath, "Last v2\n", "utf8");
    const lastPrepared = prepared.value.at(-1)!;
    const winner = await manager.discover({
      id: lastPrepared.id,
      backendId: "pi",
      targetId: "atomic-discovery-target",
      kind: "prompt",
      scope: "project",
      source: { kind: "local", path: lastPath },
      workspaceRoot: workspace
    });
    await expect(manager.completePreparedMutation(prepared, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
    }))).rejects.toThrow(/stale/u);

    expect(manager.list().map((resource) => resource.id)).toEqual([winner.id]);
    expect(manager.list().some((resource) => resource.id === prepared.value[0]!.id)).toBe(false);
    const catalog = store.getSetting<{ readonly records: readonly { readonly id: string }[] }>(
      "service",
      "orchestrator",
      "pi_resource_catalog"
    );
    expect(catalog.value.records.map((record) => record.id)).toEqual([winner.id]);
    store.close();
  });

  it("enumerates only Backend-advertised project resource kinds", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "filtered-workspace");
    await mkdir(join(workspace, ".pi", "prompts"), { recursive: true });
    await writeFile(join(workspace, ".pi", "prompts", "review.md"), "Review this.\n", "utf8");
    await writeFile(join(workspace, ".pi", "extensions"), "not a directory\n", "utf8");
    await writeFile(join(workspace, ".agents"), "not a directory\n", "utf8");
    registerTarget(store, { id: "target-filtered", root: workspace, trusted: true });

    await expect(manager.discoverProjectResources({
      backendId: "pi",
      targetId: "target-filtered",
      kinds: []
    })).rejects.toThrow(/at least one/u);
    const discovered = await manager.discoverProjectResources({
      backendId: "pi",
      targetId: "target-filtered",
      kinds: ["prompt"]
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({ kind: "prompt", name: "review.md" });
    store.close();
  });

  it("fences approved project resources immediately when Target trust is revoked", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "workspace");
    const skill = join(workspace, ".pi", "skills", "safe");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Safe\n", "utf8");
    registerTarget(store, { id: "target-trust", root: workspace, trusted: true });
    const [resource] = await manager.discoverProjectResources({ backendId: "pi", targetId: "target-trust", kinds: ["skill"] });
    await manager.approve(resource!.id, resource!.discoveredRevision, "connection-owner");
    await manager.setEnabled(resource!.id, true);
    expect((await manager.targetRuntimeSnapshot("pi", "target-trust")).skills).toHaveLength(1);

    registerTarget(store, { id: "target-trust", root: workspace, trusted: false });
    await expect(manager.targetRuntimeSnapshot("pi", "target-trust")).rejects.toThrow(/not trusted/u);
    await expect(manager.setEnabled(resource!.id, true)).rejects.toThrow(/not trusted/u);
    store.close();
  });

  it("keeps redundant disable inert so it cannot approve or resurrect a project resource", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "workspace-disable-inert");
    const skill = join(workspace, ".pi", "skills", "inert");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Inert\n", "utf8");
    registerTarget(store, { id: "target-disable-inert", root: workspace, trusted: true });

    const discovered = await manager.discover({
      id: "project-disable-inert",
      backendId: "pi",
      targetId: "target-disable-inert",
      kind: "skill",
      scope: "project",
      source: { kind: "local", path: skill },
      workspaceRoot: workspace
    });
    const redundantDisable = await manager.setEnabled(discovered.id, false);
    expect(redundantDisable).toEqual(discovered);
    await expect(manager.setEnabled(discovered.id, true)).rejects.toThrow(/not approved/u);

    const removed = await manager.remove(discovered.id);
    expect(await manager.setEnabled(discovered.id, false)).toEqual(removed);
    expect(manager.get(discovered.id).state).toBe("removed");
    store.close();
  });

  it("captures path-free prompt and skill text for one exact Backend Target and retains synchronous authority", async () => {
    const { root, store, manager } = await fixture();
    registerBackend(store, "claude", "Claude");
    registerBackend(store, "empty-backend", "Empty");
    const workspace = join(root, "claude-workspace");
    const otherWorkspace = join(root, "other-claude-workspace");
    const untrustedWorkspace = join(root, "untrusted-claude-workspace");
    const emptyWorkspace = join(root, "empty-workspace");
    await mkdir(workspace);
    await mkdir(otherWorkspace);
    await mkdir(untrustedWorkspace);
    await mkdir(emptyWorkspace);
    registerTarget(store, { id: "claude-target", backendId: "claude", root: workspace, trusted: true });
    registerTarget(store, { id: "other-claude-target", backendId: "claude", root: otherWorkspace, trusted: true });
    registerTarget(store, { id: "untrusted-claude-target", backendId: "claude", root: untrustedWorkspace, trusted: false });
    registerTarget(store, { id: "empty-target", backendId: "empty-backend", root: emptyWorkspace, trusted: false });

    const promptSource = join(root, "global-release-prompt.md");
    await writeFile(promptSource, "Prepare the release.\n", "utf8");
    const prompt = await manager.discover({
      id: "claude-global-prompt",
      backendId: "claude",
      kind: "prompt",
      scope: "global",
      source: { kind: "local", path: promptSource },
      name: "Global prompt",
      version: "1.2.3"
    });
    await manager.approve(prompt.id, prompt.discoveredRevision, "connection-owner");
    await manager.install(prompt.id);
    await manager.setEnabled(prompt.id, true);

    const skillRoot = join(workspace, ".claude", "skills", "release");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "# Target release skill\n", "utf8");
    const skill = await manager.discover({
      id: "claude-target-skill",
      backendId: "claude",
      targetId: "claude-target",
      kind: "skill",
      scope: "project",
      source: { kind: "local", path: skillRoot },
      workspaceRoot: workspace,
      name: "Target skill"
    });
    await manager.approve(skill.id, skill.discoveredRevision, "connection-owner");
    await manager.setEnabled(skill.id, true);

    const foreignPromptPath = join(otherWorkspace, "foreign.md");
    await writeFile(foreignPromptPath, "Foreign target only.\n", "utf8");
    const foreign = await manager.discover({
      id: "claude-foreign-prompt",
      backendId: "claude",
      targetId: "other-claude-target",
      kind: "prompt",
      scope: "project",
      source: { kind: "local", path: foreignPromptPath },
      workspaceRoot: otherWorkspace,
      name: "Foreign prompt"
    });
    await manager.approve(foreign.id, foreign.discoveredRevision, "connection-owner");
    await manager.setEnabled(foreign.id, true);

    const lifetime = new AbortController();
    const snapshot = await manager.runtimeTextSnapshot("claude", "claude-target", lifetime.signal);
    expect(snapshot.map((seed) => ({
      id: seed.id,
      kind: seed.kind,
      name: seed.name,
      revision: seed.revision,
      resourceVersion: seed.resourceVersion,
      version: seed.version,
      content: seed.content
    }))).toEqual([
      {
        id: prompt.id,
        kind: "prompt",
        name: "Global prompt",
        revision: prompt.discoveredRevision,
        resourceVersion: manager.get(prompt.id).versionNumber,
        version: "1.2.3",
        content: "Prepare the release.\n"
      },
      {
        id: skill.id,
        kind: "skill",
        name: "Target skill",
        revision: skill.discoveredRevision,
        resourceVersion: manager.get(skill.id).versionNumber,
        version: undefined,
        content: "# Target release skill\n"
      }
    ]);
    expect(snapshot.map((seed) => seed.id)).not.toContain(foreign.id);
    expect(snapshot.every((seed) => !("path" in seed) && !("runtimePath" in seed))).toBe(true);
    expect(stringify(snapshot)).not.toContain(promptSource);
    expect(stringify(snapshot)).not.toContain(skillRoot);
    for (const seed of snapshot) expect(() => seed.assertCurrent()).not.toThrow();
    store.createSession({
      id: "claude-resource-runtime",
      backendId: "claude",
      targetId: "claude-target",
      title: "Claude resource runtime",
      binding: { opaqueRef: "native/claude-resource-runtime.jsonl", generation: 7 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    for (const seed of snapshot) {
      await manager.markLoaded(seed.id, true, undefined, {
        discoveredRevision: seed.revision,
        resourceVersion: seed.resourceVersion,
        sessionId: "claude-resource-runtime",
        runtimeGeneration: 7
      });
      expect(() => seed.assertCurrent()).not.toThrow();
    }
    lifetime.abort(new Error("snapshot caller finished"));
    for (const seed of snapshot) expect(() => seed.assertCurrent()).not.toThrow();
    const activePromptVersion = manager.get(prompt.id).versionNumber;
    await writeFile(promptSource, "Prepare the release with the new checklist.\n", "utf8");
    const pendingPrompt = await manager.discover({
      id: prompt.id,
      backendId: "claude",
      kind: "prompt",
      scope: "global",
      name: "Global prompt",
      version: "1.2.3",
      source: { kind: "local", path: promptSource }
    });
    expect(pendingPrompt).toMatchObject({
      state: "update_available",
      enabled: true,
      discoveredRevision: prompt.discoveredRevision,
      versionNumber: activePromptVersion
    });
    expect(manager.list({ state: "update_available" }).map((resource) => resource.id)).toEqual([prompt.id]);
    expect(manager.list({ state: "installed" }).map((resource) => resource.id)).not.toContain(prompt.id);
    expect(() => snapshot.find((seed) => seed.id === prompt.id)!.assertCurrent()).not.toThrow();
    await expect(manager.runtimeTextSnapshot("claude", "claude-target", new AbortController().signal))
      .resolves.toMatchObject([{ id: prompt.id, content: "Prepare the release.\n" }, { id: skill.id }]);
    await expect(manager.runtimeTextSnapshot("claude", "untrusted-claude-target", new AbortController().signal))
      .resolves.toMatchObject([{ id: prompt.id, content: "Prepare the release.\n" }]);
    await expect(manager.runtimeTextSnapshot("empty-backend", "empty-target", new AbortController().signal))
      .resolves.toEqual([]);

    const cancelled = new AbortController();
    cancelled.abort(new Error("snapshot cancelled"));
    await expect(manager.runtimeTextSnapshot("claude", "claude-target", cancelled.signal))
      .rejects.toThrow(/snapshot cancelled/u);

    await manager.setEnabled(prompt.id, false);
    expect(() => snapshot.find((seed) => seed.id === prompt.id)!.assertCurrent()).toThrow(/no longer current/u);
    expect(() => snapshot.find((seed) => seed.id === skill.id)!.assertCurrent()).not.toThrow();
    registerTarget(store, { id: "claude-target", backendId: "claude", root: workspace, trusted: false });
    expect(() => snapshot.find((seed) => seed.id === skill.id)!.assertCurrent()).toThrow(/not trusted/u);
    await expect(manager.runtimeTextSnapshot("claude", "claude-target", new AbortController().signal))
      .rejects.toThrow(/not trusted/u);
    store.close();
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xff, 0xfe, 0xfd]), /valid UTF-8/u],
    ["oversized text", Buffer.alloc(256 * 1024 + 1, 0x61), /bounded regular UTF-8/u]
  ])("rejects %s prompt content from a fully approved resource", async (_label, content, expected) => {
    const { root, store, manager } = await fixture();
    registerBackend(store, "claude", "Claude");
    const workspace = join(root, "claude-text-workspace");
    await mkdir(workspace);
    registerTarget(store, { id: "claude-text-target", backendId: "claude", root: workspace, trusted: true });
    const source = join(root, `unsafe-prompt-${String(_label).replaceAll(" ", "-")}.md`);
    await writeFile(source, content);
    const prompt = await manager.discover({
      backendId: "claude",
      kind: "prompt",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    await manager.approve(prompt.id, prompt.discoveredRevision, "connection-owner");
    await manager.install(prompt.id);
    await manager.setEnabled(prompt.id, true);

    await expect(manager.runtimeTextSnapshot("claude", "claude-text-target", new AbortController().signal))
      .rejects.toThrow(expected);
    store.close();
  });

  it("revalidates the complete skill tree and rejects a late symlink escape", async () => {
    const { root, store, manager } = await fixture();
    registerBackend(store, "claude", "Claude");
    const workspace = join(root, "claude-tree-workspace");
    const skillRoot = join(workspace, ".claude", "skills", "tree-proof");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "# Stable body\n", "utf8");
    const sibling = join(skillRoot, "evidence.txt");
    await writeFile(sibling, "approved evidence\n", "utf8");
    registerTarget(store, { id: "claude-tree-target", backendId: "claude", root: workspace, trusted: true });
    const skill = await manager.discover({
      backendId: "claude",
      targetId: "claude-tree-target",
      kind: "skill",
      scope: "project",
      source: { kind: "local", path: skillRoot },
      workspaceRoot: workspace
    });
    await manager.approve(skill.id, skill.discoveredRevision, "connection-owner");
    await manager.setEnabled(skill.id, true);
    await expect(manager.runtimeTextSnapshot("claude", "claude-tree-target", new AbortController().signal))
      .resolves.toMatchObject([{ content: "# Stable body\n" }]);

    await writeFile(sibling, "changed evidence\n", "utf8");
    await expect(manager.runtimeTextSnapshot("claude", "claude-tree-target", new AbortController().signal))
      .rejects.toThrow(/changed after approval/u);
    await writeFile(sibling, "approved evidence\n", "utf8");
    const outside = join(root, "outside-skill.md");
    await writeFile(outside, "outside\n", "utf8");
    const manifest = join(skillRoot, "SKILL.md");
    await rm(manifest);
    try {
      await symlink(outside, manifest, "file");
    } catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")) {
        store.close();
        return;
      }
      throw error;
    }
    await expect(manager.runtimeTextSnapshot("claude", "claude-tree-target", new AbortController().signal))
      .rejects.toThrow(/symlink|junction/u);
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

  it("cleans a failed installation candidate without publishing catalog state", async () => {
    const acquisition: PiPackageAcquisition = {
      async acquire(request) {
        await mkdir(request.destinationRoot, { recursive: true });
        await writeFile(join(request.destinationRoot, "partial.txt"), "partial\n", "utf8");
        throw new Error("acquisition failed");
      }
    };
    const { root, store, manager } = await fixture(acquisition);
    const discovered = await manager.discoverPackage({
      id: "failed-install-package",
      backendId: "pi",
      scope: "managed",
      source: { kind: "npm", packageName: "failed-install-package", versionSpec: "1.0.0" }
    });
    await manager.approve(discovered.id, discovered.discoveredRevision, "connection-owner");
    const catalogBefore = stringify(store.getSetting("service", "orchestrator", "pi_resource_catalog").value);

    await expect(manager.prepareInstall(discovered.id)).rejects.toThrow(/acquisition failed/u);

    expect(manager.get(discovered.id).state).toBe("approved");
    expect(stringify(store.getSetting("service", "orchestrator", "pi_resource_catalog").value)).toBe(catalogBefore);
    expect(await readdir(join(root, "managed", ".staging"))).toEqual([]);
    expect(await readdir(join(root, "managed", "packages"))).toEqual([]);

    const localSource = join(root, "rolled-back-install");
    await mkdir(localSource);
    await writeFile(join(localSource, "SKILL.md"), "# Candidate\n", "utf8");
    const local = await manager.discover({
      id: "rolled-back-install",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: localSource }
    });
    await manager.approve(local.id, local.discoveredRevision, "connection-owner");
    const candidate = await manager.prepareInstall(local.id);
    expect(await findNamedFiles(join(root, "managed", "skills"), "SKILL.md")).toHaveLength(1);
    await expect(manager.completePreparedMutation(candidate, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      throw new Error("install commit failed");
    }))).rejects.toThrow(/install commit failed/u);
    expect(manager.get(local.id).state).toBe("approved");
    expect(await readdir(join(root, "managed", "skills"))).toEqual([]);
    store.close();
  });

  it("keeps the installed generation through failed update completion, then retires it after update and remove commit", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "transactional-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Version one\n", "utf8");
    const discovered = await manager.discover({
      id: "transactional-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    await manager.approve(discovered.id, discovered.discoveredRevision, "connection-owner");
    await manager.install(discovered.id);
    await manager.setEnabled(discovered.id, true);
    const [oldPath] = (await manager.runtimeSnapshot("pi")).skills;
    const oldRevision = manager.get(discovered.id).discoveredRevision;

    await writeFile(join(source, "SKILL.md"), "# Version two\n", "utf8");
    const rediscovered = await manager.discover({
      id: discovered.id,
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    expect(rediscovered).toMatchObject({
      state: "update_available",
      enabled: true,
      discoveredRevision: oldRevision
    });
    expect((await manager.runtimeSnapshot("pi")).skills).toEqual([oldPath]);
    const oldCatalog = stringify(store.getSetting("service", "orchestrator", "pi_resource_catalog").value);
    const oldVersion = manager.get(discovered.id).versionNumber;
    const failedUpdate = await manager.prepareUpdate(discovered.id, { approvedByConnectionId: "connection-owner" });
    expect(manager.get(discovered.id).versionNumber).toBe(oldVersion);
    expect(await readFile(join(oldPath!, "SKILL.md"), "utf8")).toContain("Version one");
    expect(await findNamedFiles(join(root, "managed", "skills"), "SKILL.md")).toHaveLength(2);

    await expect(manager.completePreparedMutation(failedUpdate, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      throw new Error("operation commit failed");
    }))).rejects.toThrow(/operation commit failed/u);
    expect(manager.get(discovered.id).versionNumber).toBe(oldVersion);
    expect(manager.get(discovered.id)).toMatchObject({ state: "update_available", enabled: true, discoveredRevision: oldRevision });
    expect(stringify(store.getSetting("service", "orchestrator", "pi_resource_catalog").value)).toBe(oldCatalog);
    expect(await readFile(join(oldPath!, "SKILL.md"), "utf8")).toContain("Version one");
    expect(await findNamedFiles(join(root, "managed", "skills"), "SKILL.md")).toHaveLength(1);
    expect((await manager.runtimeSnapshot("pi")).skills).toEqual([oldPath]);

    const successfulUpdate = await manager.prepareUpdate(discovered.id, { approvedByConnectionId: "connection-owner" });
    const updated = await manager.completePreparedMutation(successfulUpdate, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      return successfulUpdate.value;
    }));
    expect(updated).toMatchObject({ state: "installed", enabled: true });
    expect(await pathExists(oldPath!)).toBe(false);
    const [newPath] = (await manager.runtimeSnapshot("pi")).skills;
    expect(newPath).not.toBe(oldPath);
    expect(await readFile(join(newPath!, "SKILL.md"), "utf8")).toContain("Version two");

    const removal = await manager.prepareRemove(discovered.id);
    expect(manager.get(discovered.id).state).toBe("installed");
    expect(await pathExists(newPath!)).toBe(true);
    await manager.completePreparedMutation(removal, (finalize) => store.transaction((transaction) => finalize(transaction)));
    expect(manager.get(discovered.id)).toMatchObject({ state: "removed", enabled: false });
    expect(await pathExists(newPath!)).toBe(false);
    expect(await readdir(join(root, "managed", "skills"))).toEqual([]);

    // Simulate a crash after the removed catalog row committed but before its
    // generation cleanup completed. Initialization treats the catalog as the
    // authority and reclaims the now-unreferenced owner.
    await mkdir(newPath!, { recursive: true });
    await writeFile(join(newPath!, "SKILL.md"), "# Retired orphan\n", "utf8");
    store.close();
    const reopenedStore = new OperationalStore(join(root, "orchestrator.db"));
    const reopened = new PiResourceManager({ store: reopenedStore, managedRoot: join(root, "managed") });
    await reopened.initialize();
    expect(await readdir(join(root, "managed", "skills"))).toEqual([]);
    reopenedStore.close();
  });

  it("reclaims abandoned generations and working directories during initialization", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "recovery-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Durable version\n", "utf8");
    const discovered = await manager.discover({
      id: "recovery-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    await manager.approve(discovered.id, discovered.discoveredRevision, "connection-owner");
    await manager.install(discovered.id);
    await manager.setEnabled(discovered.id, true);
    const [durablePath] = (await manager.runtimeSnapshot("pi")).skills;

    await writeFile(join(source, "SKILL.md"), "# Abandoned candidate\n", "utf8");
    const rediscovered = await manager.discover({
      id: discovered.id,
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    expect(rediscovered).toMatchObject({ state: "update_available", enabled: true });
    await manager.prepareUpdate(discovered.id, { approvedByConnectionId: "connection-owner" });
    expect(await findNamedFiles(join(root, "managed", "skills"), "SKILL.md")).toHaveLength(2);
    const stagingOrphan = join(root, "managed", ".staging", "interrupted-copy");
    await mkdir(stagingOrphan);
    await writeFile(join(stagingOrphan, "partial.txt"), "partial\n", "utf8");
    store.close();

    const reopenedStore = new OperationalStore(join(root, "orchestrator.db"));
    const reopened = new PiResourceManager({ store: reopenedStore, managedRoot: join(root, "managed") });
    await reopened.initialize();

    expect(await findNamedFiles(join(root, "managed", "skills"), "SKILL.md")).toEqual([join(durablePath!, "SKILL.md")]);
    expect(await readFile(join(durablePath!, "SKILL.md"), "utf8")).toContain("Durable version");
    expect(await readdir(join(root, "managed", ".staging"))).toEqual([]);
    expect(reopened.get(discovered.id)).toMatchObject({ state: "update_available", enabled: true });
    expect((await reopened.runtimeSnapshot("pi")).skills).toEqual([durablePath]);
    reopenedStore.close();
  });

  it("fences an installed resource whose owned payload disappeared and permits repeated removal", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "missing-payload-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Installed content\n", "utf8");
    const discovered = await manager.discover({
      id: "missing-payload-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    await manager.approve(discovered.id, discovered.discoveredRevision, "connection-owner");
    await manager.install(discovered.id);
    await manager.setEnabled(discovered.id, true);
    const [installedPath] = (await manager.runtimeSnapshot("pi")).skills;
    const owner = dirname(dirname(dirname(installedPath!)));
    await rm(installedPath!, { recursive: true, force: true });
    store.close();

    const reopenedStore = new OperationalStore(join(root, "orchestrator.db"));
    const reopened = new PiResourceManager({ store: reopenedStore, managedRoot: join(root, "managed") });
    await reopened.initialize();
    expect(reopened.get(discovered.id)).toMatchObject({
      state: "error",
      enabled: false,
      error: "Installed resource payload is missing."
    });
    expect((await reopened.runtimeSnapshot("pi")).skills).toEqual([]);

    const removed = await reopened.remove(discovered.id);
    expect(removed).toMatchObject({ state: "removed", enabled: false });
    expect(await pathExists(owner)).toBe(false);
    const removedAgain = await reopened.remove(discovered.id);
    expect(removedAgain.versionNumber).toBe(removed.versionNumber);
    reopenedStore.close();
  });

  it("rejects the superseded flat install layout instead of reading or migrating it", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "current-layout-skill");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# Current layout\n", "utf8");
    const discovered = await manager.discover({
      id: "current-layout-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    await manager.approve(discovered.id, discovered.discoveredRevision, "connection-owner");
    await manager.install(discovered.id);

    const catalog = store.getSetting<{
      readonly format: 1;
      readonly records: ReadonlyArray<Record<string, unknown> & { readonly installedPath?: string }>;
    }>("service", "orchestrator", "pi_resource_catalog").value;
    const installedPath = catalog.records[0]!.installedPath!;
    const flatOwner = dirname(dirname(dirname(installedPath)));
    store.setSetting("service", "orchestrator", "pi_resource_catalog", {
      format: 1,
      records: [{ ...catalog.records[0]!, installedPath: join(flatOwner, basename(installedPath)) }]
    });

    const reopened = new PiResourceManager({ store, managedRoot: join(root, "managed") });
    await expect(reopened.initialize()).rejects.toThrow(/generation boundary/u);
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

    const updateAvailable = await manager.discoverPackage({
      id: npm.id,
      backendId: "pi",
      scope: "global",
      source: { kind: "npm", packageName: "@joko/example", versionSpec: "2.0.0" }
    });
    expect(updateAvailable).toMatchObject({
      state: "update_available",
      discoveredRevision: installed.discoveredRevision
    });
    expect(acquisition.requests).toHaveLength(1);
    const updated = await manager.update(npm.id, {
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

  it("leases and atomically replaces a managed Skill generation without exposing its owner path", async () => {
    const { root, store, manager } = await fixture();
    const source = join(root, "managed-skill-source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: managed-skill\n---\nold\n", "utf8");
    const discovered = await manager.discover({
      id: "managed-skill-content",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source },
      name: "managed-skill"
    });
    const approved = await manager.approve(discovered.id, discovered.discoveredRevision, "connection-a");
    const installed = await manager.install(approved.id);
    const enabled = await manager.setEnabled(installed.id, true);
    const lease = await manager.acquireSkillContent({
      resourceId: enabled.id,
      expectedResourceVersion: enabled.versionNumber
    });
    expect(lease.dirty).toBe(false);
    expect(stringify(lease)).not.toContain(root);
    const snapshot = join(root, "managed-skill-snapshot");
    await mkdir(snapshot);
    expect((await lease.snapshotTo(snapshot)).discoveredRevision).toBe(enabled.discoveredRevision);

    const candidate = join(root, "managed-skill-candidate");
    await mkdir(candidate);
    await writeFile(join(candidate, "SKILL.md"), "---\nname: managed-skill\n---\nnew\n", "utf8");
    await writeFile(join(candidate, "notes.md"), "notes\n", "utf8");
    const prepared = await manager.prepareReplaceSkillContent({
      resourceId: enabled.id,
      expectedResourceVersion: enabled.versionNumber,
      expectedObservedRevision: lease.observedRevision,
      candidateRoot: candidate,
      changedByConnectionId: "connection-a"
    });
    const result = await manager.completePreparedMutation(prepared, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      return prepared.value;
    }));
    expect(result.resource.enabled).toBe(true);
    expect(result.resource.state).toBe("installed");
    expect(result.resource.discoveredRevision).not.toBe(enabled.discoveredRevision);
    await expect(lease.assertCurrent()).rejects.toThrow(/authority changed/u);
    await lease.release();

    const nextLease = await manager.acquireSkillContent({
      resourceId: result.resource.id,
      expectedResourceVersion: result.resource.versionNumber
    });
    const nextSnapshot = join(root, "managed-skill-next-snapshot");
    await mkdir(nextSnapshot);
    await nextLease.snapshotTo(nextSnapshot);
    expect(await readFile(join(nextSnapshot, "SKILL.md"), "utf8")).toContain("new");
    expect(await readFile(join(nextSnapshot, "notes.md"), "utf8")).toBe("notes\n");
    await nextLease.release();
    store.close();
  });

  it("publishes, renames, removes, and rolls back project Skill content at the Resource boundary", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "workspace");
    const skillsRoot = join(workspace, ".pi", "skills");
    const source = join(skillsRoot, "project-skill");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: project-skill\n---\napproved\n", "utf8");
    registerTarget(store, { id: "target-project-skill", root: workspace, trusted: true });
    const [discovered] = await manager.discoverProjectResources({
      backendId: "pi",
      targetId: "target-project-skill",
      kinds: ["skill"]
    });
    const approved = await manager.approve(discovered!.id, discovered!.discoveredRevision, "connection-project");
    await writeFile(join(source, "SKILL.md"), "---\nname: project-skill\n---\nexternal\n", "utf8");
    const dirtyLease = await manager.acquireSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: approved.versionNumber
    });
    expect(dirtyLease.dirty).toBe(true);

    const candidate = join(root, "project-skill-candidate");
    await mkdir(candidate);
    await writeFile(join(candidate, "SKILL.md"), "---\nname: project-skill\n---\nedited\n", "utf8");
    const failed = await manager.prepareReplaceSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: approved.versionNumber,
      expectedObservedRevision: dirtyLease.observedRevision,
      candidateRoot: candidate,
      changedByConnectionId: "connection-project"
    });
    await expect(manager.completePreparedMutation(failed, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      throw new Error("store failed");
    }))).rejects.toThrow(/store failed/u);
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toContain("external");
    expect(manager.get(approved.id).versionNumber).toBe(approved.versionNumber);
    await dirtyLease.release();

    const currentLease = await manager.acquireSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: approved.versionNumber
    });
    const renamedCandidate = join(root, "project-skill-renamed-candidate");
    await mkdir(renamedCandidate);
    await writeFile(join(renamedCandidate, "SKILL.md"), "---\nname: renamed-skill\n---\nrenamed\n", "utf8");
    const renamedPlan = await manager.prepareReplaceSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: approved.versionNumber,
      expectedObservedRevision: currentLease.observedRevision,
      candidateRoot: renamedCandidate,
      changedByConnectionId: "connection-project",
      name: "renamed-skill"
    });
    const renamed = await manager.completePreparedMutation(renamedPlan, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      return renamedPlan.value;
    }));
    expect(renamed.replacedResourceId).toBe(approved.id);
    expect(manager.get(approved.id).state).toBe("removed");
    expect(await pathExists(source)).toBe(false);
    const renamedPath = join(skillsRoot, "renamed-skill");
    expect(await readFile(join(renamedPath, "SKILL.md"), "utf8")).toContain("renamed");
    await currentLease.release();

    const renamedLease = await manager.acquireSkillContent({
      resourceId: renamed.resource.id,
      expectedResourceVersion: renamed.resource.versionNumber
    });
    const recovery = join(root, "skill-recovery");
    await mkdir(recovery);
    const removal = await manager.prepareRemoveSkillContent({
      resourceId: renamed.resource.id,
      expectedResourceVersion: renamed.resource.versionNumber,
      expectedObservedRevision: renamedLease.observedRevision,
      recoveryDestination: recovery
    });
    const removed = await manager.completePreparedMutation(removal, (finalize) => store.transaction((transaction) => {
      finalize(transaction);
      return removal.value;
    }));
    expect(removed.state).toBe("removed");
    expect(await pathExists(renamedPath)).toBe(false);
    expect(await readFile(join(recovery, "SKILL.md"), "utf8")).toContain("renamed");
    await renamedLease.release();
    store.close();
  });

  it("recovers project Skill transactions after restart on both sides of the Store commit boundary", async () => {
    const { root, store, manager } = await fixture();
    const workspace = join(root, "workspace-skill-restart");
    const skillsRoot = join(workspace, ".agents", "skills");
    const source = join(skillsRoot, "restart-skill");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: restart-skill\n---\noriginal\n", "utf8");
    registerTarget(store, { id: "target-skill-restart", root: workspace, trusted: true });
    const [discovered] = await manager.discoverProjectResources({
      backendId: "pi",
      targetId: "target-skill-restart",
      kinds: ["skill"]
    });
    const approved = await manager.approve(discovered!.id, discovered!.discoveredRevision, "connection-restart");
    const originalLease = await manager.acquireSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: approved.versionNumber
    });
    const firstCandidate = join(root, "skill-restart-candidate-one");
    await mkdir(firstCandidate);
    await writeFile(join(firstCandidate, "SKILL.md"), "---\nname: restart-skill\n---\nuncommitted\n", "utf8");
    await manager.prepareReplaceSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: approved.versionNumber,
      expectedObservedRevision: originalLease.observedRevision,
      candidateRoot: firstCandidate,
      changedByConnectionId: "connection-restart"
    });
    await originalLease.release();
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toContain("uncommitted");

    const rolledBack = new PiResourceManager({ store, managedRoot: join(root, "managed") });
    await rolledBack.initialize();
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toContain("original");
    expect(await readdir(join(root, "managed", ".skill-transactions"))).toEqual([]);
    expect(await directoryMissingOrEmpty(join(skillsRoot, ".joko-skill-transactions"))).toBe(true);

    const currentLease = await rolledBack.acquireSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: approved.versionNumber
    });
    const secondCandidate = join(root, "skill-restart-candidate-two");
    await mkdir(secondCandidate);
    await writeFile(join(secondCandidate, "SKILL.md"), "---\nname: restart-skill\n---\ncommitted\n", "utf8");
    const committedPlan = await rolledBack.prepareReplaceSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: approved.versionNumber,
      expectedObservedRevision: currentLease.observedRevision,
      candidateRoot: secondCandidate,
      changedByConnectionId: "connection-restart"
    });
    await currentLease.release();
    persistPreparedSkillRecord(store, committedPlan.value.resource);

    const finalized = new PiResourceManager({ store, managedRoot: join(root, "managed") });
    await finalized.initialize();
    expect(finalized.get(approved.id).versionNumber).toBe(committedPlan.value.resource.versionNumber);
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toContain("committed");
    expect(await readdir(join(root, "managed", ".skill-transactions"))).toEqual([]);
    expect(await directoryMissingOrEmpty(join(skillsRoot, ".joko-skill-transactions"))).toBe(true);

    const committedLease = await finalized.acquireSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: committedPlan.value.resource.versionNumber
    });
    const recovery = join(root, "skill-restart-recovery");
    await mkdir(recovery);
    await finalized.prepareRemoveSkillContent({
      resourceId: approved.id,
      expectedResourceVersion: committedPlan.value.resource.versionNumber,
      expectedObservedRevision: committedLease.observedRevision,
      recoveryDestination: recovery
    });
    await committedLease.release();
    expect(await pathExists(source)).toBe(false);

    const removalRolledBack = new PiResourceManager({ store, managedRoot: join(root, "managed") });
    await removalRolledBack.initialize();
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toContain("committed");
    expect(await readdir(join(root, "managed", ".skill-transactions"))).toEqual([]);
    store.close();
  });
});

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryMissingOrEmpty(path: string): Promise<boolean> {
  if (!await pathExists(path)) return true;
  return (await readdir(path)).length === 0;
}

async function findNamedFiles(root: string, name: string): Promise<readonly string[]> {
  if (!await pathExists(root)) return [];
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

function persistPreparedSkillRecord(
  store: OperationalStore,
  resource: ReturnType<PiResourceManager["get"]>
): void {
  const catalog = store.getSetting<{
    readonly format: 1;
    readonly records: readonly Record<string, unknown>[];
  }>("service", "orchestrator", "pi_resource_catalog").value;
  store.setSetting("service", "orchestrator", "pi_resource_catalog", {
    format: 1,
    records: catalog.records.map((record) => record["id"] === resource.id
      ? {
          ...record,
          name: resource.name,
          discoveredRevision: resource.discoveredRevision,
          resourceDetails: resource.resourceDetails,
          runtimeRequirements: resource.runtimeRequirements,
          warnings: resource.warnings,
          disabledLifecycleScripts: resource.disabledLifecycleScripts,
          canToggle: resource.canToggle,
          requiresExtensionApproval: resource.requiresExtensionApproval,
          postMutationNotice: resource.postMutationNotice,
          state: resource.state,
          enabled: resource.enabled,
          approvedAt: resource.approvedAt,
          approvedByConnectionId: resource.approvedByConnectionId,
          versionNumber: resource.versionNumber.toString(10),
          updatedAt: resource.updatedAt
        }
      : record)
  });
}
