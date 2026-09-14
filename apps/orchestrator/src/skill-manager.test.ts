import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { PiResourceManager } from "./resource-manager.js";
import { SkillManager, type SkillManagerOptions } from "./skill-manager.js";
import { mkdtemp } from "./test-paths.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(skillOptions: Pick<SkillManagerOptions, "now" | "ttlMs"> = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-skill-manager-"));
  cleanup.push(root);
  const store = new OperationalStore(join(root, "orchestrator.db"));
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "0.84.4",
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
  const resources = new PiResourceManager({ store, managedRoot: join(root, "managed") });
  await resources.initialize();
  const skills = new SkillManager({ resources, store, rootDirectory: join(root, "skill-content"), ...skillOptions });
  await skills.initialize();
  return { root, store, resources, skills };
}

async function installGlobalSkill(f: Awaited<ReturnType<typeof fixture>>) {
  const source = join(f.root, "source-skill");
  await mkdir(join(source, "docs"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), [
    "---",
    "name: sample-skill",
    "description: A useful sample",
    "version: 1.2.3",
    "api_key: should-not-cross-the-wire",
    "nested:",
    "  flag: true",
    "---",
    "# Sample",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(source, "docs", "guide.md"), "old guide\n", "utf8");
  await writeFile(join(source, ".env"), "TOKEN=secret\n", "utf8");
  const discovered = await f.resources.discover({
    id: "skill-global-sample",
    backendId: "pi",
    kind: "skill",
    scope: "managed",
    source: { kind: "local", path: source },
    name: "sample-skill"
  });
  const approved = await f.resources.approve(discovered.id, discovered.discoveredRevision, "connection-a");
  return f.resources.install(approved.id);
}

describe("SkillManager", () => {
  it("keeps paths private while browsing metadata, lazy files, editing, and applying an actual diff", async () => {
    const f = await fixture();
    const installed = await installGlobalSkill(f);
    await f.skills.reconcile();

    const catalog = f.skills.list({ query: "sample" });
    expect(catalog.skills).toMatchObject([{
      id: installed.id,
      scope: "global",
      name: "sample-skill",
      contentAvailable: true,
      canEdit: true
    }]);
    expect(stringify(catalog)).not.toContain(f.root);

    const details = await f.skills.openSkill("connection-a", installed.id, installed.versionNumber);
    expect(details.metadata).toMatchObject({
      name: "sample-skill",
      description: "A useful sample",
      version: "1.2.3"
    });
    expect(details.metadata.frontmatterJson).toContain("[redacted]");
    expect(details.metadata.frontmatterJson).not.toContain("should-not-cross-the-wire");
    expect((await f.skills.listFiles("connection-a", details.sessionId)).map((entry) => entry.name)).toEqual(["docs", "SKILL.md"]);
    expect(stringify(details)).not.toContain(f.root);

    const children = await f.skills.listFiles("connection-a", details.sessionId, "docs");
    expect(children).toMatchObject([{ key: "docs/guide.md", kind: "file", editable: true }]);
    const file = await f.skills.readFile("connection-a", details.sessionId, "docs/guide.md");
    expect(file.content).toBe("old guide\n");
    await expect(f.skills.readFile("connection-b", details.sessionId, "docs/guide.md")).rejects.toThrow(/another connection/u);
    await expect(f.skills.readFile("connection-a", details.sessionId, "../SKILL.md")).rejects.toThrow(/invalid/u);
    await expect(f.skills.readFile("connection-a", details.sessionId, ".env")).rejects.toThrow(/excluded/u);

    const draft = await f.skills.prepareFileEdit({
      connectionId: "connection-a",
      sessionId: details.sessionId,
      key: "docs/guide.md",
      expectedFileRevision: file.revision,
      content: "new guide\n"
    });
    expect(draft.changes).toMatchObject([{
      key: "docs/guide.md",
      kind: "modified",
      binary: false
    }]);
    expect(draft.changes[0]?.unifiedDiff).toContain("-old guide");
    expect(draft.changes[0]?.unifiedDiff).toContain("+new guide");
    const applied = await f.skills.applyDraft("connection-a", draft.draftId);
    expect(applied.resource.versionNumber).toBeGreaterThan(installed.versionNumber);
    await expect(f.skills.applyDraft("connection-a", draft.draftId)).rejects.toThrow(/does not exist|expired/u);

    const reopened = await f.skills.openSkill("connection-a", applied.resource.id, applied.resource.versionNumber);
    expect((await f.skills.readFile("connection-a", reopened.sessionId, "docs/guide.md")).content).toBe("new guide\n");
    await f.skills.close();
    f.store.close();
  });

  it("keeps same-name Skills isolated across Backend, Target, and scope and reports a missing exact baseline", async () => {
    const f = await fixture();
    f.store.upsertBackend({
      id: "pi-two",
      displayName: "Pi Two",
      version: "0.84.4",
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
    const createGlobal = async (backendId: string, id: string) => {
      const source = join(f.root, `${id}-source`);
      await mkdir(source);
      await writeFile(join(source, "SKILL.md"), "---\nname: same-skill\n---\nglobal\n", "utf8");
      const discovered = await f.resources.discover({ id, backendId, kind: "skill", scope: "managed", source: { kind: "local", path: source }, name: "same-skill" });
      await f.resources.approve(discovered.id, discovered.discoveredRevision, "connection-same");
      return f.resources.install(discovered.id);
    };
    await createGlobal("pi", "same-skill-global-one");
    await createGlobal("pi-two", "same-skill-global-two");

    const projectResources: Array<{
      readonly targetId: string;
      readonly source: string;
      readonly approved: { readonly id: string; readonly versionNumber: bigint };
    }> = [];
    for (const targetId of ["target-same-one", "target-same-two"]) {
      const workspace = join(f.root, targetId);
      const source = join(workspace, ".agents", "skills", "same-skill");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "SKILL.md"), "---\nname: same-skill\n---\nproject\n", "utf8");
      f.store.upsertTarget({ id: targetId, backendId: "pi", displayName: targetId, workspaceRoot: workspace, managed: false, trusted: true });
      const [discovered] = await f.resources.discoverProjectResources({ backendId: "pi", targetId, kinds: ["skill"] });
      projectResources.push({
        targetId,
        source,
        approved: await f.resources.approve(discovered!.id, discovered!.discoveredRevision, "connection-same")
      });
    }
    await f.skills.reconcile();
    const catalog = f.skills.list({ query: "same-skill" });
    expect(catalog.skills).toHaveLength(4);
    expect(new Set(catalog.skills.map((skill) => skill.id)).size).toBe(4);
    expect(new Set(catalog.skills.map((skill) => `${skill.backendId}:${skill.targetId ?? skill.scope}`))).toEqual(new Set([
      "pi:global", "pi-two:global", "pi:target-same-one", "pi:target-same-two"
    ]));
    expect(stringify(catalog)).not.toContain(f.root);

    const project = projectResources[0]!;
    await writeFile(join(project.source, "SKILL.md"), "---\nname: same-skill\n---\nchanged before first detail\n", "utf8");
    const details = await f.skills.openSkill("connection-same", project.approved.id, project.approved.versionNumber);
    expect(details).toMatchObject({ dirty: true, baselineAvailable: false, diff: { available: false } });
    await f.skills.close();
    f.store.close();
  });

  it("expires exact sessions and permits only one concurrent draft to commit", async () => {
    let now = 1_000;
    const f = await fixture({ now: () => now, ttlMs: 25 });
    const installed = await installGlobalSkill(f);
    await f.skills.reconcile();
    const expired = await f.skills.openSkill("connection-expiry", installed.id, installed.versionNumber);
    now += 26;
    await expect(f.skills.listFiles("connection-expiry", expired.sessionId)).rejects.toThrow(/expired|does not exist/u);

    const current = f.resources.get(installed.id);
    const opened = await f.skills.openSkill("connection-concurrent", current.id, current.versionNumber);
    const file = await f.skills.readFile("connection-concurrent", opened.sessionId, "docs/guide.md");
    const [first, second] = await Promise.all([
      f.skills.prepareFileEdit({ connectionId: "connection-concurrent", sessionId: opened.sessionId, key: file.key, expectedFileRevision: file.revision, content: "first\n" }),
      f.skills.prepareFileEdit({ connectionId: "connection-concurrent", sessionId: opened.sessionId, key: file.key, expectedFileRevision: file.revision, content: "second\n" })
    ]);
    const outcomes = await Promise.allSettled([
      f.skills.applyDraft("connection-concurrent", first.draftId),
      f.skills.applyDraft("connection-concurrent", second.draftId)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const committed = f.resources.get(installed.id);
    const verify = await f.skills.openSkill("connection-concurrent", committed.id, committed.versionNumber);
    expect(["first\n", "second\n"]).toContain((await f.skills.readFile("connection-concurrent", verify.sessionId, "docs/guide.md")).content);
    await f.skills.close();
    f.store.close();
  });

  it("shows exact project dirty diffs and rolls a failed draft publication back to external content", async () => {
    const f = await fixture();
    const workspace = join(f.root, "workspace");
    const skillRoot = join(workspace, ".pi", "skills", "project-skill");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: project-skill\n---\napproved\n", "utf8");
    f.store.upsertTarget({
      id: "target-project",
      backendId: "pi",
      displayName: "Project",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    });
    const [discovered] = await f.resources.discoverProjectResources({
      backendId: "pi",
      targetId: "target-project",
      kinds: ["skill"]
    });
    const approved = await f.resources.approve(discovered!.id, discovered!.discoveredRevision, "connection-project");
    await f.skills.reconcile();

    const clean = await f.skills.openSkill("connection-project", approved.id, approved.versionNumber);
    expect(clean.dirty).toBe(false);
    expect(clean.baselineAvailable).toBe(true);
    await f.skills.closeSession("connection-project", clean.sessionId);
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: project-skill\n---\nexternal\n", "utf8");

    const dirty = await f.skills.openSkill("connection-project", approved.id, approved.versionNumber);
    expect(dirty.dirty).toBe(true);
    expect(dirty.diff.available).toBe(true);
    expect(dirty.diff.changes[0]?.unifiedDiff).toContain("-approved");
    expect(dirty.diff.changes[0]?.unifiedDiff).toContain("+external");
    const file = await f.skills.readFile("connection-project", dirty.sessionId, "SKILL.md");
    const draft = await f.skills.prepareFileEdit({
      connectionId: "connection-project",
      sessionId: dirty.sessionId,
      key: "SKILL.md",
      expectedFileRevision: file.revision,
      content: "---\nname: project-skill\n---\nedited\n"
    });
    const prepared = await f.skills.prepareApplyDraft("connection-project", draft.draftId);
    await expect(f.skills.completePreparedMutation(prepared, (finalize) => f.store.transaction((store) => {
      finalize(store);
      throw new Error("operation persistence failed");
    }))).rejects.toThrow(/operation persistence failed/u);
    expect(await readFile(join(skillRoot, "SKILL.md"), "utf8")).toContain("external");

    const applied = await f.skills.applyDraft("connection-project", draft.draftId);
    expect(await readFile(join(skillRoot, "SKILL.md"), "utf8")).toContain("edited");
    expect(applied.resource.discoveredRevision).not.toBe(approved.discoveredRevision);
    await f.skills.close();
    f.store.close();
  });

  it("renames project identity, physically deletes with recovery, and validates recovery state after restart", async () => {
    const f = await fixture();
    const workspace = join(f.root, "workspace-rename");
    const skillsRoot = join(workspace, ".agents", "skills");
    const skillRoot = join(skillsRoot, "old-name");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "# no frontmatter yet\n", "utf8");
    f.store.upsertTarget({
      id: "target-rename",
      backendId: "pi",
      displayName: "Rename",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    });
    const [discovered] = await f.resources.discoverProjectResources({
      backendId: "pi",
      targetId: "target-rename",
      kinds: ["skill"]
    });
    const approved = await f.resources.approve(discovered!.id, discovered!.discoveredRevision, "connection-rename");
    await f.skills.reconcile();
    const opened = await f.skills.openSkill("connection-rename", approved.id, approved.versionNumber);
    const occupied = join(skillsRoot, "occupied-name");
    await mkdir(occupied);
    await writeFile(join(occupied, "SKILL.md"), "# Occupied\n", "utf8");
    const conflictingDraft = await f.skills.prepareRename({
      connectionId: "connection-rename",
      sessionId: opened.sessionId,
      name: "occupied-name"
    });
    await expect(f.skills.applyDraft("connection-rename", conflictingDraft.draftId)).rejects.toThrow(/already exists/u);
    expect(await exists(skillRoot)).toBe(true);
    const renameDraft = await f.skills.prepareRename({
      connectionId: "connection-rename",
      sessionId: opened.sessionId,
      name: "new-name"
    });
    expect(renameDraft.changes[0]?.unifiedDiff).toContain("+name: new-name");
    const renamed = await f.skills.applyDraft("connection-rename", renameDraft.draftId);
    expect(renamed.replacedResourceId).toBe(approved.id);
    expect(await exists(skillRoot)).toBe(false);
    expect(await readFile(join(skillsRoot, "new-name", "SKILL.md"), "utf8")).toContain("name: new-name");

    const renamedDetails = await f.skills.openSkill("connection-rename", renamed.resource.id, renamed.resource.versionNumber);
    const failedRemoval = await f.skills.prepareDelete({
      connectionId: "connection-rename",
      sessionId: renamedDetails.sessionId,
      confirmation: "new-name"
    });
    await expect(f.skills.completePreparedMutation(failedRemoval, (finalize) => f.store.transaction((store) => {
      finalize(store);
      throw new Error("delete persistence failed");
    }))).rejects.toThrow(/delete persistence failed/u);
    expect(await exists(join(skillsRoot, "new-name"))).toBe(true);
    expect(await f.skills.listRecoveries()).toEqual([]);
    const removed = await f.skills.delete({
      connectionId: "connection-rename",
      sessionId: renamedDetails.sessionId,
      confirmation: "new-name"
    });
    expect(removed.state).toBe("removed");
    expect(await exists(join(skillsRoot, "new-name"))).toBe(false);
    const recoveries = await f.skills.listRecoveries();
    expect(recoveries).toMatchObject([{
      skillId: renamed.resource.id,
      name: "new-name",
      scope: "project",
      status: "ready"
    }]);
    expect(stringify(recoveries)).not.toContain(f.root);

    const orphan = join(f.root, "skill-content", "recoveries", "skill_recovery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await mkdir(orphan);
    await writeFile(join(orphan, "SKILL.md"), "uncommitted recovery\n", "utf8");

    await f.skills.close();
    const restarted = new SkillManager({
      resources: f.resources,
      store: f.store,
      rootDirectory: join(f.root, "skill-content")
    });
    await restarted.initialize();
    expect(await restarted.listRecoveries()).toMatchObject([{ status: "ready", name: "new-name" }]);
    expect(await exists(orphan)).toBe(false);
    await rm(join(f.root, "skill-content", "recoveries", recoveries[0]!.id), { recursive: true, force: true });
    expect(await restarted.listRecoveries()).toMatchObject([{ status: "missing", name: "new-name" }]);
    await restarted.close();
    f.store.close();
  });

  it("fails closed for malformed frontmatter, invalid UTF-8, stale files, and revoked Target trust", async () => {
    const f = await fixture();
    const workspace = join(f.root, "workspace-fences");
    const skillRoot = join(workspace, ".pi", "skills", "fenced-skill");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(join(skillRoot, "SKILL.md"), "---\nname: [broken\n---\nbody\n", "utf8");
    await writeFile(join(skillRoot, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
    await writeFile(join(skillRoot, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    await mkdir(join(skillRoot, ".config", "gcloud"), { recursive: true });
    await writeFile(join(skillRoot, ".config", "gcloud", "application_default_credentials.json"), "secret\n", "utf8");
    f.store.upsertTarget({
      id: "target-fences",
      backendId: "pi",
      displayName: "Fences",
      workspaceRoot: workspace,
      managed: false,
      trusted: true
    });
    const [discovered] = await f.resources.discoverProjectResources({
      backendId: "pi",
      targetId: "target-fences",
      kinds: ["skill"]
    });
    const approved = await f.resources.approve(discovered!.id, discovered!.discoveredRevision, "connection-fences");
    await f.skills.reconcile();
    const opened = await f.skills.openSkill("connection-fences", approved.id, approved.versionNumber);
    expect(opened.metadata.parseError).toBeTruthy();
    await expect(f.skills.readFile("connection-fences", opened.sessionId, "binary.bin")).rejects.toThrow(/UTF-8/u);
    await expect(f.skills.readFile("connection-fences", opened.sessionId, "large.txt")).rejects.toThrow(/byte limit/u);
    await expect(f.skills.readFile("connection-fences", opened.sessionId, ".config/gcloud/application_default_credentials.json")).rejects.toThrow(/excluded/u);
    await expect(f.skills.readFile("connection-fences", opened.sessionId, "CON.txt")).rejects.toThrow(/invalid/u);
    await expect(f.skills.listFiles("connection-fences", opened.sessionId, "a/".repeat(32) + "b")).rejects.toThrow(/invalid/u);
    await expect(f.skills.readFile("connection-fences", opened.sessionId, `${"a".repeat(513)}.txt`)).rejects.toThrow(/invalid/u);
    const manifest = await f.skills.readFile("connection-fences", opened.sessionId, "SKILL.md");
    await expect(f.skills.prepareFileEdit({
      connectionId: "connection-fences",
      sessionId: opened.sessionId,
      key: "SKILL.md",
      expectedFileRevision: "sha256:" + "0".repeat(64),
      content: manifest.content
    })).rejects.toThrow(/stale/u);
    f.store.upsertTarget({
      id: "target-fences",
      backendId: "pi",
      displayName: "Fences",
      workspaceRoot: workspace,
      managed: false,
      trusted: false
    });
    await expect(f.skills.listFiles("connection-fences", opened.sessionId)).rejects.toThrow(/trusted|fenced/u);

    const invalidUtf8 = join(f.root, "invalid-utf8-skill");
    await mkdir(invalidUtf8);
    await writeFile(join(invalidUtf8, "SKILL.md"), Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(f.resources.discover({
      id: "invalid-utf8-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: invalidUtf8 }
    })).rejects.toThrow(/UTF-8/u);
    await f.skills.close();
    f.store.close();
  });
});

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
