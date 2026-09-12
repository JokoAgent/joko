import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import {
  EditQueueItemMutationSchema,
  EntityKind,
  InputContentSchema,
  InputMentionRangeSchema,
  InputPartSchema,
  OperationMutationSchema,
  OperationState,
  QueueDeliveryMode,
  RunState,
  type QueueItem
} from "@joko/contracts";
import type { AdapterContext, PromptInput } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  pauseQueueMutation,
  queueItemFrom,
  queueRunIdFrom,
  resumeQueueMutation,
  sendInputMutation,
  sessionIdFrom,
  setQueueItemEditLockMutation,
  submit
} from "./operations.js";

it("keeps an edited historical-task reference at its admission fence across the public queue API", async () => {
  const profile = {
    ...PI_LIKE_PROFILE,
    id: "session-reference-queue-edit",
    capabilities: [
      ...PI_LIKE_PROFILE.capabilities.filter((capability) => capability.key !== "input.mention"),
      { key: "input.mention", supported: true, options: ["session"] }
    ]
  };
  class SessionReferenceAdapter extends InstrumentedFakeAdapter {
    readonly observed: Array<{ readonly sessionId: string; readonly input: PromptInput }> = [];

    override async send(input: PromptInput, context: AdapterContext): Promise<void> {
      this.observed.push({ sessionId: context.sessionId, input });
      await context.emit({
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: input.text }]
      });
      await super.send(input, context);
    }
  }

  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [profile],
      createAdapter: (entry) => new SessionReferenceAdapter(entry)
    });
    const paired = await fixture.pair("Historical task reference owner");
    const adapter = fixture.adapter(profile.id) as SessionReferenceAdapter;
    const createSession = async (displayName: string): Promise<string> => sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({
        backendId: profile.id,
        targetId: fixture!.targetId(profile.id),
        displayName
      })
    ));
    const firstSourceId = await createSession("Same task");
    const secondSourceId = await createSession("Same task");
    const destinationId = await createSession("Current task");

    const sendAndSettle = async (sessionId: string, text: string): Promise<void> => {
      const generation = BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);
      const operation = await submit(
        paired.clients.operation,
        paired.connectionId,
        sendInputMutation(sessionId, generation, text)
      );
      const runId = queueRunIdFrom(operation);
      await waitFor(
        () => paired.clients.run.getRun({ runId }),
        (value) => value.run?.state === RunState.SUCCEEDED,
        `task input ${text} to settle`
      );
    };
    await sendAndSettle(firstSourceId, "FIRST admission history");
    await sendAndSettle(secondSourceId, "SECOND admission history");

    const activeControl = (await paired.clients.queue.getQueueControl({ sessionId: destinationId })).queueControl;
    if (activeControl === undefined) throw new Error("Destination task has no Queue control.");
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(activeControl, "edit a historical task reference")
    )).state).toBe(OperationState.SUCCEEDED);

    const targetGeneration = BigInt(
      fixture.application.store.getSession(destinationId).descriptor.binding.generation
    );
    const queuedOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      sessionReferenceInputMutation(destinationId, targetGeneration, [firstSourceId, secondSourceId])
    );
    expect(queuedOperation.state).toBe(OperationState.SUCCEEDED);
    const queued = queueItemFrom(queuedOperation);
    expect(publicQueueBody(queued)).not.toContain("sessionReferenceSnapshots");
    expect(publicQueueBody(queued)).not.toContain("historyBindingFingerprint");
    expect(queued.input?.parts.flatMap((part) =>
      part.content.case === "sessionMention" ? [part.content.value.sessionId] : []
    )).toEqual([firstSourceId, secondSourceId]);

    const acceptedBody = fixture.application.store.getQueueItem(queued.queueItemId).body;
    const retainedFence = acceptedBody.sessionReferenceSnapshots?.find((snapshot) =>
      snapshot.mentionIndex === 1
    );
    expect(acceptedBody.sessionReferenceSnapshots).toHaveLength(2);
    expect(retainedFence).toBeDefined();

    const lockToken = randomUUID();
    const lockedOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueItemEditLockMutation(queued, lockToken, true)
    );
    const locked = queueItemFrom(lockedOperation);
    const editedOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      removeFirstSessionReferenceMutation(locked, secondSourceId, lockToken)
    );
    expect(editedOperation.state).toBe(OperationState.SUCCEEDED);
    const edited = queueItemFrom(editedOperation);
    expect(publicQueueBody(edited)).not.toContain("sessionReferenceSnapshots");
    expect(edited.input?.parts.flatMap((part) =>
      part.content.case === "sessionMention" ? [part.content.value.sessionId] : []
    )).toEqual([secondSourceId]);
    expect(fixture.application.store.getQueueItem(queued.queueItemId).body.sessionReferenceSnapshots)
      .toEqual([{ ...retainedFence!, mentionIndex: 0 }]);

    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueItemEditLockMutation(edited, lockToken, false)
    )).state).toBe(OperationState.SUCCEEDED);

    await sendAndSettle(secondSourceId, "SECOND late expansion must stay out");
    const pausedControl = (await paired.clients.queue.getQueueControl({ sessionId: destinationId })).queueControl;
    if (pausedControl === undefined) throw new Error("Paused destination task has no Queue control.");
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      resumeQueueMutation(pausedControl)
    )).state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      async () => fixture!.application.store.getQueueItem(queued.queueItemId),
      (item) => item.state === "completed",
      "edited historical task reference to dispatch"
    );

    const dispatched = adapter.observed.find((entry) => entry.sessionId === destinationId)?.input;
    expect(dispatched).toBeDefined();
    expect(dispatched?.sessionReferenceSnapshots).toBeUndefined();
    expect(dispatched?.mentions).toEqual([]);
    expect(dispatched?.mentionRanges).toEqual([]);
    expect(dispatched?.text).toContain("@Same");
    expect(dispatched?.text).toContain("[JOKO_TASK_REFERENCE_DATA_V1]");
    expect(dispatched?.text).toContain("SECOND admission history");
    expect(dispatched?.text).not.toContain("FIRST admission history");
    expect(dispatched?.text).not.toContain("SECOND late expansion must stay out");
  } finally {
    await fixture?.close({ removeRoot: true });
  }
});

function sessionReferenceInputMutation(
  sessionId: string,
  generation: bigint,
  sourceSessionIds: readonly [string, string]
) {
  const mutation = sendInputMutation(sessionId, generation, "@Same @Same");
  if (mutation.payload.case !== "sendInput" || mutation.payload.value.input === undefined) {
    throw new Error("Missing Session reference input mutation.");
  }
  for (const sourceSessionId of sourceSessionIds) {
    mutation.payload.value.input.parts.push(create(InputPartSchema, {
      content: {
        case: "sessionMention",
        value: { sessionId: sourceSessionId, displayText: "Same" }
      }
    }));
  }
  mutation.payload.value.input.mentionRanges.push(
    create(InputMentionRangeSchema, { start: 0, end: 5, mentionIndex: 0 }),
    create(InputMentionRangeSchema, { start: 6, end: 11, mentionIndex: 1 })
  );
  return mutation;
}

function removeFirstSessionReferenceMutation(
  item: QueueItem,
  retainedSessionId: string,
  lockToken: string
) {
  if (item.version?.revision === undefined) throw new Error("Queue item has no entity version.");
  return create(OperationMutationSchema, {
    preconditions: [{
      entity: { kind: EntityKind.QUEUE_ITEM, id: item.queueItemId },
      expectedRevision: { value: item.version.revision.value },
      expectedGeneration: item.version.generation
    }],
    payload: {
      case: "editQueueItem",
      value: create(EditQueueItemMutationSchema, {
        queueItemId: item.queueItemId,
        input: create(InputContentSchema, {
          parts: [
            create(InputPartSchema, { content: { case: "text", value: "@Same" } }),
            create(InputPartSchema, {
              content: {
                case: "sessionMention",
                value: { sessionId: retainedSessionId, displayText: "Same" }
              }
            })
          ],
          mentionRanges: [create(InputMentionRangeSchema, {
            start: 0,
            end: 5,
            mentionIndex: 0
          })]
        }),
        deliveryMode: QueueDeliveryMode.PROMPT,
        lockToken,
        textSplices: [{ start: 0, end: 6, replacementText: "" }]
      })
    }
  });
}

function publicQueueBody(item: QueueItem): string {
  return JSON.stringify(item, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString(10) : value);
}
