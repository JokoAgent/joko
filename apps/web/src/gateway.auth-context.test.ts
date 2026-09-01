import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
  BeginPairingResponseSchema,
  BackgroundTaskState,
  CompletePairingResponseSchema,
  DiscoverNativeSessionsResponseSchema,
  EventSchema,
  GetRuntimeToolCatalogResponseSchema,
  GetServerInfoResponseSchema,
  GetSnapshotResponseSchema,
  ListRuntimeCommandsResponseSchema,
  ListBackgroundTasksResponseSchema,
  NativeSessionCandidateState,
  NativeSessionPlacement,
  RuntimeCommandSource,
  RuntimeToolSourceOrigin,
  RuntimeToolSourceScope,
  SessionState,
  ScanNativeSessionCatalogResponseSchema,
  SnapshotSchema
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrchestratorGateway,
  isUnauthenticatedError,
  mapSnapshot,
  projectSnapshotEvent,
  reusablePairingDeviceId
} from "./gateway.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connection credential lifecycle", () => {
  it("classifies an unauthenticated stream failure through an error cause as terminal", () => {
    const revoked = new ConnectError("revoked", Code.Unauthenticated);
    expect(isUnauthenticatedError(revoked)).toBe(true);
    expect(isUnauthenticatedError(new Error("wrapped", { cause: revoked }))).toBe(true);
    expect(isUnauthenticatedError(new ConnectError("offline", Code.Unavailable))).toBe(false);
  });

  it("terminates an unauthenticated event stream instead of reconnecting", async () => {
    const revoked = new ConnectError("revoked", Code.Unauthenticated);
    const transport = {
      unary: vi.fn(async (method: any) => response(method, create(GetSnapshotResponseSchema, {
        snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
      }))),
      stream: vi.fn(async (method: any) => response(method, failingStream(revoked), true))
    } as unknown as Transport;
    const invalidated = vi.fn(async () => undefined);
    const states: string[] = [];
    const errors: string[] = [];
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-1", name: "Local", origin: "http://127.0.0.1:4318" , serverId: "server-test" },
      "secret",
      {
        onState: (state) => states.push(state),
        onError: (error) => errors.push(error.message),
        onAuthenticationInvalidated: invalidated
      },
      () => transport
    );

    await gateway.connect();
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());

    expect(transport.stream).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("disconnected");
    expect(errors.at(-1)).toContain("revoked or logged out");
  });

  it("reuses a device only with a credential scoped to the exact origin", () => {
    const profile = { id: "connection-1", deviceId: "device-1", serverId: "orchestrator-1", name: "Local", origin: "https://orchestrator.example" };
    expect(reusablePairingDeviceId(profile, "secret", "https://orchestrator.example/", "orchestrator-1")).toBe("device-1");
    expect(reusablePairingDeviceId(profile, undefined, "https://orchestrator.example", "orchestrator-1")).toBeUndefined();
    expect(reusablePairingDeviceId(profile, "secret", "https://other.example", "orchestrator-1")).toBeUndefined();
    expect(reusablePairingDeviceId(profile, "secret", profile.origin, "replacement-orchestrator")).toBeUndefined();
    expect(reusablePairingDeviceId({ ...profile, managedLocal: true }, "rejected-secret", profile.origin, "orchestrator-1")).toBeUndefined();
  });

  it("persists the returned device identity and sends it only on authenticated same-device pairing", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { platform: "test" });
    const requests: any[] = [];
    const factoryAuthKeys: Array<string | undefined> = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        requests.push({ method: method.localName, input });
        if (method.localName === "getServerInfo") {
          return response(method, serverInfoResponse());
        }
        if (method.localName === "beginPairing") {
          return response(method, create(BeginPairingResponseSchema, { challenge: { challengeId: "challenge-1" } }));
        }
        return response(method, create(CompletePairingResponseSchema, { result: {
          connection: { connectionId: "connection-2", deviceId: "device-1", displayName: "Browser" },
          device: { deviceId: "device-1", displayName: "Browser" },
          authKey: "new-secret"
        } }));
      })
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-1", serverId: "orchestrator-1", name: "Browser", origin: "https://orchestrator.example" },
      "old-secret",
      {},
      (_origin, authKey) => {
        factoryAuthKeys.push(authKey);
        return transport;
      }
    );

    const paired = await gateway.pair("https://orchestrator.example", "123456", "Browser");

    expect(factoryAuthKeys).toEqual([undefined, "old-secret"]);
    expect(requests.find((request) => request.method === "completePairing")?.input.deviceId).toBe("device-1");
    expect(paired.profile.deviceId).toBe("device-1");
  });

  it.each([
    ["the anonymous identity belongs to another node", { serverId: "old-orchestrator" }],
    ["a Desktop-managed credential is being recovered", { serverId: "orchestrator-1", managedLocal: true }]
  ])("never attaches a saved bearer when %s", async (_case, profileOverrides) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { platform: "test" });
    const factoryAuthKeys: Array<string | undefined> = [];
    const requests: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        requests.push({ method: method.localName, input });
        if (method.localName === "getServerInfo") return response(method, serverInfoResponse());
        if (method.localName === "beginPairing") {
          return response(method, create(BeginPairingResponseSchema, { challenge: { challengeId: "challenge-1" } }));
        }
        return response(method, create(CompletePairingResponseSchema, { result: {
          connection: { connectionId: "connection-2", deviceId: "device-2", displayName: "Browser" },
          device: { deviceId: "device-2", displayName: "Browser" },
          authKey: "new-secret"
        } }));
      })
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-1", deviceId: "device-1", name: "Browser", origin: "https://orchestrator.example", ...profileOverrides },
      "old-secret",
      {},
      (_origin, authKey) => {
        factoryAuthKeys.push(authKey);
        return transport;
      }
    );

    await gateway.pair("https://orchestrator.example", "123456", "Browser");

    expect(factoryAuthKeys).toEqual([undefined]);
    expect(requests.find((request) => request.method === "completePairing")?.input.deviceId).toBeUndefined();
  });

  it("completes a trusted CLI-issued challenge when the anonymous pairing window is explicitly closed", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { platform: "test" });
    const requests: any[] = [];
    const factoryAuthKeys: Array<string | undefined> = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        requests.push({ method: method.localName, input });
        if (method.localName === "getServerInfo") return response(method, serverInfoResponse());
        if (method.localName === "beginPairing") {
          throw new ConnectError("Pairing is not currently enabled by the owner.", Code.FailedPrecondition);
        }
        if (method.localName === "completePairing") {
          return response(method, create(CompletePairingResponseSchema, { result: {
            connection: { connectionId: "connection-cli", deviceId: "device-cli", displayName: "Browser" },
            device: { deviceId: "device-cli", displayName: "Browser" },
            authKey: "cli-secret"
          } }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      })
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(undefined, undefined, {}, (_origin, authKey) => {
      factoryAuthKeys.push(authKey);
      return transport;
    });

    const paired = await gateway.pair("https://orchestrator.example", " 654321 ", "Browser");

    expect(factoryAuthKeys).toEqual([undefined]);
    expect(requests.map((request) => request.method)).toEqual([
      "getServerInfo",
      "beginPairing",
      "completePairing"
    ]);
    expect(requests.at(-1)?.input).toMatchObject({
      challengeId: "",
      humanCode: "654321"
    });
    expect(requests.at(-1)?.input.deviceId).toBeUndefined();
    expect(paired).toMatchObject({
      profile: { id: "connection-cli", deviceId: "device-cli", serverId: "orchestrator-1" },
      authKey: "cli-secret"
    });
  });

  it.each([
    ["another failed precondition", new ConnectError("Pairing policy changed.", Code.FailedPrecondition)],
    ["pairing rate limiting", new ConnectError("Pairing requests are temporarily rate limited.", Code.ResourceExhausted)],
    ["an unavailable service", new ConnectError("offline", Code.Unavailable)]
  ])("does not swallow %s from BeginPairing", async (_label, beginError) => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { platform: "test" });
    const methods: string[] = [];
    const transport = {
      unary: vi.fn(async (method: any) => {
        methods.push(method.localName);
        if (method.localName === "getServerInfo") return response(method, serverInfoResponse());
        if (method.localName === "beginPairing") throw beginError;
        throw new Error("CompletePairing must not run.");
      })
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(undefined, undefined, {}, () => transport);

    await expect(gateway.pair("https://orchestrator.example", "654321", "Browser")).rejects.toBe(beginError);
    expect(methods).toEqual(["getServerInfo", "beginPairing"]);
  });
});

describe("Backend-neutral runtime commands", () => {
  it("uses SessionService and maps live RuntimeCommand values", async () => {
    const calls: Array<{ service: string; method: string; sessionId: string }> = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        calls.push({ service: method.parent.typeName, method: method.localName, sessionId: input.sessionId });
        return response(method, create(ListRuntimeCommandsResponseSchema, {
          commands: [{
            commandId: "runtime-review",
            sessionId: "session-commands",
            name: "review",
            description: "Review this change",
            source: RuntimeCommandSource.EXTENSION,
            loaded: true
          }]
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-commands", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    calls.length = 0;

    await expect(gateway.listCommands("session-commands")).resolves.toEqual([{
      id: "runtime-review",
      sessionId: "session-commands",
      name: "review",
      description: "Review this change",
      source: "extension",
      loaded: true
    }]);
    expect(calls).toEqual([{
      service: "joko.v1.SessionService",
      method: "listRuntimeCommands",
      sessionId: "session-commands"
    }]);
    gateway.disconnect();
  });
});

describe("Backend-neutral live runtime tools", () => {
  it("uses ToolService and maps the observed catalog without inventing permission flags", async () => {
    const calls: Array<{ service: string; method: string; sessionId: string }> = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        calls.push({ service: method.parent.typeName, method: method.localName, sessionId: input.sessionId });
        return response(method, create(GetRuntimeToolCatalogResponseSchema, {
          catalog: {
            runtimeGeneration: 9n,
            observedAt: { seconds: 12n, nanos: 345_000_000 },
            tools: [{
              name: "project_search",
              description: "Search the project.",
              active: true,
              promptGuidelines: ["Prefer exact terms."],
              inputSchema: {
                allowsAdditionalFields: false,
                fields: [{
                  fieldPath: "query",
                  title: "Query",
                  description: "Text to find.",
                  type: 1,
                  required: true,
                  secret: false,
                  enumValues: [],
                  constraints: { minimumLength: 1 }
                }]
              },
              sourceInfo: {
                path: "extensions/search.ts",
                source: "project-search",
                scope: RuntimeToolSourceScope.PROJECT,
                origin: RuntimeToolSourceOrigin.TOP_LEVEL,
                baseDir: "D:\\workspace"
              }
            }]
          }
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-tools", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    calls.length = 0;

    await expect(gateway.listRuntimeTools("session-tools")).resolves.toEqual({
      runtimeGeneration: 9n,
      observedAt: 12_345,
      tools: [{
        name: "project_search",
        description: "Search the project.",
        active: true,
        promptGuidelines: ["Prefer exact terms."],
        fields: [{
          path: "query",
          title: "Query",
          description: "Text to find.",
          type: "string",
          required: true,
          secret: false,
          enumValues: [],
          constraints: { minimumLength: 1 }
        }],
        allowsAdditionalFields: false,
        source: {
          path: "extensions/search.ts",
          name: "project-search",
          scope: "project",
          origin: "topLevel",
          baseDirectory: "D:\\workspace"
        }
      }]
    });
    expect(calls).toEqual([{
      service: "joko.v1.ToolService",
      method: "getRuntimeToolCatalog",
      sessionId: "session-tools"
    }]);
    gateway.disconnect();
  });
});

describe("durable background-task history", () => {
  it("collects every page and preserves unknown progress separately from measured zero", async () => {
    const requests: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        requests.push(input);
        const second = input.page?.pageToken === "page-2";
        return response(method, create(ListBackgroundTasksResponseSchema, {
          backgroundTasks: [second ? {
            backgroundTaskId: "task-finished",
            backendId: "backend-a",
            targetId: "target-a",
            sessionId: "session-background",
            displayName: "Finished",
            state: BackgroundTaskState.SUCCEEDED,
            progressRatio: 0,
            startedAt: { seconds: 3n },
            endedAt: { seconds: 4n },
            createdAt: { seconds: 2n },
            updatedAt: { seconds: 4n },
            version: { revision: { value: 12n } }
          } : {
            backgroundTaskId: "task-running",
            parentTaskId: "parent-a",
            backendId: "backend-a",
            targetId: "target-a",
            sessionId: "session-background",
            runId: "run-a",
            displayName: "Running",
            state: BackgroundTaskState.RUNNING,
            statusText: "Inspecting",
            startedAt: { seconds: 1n },
            createdAt: { seconds: 1n },
            updatedAt: { seconds: 2n },
            version: { revision: { value: 11n } }
          }],
          page: { nextPageToken: second ? "" : "page-2", totalSize: 2n }
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-background", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    requests.length = 0;

    const tasks = await gateway.listBackgroundTasks("session-background");

    expect(requests).toEqual([
      { sessionId: "session-background", page: { pageSize: 500, pageToken: "" } },
      { sessionId: "session-background", page: { pageSize: 500, pageToken: "page-2" } }
    ]);
    expect(tasks[0]).toMatchObject({
      id: "task-running",
      state: "running",
      parentTaskId: "parent-a",
      runId: "run-a",
      createdAt: 1_000,
      updatedAt: 2_000,
      revision: 11n
    });
    expect(tasks[0]?.progressRatio).toBeUndefined();
    expect(tasks[1]).toMatchObject({
      id: "task-finished",
      state: "completed",
      progressRatio: 0,
      endedAt: 4_000,
      revision: 12n
    });
    gateway.disconnect();
  });
});

describe("Backend-neutral native session discovery", () => {
  it("uses SessionService without sending or branching on a Backend ID", async () => {
    const calls: Array<{ service: string; method: string; input: unknown }> = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        calls.push({ service: method.parent.typeName, method: method.localName, input });
        return response(method, create(DiscoverNativeSessionsResponseSchema, {
          sessions: [{
            nativeSessionId: "native-1",
            nativeReference: "opaque-native-reference",
            name: "Recovered task",
            workspaceRoot: "workspace",
            messageCount: 7n,
            modifiedAt: { seconds: 2n },
            state: NativeSessionCandidateState.READY
          }, {
            nativeSessionId: "native-error",
            nativeReference: "opaque-error-reference",
            name: "Unreadable task",
            workspaceRoot: "workspace",
            state: NativeSessionCandidateState.ERROR
          }, {
            nativeSessionId: "native-unknown",
            nativeReference: "opaque-unknown-reference",
            name: "Unknown task",
            workspaceRoot: "workspace",
            state: NativeSessionCandidateState.UNSPECIFIED
          }]
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-discovery", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    calls.length = 0;

    await expect(gateway.discoverNativeSessions("target-1")).resolves.toEqual([
      {
        id: "native-1",
        reference: "opaque-native-reference",
        name: "Recovered task",
        workspaceRoot: "workspace",
        messageCount: 7,
        modifiedAt: 2_000,
        state: "ready"
      },
      {
        id: "native-error",
        reference: "opaque-error-reference",
        name: "Unreadable task",
        workspaceRoot: "workspace",
        messageCount: 0,
        modifiedAt: 0,
        state: "error"
      },
      {
        id: "native-unknown",
        reference: "opaque-unknown-reference",
        name: "Unknown task",
        workspaceRoot: "workspace",
        messageCount: 0,
        modifiedAt: 0,
        state: "error"
      }
    ]);
    expect(calls).toEqual([{
      service: "joko.v1.SessionService",
      method: "discoverNativeSessions",
      input: { targetId: "target-1", page: { pageSize: 500, pageToken: "" } }
    }]);
    gateway.disconnect();
  });

  it("collects every native Session discovery page beyond the first 100 candidates", async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => ({
      nativeSessionId: `native-${index + 1}`,
      nativeReference: `opaque-${index + 1}`,
      name: `Recovered task ${index + 1}`,
      workspaceRoot: "workspace",
      state: NativeSessionCandidateState.READY
    }));
    const pageTokens: string[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        const token = input.page?.pageToken ?? "";
        pageTokens.push(token);
        return response(method, create(DiscoverNativeSessionsResponseSchema, token === ""
          ? { sessions: candidates.slice(0, 100), page: { nextPageToken: "native-page-2", totalSize: 101n } }
          : { sessions: candidates.slice(100), page: { totalSize: 101n } }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-discovery-pages", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    pageTokens.length = 0;

    const result = await gateway.discoverNativeSessions("target-1");
    expect(result).toHaveLength(101);
    expect(result.at(-1)).toMatchObject({ id: "native-101", reference: "opaque-101" });
    expect(pageTokens).toEqual(["", "native-page-2"]);
    gateway.disconnect();
  });

  it("rejects a cyclic native Session discovery cursor instead of returning a partial picker", async () => {
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        const token = input.page?.pageToken ?? "";
        return response(method, create(DiscoverNativeSessionsResponseSchema, {
          page: { nextPageToken: token === "" ? "loop" : "loop", totalSize: 1n }
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-discovery-cycle", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.discoverNativeSessions("target-1"))
      .rejects.toThrow("cyclic native Session discovery page token");
    gateway.disconnect();
  });

  it("maps one Backend task catalog without coupling it to a Target request", async () => {
    const calls: Array<{ method: string; input: unknown }> = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        calls.push({ method: method.localName, input });
        return response(method, create(ScanNativeSessionCatalogResponseSchema, {
          entries: [{
            nativeSessionId: "native-dialogue",
            nativeReference: "opaque-dialogue",
            title: "Recovered dialogue",
            workingDirectory: "D:\\workspace",
            createdAt: { seconds: 1n },
            modifiedAt: { seconds: 3n },
            archived: true,
            placement: NativeSessionPlacement.DIALOGUE,
            targetId: "target-existing",
            existingSessionId: "session-existing"
          }],
          rejectedCount: 7n,
          existingCount: 5n,
          snapshotToken: "snapshot-token"
        }));
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway(
      { id: "connection-catalog", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "secret",
      {},
      () => transport
    );
    await gateway.connect();
    calls.length = 0;

    await expect(gateway.scanNativeSessionCatalog("codex")).resolves.toEqual({
      entries: [{
        id: "native-dialogue",
        reference: "opaque-dialogue",
        title: "Recovered dialogue",
        workingDirectory: "D:\\workspace",
        createdAt: 1_000,
        modifiedAt: 3_000,
        archived: true,
        placement: "dialogue",
        targetId: "target-existing",
        existingSessionId: "session-existing"
      }],
      rejectedCount: 7,
      existingCount: 5,
      snapshotToken: "snapshot-token"
    });
    expect(calls).toEqual([{
      method: "scanNativeSessionCatalog",
      input: { backendId: "codex", force: false }
    }]);
    gateway.disconnect();
  });
});

describe("authoritative session context state", () => {
  const governance = { agentResource: {}, collaboration: {}, gitSafety: {} } as const;
  const session = {
    sessionId: "session-1",
    backendId: "pi-1",
    targetId: "target-1",
    state: SessionState.IDLE,
    context: {
      usedTokens: 10n,
      contextWindowTokens: 100n,
      cumulativeUsage: { inputTokens: 4n, outputTokens: 2n, cacheReadTokens: 1n, cacheWriteTokens: 3n, totalTokens: 10n }
    }
  };

  it("uses only the backend-neutral session state and never infers policy from adapter settings", () => {
    const withContextState = create(SnapshotSchema, {
      sessions: [{ ...session, contextState: { autoCompaction: true, autoRetry: false } }],
      settings: { ...governance, pi: [{ backendId: "pi-1", autoCompaction: false, autoRetry: true }] },
      pi: { sessions: [{
        backendId: "pi-1",
        targetId: "target-1",
        productSessionId: "session-1",
        sessionState: { autoCompaction: false, autoRetry: true }
      }] }
    });
    expect(mapSnapshot(withContextState).sessions[0]?.context).toMatchObject({ autoCompact: true, autoRetry: false });
    expect(mapSnapshot(withContextState).sessions[0]?.usage?.cacheWriteTokens).toBe(3);
    expect(mapSnapshot(withContextState).sessions[0]?.usage?.totalTokens).toBe(10);

    const fromSettings = create(SnapshotSchema, {
      sessions: [session],
      settings: { ...governance, pi: [{ backendId: "pi-1", autoCompaction: false, autoRetry: true }] }
    });
    expect(mapSnapshot(fromSettings).sessions[0]?.context).not.toHaveProperty("autoCompact");
    expect(mapSnapshot(fromSettings).sessions[0]?.context).not.toHaveProperty("autoRetry");

    const withoutAuthority = mapSnapshot(create(SnapshotSchema, { sessions: [session] }));
    expect(withoutAuthority.sessions[0]?.context).not.toHaveProperty("autoCompact");
    expect(withoutAuthority.sessions[0]?.context).not.toHaveProperty("autoRetry");
  });

  it("does not rewrite authoritative session context when adapter settings change", () => {
    const raw = create(SnapshotSchema, {
      generation: 1n,
      resumeCursor: { generation: 1n, sequence: 0n },
      sessions: [{ ...session, contextState: { autoCompaction: false, autoRetry: false } }],
      settings: { ...governance, pi: [{ backendId: "pi-1", autoCompaction: false, autoRetry: false }] }
    });
    const event = create(EventSchema, {
      eventId: "settings-1",
      cursor: { generation: 1n, sequence: 1n },
      payload: { kind: { case: "settingsChanged", value: { settings: {
        ...governance,
        pi: [{ backendId: "pi-1", autoCompaction: true, autoRetry: true }]
      } } } }
    });

    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), event).snapshot;
    expect(projected.sessions[0]?.context).toMatchObject({ autoCompact: false, autoRetry: false });
  });
});

function response(method: any, message: any, stream = false): any {
  return {
    stream,
    service: method.parent,
    method,
    header: new Headers(),
    trailer: new Headers(),
    message
  };
}

function failingStream(error: Error): AsyncIterable<never> {
  return {
    async *[Symbol.asyncIterator]() {
      throw error;
    }
  };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}

function serverInfoResponse() {
  return create(GetServerInfoResponseSchema, {
    server: {
      serverId: "orchestrator-1",
      displayName: "Orchestrator",
      version: "0.1.0",
      apiVersion: "joko.v1",
      pairingEnabled: false
    }
  });
}
