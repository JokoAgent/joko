import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  ApplySkillDraftMutationSchema,
  DeleteSkillMutationSchema,
  InputMentionRangeSchema,
  InputPartSchema,
  OperationMutationSchema,
  OperationState,
  PermissionMode,
  ResourceKind,
  ResourceScope,
  RunState,
  SetSkillEnabledMutationSchema,
  SkillFileKind,
  SkillRecoveryStatus,
  type Operation,
  type SkillDescriptor,
  type SkillMutationResult
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";
import { installLocalSkill, SkillSystemFixture } from "./skill-system-fixture.js";

it("authors a project Skill in a real Pi task and loads it after explicit review and enablement", { timeout: 90_000 }, async () => {
  const authoringCommand = "/joko-skill-creator";
  const projectPath = ".agents/skills/report-triage/SKILL.md";
  const authoredBody = "Classify each report by observed impact before summarizing.";
  const authored = `---\nname: report-triage\ndescription: Triage reports by observed impact.\n---\n\n${authoredBody}\n`;
  const fixture = await RealPiSystemFixture.start({ providerResponder: ({ request }) => {
    const messages = request.body["messages"] as Array<{ role?: string }> | undefined;
    if (messages?.at(-1)?.role === "tool") return { kind: "text", text: "Wrote the requested project Skill." };
    const serialized = JSON.stringify(messages ?? []);
    if (serialized.includes("Create the report triage Skill in this project") && serialized.includes("[Joko loaded resource]")
      && serialized.includes("Choose a lowercase hyphenated name")) {
      return { kind: "tool", name: "write", arguments: { path: projectPath, content: authored } };
    }
    return { kind: "text", text: serialized.includes(authoredBody) ? "Applied the reviewed project Skill." : "Finished." };
  } });
  try {
    const { clients, connectionId } = await fixture.pair("Ordinary Skill author");
    const target = required((await clients.target.listTargets({ backendId: "pi" })).targets
      .find(item => item.workspaceId === "workspace-real-pi"), "the original Pi Target");
    const trusted = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "setWorkspaceTrust", value: { workspaceId: target.workspaceId, trusted: true } }
    }));
    expect(trusted.state, trusted.error?.message).toBe(OperationState.SUCCEEDED);
    const startTask = async () => sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({
      backendId: "pi", targetId: target.targetId, providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID,
      permissionMode: PermissionMode.BYPASS_PERMISSIONS
    })));
    const runSkill = async (sessionId: string, resourceId: string, invocation: string, instruction: string) => {
      const active = required((await clients.session.listSessionResources({ sessionId })).resources.find(item => item.resourceId === resourceId), "loaded Skill");
      const mutation = sendInputMutation(sessionId, active.runtimeGeneration, `${invocation} ${instruction}`);
      if (mutation.payload.case !== "sendInput" || mutation.payload.value.input === undefined) throw new Error("Missing Skill input.");
      mutation.payload.value.input.parts.push(create(InputPartSchema, { content: { case: "resourceMention", value: {
        resourceId, discoveredRevision: active.discoveredRevision, resourceVersion: active.resourceVersion,
        runtimeGeneration: active.runtimeGeneration, displayText: invocation
      } } }));
      mutation.payload.value.input.mentionRanges.push(create(InputMentionRangeSchema, { start: 0, end: invocation.length, mentionIndex: 0 }));
      const runId = queueRunIdFrom(await submit(clients.operation, connectionId, mutation));
      await waitFor(() => clients.run.getRun({ runId }), result => result.run?.state === RunState.SUCCEEDED, instruction);
    };
    const original = await startTask();
    const commands = (await clients.session.listRuntimeCommands({ sessionId: original })).commands;
    const creator = required(commands.find(command => command.skillCreatorRevision !== undefined), "loaded ordinary Skill creator");
    expect(creator.resourceId).toMatch(/^builtin:skill_creator:/u);
    expect(commands.find(command => command.builtinSkill?.id === "plugin_creator")?.resourceId).toMatch(/^builtin:plugin_creator:/u);
    await runSkill(original, creator.resourceId, authoringCommand, "Create the report triage Skill in this project");
    expect((await readFile(join(fixture.workspaceDirectory, projectPath), "utf8")).replaceAll("\r\n", "\n")).toBe(authored);
    expect((await clients.skill.listSkills({ targetId: target.targetId })).skills).toHaveLength(0);

    const discovered = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "discoverProjectResources", value: { targetId: target.targetId } }
    }));
    expect(discovered.state, discovered.error?.message).toBe(OperationState.SUCCEEDED);
    const review = required((await clients.pi.listPiResources({ backendId: "pi", kind: ResourceKind.SKILL })).resources
      .find(resource => resource.targetId === target.targetId && resource.name === "report-triage"), "reviewable project Skill");
    expect(review.enabled).toBe(false);
    const approved = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "approveResource", value: { resourceId: review.resourceId, discoveredRevision: review.discoveredRevision } }
    }));
    expect(approved.state, approved.error?.message).toBe(OperationState.SUCCEEDED);
    const skill = required((await clients.skill.listSkills({ targetId: target.targetId })).skills.find(item => item.skillId === review.resourceId), "approved project Skill");
    const enabled = skillResult(await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "setSkillEnabled", value: { skillId: skill.skillId, expectedResourceRevision: skill.entityVersion?.revision, enabled: true } }
    })), "enable the authored Skill");
    expect(enabled.skill?.enabled).toBe(true);
    await runSkill(await startTask(), review.resourceId, "/report-triage", "Apply the reviewed project rule");
    expect(fixture.providerRequests.some(request => JSON.stringify(request.body["messages"]).includes(authoredBody))).toBe(true);
  } finally { await fixture.close(); }
});

describe("production Skill management chain", () => {
  let fixture: SkillSystemFixture | undefined;
  let rootDirectory: string | undefined;

  afterEach(async () => {
    await fixture?.close().catch(() => undefined);
    fixture = undefined;
    if (rootDirectory !== undefined) {
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 });
      rootDirectory = undefined;
    }
  });

  it("edits, renames, toggles, deletes, and recovers a path-private Skill through production Connect", async () => {
    fixture = await SkillSystemFixture.start({ keepRoot: true });
    rootDirectory = fixture.rootDirectory;
    await expect(fixture.anonymous.skill.listSkills({ page: { pageSize: 10 } }))
      .rejects.toMatchObject({ code: Code.Unauthenticated });

    const paired = await fixture.pair("Skill HTTP owner");
    const installed = await installLocalSkill(fixture, paired);
    const initialRevision = requiredRevision(installed.skill);
    expect(installed.skill).toMatchObject({
      name: "managed-review",
      scope: ResourceScope.GLOBAL,
      enabled: true,
      contentAvailable: true,
      canEdit: true,
      canDelete: true
    });

    const opened = await paired.clients.skill.openSkill({
      skillId: installed.skill.skillId,
      expectedResourceRevision: { value: initialRevision }
    });
    const session = required(opened.skill, "Skill detail session");
    expect(session).toMatchObject({
      dirty: false,
      baselineAvailable: true,
      metadata: {
        name: "managed-review",
        description: "Production Skill management fixture",
        version: "1.0.0"
      }
    });
    expect(session).not.toHaveProperty("files");
    // Inspect the public RPC values, excluding the fixture's local source path.
    const privateRoot = privateJson(fixture.rootDirectory).slice(1, -1);
    expect(privateJson({ installed: installed.skill, session })).not.toContain(privateRoot);

    const rootFiles = await paired.clients.skill.listSkillFiles({
      sessionId: session.sessionId,
      page: { pageSize: 1 }
    });
    expect(rootFiles.files).toHaveLength(1);
    expect(rootFiles.page).toMatchObject({ totalSize: 2n });
    const secondFiles = await paired.clients.skill.listSkillFiles({
      sessionId: session.sessionId,
      page: { pageSize: 500, pageToken: required(rootFiles.page?.nextPageToken, "Skill file page token") }
    });
    const completeRootFiles = [...rootFiles.files, ...secondFiles.files];
    expect(completeRootFiles).toHaveLength(2);
    expect(completeRootFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "SKILL.md", kind: SkillFileKind.FILE, editable: true }),
      expect.objectContaining({ key: "references", kind: SkillFileKind.DIRECTORY, editable: false })
    ]));
    const nested = await paired.clients.skill.listSkillFiles({
      sessionId: session.sessionId,
      parentKey: "references",
      page: { pageSize: 500 }
    });
    expect(nested.files).toMatchObject([{ key: "references/guide.md", editable: true }]);

    const manifest = required((await paired.clients.skill.readSkillFile({
      sessionId: session.sessionId,
      key: "SKILL.md"
    })).file, "Skill manifest");
    const changedContent = manifest.content.replace("# Original Skill", "# Edited through production Connect");
    const edit = required((await paired.clients.skill.prepareSkillFileEdit({
      sessionId: session.sessionId,
      key: "SKILL.md",
      expectedFileRevision: manifest.revision,
      content: changedContent
    })).draft, "Skill edit draft");
    expect(edit.changes).toEqual([
      expect.objectContaining({ key: "SKILL.md", unifiedDiff: expect.stringContaining("+# Edited through production Connect") })
    ]);

    const editMutation = create(OperationMutationSchema, {
      payload: {
        case: "applySkillDraft",
        value: create(ApplySkillDraftMutationSchema, { draftId: edit.draftId })
      }
    });
    const editOperationId = randomUUID();
    const editedOperation = await submit(paired.clients.operation, paired.connectionId, editMutation, editOperationId);
    const edited = skillResult(editedOperation, "apply the Skill edit");
    const editedSkill = required(edited.skill, "edited Skill descriptor");
    expect(requiredRevision(editedSkill)).toBeGreaterThan(initialRevision);
    const replayed = skillResult(
      await submit(paired.clients.operation, paired.connectionId, editMutation, editOperationId),
      "replay the Skill edit"
    );
    expect(requiredRevision(required(replayed.skill, "replayed Skill descriptor"))).toBe(requiredRevision(editedSkill));
    await expect(paired.clients.skill.readSkillFile({ sessionId: session.sessionId, key: "SKILL.md" }))
      .rejects.toMatchObject({ code: Code.NotFound });

    const editedSession = required((await paired.clients.skill.openSkill({
      skillId: editedSkill.skillId,
      expectedResourceRevision: editedSkill.entityVersion?.revision
    })).skill, "edited Skill session");
    expect(required((await paired.clients.skill.readSkillFile({
      sessionId: editedSession.sessionId,
      key: "SKILL.md"
    })).file, "edited Skill manifest").content).toContain("Edited through production Connect");

    const rename = required((await paired.clients.skill.prepareSkillRename({
      sessionId: editedSession.sessionId,
      name: "managed-review-renamed"
    })).draft, "Skill rename draft");
    expect(rename.changes[0]?.unifiedDiff).toContain("+name: managed-review-renamed");
    const renamed = skillResult(await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: {
        case: "applySkillDraft",
        value: create(ApplySkillDraftMutationSchema, { draftId: rename.draftId })
      }
    })), "rename the Skill");
    const renamedSkill = required(renamed.skill, "renamed Skill descriptor");
    expect(renamedSkill.name).toBe("managed-review-renamed");

    const disabled = skillResult(await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: {
        case: "setSkillEnabled",
        value: create(SetSkillEnabledMutationSchema, {
          skillId: renamedSkill.skillId,
          expectedResourceRevision: renamedSkill.entityVersion?.revision,
          enabled: false
        })
      }
    })), "disable the Skill");
    const disabledSkill = required(disabled.skill, "disabled Skill descriptor");
    expect(disabledSkill.enabled).toBe(false);

    const enabled = skillResult(await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: {
        case: "setSkillEnabled",
        value: create(SetSkillEnabledMutationSchema, {
          skillId: disabledSkill.skillId,
          expectedResourceRevision: disabledSkill.entityVersion?.revision,
          enabled: true
        })
      }
    })), "re-enable the Skill");
    const enabledSkill = required(enabled.skill, "re-enabled Skill descriptor");
    const deleteSession = required((await paired.clients.skill.openSkill({
      skillId: enabledSkill.skillId,
      expectedResourceRevision: enabledSkill.entityVersion?.revision
    })).skill, "Skill deletion session");
    const removed = skillResult(await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: {
        case: "deleteSkill",
        value: create(DeleteSkillMutationSchema, {
          sessionId: deleteSession.sessionId,
          confirmation: "managed-review-renamed"
        })
      }
    })), "delete the Skill");
    expect(removed.skill?.enabled).toBe(false);
    expect(removed.recoveryId).toMatch(/^skill_recovery_[a-f0-9]{32}$/u);
    expect((await paired.clients.skill.listSkills({ page: { pageSize: 500 } })).skills).toEqual([]);
    const recoveries = await paired.clients.skill.listSkillRecoveries({ page: { pageSize: 500 } });
    expect(recoveries.recoveries).toMatchObject([{
      recoveryId: removed.recoveryId,
      skillId: enabledSkill.skillId,
      name: "managed-review-renamed",
      status: SkillRecoveryStatus.READY,
      files: 2n
    }]);
    expect(privateJson(recoveries)).not.toContain(privateRoot);

    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await SkillSystemFixture.start({ rootDirectory, keepRoot: true });
    const restarted = await fixture.pair("Skill restart owner");
    expect((await restarted.clients.skill.listSkills({ page: { pageSize: 500 } })).skills).toEqual([]);
    expect((await restarted.clients.skill.listSkillRecoveries({ page: { pageSize: 500 } })).recoveries)
      .toMatchObject([{ recoveryId: removed.recoveryId, status: SkillRecoveryStatus.READY }]);
  }, 90_000);
});

function skillResult(operation: Operation, action: string): SkillMutationResult {
  if (operation.state !== OperationState.SUCCEEDED || operation.result?.payload.case !== "skill") {
    throw new Error(`Production Connect operation failed to ${action}.`);
  }
  return operation.result.payload.value;
}

function requiredRevision(skill: SkillDescriptor): bigint {
  return required(skill.entityVersion?.revision?.value, "Skill revision");
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined || value === "") throw new Error(`${label} is missing.`);
  return value;
}

function privateJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => typeof nested === "bigint" ? nested.toString() : nested);
}
