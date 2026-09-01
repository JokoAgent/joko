import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  GetSnapshotResponseSchema,
  ListManagedModelRuntimesResponseSchema,
  OperationState,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";
import type { NewSessionDraft } from "./model.js";

const DRAFT: NewSessionDraft = {
  targetId: "target-1",
  name: "New task",
  nativeStart: { kind: "fresh" },
  providerId: "",
  modelId: "",
  fastMode: false,
  permissionMode: "ask",
  planMode: false
};

describe("operation ID lifecycle", () => {
  it("maps language tools off by default and preserves an explicit owner opt-in", () => {
    expect(mapSnapshot(create(SnapshotSchema, {})).settings.languageTools).toEqual({ enabled: false });
    expect(mapSnapshot(create(SnapshotSchema, {
      settings: { agentResource: {}, collaboration: {}, gitSafety: {}, languageTools: { enabled: true } }
    })).settings.languageTools).toEqual({ enabled: true });
  });

  it("maps navigation placement independently from immutable runtime identity", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      sessions: [{
        sessionId: "session-1",
        backendId: "backend-1",
        targetId: "runtime-target",
        projectId: "navigation-project",
        displayName: "Movable task",
        remoteWorkspace: { hostId: "host-1", workspaceRootDisplay: "/srv/work" }
      }]
    }));
    expect(snapshot.sessions[0]).toMatchObject({
      id: "session-1",
      targetId: "runtime-target",
      projectId: "navigation-project",
      remoteWorkspace: true
    });
  });

  it("sends the personalization snapshot only for a fresh native task", async () => {
    const createMutations: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(async (method, input) => {
        createMutations.push(input.mutation.payload.value);
        return successfulSessionResponse(method, input, `session-${createMutations.length}`);
      })
    );
    await gateway.connect();

    await gateway.createSession({ ...DRAFT, appendSystemPrompt: "Prefer concise replies." });
    await gateway.createSession({
      ...DRAFT,
      nativeStart: { kind: "attach", reference: "native-existing" },
      appendSystemPrompt: "Must be ignored when attaching."
    });
    await gateway.createSession({
      ...DRAFT,
      nativeStart: { kind: "attach", reference: "native-import" },
      catalogImport: { projectId: "project-target", archived: true, createdAt: 120_000, modifiedAt: 123_456, snapshotToken: "snapshot-token" }
    });

    expect(createMutations[0]?.appendSystemPrompt).toBe("Prefer concise replies.");
    expect(createMutations[1]?.appendSystemPrompt).toBeUndefined();
    expect(createMutations[2]?.catalogImport).toMatchObject({
      projectId: "project-target",
      archived: true,
      createdAt: { seconds: 120n, nanos: 0 },
      modifiedAt: { seconds: 123n, nanos: 456_000_000 },
      snapshotToken: "snapshot-token"
    });
    gateway.disconnect();
  });

  it("reuses one operation ID and rejects untyped create results instead of guessing existing entities", async () => {
    const operationIds: string[] = [];
    let submissions = 0;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(async (method, input) => {
        operationIds.push(input.operationId);
        submissions += 1;
        if (submissions === 1) {
          throw new ConnectError("response was lost", Code.Unavailable);
        }
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        }));
      }, [{
        sessionId: "session-existing",
        backendId: "pi",
        targetId: "target-1",
        displayName: "Existing task"
      }])
    );
    await gateway.connect();

    await expect(gateway.createSession(DRAFT)).rejects.toThrow("without a typed task result");
    await expect(gateway.createTarget({
      backendId: "pi",
      name: "Local workspace",
      workspaceKind: "userProject",
      serverPath: "D:\\existing",
      createIfMissing: false
    })).rejects.toThrow("without a typed project result");
    expect(operationIds).toHaveLength(3);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(operationIds[2]).not.toBe(operationIds[1]);
    gateway.disconnect();
  });

  it("mints a fresh operation ID for a new user attempt after a confirmed failure", async () => {
    const operationIds: string[] = [];
    let submissions = 0;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(async (method, input) => {
        operationIds.push(input.operationId);
        submissions += 1;
        if (submissions === 1) {
          return response(method, create(SubmitOperationResponseSchema, {
            operation: {
              operationId: input.operationId,
              connectionId: input.connectionId,
              state: OperationState.FAILED,
              error: {
                code: "PI_PROCESS_IDENTITY_UNAVAILABLE",
                message: "Pi startup failed."
              }
            }
          }));
        }
        return successfulSessionResponse(method, input, "session-after-user-retry");
      })
    );
    await gateway.connect();

    await expect(gateway.createSession(DRAFT)).rejects.toThrow("Pi startup failed.");
    await expect(gateway.createSession(DRAFT)).resolves.toBe("session-after-user-retry");
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).not.toBe(operationIds[0]);
    gateway.disconnect();
  });

  it("submits background cancellation with both ownership keys and waits for confirmation", async () => {
    const payloads: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(async (method, input) => {
        payloads.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        }));
      })
    );
    await gateway.connect();

    await gateway.cancelBackgroundTask("session-background", "task-owned");

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      case: "cancelBackgroundTask",
      value: { sessionId: "session-background", backgroundTaskId: "task-owned" }
    });
    gateway.disconnect();
  });

  it("submits the language tool opt-in as a typed owner setting", async () => {
    const payloads: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(async (method, input) => {
        payloads.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "settings", value: { languageTools: { enabled: true } } } }
          }
        }));
      })
    );
    await gateway.connect();

    await gateway.updateLanguageToolSettings(true);

    expect(payloads).toEqual([expect.objectContaining({
      case: "updateLanguageToolSettings",
      value: expect.objectContaining({ patch: expect.objectContaining({ enabled: true }) })
    })]);
    gateway.disconnect();
  });

  it("submits automatic and Provider-scoped model catalog refresh intent", async () => {
    const payloads: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(async (method, input) => {
        payloads.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "acknowledgement", value: { accepted: true } } }
          }
        }));
      })
    );
    await gateway.connect();

    await gateway.refreshProviderModels("backend-one", undefined, true);
    await gateway.refreshProviderModels("backend-one", "provider-one", false);

    expect(payloads).toEqual([
      expect.objectContaining({
        case: "refreshProviderModels",
        value: expect.objectContaining({ backendId: "backend-one", providerId: "", automatic: true })
      }),
      expect.objectContaining({
        case: "refreshProviderModels",
        value: expect.objectContaining({ backendId: "backend-one", providerId: "provider-one", automatic: false })
      })
    ]);
    gateway.disconnect();
  });

  it("preserves project placement presence in typed task moves", async () => {
    const payloads: any[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-test", name: "Desktop", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => operationTransport(async (method, input) => {
        payloads.push(input.mutation.payload);
        return response(method, create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "session", value: { sessionId: "session-1" } } }
          }
        }));
      })
    );
    await gateway.connect();

    await gateway.moveSessionProject("session-1", "target-2");
    await gateway.moveSessionProject("session-1");
    await gateway.moveSessionProject("session-1", "target-3", {
      archived: true,
      modifiedAt: 123_456,
      snapshotToken: "snapshot-token"
    });

    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toMatchObject({
      case: "moveSessionProject",
      value: { sessionId: "session-1", projectId: "target-2" }
    });
    expect(payloads[1]).toMatchObject({
      case: "moveSessionProject",
      value: { sessionId: "session-1" }
    });
    expect(Object.prototype.hasOwnProperty.call(payloads[1].value, "projectId")).toBe(false);
    expect(payloads[2]).toMatchObject({
      case: "moveSessionProject",
      value: {
        sessionId: "session-1",
        projectId: "target-3",
        catalogImport: {
          archived: true,
          modifiedAt: { seconds: 123n, nanos: 456_000_000 },
          snapshotToken: "snapshot-token"
        }
      }
    });
    gateway.disconnect();
  });
});

function operationTransport(
  submit: (method: any, input: any) => Promise<any>,
  sessions: any[] = []
): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n },
            targets: [{
              targetId: "target-1",
              backendId: "pi",
              displayName: "Local workspace",
              workspaceId: "workspace-1"
            }],
            sessions
          })
        }));
      }
      if (method.localName === "listManagedModelRuntimes") {
        return response(method, create(ListManagedModelRuntimesResponseSchema, {}));
      }
      if (method.localName === "submitOperation") return submit(method, input);
      throw new Error(`Unexpected method: ${method.localName}`);
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function successfulSessionResponse(method: any, input: any, sessionId: string): any {
  return response(method, create(SubmitOperationResponseSchema, {
    operation: {
      operationId: input.operationId,
      connectionId: input.connectionId,
      state: OperationState.SUCCEEDED,
      result: {
        payload: {
          case: "session",
          value: {
            sessionId,
            backendId: "pi",
            targetId: "target-1",
            displayName: "New task"
          }
        }
      }
    }
  }));
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
