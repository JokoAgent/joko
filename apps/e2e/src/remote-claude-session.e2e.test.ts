import { ClaudeCodeAdapter, type ClaudeRemoteRuntimePort } from "@joko/adapter-claude-code";
import { OperationState } from "@joko/contracts";
import { expect, it } from "vitest";

import { ControlledClaudeRuntime } from "./controlled-claude-runtime.js";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  queueRunIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const BACKEND_ID = "remote-claude-product";
const REMOTE_WORKSPACE = "/srv/joko-project";

it("dispatches a remote Claude turn through HTTP only after durable admission and fences stale authority before native input", async () => {
  const localRuntime = new ControlledClaudeRuntime();
  const remoteRuntime = new ControlledClaudeRuntime();
  let authorityCurrent = true;
  let remotePortClosed = false;
  const remoteRuntimes: ClaudeRemoteRuntimePort = {
    resolve: async (target) => {
      expect(target.remoteWorkspace).toEqual({ hostTargetId: target.id, hostId: "host-a", workspaceRoot: REMOTE_WORKSPACE });
      return {
        runtime: remoteRuntime,
        workspaceRoot: REMOTE_WORKSPACE,
        remote: true,
        assertCurrent: () => {
          if (!authorityCurrent) throw new Error("Remote Target/Host/SSH authority changed.");
        }
      };
    },
    close: async () => { remotePortClosed = true; }
  };
  let fixture: OrchestratorE2eFixture | undefined;
  let adapter: ClaudeCodeAdapter | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [],
      backendFactories: [{
        instanceId: BACKEND_ID,
        adapterKind: "claude-agent-sdk-stdio",
        displayName: "Remote Claude product fixture",
        create: ({ generation }) => {
          adapter = new ClaudeCodeAdapter({
            id: BACKEND_ID,
            instanceGeneration: generation,
            runtime: localRuntime,
            remoteRuntimes,
            environment: {},
            initializationTimeoutMs: 500,
            admissionTimeoutMs: 500,
            teardownTimeoutMs: 100
          });
          return adapter;
        }
      }]
    });
    const targetId = fixture.targetId(BACKEND_ID);
    const initialTarget = fixture.application.store.getTarget(targetId).descriptor;
    await fixture.application.sessionHost.registerTarget({
      ...initialTarget,
      workspaceRoot: "D:\\service-owned-placeholder",
      managed: false,
      remoteWorkspace: { hostTargetId: targetId, hostId: "host-a", workspaceRoot: REMOTE_WORKSPACE }
    });
    const paired = await fixture.pair("Remote Claude product client");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: BACKEND_ID, targetId })
    ));
    expect(localRuntime.queries).toHaveLength(0);
    expect(remoteRuntime.queries).toHaveLength(1);
    expect(remoteRuntime.queries[0]!.params.options.cwd).toBe(REMOTE_WORKSPACE);

    const operationId = "dispatch-remote-claude-text";
    let admission: {
      readonly operationStatus: string;
      readonly queueState: string;
      readonly runState: string;
      readonly attemptPersisted: boolean;
    } | undefined;
    remoteRuntime.onInput = () => {
      const item = fixture!.application.store.listQueueItems({ sessionId })
        .find((candidate) => candidate.operationId === operationId)!;
      const run = fixture!.application.store.getRun(item.runId);
      admission = {
        operationStatus: fixture!.application.store.getOperation(operationId).status,
        queueState: item.state,
        runState: run.descriptor.state,
        attemptPersisted: item.attemptId !== undefined
          && fixture!.application.store.getAttempt(item.attemptId).descriptor.endedAt === undefined
      };
    };
    const accepted = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(
        sessionId,
        BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation),
        "Run this turn on the exact remote workspace."
      ),
      operationId
    );
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      async () => remoteRuntime.queries[0]!.receivedInputs.length,
      (count) => count === 1,
      "remote Claude input admission"
    );
    expect(admission).toEqual({
      operationStatus: "completed",
      queueState: "dispatching",
      runState: "queued",
      attemptPersisted: true
    });
    expect(remoteRuntime.queries[0]!.receivedInputs[0]!.message.content)
      .toBe("Run this turn on the exact remote workspace.");
    remoteRuntime.queries[0]!.complete("Remote Claude result");
    const runId = queueRunIdFrom(accepted);
    await waitFor(
      async () => fixture!.application.store.getRun(runId).descriptor.state,
      (state) => state === "completed",
      "remote Claude turn completion"
    );
    expect(fixture.application.store.findQueueItemByRunId(sessionId, runId)?.state).toBe("completed");

    authorityCurrent = false;
    const staleOperationId = "dispatch-stale-remote-claude-text";
    const stale = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(
        sessionId,
        BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation),
        "This must not reach the retired remote authority."
      ),
      staleOperationId
    );
    expect(stale.state).toBe(OperationState.SUCCEEDED);
    const staleRunId = queueRunIdFrom(stale);
    await waitFor(
      async () => fixture!.application.store.getRun(staleRunId).descriptor.state,
      (state) => state === "failed",
      "stale remote Claude dispatch rejection"
    );
    expect(remoteRuntime.queries[0]!.receivedInputs).toHaveLength(1);
    expect(fixture.application.store.getRun(staleRunId).descriptor.error).toMatchObject({
      stateMayHaveChanged: false
    });
  } finally {
    authorityCurrent = true;
    await fixture?.close();
    await adapter?.dispose();
    if (adapter !== undefined) expect(remotePortClosed).toBe(true);
  }
});
