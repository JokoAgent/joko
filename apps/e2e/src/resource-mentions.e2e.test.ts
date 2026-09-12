import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import {
  InputMentionRangeSchema,
  InputPartSchema,
  OperationState,
  ResourceKind
} from "@joko/contracts";
import type { AdapterContext, PromptInput, RuntimeResource } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { expect, it } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  pauseQueueMutation,
  resumeQueueMutation,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

it("uses the authenticated live task resource catalog through durable queue dispatch", async () => {
  const profile = {
    ...PI_LIKE_PROFILE,
    capabilities: [
      ...PI_LIKE_PROFILE.capabilities.filter((entry) => entry.key !== "input.mention"),
      { key: "input.mention", supported: true, options: ["resource"] }
    ]
  };
  let revision = "sha256:resource-one";
  let resourceVersion = 5n;
  class ResourceAdapter extends InstrumentedFakeAdapter {
    override async getResources(context: AdapterContext): Promise<readonly RuntimeResource[]> {
      return [{
        id: "prompt-release",
        kind: "prompt",
        name: "Release prompt",
        source: "managed",
        state: "loaded",
        revision,
        resourceVersion,
        runtimePath: join(context.target.workspaceRoot, ".runtime", "release.md"),
        runtimeGeneration: context.generation
      }];
    }
  }

  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [profile],
      createAdapter: (entry) => new ResourceAdapter(entry)
    });
    const paired = await fixture.pair("Resource mention owner");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: profile.id, targetId: fixture.targetId(profile.id) })
    ));
    const catalog = await paired.clients.session.listSessionResources({ sessionId });
    expect(catalog.resources).toEqual([expect.objectContaining({
      sessionId,
      resourceId: "prompt-release",
      kind: ResourceKind.PROMPT_TEMPLATE,
      discoveredRevision: revision,
      resourceVersion,
      runtimeGeneration: expect.any(BigInt)
    })]);
    const generation = catalog.resources[0]!.runtimeGeneration;
    const mutation = resourceInputMutation(sessionId, generation, revision, resourceVersion);
    const accepted = await submit(paired.clients.operation, paired.connectionId, mutation);
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      async () => fixture!.application.store.listQueueItems({ sessionId }),
      (items) => items[0]?.state === "completed",
      "resource mention completion"
    );
    const adapter = fixture.adapter(profile.id);
    expect(adapter.sendCalls[0]).toMatchObject({
      text: "Apply @Release",
      mentions: [{
        kind: "resource",
        reference: "prompt-release",
        discoveredRevision: revision,
        resourceVersion: resourceVersion.toString(10),
        runtimeGeneration: Number(generation)
      }],
      mentionRanges: [{ start: 6, end: 14, mentionIndex: 0 }]
    });
    expect(fixture.application.store.listQueueItems({ sessionId })[0]?.body).toMatchObject({
      mentions: [{
        kind: "resource",
        reference: "prompt-release",
        discoveredRevision: revision,
        resourceVersion: resourceVersion.toString(10),
        runtimeGeneration: Number(generation)
      }]
    });

    const control = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, pauseQueueMutation(control));
    const queued = await submit(
      paired.clients.operation,
      paired.connectionId,
      resourceInputMutation(sessionId, generation, revision, resourceVersion),
      randomUUID()
    );
    expect(queued.state).toBe(OperationState.SUCCEEDED);
    revision = "sha256:resource-two";
    resourceVersion = 6n;
    const paused = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl!;
    await submit(paired.clients.operation, paired.connectionId, resumeQueueMutation(paused));
    const failedItems = await waitFor(
      async () => fixture!.application.store.listQueueItems({ sessionId }),
      (items) => items.some((item) => item.state === "failed"),
      "replaced resource queue failure"
    );
    expect(failedItems.find((item) => item.state === "failed")).toMatchObject({
      state: "failed",
      error: {
        code: "INPUT_RESOURCE_CATALOG_STALE",
        stateMayHaveChanged: false
      }
    });
    expect(adapter.sendCalls).toHaveLength(1);
  } finally {
    await fixture?.close({ removeRoot: true });
  }
});

function resourceInputMutation(
  sessionId: string,
  generation: bigint,
  discoveredRevision: string,
  resourceVersion: bigint
) {
  const mutation = sendInputMutation(sessionId, generation, "Apply @Release");
  if (mutation.payload.case !== "sendInput" || mutation.payload.value.input === undefined) {
    throw new Error("Missing resource input mutation.");
  }
  mutation.payload.value.input.parts.push(create(InputPartSchema, {
    content: {
      case: "resourceMention",
      value: {
        resourceId: "prompt-release",
        displayText: "Release",
        discoveredRevision,
        resourceVersion,
        runtimeGeneration: generation
      }
    }
  }));
  mutation.payload.value.input.mentionRanges.push(create(InputMentionRangeSchema, {
    start: 6,
    end: 14,
    mentionIndex: 0
  }));
  return mutation;
}
