import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { TargetDescriptor } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { Code } from "@connectrpc/connect";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { SessionHost } from "./session-host.js";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import type { ExtensionCatalogDescriptor } from "./extension-catalog.js";
import { ExtensionProjectPolicies, extensionProjectForTarget, normalizeExtensionProjectPath } from "./extension-project-policy.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-extension-policy-")), database = join(root, "store.db");
  let store = new OperationalStore(database);
  store.upsertBackend({ id: "runtime", displayName: "Runtime", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  for (const [id, workspaceRoot] of [["one", root], ["two", join(root, "other")]] as const) {
    store.upsertTarget({ id, workspaceRoot, backendId: "runtime", displayName: id, managed: false, trusted: true });
    store.createSession({ id: `session-${id}`, backendId: "runtime", targetId: id, title: id, binding: { opaqueRef: id, generation: 1 },
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  }
  cleanups.push(async () => { store.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); });
  return { root, database, get store() { return store; }, projects: new ExtensionProjectPolicies(store),
    reopen: () => { store.close(); store = new OperationalStore(database); return new ExtensionProjectPolicies(store); } };
}
function plugin(id = "plugin-a"): ExtensionCatalogDescriptor {
  return { id, revision: 7n, owner: { kind: "resource", resourceId: "bundle", discoveredRevision: "sha256:source", resourceVersion: 1n },
    source: "local", installed: true, installState: "installed", name: id, description: "", enabled: true, sidebarSupported: false, sidebarVisible: false,
    tools: [], permissions: [], commands: [], setup: { state: "not_required", revision: 0n, fields: [] }, useSupported: false, runtimeEntryPath: `extensions/${id}/index.ts` };
}

it("persists disable-only project exceptions across restart and keeps unknown/uninstalled IDs", async () => {
  const f = await fixture(), project = f.projects.list().find(project => project.name === "one")!, entry = plugin();
  f.projects.setEnabled(project.id, "connection", entry, false, 0n);
  expect(f.projects.enabledForTarget(entry.id, "one")).toBe(false);
  expect(f.projects.enabledForTarget(entry.id, "two")).toBe(true);
  expect(() => f.projects.assertEnabledForSession(entry.id, "session-one")).toThrow("disabled");
  const old = f.projects.state(project.id, "connection");
  expect(() => f.projects.setEnabled(project.id, "connection", entry, true, 0n)).toThrow("concurrently");
  const projects = f.reopen();
  expect(projects.state(project.id, "connection")).toEqual(old);
  expect(projects.enabledForTarget(entry.id, "one")).toBe(false);
  expect(() => projects.setEnabled(project.id, "connection", { ...entry, enabled: false }, true, old.revision)).toThrow("globally");
  projects.setEnabled(project.id, "connection", plugin("uninstalled-plugin"), false, old.revision);
  const next = projects.state(project.id, "connection");
  projects.setEnabled(project.id, "connection", entry, true, next.revision);
  expect(projects.state(project.id, "connection").disabledExtensionIds).toEqual(["uninstalled-plugin"]);
  expect(projects.enabledForTarget(entry.id, "one")).toBe(true);
});

it("normalizes remote paths without filesystem reads and isolates equal paths on different hosts", () => {
  expect(normalizeExtensionProjectPath("C:/Projects/One/../TWO/")).toBe("c:\\projects\\two");
  expect(normalizeExtensionProjectPath("/srv/One/../TWO/")).toBe("/srv/TWO");
  expect(normalizeExtensionProjectPath("C:/")).toBe("c:\\");
  const base: TargetDescriptor = { id: "target", backendId: "runtime", displayName: "Remote", workspaceRoot: "C:/unused", trusted: true, managed: false };
  const first = { ...base, remoteWorkspace: { kind: "ssh" as const, hostTargetId: "ssh-node", hostId: "one", workspaceRoot: "/srv/TWO" } };
  expect(extensionProjectForTarget(first).id).not.toBe(extensionProjectForTarget({ ...first, remoteWorkspace: { ...first.remoteWorkspace, hostId: "two" } }).id);
  expect(extensionProjectForTarget(first).id).toBe(extensionProjectForTarget({ ...first, id: "another-target", backendId: "other-engine" }).id);
  expect(() => normalizeExtensionProjectPath("relative")).toThrow("Invalid");
});

it("issues connection-owned browsed scopes without creating a Target or Session", async () => {
  const f = await fixture(); await mkdir(join(f.root, "browsed"));
  const before = f.store.listTargets().length;
  const project = await f.projects.resolve(join(f.root, "browsed"), "original", new AbortController().signal, () => {});
  expect(f.projects.state(project.id, "original").project).toEqual(project);
  expect(() => f.projects.state(project.id, "different")).toThrow("not found");
  expect(f.store.listTargets()).toHaveLength(before);
  f.projects.setEnabled(project.id, "original", plugin(), false, 0n);
  const restarted = f.reopen();
  expect(() => restarted.state(project.id, "original")).toThrow("not found");
  const selected = await restarted.resolve(project.path, "next", new AbortController().signal, () => {});
  expect(selected.id).toBe(project.id); expect(restarted.state(project.id, "next").disabledExtensionIds).toEqual(["plugin-a"]);
  await expect(restarted.resolve(project.path, "revoked", new AbortController().signal, () => { throw new Error("revoked"); })).rejects.toThrow("revoked");
  expect(() => restarted.state(project.id, "revoked")).toThrow("not found");
});

it("preserves corrupt settings and rejects both calls and writes instead of enabling by default", async () => {
  const f = await fixture(), project = f.projects.list()[0]!;
  const corrupt = { format: 1, disabledExtensionIds: ["b", "a"] };
  f.store.setSetting("service", "extension-project-policies", project.id, corrupt);
  expect(() => f.projects.state(project.id, "connection")).toThrow("unreadable");
  const targetId = f.store.listTargets().find(target => extensionProjectForTarget(target.descriptor).id === project.id)!.descriptor.id;
  expect(() => f.projects.enabledForTarget("plugin-a", targetId)).toThrow("unreadable");
  expect(() => f.projects.setEnabled(project.id, "connection", plugin(), true, 0n)).toThrow("unreadable");
  expect(f.store.findSetting("service", "extension-project-policies", project.id)?.value).toEqual(corrupt);
});

it("fences catalog pages and excludes only the disabled native entry of a package", async () => {
  const f = await fixture(), project = f.projects.list().find(project => project.name === "one")!, a = plugin(), b = plugin("plugin-b");
  const catalog = { revision: 9n, entries: [a, b], recoveredFromCorruption: false };
  const initial = f.projects.snapshot(catalog, "one");
  f.projects.setEnabled(project.id, "connection", a, false, 0n);
  const filtered = f.projects.snapshot(catalog, "one");
  expect(filtered.entries.map(entry => entry.id)).toEqual([b.id]); expect(filtered.revision).not.toBe(initial.revision);
  expect(f.projects.snapshot(catalog, "two").entries).toHaveLength(2);
  const root = join(f.root, "package");
  expect(f.projects.excludedNativeEntries([a, b], [{ id: "bundle", kind: "package", name: "Bundle", source: "local:bundle", state: "approved", runtimePath: root }], "one"))
    .toEqual([{ resourceId: "bundle", entryPath: "extensions/plugin-a/index.ts" }]);
});

it("commits generated project mutations and durable receipts atomically, replays once, and fences both revisions", async () => {
  const f = await fixture(), entry = plugin(), project = f.projects.list().find(project => project.name === "one")!;
  const connection = f.store.createConnection({ id: "connection", name: "Owner", authKeyDigest: "project-test-digest" });
  const artifacts = new ArtifactStore({ rootDirectory: join(f.root, "artifacts"), repository: new OperationalArtifactRepository(f.store), ingestRoots: [f.root] });
  await artifacts.initialize();
  const host = new SessionHost(f.store, artifacts, []);
  vi.spyOn(host, "getCommands").mockResolvedValue([]);
  cleanups.push(async () => { await host.dispose(); });
  const snapshot = { revision: 9n, entries: [entry], recoveredFromCorruption: false };
  const services = createConnectServices({ config: { publicOrigin: "https://service.test" }, store: f.store, sessionHost: host,
    artifacts, blobTransfers: {}, artifactRepository: {}, workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], close: async () => {},
    connections: { authenticate: () => connection, fence: () => { if (f.store.getConnection(connection.id).state !== "active") throw new Error("Revoked"); } },
    extensionProjects: f.projects, extensionCatalog: { reconcile: () => snapshot, snapshot: () => snapshot, get: () => entry }, piResources: { list: () => [], get: () => ({ targetId: undefined }) }
  } as unknown as OrchestratorApplication);
  const context = { requestHeader: new Headers({ authorization: "Bearer project-test" }), signal: new AbortController().signal };
  const invoke = (handler: unknown, request: unknown) => (handler as (request: unknown, context: unknown) => Promise<any>)(request, context);
  const mutation = (projectRevision: bigint, revision = 7n, id = project.id) => create(contract.OperationMutationSchema, { payload: { case: "setExtensionEnabled", value: {
    extensionId: entry.id, enabled: false, expectedRevision: { value: revision }, project: { projectId: id, expectedRevision: { value: projectRevision } }
  } } });
  const submit = (id: string, body: contract.OperationMutation) => invoke(services.operation.submitOperation, { operationId: id, connectionId: connection.id, mutation: body });
  const first = mutation(0n);
  await submit("project-disable", first);
  const state = f.projects.state(project.id, connection.id);
  expect(state.disabledExtensionIds).toEqual([entry.id]);
  expect(f.store.getOperation("project-disable").status).toBe("completed");
  await submit("project-disable", first);
  expect(f.projects.state(project.id, connection.id).revision).toBe(state.revision);
  await expect(submit("stale-project", mutation(0n))).rejects.toMatchObject({ code: Code.Aborted });
  await expect(submit("stale-plugin", mutation(state.revision, 6n))).rejects.toMatchObject({ code: Code.Aborted });
  await expect(submit("unknown-project", mutation(0n, 7n, "f".repeat(64)))).rejects.toMatchObject({ code: Code.NotFound });
  expect(f.projects.state(project.id, connection.id)).toEqual(state);
  const current = await invoke(services.extension.getExtensionProjectState, { projectId: project.id });
  expect(current.state.disabledExtensionIds).toEqual([entry.id]); expect(current.state.revision.value).toBe(state.revision);
  const filtered = await invoke(services.extension.listExtensions, { targetId: "one", query: "", page: { pageSize: 10 } });
  expect(filtered.extensions).toHaveLength(0);
  const global = await invoke(services.extension.listExtensions, { query: "", includeProjectDisabled: true, page: { pageSize: 10 } });
  expect(global.extensions[0].enabled).toBe(true);
  await expect(invoke(services.extension.getExtension, { extensionId: entry.id, sessionId: "session-one" })).rejects.toMatchObject({ code: Code.FailedPrecondition });
  const management = await invoke(services.extension.getExtension, { extensionId: entry.id, sessionId: "session-one", includeProjectDisabled: true });
  expect(management.extension).toMatchObject({ enabled: true, useSupported: false, commands: [] });
});
