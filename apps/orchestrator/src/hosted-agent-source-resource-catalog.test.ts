import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotNativeSkills, type AdapterContext, type BackendDescriptor } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { expect, it } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { PiResourceManager } from "./resource-manager.js";
import { HostedAgentSourceResourceCatalog } from "./hosted-agent-source-resource-catalog.js";

it("maps approved original-node global and personal text to the exact native kind without borrowing another project or approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-source-resource-catalog-")), database = join(root, "store.db"), managedRoot = join(root, "managed");
  let store = new OperationalStore(database), resources = new PiResourceManager({ store, managedRoot });
  const descriptor = (id: string, adapterKind: string): BackendDescriptor => ({ id, adapterKind, instanceGeneration: 1,
    displayName: id, version: "1", health: "unavailable", installationState: "not_installed", authenticationState: "signed_out",
    capabilities: new Map([["runtime.resources", { key: "runtime.resources", supported: true, options: ["skill", "prompt"] }]]),
    models: [], tools: [], diagnostics: [] });
  const native = descriptor("original-native", "pi"), otherNative = descriptor("another-native", "codex"), source = descriptor("paired-source", "hosted");
  for (const backend of [native, otherNative, source]) store.upsertBackend(backend);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const target = { id: "source-target", backendId: source.id, displayName: "Original", workspaceRoot: workspace, managed: false, trusted: true };
  store.upsertTarget(target);
  store.upsertTarget({ ...target, id: "native-project", backendId: native.id });
  const context: AdapterContext = { sessionId: "original-task", generation: 2, backendInstanceGeneration: 1, target, signal: new AbortController().signal,
    emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024,
    storeArtifact: async () => { throw new Error("No artifact writes in this catalog test."); } };
  let allowed: ReadonlySet<string> | undefined;
  const catalog = () => new HostedAgentSourceResourceCatalog({ store, resources, nativeBackends: new Map([["pi", native.id], ["codex", otherNative.id]]),
    allowedSkillIds: () => allowed });
  const add = async (id: string, backendId: string, scope: "global" | "user" | "project", kind: "skill" | "prompt" = "skill", approved = true) => {
    const path = kind === "skill" ? join(scope === "project" ? workspace : root, id) : join(root, `${id}.md`);
    if (kind === "skill") {
      await mkdir(join(path, "scripts"), { recursive: true });
      await writeFile(join(path, "SKILL.md"), `---\nname: ${id}\ndescription: Approved native resource\n---\nUse scripts/check.txt and image.bin.\n`);
      await writeFile(join(path, "scripts", "check.txt"), `ORIGINAL_${id}`); await writeFile(join(path, "image.bin"), Buffer.from([0, 255, 4, 6]));
    } else await writeFile(path, `ORIGINAL_${id}`);
    const record = await resources.discover({ id, backendId, scope, kind, name: id, source: { kind: "local", path },
      ...(scope === "project" ? { targetId: backendId === source.id ? target.id : "native-project", workspaceRoot: workspace } : {}) });
    if (approved) {
      await resources.approve(record.id, record.discoveredRevision, "original-owner");
      if (scope !== "project") await resources.install(record.id);
      await resources.setEnabled(record.id, true);
    }
    return record;
  };
  let snapshot: Awaited<ReturnType<typeof snapshotNativeSkills>> | undefined;
  try {
    await resources.initialize();
    await add("original-global", native.id, "global"); await add("original-personal", native.id, "user");
    await add("original-prompt", native.id, "global", "prompt"); await add("source-project", source.id, "project");
    await add("another-kind", otherNative.id, "global"); await add("another-project", native.id, "project");
    await add("unapproved", native.id, "global", "skill", false); await add("disabled", native.id, "global");
    await resources.setEnabled("disabled", false);
    const expected = ["original-global", "original-personal", "original-prompt", "source-project"];
    let text = await catalog().text(context, "pi"); expect(text.map(seed => seed.id).sort()).toEqual(expected);
    expect(await catalog().text(context, "unknown-native-kind")).toMatchObject([{ id: "source-project" }]);
    expect((await catalog().text(context, "codex")).map(seed => seed.id).sort()).toEqual(["another-kind", "source-project"]);
    const skills = await catalog().skills(context, context.signal, "pi");
    expect(skills.map(seed => seed.resource.id).sort()).toEqual(expected.filter(id => id !== "original-prompt"));
    snapshot = await snapshotNativeSkills(skills, context.signal);
    const mount = snapshot.skills.find(skill => skill.seed.resource.id === "original-personal")!;
    expect(await readFile(join(mount.path, "scripts", "check.txt"), "utf8")).toBe("ORIGINAL_original-personal");
    expect(await readFile(join(mount.path, "image.bin"))).toEqual(Buffer.from([0, 255, 4, 6]));
    allowed = new Set(["original-personal"]);
    expect((await catalog().skills(context, context.signal, "pi")).map(seed => seed.resource.id)).toEqual(["original-personal"]);
    expect((await catalog().text(context, "pi")).map(seed => seed.id)).toEqual(["original-personal", "original-prompt"]);
    allowed = undefined;
    await resources.setEnabled("original-personal", false);
    expect(() => text.find(seed => seed.id === "original-personal")!.assertCurrent()).toThrow(/no longer current/u);
    expect(() => snapshot!.assertCurrent()).toThrow(/approved skill snapshot/u);
    await resources.setEnabled("original-personal", true);
    expect(() => text.find(seed => seed.id === "original-personal")!.assertCurrent()).toThrow(/no longer current/u);
    await snapshot.dispose(); snapshot = undefined;
    store.close(); store = new OperationalStore(database); resources = new PiResourceManager({ store, managedRoot }); await resources.initialize();
    text = await catalog().text(context, "pi"); expect(text.map(seed => seed.id).sort()).toEqual(expected);
    const replacement = store.reserveBackendInstanceGeneration({ backendId: native.id, adapterKind: native.adapterKind });
    expect(store.publishBackendInstanceDescriptor({ descriptor: { ...native, instanceGeneration: replacement.generation }, expectedCurrentGeneration: 1 }).status).toBe("published");
    expect(() => text.find(seed => seed.id === "original-global")!.assertCurrent()).not.toThrow();
    const wrongOwner = new HostedAgentSourceResourceCatalog({ store, resources, nativeBackends: new Map([["pi", otherNative.id]]) });
    await expect(wrongOwner.skills(context, context.signal, "pi")).rejects.toThrow(/catalog owner changed/u);
    await expect(resources.runtimeTextSnapshot(source.id, "native-project", context.signal, undefined, context)).rejects.toThrow(/runtime owner/u);
    await expect(resources.runtimeTextSnapshot(source.id, target.id, context.signal, undefined, undefined,
      { backendId: native.id, assertCurrent: () => {} })).rejects.toThrow(/exact runtime owner/u);
  } finally { await snapshot?.dispose(); store.close(); await rm(root, { recursive: true, force: true }); }
});
