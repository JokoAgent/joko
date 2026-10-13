import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import type { RemoteWorkspaceBinding } from "@joko/core";
import type { RemoteDirectoryEntry, RemoteFileReadRequest, RemoteFileStat, RemoteFileTransportPort } from "@joko/remote-ssh";
import { OperationalStore } from "@joko/store";
import { describe, expect, it } from "vitest";
import type { RemoteExecutionRouter } from "./remote-execution-router.js";
import { RemoteSkillSourceOwner, validateRemoteProjectSkillSource, type StoredRemoteProjectSkillSource } from "./remote-skill-source.js";
import { RemoteWorkspaceService } from "./remote-workspace-service.js";
import { PiResourceManager } from "./resource-manager.js";
import { SkillManager } from "./skill-manager.js";
import { mkdtemp } from "./test-paths.js";

class SourceFiles implements RemoteFileTransportPort {
  readonly entries = new Map<string, { kind: RemoteFileStat["kind"]; content: Uint8Array; modifiedAt: number; mode: number }>();
  readonly reads: string[] = [];
  afterRead: ((path: string) => void) | undefined;
  constructor() { this.directory("/workspace"); }
  directory(path: string): void {
    if (this.entries.has(path)) return;
    if (path !== "/" && path !== "/workspace") this.directory(posix.dirname(path));
    this.entries.set(path, { kind: "directory", content: new Uint8Array(), modifiedAt: 10, mode: 0o755 });
  }
  file(path: string, content: string | Uint8Array, mode = 0o644): void {
    this.directory(posix.dirname(path));
    this.entries.set(path, { kind: "file", content: typeof content === "string" ? Buffer.from(content) : content.slice(),
      modifiedAt: (this.entries.get(path)?.modifiedAt ?? 10) + 1, mode });
  }
  node(path: string) { const node = this.entries.get(path); if (!node) throw Object.assign(new Error("Missing file"), { code: 2 }); return node; }
  async realpath(path: string): Promise<string> { this.node(path); return path; }
  async stat(path: string): Promise<RemoteFileStat> {
    const node = this.node(path); return { kind: node.kind, size: node.content.length, modifiedAt: node.modifiedAt, mode: node.mode };
  }
  async list(path: string): Promise<readonly RemoteDirectoryEntry[]> {
    if (this.node(path).kind !== "directory") throw new Error("Not a directory");
    return [...this.entries].filter(([key]) => key !== path && posix.dirname(key) === path)
      .map(([key, node]) => ({ name: posix.basename(key), kind: node.kind }));
  }
  async read(request: RemoteFileReadRequest): Promise<Uint8Array> {
    request.signal?.throwIfAborted(); this.reads.push(request.path);
    const value = this.node(request.path).content.slice();
    if (value.length > request.maximumBytes) throw new Error("Read exceeds limit");
    this.afterRead?.(request.path); return value;
  }
  async write(): Promise<void> { throw new Error("Source acquisition cannot write remote content"); }
  async mkdir(): Promise<void> { throw new Error("Source acquisition cannot write remote content"); }
  async rename(): Promise<void> { throw new Error("Source acquisition cannot write remote content"); }
  async remove(): Promise<void> { throw new Error("Source acquisition cannot write remote content"); }
}

const skillPath = "/workspace/.agents/skills/report";
const skillBody = "---\nname: report\ndescription: Prepare reports\n---\nFull instruction.\n";

async function fixture(options: { maximumEntries?: number; maximumBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-remote-skill-source-"));
  const database = join(root, "state.sqlite"), managedRoot = join(root, "source-generations");
  const store = new OperationalStore(database);
  store.upsertBackend({ id: "native", displayName: "Native", adapterKind: "codex", version: "0.159.2", health: "healthy",
    instanceGeneration: 1, installationState: "installed", authenticationState: "authenticated", capabilities: new Map([
      ["runtime.resources", { key: "runtime.resources", supported: true, options: ["skill"] }]
    ]), models: [], tools: [], diagnostics: [] });
  const fallback = join(root, "fallback"); await mkdir(fallback);
  store.upsertTarget({ id: "host-target", backendId: "native", displayName: "Host", workspaceRoot: fallback, trusted: true, managed: false });
  const binding = { kind: "ssh" as const, hostTargetId: "host-target", hostId: "host", workspaceRoot: "/workspace" };
  store.upsertTarget({ id: "project", backendId: "native", displayName: "Remote project", workspaceRoot: fallback, trusted: true,
    managed: false, remoteWorkspace: binding }, { workspaceId: "workspace" });
  const files = new SourceFiles(); files.file(`${skillPath}/SKILL.md`, skillBody);
  files.file(`${skillPath}/assets/template.bin`, Buffer.from([0, 255, 8, 12]));
  files.file(`${skillPath}/run.sh`, "#!/bin/sh\nprintf report\n", 0o755);
  let epoch = 1, fileAllowed = true, executionIdentity = "ssh-machine";
  const router = { workspace: async (value: RemoteWorkspaceBinding) => {
    const captured = epoch;
    const assert = () => { if (!fileAllowed || captured !== epoch) throw new Error("File authority retired"); };
    return { kind: "ssh" as const, binding: value, pathStyle: "posix" as const, files,
      processes: { open: async () => { throw new Error("Source does not execute remote commands"); } },
      executionIdentity, authorityIdentity: `lease-${captured}`, assertCurrent: assert, assertFilesCurrent: assert,
      assertForwardingCurrent: assert };
  } } as unknown as RemoteExecutionRouter;
  const remote = new RemoteWorkspaceService(router);
  const registration = { id: "workspace", root: "/workspace", displayName: "Remote project", trusted: true,
    remote: { targetId: "project", binding } };
  await remote.register(registration);
  const owner = new RemoteSkillSourceOwner({ store, managedRoot, ...options,
    captureSkillSourceAuthority: (id, signal) => remote.captureSkillSourceAuthority(id, signal) });
  const manager = new PiResourceManager({ store, managedRoot: join(root, "resources"), remoteProjectSkills: owner });
  await manager.initialize();
  return { root, database, managedRoot, store, files, remote, owner, manager, registration, router,
    revoke: () => { fileAllowed = false; epoch++; }, reconnect: () => { fileAllowed = true; epoch++; },
    rebindExecution: () => { executionIdentity = "other-machine"; epoch++; },
    cleanup: async () => { await remote.close(); store.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("registered project Skill source", () => {
  it("stages a full immutable binary tree, reviews before approval, and leases exact enabled content", async () => {
    const f = await fixture();
    try {
      f.files.file("/workspace/.agents/skills/README.md", "ordinary index");
      f.files.directory("/workspace/.agents/skills/not-a-skill");
      f.files.file("/workspace/.codex/skills/report/SKILL.md", skillBody);
      f.files.file("/workspace/elsewhere/SKILL.md", "# Not a declared root");
      const rows = await f.manager.discoverProjectResources({ backendId: "native", targetId: "project", kinds: ["skill"] });
      expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.id)).size).toBe(2);
      const row = rows[0]!;
      expect(row).toMatchObject({ sourceKind: "remote_project", scope: "project", targetId: "project", state: "awaiting_approval", enabled: false });
      expect(JSON.stringify(row, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)).not.toContain("/workspace");
      expect(f.files.reads.some(path => path.startsWith("/workspace/elsewhere"))).toBe(false);
      const review = await f.manager.acquireSkillContent({ resourceId: row.id, expectedResourceVersion: row.versionNumber });
      expect(review.dirty).toBe(false); expect(await readFile(review.entryFilePath, "utf8")).toBe(skillBody); await review.release();
      await expect(f.manager.setEnabled(row.id, true)).rejects.toThrow("approved");
      await expect(f.manager.approve(row.id, "sha256:" + "0".repeat(64), "connection")).rejects.toThrow("stale");
      await f.manager.approve(row.id, row.discoveredRevision, "connection"); await f.manager.setEnabled(row.id, true);
      const controller = new AbortController();
      const seeds = await f.manager.runtimeSkillSnapshot("native", "project", controller.signal);
      expect(seeds).toHaveLength(1); expect(isAbsolute(seeds[0]!.sourcePath)).toBe(true);
      expect(await readFile(join(seeds[0]!.sourcePath, "assets", "template.bin"))).toEqual(Buffer.from([0, 255, 8, 12]));
      controller.abort(); expect(() => seeds[0]!.assertCurrent()).not.toThrow();
      const rediscovered = await f.manager.discoverProjectResources({ backendId: "native", targetId: "project", kinds: ["skill"] });
      expect(rediscovered.find(value => value.id === row.id)?.versionNumber).toBe(f.manager.get(row.id).versionNumber);
      await f.manager.setEnabled(row.id, false); expect(() => seeds[0]!.assertCurrent()).toThrow();
    } finally { await f.cleanup(); }
  });

  it("rejects original source changes before approval and new runtimes without replacing reviewed bytes", async () => {
    const f = await fixture();
    try {
      const [row] = await f.manager.discoverProjectResources({ backendId: "native", targetId: "project", kinds: ["skill"] });
      f.files.file(`${skillPath}/assets/template.bin`, Buffer.from([5, 6]));
      await expect(f.manager.approve(row!.id, row!.discoveredRevision, "connection")).rejects.toThrow("unavailable or changed");
      expect(f.manager.get(row!.id).state).toBe("awaiting_approval");
      const [fresh] = await f.manager.discoverProjectResources({ backendId: "native", targetId: "project", kinds: ["skill"] });
      expect(fresh!.id).toBe(row!.id); expect(fresh!.versionNumber).toBeGreaterThan(row!.versionNumber);
      await f.manager.approve(fresh!.id, fresh!.discoveredRevision, "connection"); await f.manager.setEnabled(fresh!.id, true);
      f.files.file(`${skillPath}/SKILL.md`, skillBody + "Changed original\n");
      await expect(f.manager.runtimeSkillSnapshot("native", "project", new AbortController().signal)).rejects.toThrow("unavailable or changed");
      const review = await f.manager.acquireSkillContent({ resourceId: fresh!.id, expectedResourceVersion: f.manager.get(fresh!.id).versionNumber });
      expect(await readFile(review.entryFilePath, "utf8")).toBe(skillBody); await review.release();
    } finally { await f.cleanup(); }
  });

  it("fences prepared approval and leased seeds on exact file authority, registration, trust and execution changes", async () => {
    const f = await fixture();
    try {
      const [row] = await f.manager.discoverProjectResources({ backendId: "native", targetId: "project", kinds: ["skill"] });
      const prepared = await f.manager.prepareApprove(row!.id, row!.discoveredRevision, "connection");
      f.revoke();
      await expect(f.manager.completePreparedMutation(prepared, finalize => { finalize(f.store); })).rejects.toThrow("File authority retired");
      expect(f.manager.get(row!.id).state).toBe("awaiting_approval");
      f.reconnect(); await f.manager.approve(row!.id, row!.discoveredRevision, "connection"); await f.manager.setEnabled(row!.id, true);
      const [seed] = await f.manager.runtimeSkillSnapshot("native", "project", new AbortController().signal);
      await f.remote.register(f.registration); expect(() => seed!.assertCurrent()).toThrow("workspace changed");
      const [current] = await f.manager.runtimeSkillSnapshot("native", "project", new AbortController().signal);
      const target = f.store.getTarget("project"); f.store.upsertTarget({ ...target.descriptor, trusted: false }, target.metadata);
      expect(() => current!.assertCurrent()).toThrow();
      await expect(f.manager.runtimeSkillSnapshot("native", "project", new AbortController().signal)).rejects.toThrow();
      f.store.upsertTarget({ ...target.descriptor, trusted: true }, target.metadata); f.rebindExecution();
      await expect(f.manager.runtimeSkillSnapshot("native", "project", new AbortController().signal)).rejects.toThrow("unavailable or changed");
    } finally { await f.cleanup(); }
  });

  it("keeps root provenance stable across reconnect and restart while retiring captured pointers", async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      const first = await f.remote.captureSkillSourceAuthority("workspace", controller.signal); controller.abort();
      expect(() => first.assertCurrent()).not.toThrow();
      f.revoke(); expect(() => first.assertFilesCurrent()).toThrow(); f.reconnect();
      const next = await f.remote.captureSkillSourceAuthority("workspace"); expect(next.rootRegistrationId).toBe(first.rootRegistrationId);
      const restarted = new RemoteWorkspaceService(f.router); await restarted.register(f.registration);
      expect((await restarted.captureSkillSourceAuthority("workspace")).rootRegistrationId).toBe(first.rootRegistrationId);
      f.remote.unregister("workspace"); expect(() => next.assertCurrent()).toThrow();
      await restarted.close();
    } finally { await f.cleanup(); }
  });

  it("persists only strict source provenance and immutable Node generations, not an ephemeral lease", async () => {
    const f = await fixture();
    try {
      const [row] = await f.manager.discoverProjectResources({ backendId: "native", targetId: "project", kinds: ["skill"] });
      await f.manager.approve(row!.id, row!.discoveredRevision, "connection"); await f.manager.setEnabled(row!.id, true);
      f.store.close(); const reopened = new OperationalStore(f.database);
      try {
        const owner = new RemoteSkillSourceOwner({ store: reopened, managedRoot: f.managedRoot,
          captureSkillSourceAuthority: (id, signal) => f.remote.captureSkillSourceAuthority(id, signal) });
        const manager = new PiResourceManager({ store: reopened, managedRoot: join(f.root, "resources"), remoteProjectSkills: owner });
        await manager.initialize(); expect(manager.get(row!.id)).toMatchObject({ sourceKind: "remote_project", enabled: true });
        const [seed] = await manager.runtimeSkillSnapshot("native", "project", new AbortController().signal);
        expect(await readFile(join(seed!.sourcePath, "SKILL.md"), "utf8")).toBe(skillBody);
        await writeFile(join(seed!.sourcePath, "SKILL.md"), "# Changed staging\n");
        await expect(manager.runtimeSkillSnapshot("native", "project", new AbortController().signal)).rejects.toThrow("changed");
      } finally { reopened.close(); }
    } finally { await f.cleanup(); }
  });

  it("rejects cancelled, unsafe, incomplete and changing full copies without leaving stages", async () => {
    const f = await fixture();
    try {
      const cancelled = new AbortController(); cancelled.abort(); await expect(f.owner.discover("project", cancelled.signal)).rejects.toThrow();
      f.files.entries.set(`${skillPath}/unsafe`, { kind: "symbolic_link", content: new Uint8Array(), modifiedAt: 10, mode: 0o777 });
      await expect(f.owner.discover("project")).rejects.toThrow("unavailable or changed"); expect(await readdir(f.managedRoot)).toEqual([]);
      f.files.entries.delete(`${skillPath}/unsafe`); f.files.file(`${skillPath}/.env`, "not a public asset");
      await expect(f.owner.discover("project")).rejects.toThrow(); expect(await readdir(f.managedRoot)).toEqual([]);
      f.files.entries.delete(`${skillPath}/.env`); f.files.file(`${skillPath}/SKILL.md`, Buffer.from([255]));
      await expect(f.owner.discover("project")).rejects.toThrow(); expect(await readdir(f.managedRoot)).toEqual([]);
      f.files.file(`${skillPath}/SKILL.md`, skillBody);
      let mutated = false;
      f.files.afterRead = path => { if (!mutated && path === `${skillPath}/run.sh`) { mutated = true; f.files.file(`${skillPath}/assets/template.bin`, Buffer.from([3, 4])); } };
      await expect(f.owner.discover("project")).rejects.toThrow(); expect(await readdir(f.managedRoot)).toEqual([]);
      expect(f.manager.list()).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("enforces package limits, private source shape and remote read-only mutations", async () => {
    const f = await fixture({ maximumEntries: 2 });
    try {
      await expect(f.owner.discover("project")).rejects.toThrow(); expect(await readdir(f.managedRoot)).toEqual([]);
      const owner = new RemoteSkillSourceOwner({ store: f.store, managedRoot: f.managedRoot,
        captureSkillSourceAuthority: (id, signal) => f.remote.captureSkillSourceAuthority(id, signal) });
      const [candidate] = await owner.discover("project");
      expect(() => validateRemoteProjectSkillSource({ ...candidate!.source, authorityIdentity: "ephemeral" } as StoredRemoteProjectSkillSource)).toThrow();
      expect(() => validateRemoteProjectSkillSource({ ...candidate!.source, packageKey: "../other" })).toThrow();
      await candidate!.discard();
      const manager = new PiResourceManager({ store: f.store, managedRoot: join(f.root, "normal-resources"), remoteProjectSkills: owner });
      await manager.initialize(); const [row] = await manager.discoverProjectResources({ backendId: "native", targetId: "project", kinds: ["skill"] });
      await expect(manager.prepareReplaceSkillContent({ resourceId: row!.id, expectedResourceVersion: row!.versionNumber,
        expectedObservedRevision: row!.discoveredRevision, candidateRoot: f.root, changedByConnectionId: "connection" })).rejects.toThrow("read-only");
      const recovery = join(f.root, "recovery");
      await expect(manager.prepareRemoveSkillContent({ resourceId: row!.id, expectedResourceVersion: row!.versionNumber,
        expectedObservedRevision: row!.discoveredRevision, recoveryDestination: recovery })).rejects.toThrow("read-only");
      expect(f.files.node(`${skillPath}/SKILL.md`).content).toEqual(Buffer.from(skillBody));
      await manager.remove(row!.id); expect(manager.get(row!.id).state).toBe("removed");
      expect(f.files.node(`${skillPath}/SKILL.md`).content).toEqual(Buffer.from(skillBody));
    } finally { await f.cleanup(); }
  });

  it("stops an in-flight full copy on caller cancellation and enforces total package bytes", async () => {
    const f = await fixture();
    try {
      const controller = new AbortController();
      f.files.afterRead = () => controller.abort();
      await expect(f.owner.discover("project", controller.signal)).rejects.toThrow();
      expect(await readdir(f.managedRoot)).toEqual([]);
      f.files.afterRead = undefined;
      const bounded = new RemoteSkillSourceOwner({ store: f.store, managedRoot: f.managedRoot, maximumBytes: 20,
        captureSkillSourceAuthority: (id, signal) => f.remote.captureSkillSourceAuthority(id, signal) });
      await expect(bounded.discover("project")).rejects.toThrow(); expect(await readdir(f.managedRoot)).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("requires a trusted exact registered SSH root and a currently advertised Skill capability", async () => {
    const f = await fixture();
    try {
      await f.remote.register({ ...f.registration, trusted: false });
      await expect(f.owner.discover("project")).rejects.toThrow("trusted SSH");
      await f.remote.register({ ...f.registration, remote: { ...f.registration.remote, targetId: "different-target" } });
      await expect(f.owner.discover("project")).rejects.toThrow("unavailable or changed");
      await f.remote.register(f.registration);
      const backend = f.store.getBackend("native");
      f.store.upsertBackend({ ...backend.descriptor, capabilities: new Map() });
      await expect(f.owner.discover("project")).rejects.toThrow("unavailable or changed");
      expect(f.files.reads).toEqual([]);
    } finally { await f.cleanup(); }
  });

  it("exposes awaiting-approval remote content through the existing read-only Skill detail owner", async () => {
    const f = await fixture();
    const skills = new SkillManager({ resources: f.manager, store: f.store, rootDirectory: join(f.root, "skill-content") });
    try {
      await skills.initialize();
      const [row] = await f.manager.discoverProjectResources({ backendId: "native", targetId: "project", kinds: ["skill"] });
      expect(skills.list().skills).toMatchObject([{ id: row!.id, contentAvailable: true, canEdit: false, canDelete: false,
        state: "awaiting_approval", scope: "project" }]);
      const details = await skills.openSkill("connection", row!.id, row!.versionNumber);
      expect(details.metadata.name).toBe("report");
      const file = await skills.readFile("connection", details.sessionId, "SKILL.md");
      expect(file.content).toBe(skillBody); expect(file.editable).toBe(false);
      expect((await skills.listFiles("connection", details.sessionId)).every(value => value.editable === false)).toBe(true);
      await expect(skills.prepareFileEdit({ connectionId: "connection", sessionId: details.sessionId, key: "SKILL.md",
        expectedFileRevision: file.revision, content: "# Another body\n" })).rejects.toThrow("read-only");
      await expect(skills.prepareRename({ connectionId: "connection", sessionId: details.sessionId, name: "another" })).rejects.toThrow("read-only");
      await skills.closeSession("connection", details.sessionId);
    } finally { await skills.close(); await f.cleanup(); }
  });

  it("discovers the two declared local Codex project roots and rejects a LOCAL server path for remote Targets", async () => {
    const f = await fixture();
    try {
      const localRoot = join(f.root, "local");
      for (const path of [".agents/skills/local/SKILL.md", ".codex/skills/local/SKILL.md", "skills/other/SKILL.md"]) {
        const file = join(localRoot, ...path.split("/")); await mkdir(dirname(file), { recursive: true }); await writeFile(file, skillBody);
      }
      f.store.upsertTarget({ id: "local", backendId: "native", displayName: "Local", workspaceRoot: localRoot, trusted: true, managed: false });
      const rows = await f.manager.discoverProjectResources({ backendId: "native", targetId: "local", kinds: ["skill"] });
      expect(rows).toHaveLength(2); expect(rows.every(row => row.sourceKind === "local")).toBe(true);
      await expect(f.manager.discover({ backendId: "native", targetId: "project", scope: "project", kind: "skill",
        workspaceRoot: localRoot, source: { kind: "local", path: join(localRoot, ".agents", "skills", "local") } })).rejects.toThrow("remote");
      const target = f.store.getTarget("local"); f.store.upsertTarget({ ...target.descriptor, trusted: false });
      await expect(f.manager.discoverProjectResources({ backendId: "native", targetId: "local", kinds: ["skill"] })).rejects.toThrow("trusted");
    } finally { await f.cleanup(); }
  });
});
