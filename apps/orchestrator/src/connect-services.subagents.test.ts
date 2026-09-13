import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { AdapterContext, SubagentControlInput, SubagentRunDetail, SubagentTranscriptEntry } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { createConnectServices } from "./connect-services.js";
import { SessionHost } from "./session-host.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("delegated-run public service", () => {
  it("serves capability-gated list, detail, and transcript pages from durable projections", async () => {
    const fixture = await createFixture();
    const active = delegatedRun("delegated-active", "running", 100);
    const completed = {
      ...delegatedRun("delegated-completed", "completed", 90),
      updatedAt: 95,
      endedAt: 95
    } satisfies SubagentRunDetail;
    appendRun(fixture.store, active);
    appendRun(fixture.store, completed);
    appendTranscript(fixture.store, active.id, {
      id: "entry-1",
      sequence: 1,
      role: "tool",
      content: "started",
      occurredAt: 101,
      childId: "child-delegated-active",
      toolName: "read",
      toolCallId: "call-1",
      toolPhase: "start",
      toolInputJson: "{\"path\":\"safe.txt\"}",
      isError: false
    });
    const services = createConnectServices(fixture.application);

    const listed = await invoke<contract.ListSubagentRunsResponse>(
      services.subagent.listSubagentRuns,
      create(contract.ListSubagentRunsRequestSchema, {
        sessionId: fixture.sessionId,
        page: create(contract.PageRequestSchema, { pageSize: 1 })
      })
    );
    expect(listed.runs.map((run) => run.subagentRunId)).toEqual([active.id]);
    expect(listed.page).toMatchObject({ totalSize: 2n });
    expect(listed.page?.nextPageToken).not.toBe("");

    const detail = await invoke<contract.GetSubagentRunResponse>(
      services.subagent.getSubagentRun,
      create(contract.GetSubagentRunRequestSchema, {
        sessionId: fixture.sessionId,
        subagentRunId: "provider-delegated-active"
      })
    );
    expect(detail.run).toMatchObject({
      run: {
        subagentRunId: active.id,
        logicalAgentId: "logical-delegated-active",
        state: contract.SubagentRunState.RUNNING,
        route: { providerId: "provider", modelId: "model", thinkingLevel: "high" },
        usage: { inputTokens: 10n, outputTokens: 5n, toolUses: 1n, costUsd: 0.01 },
        capabilities: { viewFullTranscript: true, steer: true }
      },
      returnedResult: "returned result",
      children: [expect.objectContaining({ childId: "child-delegated-active", role: "worker" })]
    });

    const transcript = await invoke<contract.ListSubagentTranscriptResponse>(
      services.subagent.listSubagentTranscript,
      create(contract.ListSubagentTranscriptRequestSchema, {
        sessionId: fixture.sessionId,
        subagentRunId: active.id,
        childId: "native-child-delegated-active"
      })
    );
    expect(transcript.entries).toEqual([expect.objectContaining({
      entryId: "entry-1",
      role: contract.SubagentTranscriptRole.TOOL,
      toolPhase: contract.SubagentToolPhase.START
    })]);
    expect(transcript.tailPageToken).not.toBe("");

    const backend = fixture.store.getBackend(fixture.adapter.id).descriptor;
    const capabilities = new Map(backend.capabilities);
    capabilities.set(contract.capabilityNames.subagentsTranscript, {
      key: contract.capabilityNames.subagentsTranscript,
      supported: false,
      reason: "upstream_missing",
      detail: "Transcript is unavailable."
    });
    fixture.store.upsertBackend({ ...backend, capabilities });
    await expect(invoke(
      services.subagent.listSubagentTranscript,
      create(contract.ListSubagentTranscriptRequestSchema, {
        sessionId: fixture.sessionId,
        subagentRunId: active.id
      })
    )).rejects.toMatchObject({ code: Code.Unimplemented });
  });

  it("persists the Operation before adapter dispatch and fails closed on run-local control capability", async () => {
    const fixture = await createFixture();
    const run = delegatedRun("delegated-control", "running", 100);
    appendRun(fixture.store, run);
    const services = createConnectServices(fixture.application);
    fixture.adapter.expectedOperationId = "operation-steer";

    const response = await invoke<contract.SubmitOperationResponse>(
      services.operation.submitOperation,
      create(contract.SubmitOperationRequestSchema, {
        operationId: fixture.adapter.expectedOperationId,
        connectionId: fixture.connection.id,
        mutation: create(contract.OperationMutationSchema, {
          payload: {
            case: "controlSubagent",
            value: create(contract.ControlSubagentMutationSchema, {
              sessionId: fixture.sessionId,
              subagentRunId: "provider-delegated-control",
              childId: "native-child-delegated-control",
              action: contract.SubagentControlAction.STEER,
              message: "Focus on durable ownership."
            })
          }
        })
      })
    );
    expect(response.operation?.state).toBe(contract.OperationState.SUCCEEDED);
    expect(fixture.adapter.observedOperationStatus).toBe("started");
    expect(fixture.adapter.controls).toEqual([{
      runId: run.id,
      childId: "child-delegated-control",
      action: "steer",
      message: "Focus on durable ownership."
    }]);
    expect(fixture.store.getOperation("operation-steer").status).toBe("completed");
    expect(fixture.store.listSubagentTranscript({
      sessionId: fixture.sessionId,
      subagentRunId: run.id
    }).entries.at(-1)).toMatchObject({ controlAction: "steer", role: "parent" });
    expect(fixture.store.listEvents({ sessionId: fixture.sessionId, limit: 10_000 })
      .filter((event) => event.payload.type === "subagent_transcript")
      .at(-1)?.operationId).toBe("operation-steer");

    const submitControl = async (
      operationId: string,
      subagentRunId: string,
      action: contract.SubagentControlAction,
      message?: string
    ): Promise<contract.SubmitOperationResponse> => {
      fixture.adapter.expectedOperationId = operationId;
      return invoke(
        services.operation.submitOperation,
        create(contract.SubmitOperationRequestSchema, {
          operationId,
          connectionId: fixture.connection.id,
          mutation: create(contract.OperationMutationSchema, {
            payload: {
              case: "controlSubagent",
              value: create(contract.ControlSubagentMutationSchema, {
                sessionId: fixture.sessionId,
                subagentRunId,
                action,
                ...(message === undefined ? {} : { message })
              })
            }
          })
        })
      );
    };
    expect((await submitControl(
      "operation-follow-up",
      run.id,
      contract.SubagentControlAction.FOLLOW_UP,
      "Continue with the next check."
    )).operation?.state).toBe(contract.OperationState.SUCCEEDED);
    expect((await submitControl(
      "operation-stop",
      run.id,
      contract.SubagentControlAction.STOP
    )).operation?.state).toBe(contract.OperationState.SUCCEEDED);
    const terminalRun = delegatedRun("delegated-terminal-control", "completed", 120);
    appendRun(fixture.store, terminalRun);
    expect((await submitControl(
      "operation-resume",
      terminalRun.id,
      contract.SubagentControlAction.RESUME,
      "Resume with the corrected constraint."
    )).operation?.state).toBe(contract.OperationState.SUCCEEDED);
    expect(fixture.adapter.controls.map((control) => control.action)).toEqual([
      "steer",
      "follow_up",
      "stop",
      "resume"
    ]);

    appendRun(fixture.store, {
      ...run,
      updatedAt: 110,
      capabilities: { ...run.capabilities, steer: false }
    });
    const denied = await invoke<contract.SubmitOperationResponse>(
      services.operation.submitOperation,
      create(contract.SubmitOperationRequestSchema, {
        operationId: "operation-steer-denied",
        connectionId: fixture.connection.id,
        mutation: create(contract.OperationMutationSchema, {
          payload: {
            case: "controlSubagent",
            value: create(contract.ControlSubagentMutationSchema, {
              sessionId: fixture.sessionId,
              subagentRunId: run.id,
              action: contract.SubagentControlAction.STEER,
              message: "This must not dispatch."
            })
          }
        })
      })
    );
    expect(denied.operation).toMatchObject({
      state: contract.OperationState.FAILED,
      error: { code: "SUBAGENT_ACTION_UNAVAILABLE" }
    });
    expect(fixture.adapter.controls).toHaveLength(4);
    expect(fixture.store.getOperation("operation-steer-denied").status).toBe("failed");

    Object.defineProperty(fixture.adapter, "controlSubagent", { value: undefined });
    const unsupported = await invoke<contract.SubmitOperationResponse>(
      services.operation.submitOperation,
      create(contract.SubmitOperationRequestSchema, {
        operationId: "operation-stop-unsupported",
        connectionId: fixture.connection.id,
        mutation: create(contract.OperationMutationSchema, {
          payload: {
            case: "controlSubagent",
            value: create(contract.ControlSubagentMutationSchema, {
              sessionId: fixture.sessionId,
              subagentRunId: run.id,
              action: contract.SubagentControlAction.STOP
            })
          }
        })
      })
    );
    expect(unsupported.operation).toMatchObject({
      state: contract.OperationState.FAILED,
      error: { code: "SUBAGENT_CONTROL_UNSUPPORTED" }
    });
    expect(fixture.store.getOperation("operation-stop-unsupported").status).toBe("failed");
  });
});

class DelegatedControlAdapter extends FakeBackendAdapter {
  readonly controls: SubagentControlInput[] = [];
  expectedOperationId = "";
  observedOperationStatus: string | undefined;
  store: OperationalStore | undefined;
  #nextTranscriptSequence = 2;

  constructor() {
    super({ ...PI_LIKE_PROFILE, id: "delegated-backend", displayName: "Delegated backend" });
  }

  override async describe() {
    const descriptor = await super.describe();
    const capabilities = new Map(descriptor.capabilities);
    for (const key of [
      contract.capabilityNames.subagentsList,
      contract.capabilityNames.subagentsDetail,
      contract.capabilityNames.subagentsTranscript,
      contract.capabilityNames.subagentsStop,
      contract.capabilityNames.subagentsSteer,
      contract.capabilityNames.subagentsFollowUp,
      contract.capabilityNames.subagentsResume
    ]) capabilities.set(key, { key, supported: true });
    return { ...descriptor, capabilities };
  }

  async controlSubagent(input: SubagentControlInput, context: AdapterContext): Promise<void> {
    this.observedOperationStatus = this.store?.findOperation(this.expectedOperationId)?.status;
    this.controls.push(input);
    await context.emit({
      type: "subagent_transcript",
      subagentRunId: input.runId,
      entry: {
        id: `control-entry-${this.#nextTranscriptSequence}`,
        sequence: this.#nextTranscriptSequence++,
        role: "parent",
        content: input.message ?? "",
        occurredAt: Date.now(),
        isError: false,
        controlAction: input.action
      }
    });
  }
}

async function createFixture(): Promise<{
  readonly store: OperationalStore;
  readonly adapter: DelegatedControlAdapter;
  readonly application: OrchestratorApplication;
  readonly sessionId: string;
  readonly connection: ReturnType<OperationalStore["createConnection"]>;
}> {
  const directory = mkdtempSync(join(tmpdir(), "joko-delegated-service-"));
  const store = new OperationalStore(join(directory, "operational.sqlite"));
  const repository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    repository,
    ingestRoots: [directory]
  });
  await artifacts.initialize();
  const adapter = new DelegatedControlAdapter();
  adapter.store = store;
  const host = new SessionHost(store, artifacts, [adapter]);
  await host.initialize();
  await host.registerTarget({
    id: "target-delegated",
    backendId: adapter.id,
    displayName: "Workspace",
    workspaceRoot: directory,
    managed: true,
    trusted: true
  });
  const connection = store.createConnection({
    id: "connection-delegated",
    name: "Test device",
    authKeyDigest: "digest-delegated"
  });
  const sessionId = (await host.createSession({
    operationId: "operation-create-delegated-session",
    connection,
    targetId: "target-delegated",
    title: "Delegated task",
    fastMode: false,
    permissionMode: "ask",
    planMode: false
  })).value.sessionId;
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: {
      authenticate: () => connection,
      fence: () => connection,
      onRevoked: () => () => undefined
    },
    artifacts,
    blobTransfers: {},
    artifactRepository: repository,
    workspaces: {},
    workspaceChanges: {},
    sessionHost: host,
    scheduler: {},
    adapters: [adapter],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  cleanups.push(async () => {
    await host.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, adapter, application, sessionId, connection };
}

function delegatedRun(id: string, state: SubagentRunDetail["state"], startedAt: number): SubagentRunDetail {
  const terminal = state === "completed" || state === "failed" || state === "stopped";
  return {
    id,
    sessionId: "",
    parentTaskId: "parent-task",
    logicalAgentId: `logical-${id}`,
    identityAliases: [`alias-${id}`],
    providerRunIds: [`provider-${id}`],
    state,
    title: "Worker",
    assignment: "Inspect the assigned surface",
    summary: "Working",
    route: { providerId: "provider", modelId: "model", thinkingLevel: "high" },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, toolUses: 1, durationMs: 250, costUsd: 0.01 },
    capabilities: {
      viewActivity: true,
      viewReturnedResult: true,
      viewFullTranscript: true,
      stop: !terminal,
      steer: !terminal,
      followUp: !terminal,
      resume: terminal,
      parentContext: "snapshot"
    },
    startedAt,
    updatedAt: terminal ? startedAt + 5 : startedAt,
    ...(terminal ? { endedAt: startedAt + 5 } : {}),
    activity: [{ sequence: 1, kind: "started", state: "running", occurredAt: startedAt }],
    children: [{
      id: `child-${id}`,
      identityAliases: [`native-child-${id}`],
      role: "worker",
      state,
      awaitingApproval: false,
      resultTruncated: false,
      startedAt
    }],
    returnedResult: "returned result",
    returnedResultTruncated: false
  };
}

function appendRun(store: OperationalStore, value: SubagentRunDetail): void {
  const session = store.listSessions({ includeArchived: true, includeDeleted: true })
    .find((candidate) => candidate.descriptor.backendId === "delegated-backend")?.descriptor;
  if (session === undefined) throw new Error("Delegated Session is missing.");
  const run = { ...value, sessionId: session.id };
  store.appendEvent({
    backendId: session.backendId,
    targetId: session.targetId,
    sessionId: session.id,
    generation: session.binding.generation,
    traceId: `delegated:${run.id}:${run.updatedAt}`,
    payload: { type: "subagent_run", run }
  });
}

function appendTranscript(
  store: OperationalStore,
  subagentRunId: string,
  entry: SubagentTranscriptEntry
): void {
  const projection = store.listSubagentRuns({
    sessionId: store.listSessions({ includeArchived: true, includeDeleted: true })
      .find((candidate) => candidate.descriptor.backendId === "delegated-backend")!.descriptor.id
  }).runs.find((run) => run.id === subagentRunId);
  if (projection === undefined) throw new Error("Delegated run is missing.");
  const session = store.getSession(projection.sessionId).descriptor;
  store.appendEvent({
    backendId: session.backendId,
    targetId: session.targetId,
    sessionId: session.id,
    generation: session.binding.generation,
    traceId: `delegated:${subagentRunId}:transcript:${entry.sequence}`,
    payload: { type: "subagent_transcript", subagentRunId, entry }
  });
}

async function invoke<T>(handler: unknown, request: unknown): Promise<T> {
  if (typeof handler !== "function") throw new Error("RPC handler is missing.");
  return await (handler as (request: unknown, context: unknown) => Promise<T> | T)(request, {
    requestHeader: new Headers({ authorization: "Bearer delegated-test" }),
    signal: new AbortController().signal
  });
}
