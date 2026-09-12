import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { create } from "@bufbuild/protobuf";
import { InputMentionRangeSchema, InputPartSchema, OperationState } from "@joko/contracts";
import type { AdapterContext, PromptInput } from "@joko/core";
import { createArtifactMentionResolver } from "@joko/orchestrator";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, exportMutation, pauseQueueMutation, resumeQueueMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

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
        const artifact = await resolve(mention.reference, context, context.signal);
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
      artifactId: artifact.blob.id, displayText: "Export"
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
      mentions: [{ kind: "artifact", reference: artifact.blob.id, label: "Export" }],
      mentionRanges: [{ start: 5, end: 12, mentionIndex: 0 }]
    });
    const acceptedUserEvent = fixture.application.store.listEvents({ sessionId }).find((event) =>
      event.payload.type === "message_complete" && event.payload.role === "user");
    expect(acceptedUserEvent?.payload).toMatchObject({
      blocks: [{ kind: "text", text: "native echo: Read @Export now" }],
      acceptedInput: {
        text: "Read @Export now",
        mentions: [{ kind: "artifact", reference: artifact.blob.id, label: "Export" }],
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
          mentions: [{ kind: "artifact", reference: artifact.blob.id, label: "Export" }],
          mentionRanges: [{ start: 5, end: 12, mentionIndex: 0 }]
        }
      });
  } finally { await fixture?.close({ removeRoot: true }); }
});
