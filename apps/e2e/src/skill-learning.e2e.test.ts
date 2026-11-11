import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { JokoError, NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD } from "@joko/core";
import {
  AddSkillMarketSourceMutationSchema,
  ApplySkillDraftMutationSchema,
  BackendSettingsPatchSchema,
  OperationMutationSchema,
  OperationState,
  SetWorkspaceTrustMutationSchema,
  SkillLearningSourceKind,
  SkillLearningState,
  SkillMarketSort
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture, startLocalProvider, type CapturedProviderRequest } from "./real-pi-fixture.js";
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
    vi.restoreAllMocks();
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
    expect(currentSkill).toMatchObject({ contentAvailable: true, canEdit: true, canDelete: true });
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

    const catalogTail = "Keep the final approval gate from the catalog skill.";
    const catalogNotes = Array.from({ length: 1800 }, (_, index) => `Catalog example ${index} explains a work step.`).join("\n");
    const marketRoot = await writeSkillMarketSource(fixture, "1.0.0", `# Catalog experience\n${catalogNotes}\n${catalogTail}`, [
      { key: "references/unreadable.bin", content: Buffer.from([0xff, 0x00]) }
    ]);
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
    expect(fixture.application.store.getTarget("workspace-real-pi").descriptor.trusted).toBe(false);
    const marketRun = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "", marketIdentity: marketEntry.identity
    })).run!;
    expect(marketRun.sourceKind).toBe(SkillLearningSourceKind.MARKET);
    const marketReview = (await waitFor(
      () => paired.clients.skill.getSkillLearningRun({ runId: marketRun.runId }),
      (response) => response.run?.state === SkillLearningState.AWAITING_REVIEW,
      "catalog Skill learning proposal", 45_000
    )).run!;
    const marketPrompt = JSON.stringify(fixture.providerRequests.at(-1)?.body);
    expect(marketPrompt).toContain(catalogTail);
    expect(marketPrompt).toContain("references/guide.md");
    expect(marketPrompt).toContain("Omitted catalog reference files");
    expect(marketPrompt).toContain("references/unreadable.bin");
    const [marketQueue] = fixture.application.store.listQueueItems({ sessionId: marketRun.distillationSessionId! });
    expect(marketQueue?.body.files).toEqual([]);
    expect(marketPrompt).toContain("Guide for 1.0.0");
    expect((await paired.clients.skill.discardSkillLearning({
      operationId: randomUUID(), runId: marketReview.runId, expectedRunRevision: marketReview.revision
    })).run?.state).toBe(SkillLearningState.DISCARDED);

    expect((await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: { case: "setWorkspaceTrust", value: create(SetWorkspaceTrustMutationSchema, {
        workspaceId: "workspace-real-pi", trusted: true
      }) }
    }))).state).toBe(OperationState.SUCCEEDED);
    const attachedRun = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "", marketIdentity: marketEntry.identity
    })).run!;
    const attachedReview = (await waitFor(
      () => paired.clients.skill.getSkillLearningRun({ runId: attachedRun.runId }),
      response => response.run?.state === SkillLearningState.AWAITING_REVIEW,
      "trusted catalog Skill learning proposal", 45_000
    )).run!;
    const attachedPrompt = JSON.stringify(fixture.providerRequests.at(-1)?.body);
    const [attachedQueue] = fixture.application.store.listQueueItems({ sessionId: attachedRun.distillationSessionId! });
    expect(attachedQueue?.body.files).toHaveLength(1);
    expect(attachedPrompt).toContain(catalogTail);
    expect(attachedPrompt).toContain("references/guide.md");
    const reference = attachedQueue!.body.files[0]!.blob;
    const referencePath = await fixture.application.artifacts.resolveBlobPath(reference);
    expect(attachedPrompt).toContain(JSON.stringify(referencePath).slice(1, -1));
    expect(Buffer.from((await fixture.application.artifacts.readBlob(reference)).data).toString("utf8")).toBe("Guide for 1.0.0\n");
    expect((await paired.clients.skill.discardSkillLearning({
      operationId: randomUUID(), runId: attachedReview.runId, expectedRunRevision: attachedReview.revision
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
    const sourceStore = fixture.application.store;
    const source = sourceStore.getSession(sourceSessionId).descriptor;
    const appendEvidenceMessage = (
      payload: Parameters<typeof sourceStore.appendEvent>[0]["payload"]
    ): void => {
      sourceStore.appendEvent({
        id: randomUUID(),
        backendId: source.backendId,
        targetId: source.targetId,
        sessionId: sourceSessionId,
        generation: source.binding.generation,
        traceId: "skill-learning-session-evidence",
        payload
      });
    };
    appendEvidenceMessage({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "internal runtime recovery directive" }],
      automaticContinuation: { recoveryId: "skill-learning-recovery" }
    });
    appendEvidenceMessage({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "internal objective directive" }],
      objectiveContinuation: { ownerGeneration: 1, turn: 1 }
    });
    appendEvidenceMessage({
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "Ordinary assistant evidence remains available." }]
    });
    const sessionRun = (await paired.clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "", sourceSessionId
    })).run!;
    expect(sessionRun.sourceKind).toBe(SkillLearningSourceKind.SESSION);
    const sessionReview = (await waitFor(
      () => paired.clients.skill.getSkillLearningRun({ runId: sessionRun.runId }),
      (response) => response.run?.state === SkillLearningState.AWAITING_REVIEW,
      "task-derived Skill learning proposal", 45_000
    )).run!;
    const sessionEvidenceRequest = JSON.stringify(fixture.providerRequests.at(-1)?.body);
    expect(sessionEvidenceRequest).toContain("Verify staging before applying the change.");
    expect(sessionEvidenceRequest).toContain("Ordinary assistant evidence remains available.");
    expect(sessionEvidenceRequest).not.toContain("internal runtime recovery directive");
    expect(sessionEvidenceRequest).not.toContain("internal objective directive");
    expect((await paired.clients.skill.discardSkillLearning({
      operationId: randomUUID(), runId: sessionReview.runId, expectedRunRevision: sessionReview.revision
    })).run?.state).toBe(SkillLearningState.DISCARDED);
  });

  it("collects the active conversation beyond streaming events and refuses an empty source before dispatch", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ providerResponder: () => ({ kind: "text", text: proposal("# Conversation evidence") }) });
    const { clients, connectionId } = await fixture.pair("Conversation evidence reviewer");
    const sourceSessionId = sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID
    })));
    const store = fixture.application.store;
    const source = store.getSession(sourceSessionId).descriptor;
    const sourceSessions = store.listSessions({ includeArchived: true }).map(session => session.descriptor.id);
    const empty = (await clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: source.targetId, sourceSessionId, instruction: ""
    })).run!;
    expect(empty.state).toBe(SkillLearningState.FAILED);
    expect(empty.error).toContain("no conversation text");
    expect(empty.distillationSessionId).toBeUndefined();
    expect(store.listSessions({ includeArchived: true }).map(session => session.descriptor.id)).toEqual(sourceSessions);
    expect(fixture.providerRequests).toHaveLength(0);
    const append = (payload: Parameters<typeof store.appendEvent>[0]["payload"], native = false): void => {
      store.appendEvent({ id: randomUUID(), backendId: source.backendId, targetId: source.targetId,
        sessionId: sourceSessionId, generation: source.binding.generation, traceId: "learning-visible-evidence", payload,
        ...(native ? { metadata: { namespace: "test.native_history", fields: {
          [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: `sha256:${createHash("sha256").update(source.binding.opaqueRef).digest("hex")}`
        } } } : {}) });
    };
    const deletedEventId = randomUUID();
    store.appendEvent({ id: deletedEventId, backendId: source.backendId, targetId: source.targetId,
      sessionId: sourceSessionId, generation: source.binding.generation, traceId: "learning-deleted-evidence",
      payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Deleted content must stay out." }] } });
    const deletionOperationId = randomUUID();
    store.runOperation({ id: deletionOperationId, kind: "delete_session_message", body: { sourceSessionId, deletedEventId } },
      current => current.commitMessageDeletion({ sessionId: sourceSessionId, requestedEventId: deletedEventId,
        deletedEventIds: [deletedEventId], operationId: deletionOperationId, traceId: "learning-deleted-evidence" }));
    store.transaction(() => {
      append({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: "Preserve the original review request." }],
        nativeHistory: { identity: { entryId: "learning-root" } } }, true);
      append({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Use the accepted review procedure." }],
        nativeHistory: { identity: { entryId: "learning-accepted", parentEntryId: "learning-root" } } }, true);
      append({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Retired sibling content must stay out." }],
        nativeHistory: { identity: { entryId: "learning-retired", parentEntryId: "learning-root" } } }, true);
      append({ type: "native_session_changed", opaqueRef: source.binding.opaqueRef, leafId: "learning-accepted" });
      append({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: "Internal continuation is not evidence." }],
        automaticContinuation: { recoveryId: "learning-internal" } });
      append({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: "Private Partner message is not evidence." }],
        partnerPrivateOrigin: { messageId: "private-learning-message", threadId: "private-learning-thread",
          senderPartnerId: "source-partner", recipientPartnerId: "target-partner", senderDisplayName: "Private source" } });
      append({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: "/skill:learn" }] });
      append({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "   " }] });
      for (let index = 0; index < 1_100; index += 1) {
        append({ type: "text_delta", blockId: "streaming-noise", delta: "not a completed message" });
      }
    });
    const started = (await clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: source.targetId, sourceSessionId, instruction: ""
    })).run!;
    expect(started.state).toBe(SkillLearningState.DISTILLING);
    const [queued] = store.listQueueItems({ sessionId: started.distillationSessionId! });
    expect(queued!.body.text).toContain("Preserve the original review request.");
    expect(queued!.body.text).toContain("Use the accepted review procedure.");
    expect(queued!.body.text).not.toContain("Retired sibling content");
    expect(queued!.body.text).not.toContain("Deleted content");
    expect(queued!.body.text).not.toContain("Internal continuation");
    expect(queued!.body.text).not.toContain("Private Partner message");
    expect(queued!.body.text).not.toContain("/skill:learn");
    expect(queued!.body.text).not.toContain("not a completed message");
    const reviewed = (await waitFor(() => clients.skill.getSkillLearningRun({ runId: started.runId }),
      response => response.run?.state === SkillLearningState.AWAITING_REVIEW, "visible conversation proposal", 45_000)).run!;
    expect(fixture.providerRequests).toHaveLength(1);
    expect(JSON.stringify(fixture.providerRequests[0]?.body)).toContain("Preserve the original review request.");
    expect(JSON.stringify(fixture.providerRequests[0]?.body)).not.toContain("Retired sibling content");
    await clients.skill.discardSkillLearning({ operationId: randomUUID(), runId: reviewed.runId, expectedRunRevision: reviewed.revision });
    store.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) append({ type: "message_complete", role: "user",
        blocks: [{ kind: "text", text: "Internal continuation is not evidence." }], automaticContinuation: { recoveryId: `internal-${index}` } });
    });
    const readEvents = store.listEvents.bind(store);
    let branchChanged = false;
    vi.spyOn(store, "listEvents").mockImplementation(query => {
      const page = readEvents(query);
      if (query?.messageCompleteOnly && !branchChanged) {
        branchChanged = true;
        setImmediate(() => append({ type: "native_session_changed", opaqueRef: source.binding.opaqueRef, leafId: "learning-retired" }));
      }
      return page;
    });
    const sessionsBeforeChange = store.listSessions({ includeArchived: true }).map(session => session.descriptor.id);
    const changed = (await clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: source.targetId, sourceSessionId, instruction: ""
    })).run!;
    expect(changed.state).toBe(SkillLearningState.FAILED);
    expect(changed.distillationSessionId).toBeUndefined();
    expect(store.listSessions({ includeArchived: true }).map(session => session.descriptor.id)).toEqual(sessionsBeforeChange);
    expect(fixture.providerRequests).toHaveLength(1);
  });

  it("keeps the latest bounded conversation messages and makes size omissions explicit", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ providerResponder: () => ({ kind: "text", text: proposal("# Bounded evidence") }) });
    const { clients, connectionId } = await fixture.pair("Bounded evidence reviewer");
    const sourceSessionId = sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID
    })));
    const store = fixture.application.store;
    const source = store.getSession(sourceSessionId).descriptor;
    const append = (text: string) => store.appendEvent({ id: randomUUID(), backendId: source.backendId, targetId: source.targetId,
      sessionId: sourceSessionId, generation: source.binding.generation, traceId: "learning-bounded-evidence",
      payload: { type: "message_complete", role: "user", blocks: [{ kind: "text", text }] } });
    store.transaction(() => {
      for (let index = 0; index < 130; index += 1) append(`Completed evidence ${String(index).padStart(3, "0")}.`);
    });
    const learn = async () => {
      const started = (await clients.skill.startSkillLearning({
        requestId: randomUUID(), targetId: source.targetId, sourceSessionId, instruction: ""
      })).run!;
      expect(started.state).toBe(SkillLearningState.DISTILLING);
      const text = store.listQueueItems({ sessionId: started.distillationSessionId! })[0]!.body.text;
      const reviewed = (await waitFor(() => clients.skill.getSkillLearningRun({ runId: started.runId }),
        response => response.run?.state === SkillLearningState.AWAITING_REVIEW, "bounded conversation proposal", 45_000)).run!;
      await clients.skill.discardSkillLearning({ operationId: randomUUID(), runId: reviewed.runId, expectedRunRevision: reviewed.revision });
      return text;
    };
    const messages = await learn();
    expect(messages).not.toContain("Completed evidence 009.");
    expect(messages).toContain("Completed evidence 010.");
    expect(messages).toContain("Completed evidence 129.");
    expect(messages.match(/Completed evidence \d{3}\./gu)).toHaveLength(120);
    expect(messages.indexOf("Completed evidence 010.")).toBeLessThan(messages.indexOf("Completed evidence 129."));
    store.transaction(() => {
      for (let index = 0; index < 20; index += 1) append(`Long evidence ${String(index).padStart(2, "0")}. ${"x".repeat(1_600)} omitted tail`);
    });
    const bounded = await learn();
    const evidence = bounded.split("<bounded_evidence>\n\n")[1]!.split("\n\n</bounded_evidence>")[0]!;
    expect(evidence.length).toBeLessThanOrEqual(24_000);
    expect(evidence).toContain("earlier message(s) omitted due to size budget");
    expect(evidence).toContain("[...truncated]");
    expect(evidence).toContain("Long evidence 19.");
    expect(evidence).not.toContain("Long evidence 00.");
    expect(evidence).not.toContain("omitted tail");
    expect(evidence).not.toContain("Completed evidence 129.");
  });

  it("preserves portable references through evidence, review and adoption while removing host paths and secrets", { timeout: 120_000 }, async () => {
    const portable = [
      "Run python 'scripts/tools/report.py'.",
      "[Report script](scripts/tools/report.py)",
      "Read ./references/guides/setup.md and ../shared/templates/report.md.",
      "Read reports+drafts/tools/report.py and 📁/tools/report.py.",
      "const pattern = /scripts\\/tools\\/report\\.py/u;",
      "https://example.test/docs/guides/run"
    ].join("\n");
    const privatePaths = ["/Users/learner/private/report.md", "/home/learner/private/report.md",
      "C:\\Users\\learner\\private\\report.md", "C:/Users/learner/private/report.md",
      "\\\\private-server\\share\\report.md", "//private-server/share/report.md", "~/private/report.md", "file:///Users/learner/private/report.md"];
    const regularExpressions = [
      "const extension = /[.]py/;",
      "const word = /report/gi;",
      "const slash = /[/]/u;",
      "const nested = /scripts\\/tools\\/report\\.py/u;"
    ];
    const credential = `sk-${"a".repeat(24)}`;
    const javascript = [
      `${regularExpressions[0]} const nearby = ${JSON.stringify(privatePaths[0])};`,
      ...regularExpressions.slice(1),
      'const relative = "scripts/tools/report.py";',
      "const divided = 12 / 3 / 2;",
      'const ambiguousString = "/[.]py/";',
      ...privatePaths.map((path, index) => `const host${index} = ${JSON.stringify(path)};`),
      `// Host reference: ${privatePaths[0]}`,
      'const password = "training-secret";',
      `const fingerprint = /${credential}/;`,
      'const publicUrl = "https://example.test/docs?ticket=private-ticket";',
      ""
    ].join("\n");
    const expectedJavascript = [
      `${regularExpressions[0]} const nearby = "<path>";`,
      ...regularExpressions.slice(1),
      'const relative = "scripts/tools/report.py";',
      "const divided = 12 / 3 / 2;",
      'const ambiguousString = "<path>";',
      ...privatePaths.map((_path, index) => `const host${index} = "<path>";`),
      "// Host reference: <path>",
      'const password = "[REDACTED]";',
      "const fingerprint = /[REDACTED]/;",
      'const publicUrl = "https://example.test/docs";',
      ""
    ].join("\n");
    const body = [portable, "```javascript", javascript, "```", ...privatePaths,
      "password=training-secret", "https://example.test/docs?ticket=private-ticket"].join("\n");
    const ambiguousText = `${regularExpressions[0]}\n${privatePaths[0]}\npassword=training-secret\n`;
    const brokenJavascript = `const incomplete = ;\n${ambiguousText}`;
    const script = 'from pathlib import Path\nprint(Path("scripts/tools/report.py"))\n';
    fixture = await RealPiSystemFixture.start({ providerResponder: () => ({ kind: "text", text: JSON.stringify({
      name: "learned-review", description: "Review a portable workflow", explanation: "Keep the reviewed portable references.",
      files: [{ path: "SKILL.md", content: skillDocument(body) }, { path: "scripts/tools/report.py", content: script },
        { path: "scripts/tools/report.js", content: javascript },
        { path: "references/unknown.txt", content: ambiguousText },
        { path: "scripts/tools/incomplete.js", content: brokenJavascript }]
    }) }) });
    const { clients, connectionId } = await fixture.pair("Portable learning reviewer");
    const started = (await clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: body
    })).run!;
    const reviewed = (await waitFor(() => clients.skill.getSkillLearningRun({ runId: started.runId }),
      response => response.run?.state === SkillLearningState.AWAITING_REVIEW, "portable Skill proposal", 45_000)).run!;
    const proposed = reviewed.proposal!;
    const content = proposed.files.find(file => file.key === "SKILL.md")!.content;
    const prompt = fixture.application.store.listQueueItems({ sessionId: started.distillationSessionId! })[0]!.body.text;
    const diff = proposed.changes.map(change => change.unifiedDiff ?? "").join("\n");
    for (const value of [prompt, content, diff]) {
      for (const line of portable.split("\n")) expect(value).toContain(line);
      for (const expression of regularExpressions) expect(value).toContain(expression);
      for (const path of privatePaths) expect(value).not.toContain(path);
      expect(value).not.toContain("training-secret");
      expect(value).not.toContain("private-ticket");
      expect(value).not.toContain(credential);
      expect(value).toContain("<path>");
    }
    expect(proposed.files.find(file => file.key === "scripts/tools/report.py")?.content).toBe(script);
    expect(proposed.files.find(file => file.key === "scripts/tools/report.js")?.content).toBe(expectedJavascript);
    expect(content).toContain(expectedJavascript);
    expect(prompt).toContain(expectedJavascript);
    const scriptDiff = proposed.changes.find(change => change.key === "scripts/tools/report.js")!.unifiedDiff!;
    expect(scriptDiff.split("\n").slice(3, -1).map(line => line.slice(1)).join("\n") + "\n").toBe(expectedJavascript);
    for (const key of ["references/unknown.txt", "scripts/tools/incomplete.js"]) {
      const fallback = proposed.files.find(file => file.key === key)!.content;
      expect(fallback).not.toContain(regularExpressions[0]);
      expect(fallback).not.toContain(privatePaths[0]);
      expect(fallback).not.toContain("training-secret");
      expect(fallback).toContain("<path>");
    }
    expect((await clients.skill.applySkillLearning({ operationId: randomUUID(), runId: reviewed.runId,
      expectedRunRevision: reviewed.revision, expectedProposalRevision: proposed.revision,
      expectedResourceId: proposed.resourceId, confirmReplace: false })).run?.state).toBe(SkillLearningState.APPLIED);
    const installed = (await clients.skill.listSkills({ query: "learned-review", page: { pageSize: 100 } }))
      .skills.find(skill => skill.skillId === proposed.resourceId)!;
    const opened = (await clients.skill.openSkill({ skillId: installed.skillId,
      expectedResourceRevision: installed.entityVersion?.revision })).skill!;
    for (const file of proposed.files) {
      expect((await clients.skill.readSkillFile({ sessionId: opened.sessionId, key: file.key })).file?.content).toBe(file.content);
    }

    // A normal Skill edit can introduce private host details. A replacement
    // preview must sanitize that complete old source without damaging regexes.
    const before = (await clients.skill.readSkillFile({ sessionId: opened.sessionId, key: "scripts/tools/report.js" })).file!;
    const draft = (await clients.skill.prepareSkillFileEdit({ sessionId: opened.sessionId, key: before.key,
      expectedFileRevision: before.revision, content: javascript })).draft!;
    expect((await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "applySkillDraft", value: create(ApplySkillDraftMutationSchema, { draftId: draft.draftId }) }
    }))).state).toBe(OperationState.SUCCEEDED);
    const replacement = (await clients.skill.startSkillLearning({
      requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "Replace the portable workflow."
    })).run!;
    const replacementReview = (await waitFor(() => clients.skill.getSkillLearningRun({ runId: replacement.runId }),
      response => response.run?.state === SkillLearningState.AWAITING_REVIEW, "portable replacement proposal", 45_000)).run!;
    const replacementProposal = replacementReview.proposal!;
    const replacementDiff = replacementProposal.changes.find(change => change.key === before.key)!.unifiedDiff!;
    for (const prefix of ["-", "+"]) {
      const side = replacementDiff.split("\n").slice(3, -1).filter(line => line.startsWith(prefix)).map(line => line.slice(1));
      expect(side.join("\n") + "\n").toBe(expectedJavascript);
    }
    expect((await clients.skill.applySkillLearning({ operationId: randomUUID(), runId: replacementReview.runId,
      expectedRunRevision: replacementReview.revision, expectedProposalRevision: replacementProposal.revision,
      expectedResourceId: replacementProposal.resourceId, expectedCurrentResourceId: replacementProposal.currentResourceId,
      expectedCurrentResourceRevision: replacementProposal.currentResourceRevision,
      expectedCurrentObservedRevision: replacementProposal.currentObservedRevision, confirmReplace: true })).run?.state)
      .toBe(SkillLearningState.APPLIED);
    const replaced = (await clients.skill.listSkills({ query: "learned-review", page: { pageSize: 100 } }))
      .skills.find(skill => skill.skillId === replacementProposal.resourceId)!;
    const replacementSession = (await clients.skill.openSkill({ skillId: replaced.skillId,
      expectedResourceRevision: replaced.entityVersion?.revision })).skill!;
    for (const file of replacementProposal.files) {
      expect((await clients.skill.readSkillFile({ sessionId: replacementSession.sessionId, key: file.key })).file?.content).toBe(file.content);
    }
  });

  it("uses the source task's exact Provider for distillation while that route is enabled", { timeout: 90_000 }, async () => {
    const sourceRequests: CapturedProviderRequest[] = [];
    const alternate = await startLocalProvider(sourceRequests, undefined, undefined, [], () => ({ kind: "text", text: proposal("# Source route") }));
    try {
      fixture = await RealPiSystemFixture.start({ providerResponder: () => ({ kind: "text", text: proposal("# Default route") }) });
      const backendId = "pi", targetId = "workspace-real-pi";
      const sourceProvider = "joko-e2e-source-route";
      const sourceModel = { providerId: sourceProvider, modelId: REAL_PI_MODEL_ID };
      await fixture.application.providers!.upsert({
        backendId, credentialOrigin: "", provider: { id: sourceProvider, api: "openai-completions", keyless: true,
          baseUrl: `http://127.0.0.1:${(alternate.address() as AddressInfo).port}/v1`,
          models: [{ id: REAL_PI_MODEL_ID, reasoning: true, contextWindow: 16_384, maxTokens: 1_024 }] },
        displayName: "Alternate local route", kind: "local_keyless", credentialBindings: {}, enabled: true,
        supportsLogin: false, supportsLogout: false, supportsRefresh: false
      });
      await fixture.application.refreshPiGeneration!();
      const { clients, connectionId } = await fixture.pair("Task learning route owner");
      const mutate = (mutation: Parameters<typeof submit>[2]) => submit(clients.operation, connectionId, mutation);
      const patchBackend = (patch: MessageInitShape<typeof BackendSettingsPatchSchema>) =>
        mutate(create(OperationMutationSchema, { payload: { case: "updateBackendSettings", value: { patch } } }));
      expect((await patchBackend({ backendId, defaultModel: { model: { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID } } })).state)
        .toBe(OperationState.SUCCEEDED);
      const sourceSessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId, ...sourceModel, effortId: "high" })));
      fixture.application.store.appendEvent({ id: randomUUID(), backendId, targetId, sessionId: sourceSessionId,
        generation: fixture.application.store.getSession(sourceSessionId).descriptor.binding.generation,
        traceId: "learning-source-route-evidence",
        payload: { type: "message_complete", role: "user", blocks: [{ kind: "text", text: "Preserve the review sequence from this task." }] } });
      const learn = async () => {
        const { run } = await clients.skill.startSkillLearning({ requestId: randomUUID(), targetId, sourceSessionId, instruction: "Distill the source task." });
        expect(run?.state).toBe(SkillLearningState.DISTILLING);
        const review = await waitFor(() => clients.skill.getSkillLearningRun({ runId: run!.runId }),
          value => value.run?.state === SkillLearningState.AWAITING_REVIEW, "the distillation proposal", 30_000);
        return { session: fixture!.application.store.getSession(run!.distillationSessionId!).descriptor, proposal: review.run?.proposal };
      };

      const inherited = await learn();
      expect(inherited.session).toMatchObject({ ...sourceModel, effort: "high", permissionMode: "ask" });
      expect(inherited.proposal?.files[0]?.content).toContain("# Source route");
      expect(sourceRequests).toHaveLength(1);
      expect(fixture.providerRequests).toHaveLength(0);

      expect((await patchBackend({ backendId, modelAccessUpdate: { ...sourceModel, enabled: false } })).state).toBe(OperationState.SUCCEEDED);
      const fallback = await learn();
      expect(fallback.session).toMatchObject({ providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID });
      expect(fallback.proposal?.files[0]?.content).toContain("# Default route");
      expect(sourceRequests).toHaveLength(1);
      expect(fixture.providerRequests).toHaveLength(1);
    } finally {
      alternate.closeAllConnections();
      await new Promise<void>(resolve => alternate.close(() => resolve()));
    }
  });

  it("exposes collection and cancels it without waiting for catalog evidence or replaying its start", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ providerResponder: () => ({ kind: "text", text: proposal("# New collection") }) });
    const paired = await fixture.pair("Collection cancellation reviewer");
    const marketRoot = await writeSkillMarketSource(fixture, "1.0.0", "# Catalog evidence");
    expect((await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: { case: "addSkillMarketSource", value: create(AddSkillMarketSourceMutationSchema, {
        source: { kind: { case: "local", value: { serverPath: marketRoot } } }, expectedCatalogRevision: { value: 0n }
      }) }
    }))).state).toBe(OperationState.SUCCEEDED);
    const identity = (await paired.clients.skill.listSkillMarketCatalog({ sort: SkillMarketSort.UPDATED, page: { pageSize: 100 } })).entries[0]!.identity!;
    const market = fixture.application.skillMarket!;
    const acquire = market.acquireEntry.bind(market);
    const blocked = barrier();
    const released = barrier();
    let entered = false;
    vi.spyOn(market, "acquireEntry").mockImplementationOnce(async (...args) => {
      entered = true;
      await blocked.promise;
      const lease = await acquire(...args);
      return { ...lease, release: () => { lease.release(); released.release(); } };
    });
    const request = { requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "", marketIdentity: identity };
    const starting = paired.clients.skill.startSkillLearning(request, { timeoutMs: 60_000 });
    let retry: ReturnType<typeof paired.clients.skill.startSkillLearning> | undefined;
    try {
      await waitFor(async () => entered, value => value, "blocked catalog collection");
      const collecting = (await paired.clients.skill.listSkillLearningRuns({})).runs[0]!;
      expect(collecting.state).toBe(SkillLearningState.COLLECTING);
      expect((await paired.clients.skill.getSkillLearningRun({ runId: collecting.runId })).run?.state).toBe(SkillLearningState.COLLECTING);
      let retrySettled = false;
      retry = paired.clients.skill.startSkillLearning(request, { timeoutMs: 60_000 }).then(response => { retrySettled = true; return response; });
      await expect(paired.clients.skill.startSkillLearning({ ...request, requestId: randomUUID() }))
        .rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect(retrySettled).toBe(false);
      const cancel = { operationId: randomUUID(), runId: collecting.runId, expectedRunRevision: collecting.revision };
      await expect(fixture.anonymous.skill.cancelSkillLearning(cancel)).rejects.toMatchObject({ code: Code.Unauthenticated });
      expect((await paired.clients.skill.cancelSkillLearning(cancel)).run?.state).toBe(SkillLearningState.CANCELLED);
      expect((await paired.clients.skill.cancelSkillLearning(cancel)).run?.state).toBe(SkillLearningState.CANCELLED);
      expect((await starting).run?.state).toBe(SkillLearningState.CANCELLED);
      expect((await retry).run?.state).toBe(SkillLearningState.CANCELLED);
      expect(fixture.application.store.findOperation(cancel.operationId)).toMatchObject({ kind: "cancel_skill_learning", status: "completed" });
      expect(fixture.application.store.listSessions({ includeArchived: true })).toEqual([]);
      expect(fixture.providerRequests).toHaveLength(0);
      const next = (await paired.clients.skill.startSkillLearning({ requestId: randomUUID(),
        targetId: "workspace-real-pi", instruction: "Start an independent procedure after cancellation." })).run!;
      expect(next.state).toBe(SkillLearningState.DISTILLING);
      blocked.release();
      await released.promise;
      expect(market.acquireEntry).toHaveBeenCalledTimes(1);
      expect(fixture.application.store.findOperation(`${collecting.runId}_session`)).toBeUndefined();
      expect(fixture.application.store.findOperation(`${collecting.runId}_input`)).toBeUndefined();
      expect(fixture.application.store.listSessions({ includeArchived: true })).toHaveLength(1);
      const nextReview = (await waitFor(() => paired.clients.skill.getSkillLearningRun({ runId: next.runId }),
        response => response.run?.state === SkillLearningState.AWAITING_REVIEW, "new collection proposal", 45_000)).run!;
      expect(fixture.providerRequests).toHaveLength(1);
      await paired.clients.skill.discardSkillLearning({ operationId: randomUUID(), runId: next.runId, expectedRunRevision: nextReview.revision });
    } finally {
      blocked.release();
      await starting.catch(() => undefined);
      await retry?.catch(() => undefined);
    }
  });

  it.each(["native creation", "unknown native effect", "committed Session"] as const)("keeps cancellation terminal when a late %s returns", { timeout: 90_000 }, async phase => {
    fixture = await RealPiSystemFixture.start();
    const paired = await fixture.pair("Late creation reviewer");
    const blocked = barrier();
    let entered = false;
    const host = fixture.application.sessionHost;
    const adapter = fixture.application.adapters.find(candidate => candidate.id === "pi")!;
    const close = vi.spyOn(adapter, "closeSession");
    if (phase !== "committed Session") {
      const createSession = adapter.createSession.bind(adapter);
      vi.spyOn(adapter, "createSession").mockImplementationOnce(async (...args) => {
        const result = await createSession(...args);
        entered = true;
        await blocked.promise;
        if (phase === "unknown native effect") throw new JokoError({ code: "NATIVE_CREATION_UNKNOWN",
          message: "The native creation acknowledgement was lost.", phase: "session", retryable: false,
          stateMayHaveChanged: true, recovery: "Inspect the original creation Operation." });
        return result;
      });
    } else {
      const createSession = host.createServiceSession.bind(host);
      vi.spyOn(host, "createServiceSession").mockImplementationOnce(async input => {
        const result = await createSession(input);
        entered = true;
        await blocked.promise;
        return result;
      });
    }
    const request = { requestId: randomUUID(), targetId: "workspace-real-pi", instruction: "Keep this cancelled creation from dispatching." };
    const starting = paired.clients.skill.startSkillLearning(request, { timeoutMs: 60_000 });
    try {
      await waitFor(async () => entered, value => value, "blocked Session creation", 30_000);
      const collecting = (await paired.clients.skill.listSkillLearningRuns({})).runs[0]!;
      expect(collecting.state).toBe(SkillLearningState.COLLECTING);
      expect((await paired.clients.skill.cancelSkillLearning({ operationId: randomUUID(), runId: collecting.runId,
        expectedRunRevision: collecting.revision })).run?.state).toBe(SkillLearningState.CANCELLED);
      expect((await starting).run?.state).toBe(SkillLearningState.CANCELLED);
      blocked.release();
      if (phase === "committed Session") {
        await waitFor(() => paired.clients.skill.getSkillLearningRun({ runId: collecting.runId }),
          response => response.run?.distillationSessionId !== undefined, "late committed Session receipt");
      } else {
        await waitFor(async () => fixture!.application.store.findOperation(`${collecting.runId}_session`)?.status,
          status => status === "failed", "late native creation Operation");
      }
      const cancelled = (await paired.clients.skill.getSkillLearningRun({ runId: collecting.runId })).run!;
      expect(cancelled.state).toBe(SkillLearningState.CANCELLED);
      expect(fixture.providerRequests).toHaveLength(0);
      expect(fixture.application.store.findOperation(`${collecting.runId}_input`)).toBeUndefined();
      const creation = fixture.application.store.findOperation<{ sessionId: string }>(`${collecting.runId}_session`)!;
      if (phase !== "committed Session") {
        expect(close).toHaveBeenCalledTimes(phase === "native creation" ? 1 : 0);
        expect(creation.status).toBe("failed");
        if (phase === "unknown native effect") expect(creation.error).toMatchObject({ stateMayHaveChanged: true });
        expect(fixture.application.store.listSessions({ includeArchived: true })).toEqual([]);
      } else {
        expect(creation.status).toBe("completed");
        expect(cancelled.distillationSessionId).toBe(creation.response?.sessionId);
        expect(fixture.application.store.listQueueItems({ sessionId: cancelled.distillationSessionId! })).toEqual([]);
      }
      expect((await paired.clients.skill.startSkillLearning(request)).run?.state).toBe(SkillLearningState.CANCELLED);
      if (phase !== "committed Session") expect(adapter.createSession).toHaveBeenCalledTimes(1);
      expect(fixture.providerRequests).toHaveLength(0);
    } finally {
      blocked.release();
      await starting.catch(() => undefined);
    }
  });

  it.each(["target", "connection"] as const)("revalidates the original %s after collection yields", { timeout: 90_000 }, async authority => {
    fixture = await RealPiSystemFixture.start();
    const paired = await fixture.pair("Collection authority reviewer");
    const blocked = barrier();
    const host = fixture.application.sessionHost;
    const createSession = host.createServiceSession.bind(host);
    let entered = false;
    vi.spyOn(host, "createServiceSession").mockImplementationOnce(async input => {
      entered = true;
      await blocked.promise;
      return createSession(input);
    });
    const starting = paired.clients.skill.startSkillLearning({ requestId: randomUUID(), targetId: "workspace-real-pi",
      instruction: "Require the original collection authority." }, { timeoutMs: 60_000 });
    try {
      await waitFor(async () => entered, value => value, "collection authority boundary");
      if (authority === "target") {
        expect((await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
          payload: { case: "setWorkspaceTrust", value: create(SetWorkspaceTrustMutationSchema, {
            workspaceId: "workspace-real-pi", trusted: true
          }) }
        }))).state).toBe(OperationState.SUCCEEDED);
      } else fixture.application.store.revokeConnection(paired.connectionId);
      blocked.release();
      expect((await starting).run?.state).toBe(SkillLearningState.FAILED);
      expect(fixture.application.store.listSessions({ includeArchived: true })).toEqual([]);
      expect(fixture.providerRequests).toHaveLength(0);
    } finally {
      blocked.release();
      await starting.catch(() => undefined);
    }
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

  it("retains interrupted collection after restart without recreating its temporary pipeline", { timeout: 90_000 }, async () => {
    fixture = await RealPiSystemFixture.start({ keepRoot: true });
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("Interrupted collection reviewer");
    const blocked = barrier();
    const host = fixture.application.sessionHost;
    const createSession = host.createServiceSession.bind(host);
    let entered = false;
    vi.spyOn(host, "createServiceSession").mockImplementationOnce(async input => {
      entered = true;
      await blocked.promise;
      return createSession(input);
    });
    const starting = paired.clients.skill.startSkillLearning({ requestId: randomUUID(), targetId: "workspace-real-pi",
      instruction: "Keep the interrupted collection receipt." }, { timeoutMs: 60_000 }).catch(() => undefined);
    try {
      await waitFor(async () => entered, value => value, "collection before service restart");
      const collecting = (await paired.clients.skill.listSkillLearningRuns({})).runs[0]!;
      expect(collecting.state).toBe(SkillLearningState.COLLECTING);
      // Retire the service owner first, then drain the blocked RPC before the
      // HTTP fixture's graceful close waits for outstanding requests.
      await fixture.application.close();
      blocked.release();
      await starting;
      await fixture.close({ removeRoot: false });
      fixture = await RealPiSystemFixture.start({ rootDirectory });
      const recovered = (await (await fixture.pair("Recovered collection reviewer")).clients.skill.getSkillLearningRun({
        runId: collecting.runId
      })).run!;
      expect(recovered.state).toBe(SkillLearningState.FAILED);
      expect(recovered.error).toContain("interrupted");
      expect(recovered.distillationSessionId).toBeUndefined();
      expect(fixture.application.store.findOperation(`${collecting.runId}_session`)).toBeUndefined();
      expect(fixture.application.store.findOperation(`${collecting.runId}_input`)).toBeUndefined();
      expect(fixture.providerRequests).toHaveLength(0);
    } finally {
      blocked.release();
      await starting;
    }
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

function barrier(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
