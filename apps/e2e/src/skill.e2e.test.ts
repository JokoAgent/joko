import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  ApplySkillDraftMutationSchema,
  DeleteSkillMutationSchema,
  OperationMutationSchema,
  OperationState,
  ResourceScope,
  SetSkillEnabledMutationSchema,
  SkillFileKind,
  SkillRecoveryStatus,
  type Operation,
  type SkillDescriptor,
  type SkillMutationResult
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { submit } from "./operations.js";
import { installLocalSkill, SkillSystemFixture } from "./skill-system-fixture.js";

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
    expect(privateJson({ installed, session })).not.toContain(fixture.rootDirectory);

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
    expect(privateJson(recoveries)).not.toContain(fixture.rootDirectory);

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
