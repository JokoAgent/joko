import type { Transport } from "@connectrpc/connect";
import {
  AuthenticationState,
  BackendHealth,
  CapabilitySupport,
  EntityKind,
  InstallationState,
  OperationState,
  ProviderApiCompatibility,
  ProviderConfigurationField,
  ProviderKind,
  SessionState,
  TargetState
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import type { DesktopManagedOrchestratorConnection } from "../src/channels.js";
import {
  createPackagedSmokeTask,
  verifyPackagedSmokeTask,
  type PackagedSmokeTask
} from "../src/packaged-smoke-task.js";

const CONNECTION: DesktopManagedOrchestratorConnection = {
  profileId: "managed-connection",
  deviceId: "desktop-device",
  serverId: "managed-server",
  name: "Local Joko",
  origin: "http://127.0.0.1:4318"
};
const AUTH_KEY = "a".repeat(43);
const DISPLAY_NAME = "Packaged application-window task";
const PROVIDER_ORIGIN = "http://127.0.0.1:9001";
const TASK: PackagedSmokeTask = {
  sessionId: "session-packaged",
  backendId: "managed-runtime",
  targetId: "target-managed",
  displayName: DISPLAY_NAME,
  generation: 3n
};

describe("packaged Desktop durable Task acceptance fixture", () => {
  it("proves anonymous identity before auth, selects by capabilities, and uses the prepared Target revision", async () => {
    const calls: Array<{ readonly method: string; readonly input: any }> = [];
    let snapshots = 0;
    const transport = fakeTransport(async (method, input) => {
      calls.push({ method, input });
      if (method === "getServerInfo") return serverInfo("managed-server");
      if (method === "getSnapshot") {
        snapshots += 1;
        return {
          snapshot: snapshot(snapshots >= 3 ? [taskSession()] : [], true, snapshots >= 2)
        };
      }
      if (method === "prepareTargetWorkspace") {
        return {
          workspace: {
            workspaceId: "workspace-managed",
            targetId: "target-managed",
            version: { revision: { value: 7n } }
          }
        };
      }
      if (method === "submitOperation") {
        if (input.mutation.payload.case === "upsertProvider") {
          return {
            operation: {
              operationId: input.operationId,
              connectionId: input.connectionId,
              state: OperationState.SUCCEEDED,
              result: { payload: { case: "acknowledgement", value: { accepted: true } } }
            }
          };
        }
        return {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "session", value: taskSession() } }
          }
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const transportFactory = vi.fn(() => transport);
    const readAuthKey = vi.fn(async () => AUTH_KEY);
    const isAuthorityCurrent = vi.fn(async () => true);
    const operationId = vi.fn()
      .mockReturnValueOnce("operation-provider")
      .mockReturnValueOnce("operation-packaged");

    await expect(createPackagedSmokeTask({
      connection: CONNECTION,
      displayName: DISPLAY_NAME,
      providerOrigin: PROVIDER_ORIGIN,
      readAuthKey,
      isAuthorityCurrent,
      operationId,
      transportFactory
    })).resolves.toEqual(TASK);

    expect(calls.map((call) => call.method)).toEqual([
      "getServerInfo",
      "getSnapshot",
      "submitOperation",
      "getSnapshot",
      "prepareTargetWorkspace",
      "submitOperation",
      "getSnapshot"
    ]);
    expect(transportFactory).toHaveBeenNthCalledWith(1, CONNECTION.origin, undefined, 35_000);
    expect(transportFactory).toHaveBeenNthCalledWith(2, CONNECTION.origin, AUTH_KEY, 35_000);
    expect(readAuthKey).toHaveBeenCalledWith(CONNECTION.profileId);
    expect(isAuthorityCurrent).toHaveBeenCalledTimes(3);

    const providerSubmit = calls.find((call) =>
      call.method === "submitOperation" && call.input.mutation.payload.case === "upsertProvider")?.input;
    expect(providerSubmit).toMatchObject({
      operationId: "operation-provider",
      connectionId: CONNECTION.profileId,
      mutation: {
        payload: {
          case: "upsertProvider",
          value: {
            provider: {
              providerId: "packaged-smoke-local",
              kind: ProviderKind.LOCAL_KEYLESS,
              enabled: true,
              version: { revision: { value: 0n } },
              runtimes: [{
                backendId: "managed-runtime",
                endpoint: `${PROVIDER_ORIGIN}/v1`,
                keyless: true,
                apiCompatibility: ProviderApiCompatibility.OPENAI_COMPLETIONS,
                models: [{ modelId: "packaged-smoke-model" }]
              }]
            }
          }
        }
      }
    });

    const prepare = calls.find((call) => call.method === "prepareTargetWorkspace")?.input;
    expect(prepare).toMatchObject({
      targetId: "target-managed",
      expectedTargetRevision: { value: 7n }
    });
    const submit = calls.find((call) =>
      call.method === "submitOperation" && call.input.mutation.payload.case === "createSession")?.input;
    expect(submit).toMatchObject({
      operationId: "operation-packaged",
      connectionId: CONNECTION.profileId,
      mutation: {
        preconditions: [{
          entity: { kind: EntityKind.TARGET, id: "target-managed" },
          expectedRevision: { value: 7n }
        }],
        payload: {
          case: "createSession",
          value: {
            backendId: "managed-runtime",
            targetId: "target-managed",
            displayName: DISPLAY_NAME,
            model: {
              model: { providerId: "packaged-smoke-local", modelId: "packaged-smoke-model" }
            }
          }
        }
      }
    });
  });

  it("never reads the bearer when the loopback identity differs", async () => {
    const calls: string[] = [];
    const transport = fakeTransport(async (method) => {
      calls.push(method);
      if (method === "getServerInfo") return serverInfo("different-server");
      throw new Error(`Unexpected authenticated call: ${method}`);
    });
    const readAuthKey = vi.fn(async () => AUTH_KEY);

    await expect(createPackagedSmokeTask({
      connection: CONNECTION,
      displayName: DISPLAY_NAME,
      providerOrigin: PROVIDER_ORIGIN,
      readAuthKey,
      isAuthorityCurrent: async () => true,
      transportFactory: () => transport
    })).rejects.toThrow("identity changed");
    expect(calls).toEqual(["getServerInfo"]);
    expect(readAuthKey).not.toHaveBeenCalled();
  });

  it("does not replace a missing managed-runtime Target with an unrelated installed Backend", async () => {
    const calls: string[] = [];
    const transport = fakeTransport(async (method) => {
      calls.push(method);
      if (method === "getServerInfo") return serverInfo("managed-server");
      if (method === "getSnapshot") return {
        snapshot: snapshot([], false)
      };
      throw new Error(`Unexpected mutation call: ${method}`);
    });

    await expect(createPackagedSmokeTask({
      connection: CONNECTION,
      displayName: DISPLAY_NAME,
      providerOrigin: PROVIDER_ORIGIN,
      readAuthKey: async () => AUTH_KEY,
      isAuthorityCurrent: async () => true,
      transportFactory: () => transport
    })).rejects.toThrow("no installed local Target with a managed Task runtime");
    expect(calls).toEqual(["getServerInfo", "getSnapshot"]);
  });

  it("rechecks the durable Task after the application window retires", async () => {
    const calls: string[] = [];
    const transport = fakeTransport(async (method) => {
      calls.push(method);
      if (method === "getServerInfo") return serverInfo("managed-server");
      if (method === "getSnapshot") return { snapshot: snapshot([taskSession()]) };
      throw new Error(`Unexpected verification call: ${method}`);
    });
    const isAuthorityCurrent = vi.fn(async () => true);

    await expect(verifyPackagedSmokeTask({
      connection: CONNECTION,
      displayName: DISPLAY_NAME,
      readAuthKey: async () => AUTH_KEY,
      isAuthorityCurrent,
      transportFactory: () => transport
    }, TASK)).resolves.toBeUndefined();
    expect(calls).toEqual(["getServerInfo", "getSnapshot"]);
    expect(isAuthorityCurrent).toHaveBeenCalledTimes(3);
  });
});

function snapshot(sessions: readonly object[], includeManaged = true, configured = true): object {
  return {
    $typeName: "joko.v1.Snapshot",
    snapshotId: "snapshot-packaged",
    revision: { value: 11n },
    generation: 1n,
    backends: [
      {
        backendId: "unrelated-runtime",
        displayName: "Unrelated",
        health: BackendHealth.HEALTHY,
        installationState: InstallationState.INSTALLED,
        authenticationState: AuthenticationState.NOT_REQUIRED,
        capabilities: {
          capabilities: [{ name: "session.resume", support: CapabilitySupport.SUPPORTED }]
        }
      },
      ...(includeManaged ? [{
        backendId: "managed-runtime",
        displayName: "Managed runtime",
        health: BackendHealth.HEALTHY,
        installationState: InstallationState.INSTALLED,
        authenticationState: configured ? AuthenticationState.AUTHENTICATED : AuthenticationState.SIGNED_OUT,
        providerRuntimeSupport: {
          protocols: [ProviderApiCompatibility.OPENAI_COMPLETIONS],
          fields: [ProviderConfigurationField.KEYLESS]
        },
        capabilities: {
          capabilities: [
            { name: "provider.managed_catalog", support: CapabilitySupport.SUPPORTED },
            { name: "session.resume", support: CapabilitySupport.SUPPORTED }
          ]
        }
      }] : [])
    ],
    targets: [
      {
        targetId: "target-unrelated",
        backendId: "unrelated-runtime",
        displayName: "Unrelated project",
        workspaceId: "workspace-unrelated",
        state: TargetState.ACTIVE,
        version: { revision: { value: 4n } }
      },
      ...(includeManaged ? [{
        targetId: "target-managed",
        backendId: "managed-runtime",
        displayName: "Managed project",
        workspaceId: "workspace-managed",
        state: TargetState.ACTIVE,
        version: { revision: { value: 7n } }
      }] : [])
    ],
    providers: includeManaged && configured ? [{
      backendId: "managed-runtime",
      providerId: "packaged-smoke-local",
      displayName: "Packaged smoke local runtime",
      kind: ProviderKind.LOCAL_KEYLESS,
      apiCompatibility: ProviderApiCompatibility.OPENAI_COMPLETIONS,
      authenticationState: AuthenticationState.NOT_REQUIRED
    }] : [],
    models: includeManaged && configured ? [{
      backendId: "managed-runtime",
      key: { providerId: "packaged-smoke-local", modelId: "packaged-smoke-model" },
      displayName: "Packaged smoke model",
      available: true
    }] : [],
    sessions: [...sessions]
  };
}

function taskSession(): object {
  return {
    sessionId: TASK.sessionId,
    backendId: TASK.backendId,
    targetId: TASK.targetId,
    displayName: TASK.displayName,
    state: SessionState.IDLE,
    nativeBinding: {
      backendId: TASK.backendId,
      opaqueReference: "native-packaged",
      runtimeGeneration: TASK.generation,
      runtimeAttached: true
    }
  };
}

function serverInfo(serverId: string): object {
  return {
    server: {
      serverId,
      displayName: "Managed Orchestrator",
      version: "0.1.0",
      apiVersion: "joko.v1",
      pairingEnabled: false
    }
  };
}

function fakeTransport(handler: (method: string, input: any) => Promise<object>): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => ({
      stream: false,
      service: method.parent,
      method,
      header: new Headers(),
      trailer: new Headers(),
      message: await handler(method.localName, input)
    })),
    stream: vi.fn()
  } as unknown as Transport;
}
