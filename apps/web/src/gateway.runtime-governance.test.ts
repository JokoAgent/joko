import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema,
  ManagedProcessPriority,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";

describe("runtime governance gateway", () => {
  it("projects resource, collaboration, and savepoint settings without losing versions or status", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      settings: {
        agentResource: {
          maxConcurrentCommands: 4,
          processPriority: ManagedProcessPriority.LOW,
          capToolchainThreads: true,
          customized: true,
          version: { revision: { value: 7n } }
        },
        collaboration: {
          workerSoftLimit: 3,
          workerHardLimit: 6,
          workerIdleReleaseMinutes: 15,
          version: { revision: { value: 8n } }
        },
        gitSafety: {
          autoSnapshotEnabled: true,
          pendingTurns: 1,
          trackedSessions: 2,
          trackedRepositories: 1,
          cleanupAvailable: false,
          customized: true,
          version: { revision: { value: 9n } }
        }
      }
    }));

    expect(snapshot.settings.agentResource).toEqual({
      maxConcurrentCommands: 4,
      processPriority: "low",
      capToolchainThreads: true,
      customized: true,
      revision: 7n
    });
    expect(snapshot.settings.collaboration).toMatchObject({
      workerSoftLimit: 3,
      workerHardLimit: 6,
      workerIdleReleaseMinutes: 15,
      revision: 8n
    });
    expect(snapshot.settings.gitSafety).toMatchObject({
      autoSnapshotEnabled: true,
      pendingTurns: 1,
      trackedSessions: 2,
      trackedRepositories: 1,
      cleanupAvailable: false,
      revision: 9n
    });
  });

  it("submits every governance mutation with typed patch presence", async () => {
    const payloads: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(payloads)
    );
    await gateway.connect();

    await gateway.updateAgentResourceSettings({
      maxConcurrentCommands: 2,
      processPriority: "lowest",
      capToolchainThreads: true
    });
    await gateway.updateAgentResourceSettings({ resetAll: true });
    await gateway.updateCollaborationSettings({
      workerSoftLimit: 4,
      workerHardLimit: 9,
      workerIdleReleaseMinutes: 20
    });
    await gateway.updateGitSafetySettings({ autoSnapshotEnabled: true });
    await gateway.cleanupGitSafetySavepoints();

    expect(payloads).toEqual([
      expect.objectContaining({
        case: "updateAgentResourceSettings",
        value: expect.objectContaining({ patch: expect.objectContaining({
          maxConcurrentCommands: 2,
          processPriority: ManagedProcessPriority.LOWEST,
          capToolchainThreads: true,
          resetAll: false
        }) })
      }),
      expect.objectContaining({
        case: "updateAgentResourceSettings",
        value: expect.objectContaining({ patch: expect.objectContaining({ resetAll: true }) })
      }),
      expect.objectContaining({
        case: "updateCollaborationSettings",
        value: expect.objectContaining({ patch: expect.objectContaining({
          workerSoftLimit: 4,
          workerHardLimit: 9,
          workerIdleReleaseMinutes: 20,
          resetAll: false
        }) })
      }),
      expect.objectContaining({
        case: "updateGitSafetySettings",
        value: expect.objectContaining({ patch: expect.objectContaining({ autoSnapshotEnabled: true, resetAll: false }) })
      }),
      expect.objectContaining({ case: "cleanupGitSafetySavepoints" })
    ]);
    gateway.disconnect();
  });
});

function operationTransport(payloads: any[]): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n }
          })
        }));
      }
      if (method.localName === "listManagedModelRuntimes") {
        return response(method, create(ListManagedModelRuntimesResponseSchema, {}));
      }
      if (method.localName === "submitOperation") {
        payloads.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "settings", value: {} } }
          }
        }));
      }
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
