import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  AddSkillMarketSourceMutationSchema,
  ApplySkillDraftMutationSchema,
  OperationMutationSchema,
  OperationState,
  SkillLearningSourceKind,
  SkillLearningState,
  SkillMarketSort
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";
import { writeSkillMarketSource } from "./skill-market-system-fixture.js";

const skillDocument = (body: string): string => [
  "---",
  "name: learned-review",
  "description: Review a production change before applying it",
  "---",
  body,
  ""
].join("\n");

function proposal(body: string): string {
  return JSON.stringify({
    name: "learned-review",
    description: "Review a production change before applying it",
    explanation: `This proposal captures ${body}.`,
    files: [{ path: "SKILL.md", content: skillDocument(body) }]
  });
}

describe("production Skill learning", () => {
  let fixture: RealPiSystemFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("distills and revises in one visible Session, then adopts the reviewed Resource through authenticated Connect", { timeout: 120_000 }, async () => {
    fixture = await RealPiSystemFixture.start({
      providerResponder: ({ requestNumber }) => ({ kind: "text", text: proposal(requestNumber === 1 ? "# Initial review" : "# Revised review") })
    });
    const paired = await fixture.pair("Skill learning reviewer");
    await expect(fixture.anonymous.skill.listSkillLearningRuns({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    const started = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(),
      targetId: "workspace-real-pi",
      instruction: "Create a review Skill from this workflow. password=training-secret C:\\Users\\Someone\\draft.md"
    })).run;
    expect(started?.distillationSessionId).toBeTruthy();
    expect(started?.state).toBe(SkillLearningState.DISTILLING);
    const sessionId = started!.distillationSessionId!;
    expect(fixture.application.store.listQueueItems({ sessionId })).toHaveLength(1);
    let reviewed = (await waitFor(
      () => paired.clients.skill.getSkillLearningRun({ runId: started!.runId }),
      (response) => response.run?.state === SkillLearningState.AWAITING_REVIEW,
      "initial Skill learning proposal",
      45_000
    )).run!;
    expect(reviewed.proposal?.files[0]?.content).toContain("# Initial review");
    expect(reviewed.proposal?.changes.length).toBeGreaterThan(0);
    expect(fixture.providerRequests).toHaveLength(1);
    expect(JSON.stringify(fixture.providerRequests[0]?.body)).not.toContain("training-secret");
    expect(JSON.stringify(fixture.providerRequests[0]?.body)).not.toContain("C:\\Users\\Someone");

    await submit(paired.clients.operation, paired.connectionId, sendInputMutation(
      sessionId,
      BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation),
      "Revise the proposal to include the updated review step."
    ));
    const firstRevision = reviewed.revision?.value;
    reviewed = (await waitFor(
      () => paired.clients.skill.getSkillLearningRun({ runId: started!.runId }),
      (response) => response.run?.state === SkillLearningState.AWAITING_REVIEW
        && response.run.revision?.value !== firstRevision
        && response.run.proposal?.files[0]?.content.includes("# Revised review") === true,
      "revised Skill learning proposal",
      45_000
    )).run!;
    const proposed = reviewed.proposal!;
    const operationId = randomUUID();
    const applied = (await paired.clients.skill.applySkillLearning({
      operationId,
      runId: reviewed.runId,
      expectedRunRevision: reviewed.revision,
      expectedProposalRevision: proposed.revision,
      expectedResourceId: proposed.resourceId,
      confirmReplace: false
    })).run!;
    expect(applied.state).toBe(SkillLearningState.APPLIED);
    expect(applied.appliedResourceId).toBe(proposed.resourceId);
    expect(applied.proposal).toBeUndefined();
    const resource = fixture.application.piResources?.get(proposed.resourceId);
    expect(resource).toMatchObject({ sourceKind: "learned", state: "installed" });
    expect(JSON.stringify(await paired.clients.skill.getSkillLearningRun({ runId: reviewed.runId }),
      (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)).not.toContain(fixture.rootDirectory);

    const replacement = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "Improve the same review Skill."
    })).run!;
    const replaceReview = (await waitFor(
      () => paired.clients.skill.getSkillLearningRun({ runId: replacement.runId }),
      (response) => response.run?.state === SkillLearningState.AWAITING_REVIEW,
      "replacement Skill learning proposal",
      45_000
    )).run!;
    expect(replaceReview.proposal?.currentResourceId).toBe(proposed.resourceId);
    const replacementRequest = {
      runId: replaceReview.runId,
      expectedRunRevision: replaceReview.revision,
      expectedProposalRevision: replaceReview.proposal!.revision,
      expectedResourceId: replaceReview.proposal!.resourceId,
      expectedCurrentResourceId: replaceReview.proposal!.currentResourceId,
      expectedCurrentResourceRevision: replaceReview.proposal!.currentResourceRevision,
      expectedCurrentObservedRevision: replaceReview.proposal!.currentObservedRevision
    };
    await expect(paired.clients.skill.applySkillLearning({
      ...replacementRequest, operationId: randomUUID(), confirmReplace: false
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const currentSkill = (await paired.clients.skill.listSkills({ query: "learned-review", page: { pageSize: 100 } }))
      .skills.find((skill) => skill.skillId === proposed.resourceId);
    if (currentSkill === undefined) throw new Error("Learned Skill was not listed for editing.");
    const editSession = (await paired.clients.skill.openSkill({
      skillId: currentSkill.skillId, expectedResourceRevision: currentSkill.entityVersion?.revision
    })).skill;
    if (editSession === undefined) throw new Error("Learned Skill could not be opened.");
    const before = (await paired.clients.skill.readSkillFile({ sessionId: editSession.sessionId, key: "SKILL.md" })).file;
    if (before === undefined) throw new Error("Learned Skill file could not be read.");
    const externallyEdited = `${before.content}\n# Concurrent edit\n`;
    const edit = (await paired.clients.skill.prepareSkillFileEdit({
      sessionId: editSession.sessionId, key: "SKILL.md", expectedFileRevision: before.revision, content: externallyEdited
    })).draft;
    if (edit === undefined) throw new Error("Concurrent Skill edit was not prepared.");
    const editOperation = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: { case: "applySkillDraft", value: create(ApplySkillDraftMutationSchema, { draftId: edit.draftId }) }
    }));
    expect(editOperation.state).toBe(OperationState.SUCCEEDED);
    await expect(paired.clients.skill.applySkillLearning({
      ...replacementRequest, operationId: randomUUID(), confirmReplace: true
    })).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const changedSkill = (await paired.clients.skill.listSkills({ query: "learned-review", page: { pageSize: 100 } }))
      .skills.find((skill) => skill.skillId === proposed.resourceId);
    const changedSession = (await paired.clients.skill.openSkill({
      skillId: changedSkill!.skillId, expectedResourceRevision: changedSkill!.entityVersion?.revision
    })).skill;
    expect((await paired.clients.skill.readSkillFile({ sessionId: changedSession!.sessionId, key: "SKILL.md" })).file?.content)
      .toBe(externallyEdited);
    const discarded = (await paired.clients.skill.discardSkillLearning({
      operationId: randomUUID(), runId: replaceReview.runId, expectedRunRevision: replaceReview.revision
    })).run!;
    expect(discarded.state).toBe(SkillLearningState.DISCARDED);
    expect(discarded.proposal).toBeUndefined();
    expect(await readdir(join(fixture.rootDirectory, "data", "skill-learning", replaceReview.runId)).catch(() => []))
      .toEqual([]);

    const expiring = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "Prepare another review proposal."
    })).run!;
    await waitFor(() => paired.clients.skill.getSkillLearningRun({ runId: expiring.runId }),
      (response) => response.run?.state === SkillLearningState.AWAITING_REVIEW, "expiring learning proposal", 45_000);
    const persisted = fixture.application.store.findSetting("service", "skill-learning", expiring.runId);
    if (persisted === undefined || !persisted.value || typeof persisted.value !== "object") {
      throw new Error("Learning run was not durably stored.");
    }
    fixture.application.store.setSetting("service", "skill-learning", expiring.runId, {
      ...persisted.value, expiresAt: Date.now() - 1
    });
    expect((await paired.clients.skill.getSkillLearningRun({ runId: expiring.runId })).run?.state)
      .toBe(SkillLearningState.EXPIRED);
    expect(await readdir(join(fixture.rootDirectory, "data", "skill-learning", expiring.runId)).catch(() => []))
      .toEqual([]);

    const marketRoot = await writeSkillMarketSource(fixture, "1.0.0", "# Catalog experience");
    const addedMarket = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: {
        case: "addSkillMarketSource",
        value: create(AddSkillMarketSourceMutationSchema, {
          source: { kind: { case: "local", value: { serverPath: marketRoot } } },
          expectedCatalogRevision: { value: 0n }
        })
      }
    }));
    expect(addedMarket.state).toBe(OperationState.SUCCEEDED);
    const marketEntry = (await paired.clients.skill.listSkillMarketCatalog({
      sort: SkillMarketSort.UPDATED, page: { pageSize: 100 }
    })).entries[0];
    if (marketEntry?.identity === undefined) throw new Error("Catalog Skill identity is unavailable.");
    const marketRun = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "", marketIdentity: marketEntry.identity
    })).run!;
    expect(marketRun.sourceKind).toBe(SkillLearningSourceKind.MARKET);
    const marketReview = (await waitFor(
      () => paired.clients.skill.getSkillLearningRun({ runId: marketRun.runId }),
      (response) => response.run?.state === SkillLearningState.AWAITING_REVIEW,
      "catalog Skill learning proposal", 45_000
    )).run!;
    expect(JSON.stringify(fixture.providerRequests.at(-1)?.body)).toContain("Guide for 1.0.0");
    expect((await paired.clients.skill.discardSkillLearning({
      operationId: randomUUID(), runId: marketReview.runId, expectedRunRevision: marketReview.revision
    })).run?.state).toBe(SkillLearningState.DISCARDED);

    const sourceOperation = await submit(paired.clients.operation, paired.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Source task for Skill learning",
      providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off"
    }));
    const sourceSessionId = sessionIdFrom(sourceOperation);
    const generation = BigInt(fixture.application.store.getSession(sourceSessionId).descriptor.binding.generation);
    await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(sourceSessionId, generation, "Verify staging before applying the change."));
    await waitFor(async () => fixture!.application.store.listRuns({ sessionId: sourceSessionId })[0]?.descriptor.state,
      (state) => state === "completed", "source task completion", 45_000);
    const sessionRun = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "", sourceSessionId
    })).run!;
    expect(sessionRun.sourceKind).toBe(SkillLearningSourceKind.SESSION);
    const sessionReview = (await waitFor(
      () => paired.clients.skill.getSkillLearningRun({ runId: sessionRun.runId }),
      (response) => response.run?.state === SkillLearningState.AWAITING_REVIEW,
      "task-derived Skill learning proposal", 45_000
    )).run!;
    expect(JSON.stringify(fixture.providerRequests.at(-1)?.body)).toContain("Verify staging before applying the change.");
    expect((await paired.clients.skill.discardSkillLearning({
      operationId: randomUUID(), runId: sessionReview.runId, expectedRunRevision: sessionReview.revision
    })).run?.state).toBe(SkillLearningState.DISCARDED);
  });

  it("commits cancellation before aborting in-flight distillation", { timeout: 120_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ holdProviderResponses: true });
    const paired = await fixture.pair("Learning cancellation reviewer");
    const started = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "Learn a cancellable procedure."
    })).run!;
    await waitFor(async () => fixture!.providerRequests.length, (count) => count > 0, "pending learning Provider request", 30_000);
    const cancelling = paired.clients.skill.cancelSkillLearning({
      operationId: randomUUID(), runId: started.runId, expectedRunRevision: started.revision
    });
    await waitFor(async () => fixture!.application.store.findSetting("service", "skill-learning", started.runId)?.value,
      (value) => value !== undefined && typeof value === "object" && value !== null && "state" in value && value.state === "cancelled",
      "durable learning cancellation", 15_000);
    fixture.releaseProviderResponses();
    expect((await cancelling).run?.state).toBe(SkillLearningState.CANCELLED);
    expect((await paired.clients.skill.getSkillLearningRun({ runId: started.runId })).run?.state)
      .toBe(SkillLearningState.CANCELLED);
  });

  it("retains a failed interrupted run and retires its private proposal on restart", { timeout: 120_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ keepRoot: true, holdProviderResponses: true });
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("Interrupted learning reviewer");
    const started = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "Learn a restart-safe procedure."
    })).run!;
    await waitFor(async () => fixture!.providerRequests.length, (count) => count > 0, "pending distillation request", 30_000);
    expect(started.state).toBe(SkillLearningState.DISTILLING);
    await fixture.close({ removeRoot: false });
    fixture = await RealPiSystemFixture.start({ rootDirectory });
    const current = (await (await fixture.pair("Recovered learning reviewer")).clients.skill.getSkillLearningRun({
      runId: started.runId
    })).run!;
    expect(current.state).toBe(SkillLearningState.FAILED);
    expect(current.error).toContain("interrupted");
    expect(await readdir(join(rootDirectory, "data", "skill-learning", started.runId)).catch(() => []))
      .toEqual([]);
  });
});
