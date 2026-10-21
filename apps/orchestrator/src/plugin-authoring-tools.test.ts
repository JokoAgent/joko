import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperationalStore } from "@joko/store";
import { mkdtemp } from "./test-paths.js";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { PiResourceManager } from "./resource-manager.js";
import { PluginAuthoringTools } from "./plugin-authoring-tools.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-plugin-authoring-"));
  const store = new OperationalStore(join(root, "store.db"));
  cleanups.push(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.upsertBackend({ id: "engine", displayName: "Engine", adapterKind: "pi", version: "0.85.1", instanceGeneration: 1,
    health: "healthy", installationState: "installed", authenticationState: "authenticated", models: [], tools: [], diagnostics: [],
    capabilities: new Map([["runtime.resources", { key: "runtime.resources", supported: true, options: ["extension", "package", "skill"] }]]) });
  const workspace = join(root, "workspace"), source = join(workspace, "plugin");
  await mkdir(join(source, "extensions"), { recursive: true }); await mkdir(join(source, "ui"));
  await writeFile(join(source, "extensions", "index.js"), "export default function () {}\n");
  await writeFile(join(source, "ui", "index.html"), "<!doctype html><title>Example</title><p>Example</p>");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "joko-authoring-test", version: "1.0.0", type: "module", files: ["extensions", "ui"],
    scripts: { prepack: 'node -e "process.exit(91)"' }, pi: { extensions: ["extensions/index.js"] },
    joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{ entry: "extensions/index.js", mainView: { html: "ui/index.html", title: "Example" } }] } } }));
  store.upsertTarget({ id: "target", backendId: "engine", displayName: "Workspace", workspaceRoot: workspace, managed: false, trusted: true });
  store.createSession({ id: "session", backendId: "engine", targetId: "target", title: "Author", binding: { opaqueRef: "native", generation: 1 }, pinned: false, archived: false,
    permissionMode: "ask", fastMode: false, planMode: false, createdAt: 1, updatedAt: 1 });
  const resources = new PiResourceManager({ store, managedRoot: join(root, "resources") }); await resources.initialize();
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const workspaceOwner = { root: workspace, remote: false, assertCurrent: vi.fn() };
  const tools = new PluginAuthoringTools({ store, resources, artifacts, workingRoot: join(root, "authoring"), captureWorkspace: () => workspaceOwner });
  return { root, store, source, resources, artifacts, tools, workspaceOwner, context: { sessionId: "session", targetId: "target", generation: 1 } };
}
it("validates real source and returns actual npm archive bytes without running lifecycle scripts or installing", async () => {
  const f = await fixture(); const signal = new AbortController().signal;
  const validated = await f.tools.callTool("validate_extension_package", { directory: "plugin" }, signal, f.context);
  expect(validated.isError).toBe(false); expect(validated.structuredContent).toMatchObject({ name: "joko-authoring-test", validated: true, installed: false });
  const packed = await f.tools.callTool("pack_extension_package", { directory: "plugin" }, signal, f.context);
  expect(packed.isError, JSON.stringify(packed.content)).toBe(false);
  expect(packed.hostArtifacts).toHaveLength(1);
  const blob = packed.hostArtifacts![0]!.blob;
  expect(blob.mimeType).toBe("application/gzip"); expect(blob.fileName).toBe("joko-authoring-test-1.0.0.tgz");
  const stored = await f.artifacts.readBlob(blob);
  expect(Buffer.from(stored.data).subarray(0, 2)).toEqual(Buffer.from([31, 139]));
  expect(f.resources.list({})).toHaveLength(0);
}, 30_000);
it("rejects a malformed declaration, another Workspace and a late Session generation", async () => {
  const f = await fixture(); const signal = new AbortController().signal;
  expect((await f.tools.callTool("validate_extension_package", { directory: "../../elsewhere" }, signal, f.context)).isError).toBe(true);
  const inspect = f.resources.inspectPackageCandidate.bind(f.resources);
  vi.spyOn(f.resources, "inspectPackageCandidate").mockImplementationOnce(async (...args) => {
    const value = await inspect(...args), session = f.store.getSession("session");
    f.store.updateSession("session", { binding: { opaqueRef: "replacement", generation: 2 } }, session.revision); return value;
  });
  expect((await f.tools.callTool("pack_extension_package", { directory: "plugin" }, signal, f.context)).isError).toBe(true);
  await writeFile(join(f.source, "package.json"), JSON.stringify({ name: "broken", version: "1.0.0", pi: { extensions: ["missing.js"] } }));
  expect((await f.tools.callTool("validate_extension_package", { directory: "plugin" }, signal, { ...f.context, generation: 2 })).isError).toBe(true);
});
it("uses the actual task checkout and refuses a Session-level remote Workspace before local reads", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  // The source exists only in the checkout, while the Target still points at the original project.
  f.store.upsertTarget({ ...f.store.getTarget("target").descriptor, workspaceRoot: join(f.root, "original-project") });
  expect((await f.tools.callTool("validate_extension_package", { directory: "plugin" }, signal, f.context)).isError).toBe(false);
  f.workspaceOwner.remote = true;
  const inspect = vi.spyOn(f.resources, "inspectPackageCandidate");
  expect((await f.tools.callTool("pack_extension_package", { directory: "plugin" }, signal, f.context)).isError).toBe(true);
  expect(inspect).not.toHaveBeenCalled();
  f.workspaceOwner.remote = false; f.workspaceOwner.assertCurrent.mockImplementation(() => { throw Error("Checkout lease retired"); });
  expect((await f.tools.callTool("validate_extension_package", { directory: "plugin" }, signal, f.context)).isError).toBe(true);
  expect(inspect).not.toHaveBeenCalled();
});
it("packs the actual runnable example shipped with the creator Skill", async () => {
  const f = await fixture();
  await cp(fileURLToPath(new URL("./system-skills/joko-plugin-creator/examples/status/", import.meta.url)), f.source, { recursive: true, force: true });
  const packed = await f.tools.callTool("pack_extension_package", { directory: "plugin" }, new AbortController().signal, f.context);
  expect(packed.isError, JSON.stringify(packed.content)).toBe(false);
  expect(packed.hostArtifacts?.[0]?.blob.fileName).toBe("joko-status-example-1.0.0.tgz");
  expect(packed.structuredContent).toMatchObject({ name: "joko-status-example", validated: true, installed: false });
}, 30_000);
