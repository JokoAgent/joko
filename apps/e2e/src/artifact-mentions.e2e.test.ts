import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { create } from "@bufbuild/protobuf";
import { InputMentionRangeSchema, InputPartSchema, OperationState } from "@joko/contracts";
import type { AdapterContext, PromptInput } from "@joko/core";
import { createArtifactMentionResolver } from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, exportMutation, pauseQueueMutation, queueItemIdFrom, resumeQueueMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

it("adopts an exported Artifact before publication and resolves the same durable mention through HTTP, queue dispatch, and restart replay", async () => {
  const profile = { ...PI_LIKE_PROFILE, capabilities: [
    ...PI_LIKE_PROFILE.capabilities.filter((entry) => entry.key !== "input.mention"),
    { key: "input.mention", supported: true, options: ["artifact"] }
  ] };
  let fixture!: OrchestratorE2eFixture;
  const resolved: string[] = [];
  class ArtifactAdapter extends InstrumentedFakeAdapter {
    override async send(input: PromptInput, context: AdapterContext): Promise<void> {
      const application = fixture.application;
      const resolve = createArtifactMentionResolver({
        store: application.store, artifacts: application.artifacts,
        resolveTarget: (session) => application.sessionWorktrees.effectiveTarget(session),
        assertBackendCurrent: (owner) => {
          if (application.store.getBackend(owner.target.backendId).descriptor.instanceGeneration !== owner.backendInstanceGeneration) throw new Error("Retired input.");
        }
      });
      for (const mention of input.mentions) {
        if (mention.kind !== "artifact") throw new Error("Unexpected mention kind.");
        const artifact = await resolve(mention.reference, mention.sourceSessionId, context, context.signal);
        const text = await readFile(artifact.path, "utf8");
        artifact.assertCurrent();
        expect(text).toContain("Joko export");
        resolved.push(mention.reference);
      }
      await context.emit({
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: `native echo: ${input.text}` }]
      });
      await super.send(input, context);
    }
  }
  const start = (rootDirectory?: string) => OrchestratorE2eFixture.start({ profiles: [profile], createAdapter: (entry) => new ArtifactAdapter(entry),
    ...(rootDirectory === undefined ? {} : { rootDirectory }) });
  try {
    fixture = await start();
    const paired = await fixture.pair();
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: profile.id, targetId: fixture.targetId() })));
    const exported = await submit(paired.clients.operation, paired.connectionId, exportMutation(sessionId));
    expect(exported.state).toBe(OperationState.SUCCEEDED);
    const artifact = fixture.application.store.listArtifacts({ sessionId })[0]!;
    expect(artifact).toBeDefined();
    expect(artifact.metadata).toEqual({});
    const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
    const mutation = sendInputMutation(sessionId, generation, "Read @Export now");
    if (mutation.payload.case !== "sendInput") throw new Error("Missing send input.");
    mutation.payload.value.input!.parts.push(create(InputPartSchema, { content: { case: "artifactMention", value: {
      artifactId: artifact.blob.id, displayText: "Export", sourceSessionId: sessionId
    } } }));
    mutation.payload.value.input!.mentionRanges.push(create(InputMentionRangeSchema, {
      start: 5,
      end: 12,
      mentionIndex: 0
    }));
    const operationId = randomUUID();
    const accepted = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
    expect(accepted.error).toBeUndefined();
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    await waitFor(async () => fixture.application.store.listQueueItems({ sessionId }), (items) => items[0]?.state === "completed", "Artifact mention completion");
    expect(resolved).toEqual([artifact.blob.id]);
    expect(fixture.application.store.listQueueItems({ sessionId })[0]?.body).toMatchObject({
      text: "Read @Export now",
      mentions: [{ kind: "artifact", reference: artifact.blob.id, label: "Export", sourceSessionId: sessionId }],
      mentionRanges: [{ start: 5, end: 12, mentionIndex: 0 }]
    });
    const acceptedUserEvent = fixture.application.store.listEvents({ sessionId }).find((event) =>
      event.payload.type === "message_complete" && event.payload.role === "user");
    expect(acceptedUserEvent?.payload).toMatchObject({
      blocks: [{ kind: "text", text: "Read @Export now" }],
      acceptedInput: {
        text: "Read @Export now",
        mentions: [{ kind: "artifact", reference: artifact.blob.id, label: "Export", sourceSessionId: sessionId }],
        mentionRanges: [{ start: 5, end: 12, mentionIndex: 0 }]
      }
    });

    const control = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, pauseQueueMutation(control));
    await submit(paired.clients.operation, paired.connectionId, mutation);
    fixture.application.store.deleteArtifact(artifact.blob.id);
    const paused = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, resumeQueueMutation(paused));
    await waitFor(async () => fixture.application.store.listQueueItems({ sessionId }), (items) => items.some((item) => item.state === "failed"), "deleted Artifact queue failure");
    expect(resolved).toEqual([artifact.blob.id]);

    const root = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await start(root);
    const clients = fixture.clients(paired.authKey);
    expect((await submit(clients.operation, paired.connectionId, mutation, operationId)).state).toBe(OperationState.SUCCEEDED);
    expect(resolved).toEqual([artifact.blob.id]);
    expect(fixture.application.store.listQueueItems({ sessionId })).toHaveLength(2);
    expect(fixture.application.store.listEvents({ sessionId }).find((event) =>
      event.id === acceptedUserEvent?.id)?.payload).toMatchObject({
        acceptedInput: {
          text: "Read @Export now",
          mentions: [{ kind: "artifact", reference: artifact.blob.id, label: "Export", sourceSessionId: sessionId }],
          mentionRanges: [{ start: 5, end: 12, mentionIndex: 0 }]
        }
      });
  } finally { await fixture?.close({ removeRoot: true }); }
});

it("carries a cross-task Artifact through the formal catalog and Queue snapshot, then revokes its restart-stale authority before native send", async () => {
  const profile = { ...PI_LIKE_PROFILE, capabilities: [
    ...PI_LIKE_PROFILE.capabilities.filter((entry) => entry.key !== "input.mention"),
    { key: "input.mention", supported: true, options: ["artifact"] }
  ] };
  let fixture!: OrchestratorE2eFixture;
  const resolved: Array<{ readonly artifactId: string; readonly sourceSessionId: string }> = [];
  class CrossTaskArtifactAdapter extends InstrumentedFakeAdapter {
    override async send(input: PromptInput, context: AdapterContext): Promise<void> {
      const application = fixture.application;
      const resolve = createArtifactMentionResolver({
        store: application.store,
        artifacts: application.artifacts,
        resolveTarget: (session) => application.sessionWorktrees.effectiveTarget(session),
        assertBackendCurrent: (owner) => {
          if (application.store.getBackend(owner.target.backendId).descriptor.instanceGeneration !== owner.backendInstanceGeneration) {
            throw new Error("Retired input.");
          }
        }
      });
      for (const mention of input.mentions) {
        if (mention.kind !== "artifact") throw new Error("Unexpected mention kind.");
        const artifact = await resolve(mention.reference, mention.sourceSessionId, context, context.signal);
        expect(await readFile(artifact.path, "utf8")).toContain("Joko export");
        artifact.assertCurrent();
        resolved.push({ artifactId: mention.reference, sourceSessionId: mention.sourceSessionId });
      }
      await context.emit({
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: `native echo: ${input.text}` }]
      });
      await super.send(input, context);
    }
  }
  const start = (rootDirectory?: string) => OrchestratorE2eFixture.start({
    profiles: [profile],
    createAdapter: (entry) => new CrossTaskArtifactAdapter(entry),
    ...(rootDirectory === undefined ? {} : { rootDirectory })
  });
  const artifactMutation = (
    targetSessionId: string,
    targetGeneration: bigint,
    sourceSessionId: string,
    artifactId: string
  ) => {
    const mutation = sendInputMutation(targetSessionId, targetGeneration, "Read @Export now");
    if (mutation.payload.case !== "sendInput" || mutation.payload.value.input === undefined) {
      throw new Error("Missing cross-task Artifact input.");
    }
    mutation.payload.value.input.parts.push(create(InputPartSchema, { content: { case: "artifactMention", value: {
      sourceSessionId,
      artifactId,
      displayText: "Export"
    } } }));
    mutation.payload.value.input.mentionRanges.push(create(InputMentionRangeSchema, {
      start: 5,
      end: 12,
      mentionIndex: 0
    }));
    return mutation;
  };

  try {
    fixture = await start();
    const paired = await fixture.pair("Cross-task Artifact owner");
    const createSession = async (displayName: string): Promise<string> => sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: profile.id, targetId: fixture.targetId(), displayName })
    ));
    const sourceSessionId = await createSession("Artifact source");
    expect((await submit(paired.clients.operation, paired.connectionId, exportMutation(sourceSessionId))).state)
      .toBe(OperationState.SUCCEEDED);
    const artifact = fixture.application.store.listArtifacts({ sessionId: sourceSessionId })[0]!;
    const targetSessionId = await createSession("Artifact receiver");
    const targetGeneration = BigInt(fixture.application.store.getSession(targetSessionId).descriptor.binding.generation);

    const catalog = await paired.clients.artifact.listArtifacts({
      referenceTargetSessionId: targetSessionId,
      referenceTargetGeneration: targetGeneration,
      page: { pageSize: 100 }
    });
    expect(catalog.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: artifact.blob.id, sessionId: sourceSessionId })
    ]));
    expect(catalog.revision?.value).toBeGreaterThan(0n);

    const mutation = artifactMutation(targetSessionId, targetGeneration, sourceSessionId, artifact.blob.id);
    expect((await submit(paired.clients.operation, paired.connectionId, mutation)).state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      async () => fixture.application.store.listQueueItems({ sessionId: targetSessionId }),
      (items) => items[0]?.state === "completed",
      "cross-task Artifact completion"
    );
    expect(resolved).toEqual([{ artifactId: artifact.blob.id, sourceSessionId }]);
    expect(fixture.application.store.listEvents({ sessionId: targetSessionId }).find((event) =>
      event.payload.type === "message_complete" && event.payload.role === "user")?.payload).toMatchObject({
      acceptedInput: {
        mentions: [{ kind: "artifact", sourceSessionId, reference: artifact.blob.id, label: "Export" }]
      }
    });

    const control = (await paired.clients.queue.getQueueControl({ sessionId: targetSessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, pauseQueueMutation(control));
    const queuedOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      mutation,
      randomUUID()
    );
    const queueItemId = queueItemIdFrom(queuedOperation);
    const privateQueue = fixture.application.store.getQueueItem(queueItemId);
    expect(privateQueue.body.artifactReferenceSnapshots).toEqual([
      expect.objectContaining({ sourceSessionId, targetSessionId, artifactId: artifact.blob.id, mentionIndex: 0 })
    ]);
    expect(JSON.stringify(privateQueue.body.artifactReferenceSnapshots)).not.toContain(artifact.storageKey);
    const publicQueue = (await paired.clients.queue.listQueueItems({ sessionId: targetSessionId })).queueItems
      .find((item) => item.queueItemId === queueItemId)!;
    expect(publicQueue.input?.parts.find((part) => part.content.case === "artifactMention")?.content).toMatchObject({
      case: "artifactMention",
      value: { sourceSessionId, artifactId: artifact.blob.id, displayText: "Export" }
    });
    expect(jsonWithBigints(publicQueue)).not.toContain("AuthorityFingerprint");

    const root = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await start(root);
    const restarted = fixture.clients(paired.authKey);
    expect(fixture.application.store.getQueueItem(queueItemId).body.artifactReferenceSnapshots)
      .toEqual(privateQueue.body.artifactReferenceSnapshots);
    const restartedPublic = (await restarted.queue.listQueueItems({ sessionId: targetSessionId })).queueItems
      .find((item) => item.queueItemId === queueItemId)!;
    expect(jsonWithBigints(restartedPublic)).not.toContain("AuthorityFingerprint");
    const restartedControl = (await restarted.queue.getQueueControl({ sessionId: targetSessionId })).queueControl!;
    await submit(restarted.operation, paired.connectionId, resumeQueueMutation(restartedControl));
    const failed = await waitFor(
      async () => fixture.application.store.listQueueItems({ sessionId: targetSessionId }),
      (items) => items.some((item) => item.id === queueItemId && item.state === "failed"),
      "restart-stale cross-task Artifact rejection"
    );
    expect(failed.find((item) => item.id === queueItemId)).toMatchObject({
      state: "failed",
      error: { code: "INPUT_ARTIFACT_REFERENCE_UNAVAILABLE", stateMayHaveChanged: false }
    });
    expect(fixture.adapter(profile.id).sendCalls).toHaveLength(0);
    expect(resolved).toEqual([{ artifactId: artifact.blob.id, sourceSessionId }]);
  } finally {
    await fixture?.close({ removeRoot: true });
  }
});

function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) => typeof candidate === "bigint" ? candidate.toString(10) : candidate);
}
