import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  GetSubagentRunResponseSchema,
  ListSubagentRunsResponseSchema,
  ListSubagentTranscriptResponseSchema,
  OperationState,
  SnapshotSchema,
  SubagentActivityKind,
  SubagentControlAction,
  SubagentParentContext,
  SubagentRunDetailSchema,
  SubagentRunSchema,
  SubagentRunState,
  SubagentToolPhase,
  SubagentTranscriptEntrySchema,
  SubagentTranscriptRole,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

describe("delegated-run gateway", () => {
  it("maps list, detail, transcript pagination, and capability-driven controls", async () => {
    const mutations: any[] = [];
    const run = create(SubagentRunSchema, {
      subagentRunId: "delegated-one",
      sessionId: "session-one",
      parentRunId: "parent-run",
      logicalAgentId: "researcher",
      identityAliases: ["alias-one"],
      providerRunIds: ["provider-one"],
      state: SubagentRunState.RUNNING,
      title: "Research",
      description: "Inspect the evidence",
      assignment: "Find the regression",
      summary: "Reading tests",
      route: { providerId: "provider-a", modelId: "model-a", thinkingLevel: "high" },
      readOnly: false,
      usage: { inputTokens: 12n, outputTokens: 34n, totalTokens: 46n, toolUses: 2n, duration: { seconds: 3n, nanos: 500_000_000 }, costUsd: 0.004 },
      capabilities: {
        viewActivity: true,
        viewReturnedResult: true,
        viewFullTranscript: true,
        stop: true,
        steer: true,
        followUp: true,
        resume: false,
        parentContext: SubagentParentContext.LIVE
      },
      startedAt: { seconds: 100n, nanos: 0 },
      updatedAt: { seconds: 105n, nanos: 0 },
      version: { revision: { value: 7n } }
    });
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "listSubagentRuns") {
          expect(input).toMatchObject({ sessionId: "session-one", state: SubagentRunState.RUNNING, page: { pageSize: 25, pageToken: "page-a" } });
          return response(method, create(ListSubagentRunsResponseSchema, {
            runs: [run], page: { nextPageToken: "page-b", totalSize: 3n }
          }));
        }
        if (method.localName === "getSubagentRun") {
          return response(method, create(GetSubagentRunResponseSchema, {
            run: create(SubagentRunDetailSchema, {
              run,
              activity: [{
                sequence: 1n,
                kind: SubagentActivityKind.PROGRESS,
                state: SubagentRunState.RUNNING,
                summary: "Reading",
                lastToolName: "read",
                occurredAt: { seconds: 104n, nanos: 0 }
              }],
              children: [{
                childId: "child-one",
                role: "worker",
                title: "Child",
                assignment: "Inspect file",
                state: SubagentRunState.COMPLETED,
                readOnly: true,
                result: "Found it",
                resultTruncated: false,
                startedAt: { seconds: 101n, nanos: 0 },
                endedAt: { seconds: 103n, nanos: 0 }
              }],
              returnedResult: "Evidence",
              returnedResultTruncated: false,
              childrenObserved: true
            })
          }));
        }
        if (method.localName === "listSubagentTranscript") {
          expect(input).toMatchObject({ sessionId: "session-one", subagentRunId: "delegated-one", childId: "child-one", page: { pageSize: 40, pageToken: "transcript-a" } });
          return response(method, create(ListSubagentTranscriptResponseSchema, {
            entries: [create(SubagentTranscriptEntrySchema, {
              entryId: "entry-one",
              sequence: 9n,
              role: SubagentTranscriptRole.TOOL,
              content: "done",
              occurredAt: { seconds: 106n, nanos: 0 },
              childId: "child-one",
              childTitle: "Child",
              toolName: "read",
              toolCallId: "call-one",
              toolPhase: SubagentToolPhase.END,
              toolInputJson: "{\"path\":\"safe.txt\"}",
              isError: false,
              controlAction: SubagentControlAction.STEER,
              systemEvent: { kind: "checkpoint", params: [{ key: "phase", value: "read" }] }
            })],
            page: { nextPageToken: "transcript-b", totalSize: 12n },
            tailPageToken: "tail-current"
          }));
        }
        if (method.localName === "submitOperation") {
          mutations.push(input.mutation?.payload);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED }
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection-subagents", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    const page = await gateway.listSubagentRuns("session-one", "running", "page-a", 25);
    expect(page).toMatchObject({
      nextPageToken: "page-b",
      totalSize: 3,
      runs: [{
        id: "delegated-one",
        state: "running",
        title: "Research",
        route: { providerId: "provider-a", modelId: "model-a", thinkingLevel: "high" },
        readOnly: false,
        usage: { totalTokens: 46, durationMs: 3_500, costUsd: 0.004 },
        capabilities: { viewFullTranscript: true, steer: true, parentContext: "live" },
        revision: 7n
      }]
    });
    await expect(gateway.getSubagentRun("session-one", "delegated-one")).resolves.toMatchObject({
      run: { id: "delegated-one" },
      activity: [{ kind: "progress", lastToolName: "read" }],
      children: [{ id: "child-one", state: "completed", readOnly: true, result: "Found it" }],
      returnedResult: "Evidence",
      childrenObserved: true
    });
    await expect(gateway.listSubagentTranscript("session-one", "delegated-one", "child-one", "transcript-a", 40)).resolves.toEqual({
      entries: [{
        id: "entry-one",
        sequence: 9,
        role: "tool",
        content: "done",
        occurredAt: 106_000,
        childId: "child-one",
        childTitle: "Child",
        toolName: "read",
        toolCallId: "call-one",
        toolPhase: "end",
        toolInputJson: "{\"path\":\"safe.txt\"}",
        isError: false,
        controlAction: "steer",
        systemEvent: { kind: "checkpoint", params: [{ key: "phase", value: "read" }] }
      }],
      nextPageToken: "transcript-b",
      tailPageToken: "tail-current",
      totalSize: 12
    });

    await gateway.controlSubagent("session-one", "delegated-one", "steer", "Inspect the failing assertion", "child-one");
    await gateway.controlSubagent("session-one", "delegated-one", "stop");
    expect(mutations).toEqual([
      { case: "controlSubagent", value: expect.objectContaining({ action: SubagentControlAction.STEER, message: "Inspect the failing assertion", childId: "child-one" }) },
      { case: "controlSubagent", value: expect.objectContaining({ action: SubagentControlAction.STOP, message: "", childId: "" }) }
    ]);
    await expect(gateway.controlSubagent("session-one", "delegated-one", "followUp", "  ")).rejects.toThrow(/1\.\.32000/);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
