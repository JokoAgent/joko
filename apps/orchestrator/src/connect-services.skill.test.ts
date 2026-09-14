import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { PiResourceManager } from "./resource-manager.js";
import { SessionHost } from "./session-host.js";
import { SkillManager } from "./skill-manager.js";
import { mkdtemp } from "./test-paths.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Connect Skill boundary", () => {
  it("maps path-free detail/edit/diff operations and durable physical deletion", async () => {
    const fixture = await createFixture();
    const source = join(fixture.root, "source");
    await mkdir(join(source, "docs"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: connect-skill\ndescription: Connect detail\n---\nbody\n", "utf8");
    await writeFile(join(source, "docs", "guide.md"), "before\n", "utf8");
    const discovered = await fixture.resources.discover({
      id: "connect-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source },
      name: "connect-skill"
    });
    const approved = await fixture.resources.approve(discovered.id, discovered.discoveredRevision, CONNECTION_ID);
    const installed = await fixture.resources.install(approved.id);

    const listed = await invoke<contract.ListSkillsResponse>(fixture.services.skill.listSkills, {
      query: "connect",
      page: { pageSize: 100 }
    });
    expect(listed.skills).toMatchObject([{
      skillId: installed.id,
      name: "connect-skill",
      scope: contract.ResourceScope.GLOBAL,
      contentAvailable: true
    }]);
    expect(stringify(listed)).not.toContain(fixture.root);

    const opened = await invoke<contract.OpenSkillResponse>(fixture.services.skill.openSkill, {
      skillId: installed.id,
      expectedResourceRevision: { value: installed.versionNumber }
    });
    expect(opened.skill).toMatchObject({
      dirty: false,
      baselineAvailable: true,
      metadata: { name: "connect-skill", description: "Connect detail" }
    });
    expect(stringify(opened)).not.toContain(fixture.root);
    const sessionId = opened.skill!.sessionId;

    const files = await invoke<contract.ListSkillFilesResponse>(fixture.services.skill.listSkillFiles, {
      sessionId,
      parentKey: "docs",
      page: { pageSize: 1 }
    });
    expect(files.files).toMatchObject([{ key: "docs/guide.md", editable: true }]);
    expect(files.page?.totalSize).toBe(1n);
    const read = await invoke<contract.ReadSkillFileResponse>(fixture.services.skill.readSkillFile, {
      sessionId,
      key: "docs/guide.md"
    });
    expect(read.file?.content).toBe("before\n");
    const draft = await invoke<contract.PrepareSkillFileEditResponse>(fixture.services.skill.prepareSkillFileEdit, {
      sessionId,
      key: "docs/guide.md",
      expectedFileRevision: read.file!.revision,
      content: "after\n"
    });
    expect(draft.draft?.changes[0]?.unifiedDiff).toContain("+after");

    const applied = await submit(fixture, "apply-skill-draft", {
      case: "applySkillDraft",
      value: create(contract.ApplySkillDraftMutationSchema, { draftId: draft.draft!.draftId })
    });
    expect(applied.operation?.state).toBe(contract.OperationState.SUCCEEDED);
    expect(applied.operation?.result?.payload.case).toBe("skill");
    if (applied.operation?.result?.payload.case !== "skill") throw new Error("Expected Skill operation result.");
    const updated = applied.operation.result.payload.value.skill!;
    expect(updated.skillId).toBe(installed.id);
    expect(fixture.refreshPiGeneration).toHaveBeenCalledTimes(1);

    const toggled = await submit(fixture, "enable-skill", {
      case: "setSkillEnabled",
      value: create(contract.SetSkillEnabledMutationSchema, {
        skillId: updated.skillId,
        expectedResourceRevision: updated.entityVersion?.revision,
        enabled: true
      })
    });
    expect(toggled.operation?.result?.payload.case).toBe("skill");
    if (toggled.operation?.result?.payload.case !== "skill") throw new Error("Expected Skill toggle result.");
    expect(toggled.operation.result.payload.value.skill?.enabled).toBe(true);

    const current = toggled.operation.result.payload.value.skill!;
    const reopened = await invoke<contract.OpenSkillResponse>(fixture.services.skill.openSkill, {
      skillId: current.skillId,
      expectedResourceRevision: current.entityVersion?.revision
    });
    const removed = await submit(fixture, "delete-skill", {
      case: "deleteSkill",
      value: create(contract.DeleteSkillMutationSchema, {
        sessionId: reopened.skill!.sessionId,
        confirmation: "connect-skill"
      })
    });
    expect(removed.operation?.result?.payload.case).toBe("skill");
    if (removed.operation?.result?.payload.case !== "skill") throw new Error("Expected Skill delete result.");
    expect(removed.operation.result.payload.value.skill?.state).toBe(contract.ResourceState.REMOVED);
    expect(removed.operation.result.payload.value.recoveryId).toMatch(/^skill_recovery_/u);
    const recoveries = await invoke<contract.ListSkillRecoveriesResponse>(fixture.services.skill.listSkillRecoveries, {
      page: { pageSize: 1 }
    });
    expect(recoveries.recoveries).toMatchObject([{
      skillId: installed.id,
      name: "connect-skill",
      status: contract.SkillRecoveryStatus.READY
    }]);
    expect(recoveries.page?.totalSize).toBe(1n);
    expect(stringify(recoveries)).not.toContain(fixture.root);
  });

  it("fences revisions, connection ownership, and revoked connection sessions", async () => {
    const fixture = await createFixture();
    await expect(invoke(fixture.services.skill.listSkills, { scope: 999 })).rejects.toThrow(/scope/u);
    const source = join(fixture.root, "fenced-source");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "# fenced\n", "utf8");
    const discovered = await fixture.resources.discover({
      id: "fenced-skill",
      backendId: "pi",
      kind: "skill",
      scope: "managed",
      source: { kind: "local", path: source }
    });
    const approved = await fixture.resources.approve(discovered.id, discovered.discoveredRevision, CONNECTION_ID);
    const installed = await fixture.resources.install(approved.id);
    await expect(invoke(fixture.services.skill.openSkill, {
      skillId: installed.id,
      expectedResourceRevision: { value: installed.versionNumber - 1n }
    })).rejects.toMatchObject({ code: 10 });

    const opened = await invoke<contract.OpenSkillResponse>(fixture.services.skill.openSkill, {
      skillId: installed.id,
      expectedResourceRevision: { value: installed.versionNumber }
    });
    fixture.connectionId = "another-connection";
    await expect(invoke(fixture.services.skill.listSkillFiles, {
      sessionId: opened.skill!.sessionId,
      parentKey: ""
    })).rejects.toMatchObject({ code: 7 });
    fixture.connectionId = CONNECTION_ID;
    fixture.revoke?.();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    await expect(invoke(fixture.services.skill.listSkillFiles, {
      sessionId: opened.skill!.sessionId,
      parentKey: ""
    })).rejects.toMatchObject({ code: 5 });
  });
});

const CONNECTION_ID = "connection-skill";

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-connect-skill-"));
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
  const skills = new SkillManager({ resources, store, rootDirectory: join(root, "skills") });
  await skills.initialize();
  const sessionHost = new SessionHost(store, {} as never, []);
  const refreshPiGeneration = vi.fn(async () => undefined);
  const ownerConnection = store.createConnection({ id: CONNECTION_ID, name: "Skill tests", authKeyDigest: "digest-owner" });
  const otherConnection = store.createConnection({ id: "another-connection", name: "Other", authKeyDigest: "digest-other" });
  const state: {
    connectionId: string;
    revoke?: () => void;
  } = { connectionId: CONNECTION_ID };
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: {
      authenticate: () => state.connectionId === CONNECTION_ID ? ownerConnection : otherConnection,
      fence: () => undefined,
      onRevoked: (_connectionId: string, listener: () => void) => {
        state.revoke = listener;
        return () => { state.revoke = undefined; };
      }
    },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost,
    scheduler: {},
    adapters: [],
    piResources: resources,
    skills,
    refreshPiGeneration,
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  const services = createConnectServices(application);
  cleanups.push(async () => {
    await skills.close();
    await sessionHost.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return Object.assign(state, { root, store, resources, skills, services, refreshPiGeneration, sessionHost });
}

async function submit(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  operationId: string,
  payload: contract.OperationMutation["payload"]
): Promise<contract.SubmitOperationResponse> {
  return invoke(fixture.services.operation.submitOperation, {
    operationId,
    connectionId: fixture.connectionId,
    mutation: create(contract.OperationMutationSchema, { payload })
  });
}

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (input: unknown, context: unknown) => T | Promise<T>)(request, {
    requestHeader: new Headers(),
    signal: new AbortController().signal
  });
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString(10) : item);
}
