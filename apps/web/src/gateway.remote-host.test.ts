import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  CapabilitySupport,
  BeginCredentialUploadResponseSchema,
  CreateRemoteHostResponseSchema,
  EntityKind,
  InteractionKind,
  InteractionState,
  GetRemoteHostCapabilitiesResponseSchema,
  GetSnapshotResponseSchema,
  ListRemoteHostsResponseSchema,
  OperationState,
  RemoteHostAuthenticationMode,
  RemoteHostCapabilityKind,
  RemoteHostFailureCode,
  RemoteHostSource,
  RemoteHostStatus,
  SnapshotSchema,
  SubmitOperationResponseSchema,
  TestRemoteHostConnectionResponseSchema,
  WatchRemoteHostsResponseSchema,
  RemoteHostChangeKind
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";
import type { AppSnapshot } from "./model.js";

describe("Remote Host gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, 0n])("rejects a Target projection without a usable revision (%s)", (revision) => {
    expect(() => mapSnapshot(create(SnapshotSchema, { targets: [{
      targetId: "target-one", backendId: "backend", workspaceId: "workspace-one",
      ...(revision === undefined ? {} : { version: { revision: { value: revision } } })
    }] }))).toThrow("Target without a current revision");
  });
  it("uses generated contracts for capability, CRUD, status, TOFU, and remote workspace binding", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    let snapshot: AppSnapshot | undefined;
    const transport = remoteTransport((method, input) => {
      requests.push({ method, input });
      if (method === "getRemoteHostCapabilities") {
        return create(GetRemoteHostCapabilitiesResponseSchema, {
          capabilities: [
            RemoteHostCapabilityKind.CATALOG,
            RemoteHostCapabilityKind.MANAGEMENT,
            RemoteHostCapabilityKind.CONNECTION_TEST,
            RemoteHostCapabilityKind.PROCESS_STREAMING,
            RemoteHostCapabilityKind.FILE_TRANSFER,
            RemoteHostCapabilityKind.TCP_FORWARDING
          ].map((kind) => ({ kind, name: `capability-${kind}`, support: CapabilitySupport.SUPPORTED }))
        });
      }
      if (method === "listRemoteHosts") {
        return create(ListRemoteHostsResponseSchema, { hosts: [host()], page: { totalSize: 1n } });
      }
      if (method === "createRemoteHost") return create(CreateRemoteHostResponseSchema, { host: host() });
      if (method === "testRemoteHostConnection") {
        return create(TestRemoteHostConnectionResponseSchema, { result: { outcome: 1, host: host() } });
      }
      if (method === "submitOperation") {
        return create(SubmitOperationResponseSchema, {
          operation: {
            operationId: input.operationId,
            connectionId: input.connectionId,
            state: OperationState.SUCCEEDED
          }
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "remote-connection", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      { onSnapshot: (value) => { snapshot = value; } },
      () => transport
    );
    await gateway.connect();

    expect(snapshot?.targets[0]?.revision).toBe(7n);
    expect(snapshot?.targets[0]?.remoteWorkspace).toEqual({
      hostId: "build-box",
      workspaceRoot: "/srv/project"
    });
    await expect(gateway.getRemoteHostCapabilities("target-one")).resolves.toMatchObject({
      catalog: true,
      management: true,
      connectionTest: true,
      processStreaming: true,
      fileTransfer: true,
      tcpForwarding: true,
      connectionControl: false,
      commandExecution: false
    });
    await expect(gateway.listRemoteHosts("target-one")).resolves.toEqual([{
      targetId: "target-one",
      id: "build-box",
      hostname: "build.internal",
      port: 22,
      user: "joko",
      source: "manual",
      authentication: "privateKey",
      credentialReferenceId: "ssh-key-reference",
      trust: {
        algorithm: "ssh-ed25519",
        sha256Fingerprint: "SHA256:public-fingerprint",
        pinnedAt: 10_000
      },
      status: {
        state: "failed",
        changedAt: 11_000,
        failure: { code: "hostKeyChanged", retryable: false }
      },
      revision: 4n
    }]);
    await gateway.createRemoteHost("target-one", {
      id: "build-box",
      hostname: "build.internal",
      port: 22,
      user: "joko",
      authentication: "privateKey",
      credentialReferenceId: "ssh-key-reference"
    });
    await gateway.testRemoteHostConnection("target-one", "build-box", 4n);
    await gateway.updateTarget("target-one", {
      workspaceLocation: { kind: "remote", hostId: "build-box", workspaceRoot: "  /srv/project  " }
    }, 7n);

    expect(requests.find((request) => request.method === "listRemoteHosts")?.input).toEqual({
      targetId: "target-one",
      page: { pageSize: 500, pageToken: "" }
    });
    const createInput = requests.find((request) => request.method === "createRemoteHost")?.input;
    expect(createInput).toMatchObject({
      targetId: "target-one",
      hostId: "build-box",
      authenticationMode: RemoteHostAuthenticationMode.PRIVATE_KEY,
      credentialReferenceId: "ssh-key-reference"
    });
    expect(JSON.stringify(createInput)).not.toContain("PRIVATE KEY");
    expect(requests.find((request) => request.method === "testRemoteHostConnection")?.input).toEqual({
      targetId: "target-one",
      hostId: "build-box",
      expectedRevision: { value: 4n }
    });
    expect(requests.find((request) => request.method === "submitOperation")?.input.mutation.payload).toMatchObject({
      case: "updateTarget",
      value: {
        targetId: "target-one",
        workspaceLocationUpdate: {
          case: "remoteWorkspace",
          value: { hostId: "build-box", workspaceRootDisplay: "/srv/project" }
        }
      }
    });
    expect(requests.find((request) => request.method === "submitOperation")?.input.mutation.preconditions).toMatchObject([{
      entity: { kind: EntityKind.TARGET, id: "target-one" }, expectedRevision: { value: 7n }
    }]);
    gateway.disconnect();
  });

  it("requires a full initial Remote Host snapshot before accepting changes", async () => {
    const transport = remoteTransport(() => { throw new Error("Unexpected unary request"); });
    vi.mocked(transport.stream).mockImplementation(async (method: any) => response(method,
      method.localName === "watchRemoteHosts" ? (async function* () {
        yield create(WatchRemoteHostsResponseSchema, {
          sequence: 1n,
          update: { case: "change", value: { kind: RemoteHostChangeKind.UPSERTED, host: host() } }
        });
      })() : idleStream(), true));
    const gateway = createOrchestratorGateway(
      { id: "remote-watch", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "auth-key", {}, () => transport
    );
    await gateway.connect();
    await expect(gateway.watchRemoteHosts("target-one")[Symbol.asyncIterator]().next()).rejects.toThrow("initial Remote Host snapshot");
    gateway.disconnect();
  });

  it.each(["ticket", "upload"] as const)("retires a credential action during %s without continuing on a replacement connection", async (stage) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const submissions: unknown[] = [];
    const fetch = vi.fn(async () => {
      if (stage === "upload") { entered(); await pending; }
      return new Response(undefined, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);
    const transport = remoteTransport(async (method, input) => {
      if (method === "beginCredentialUpload") {
        if (stage === "ticket") { entered(); await pending; }
        return create(BeginCredentialUploadResponseSchema, { ticket: {
          ticketId: "original-ticket", relativeEndpoint: "/v1/credential-uploads/original-ticket", maximumBytes: 1024n
        } });
      }
      if (method === "submitOperation") {
        submissions.push(input);
        return create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, state: OperationState.SUCCEEDED } });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "remote-credential", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "auth-key", {}, () => transport
    );
    await gateway.connect();
    const action = gateway.saveCredential({ id: "key-reference", name: "Test key", kind: "sshPrivateKey", providerId: "", secret: "test-only-secret" });
    const outcome = action.then(() => undefined, (error: unknown) => error);
    await started;
    await gateway.connect();
    release();
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(stage === "ticket" ? 0 : 1);
    expect(submissions).toEqual([]);
    gateway.disconnect();
  });

  it("honors caller retirement after key upload without committing its reference", async () => {
    const caller = new AbortController();
    const submissions: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      caller.abort();
      return new Response(undefined, { status: 204 });
    }));
    const transport = remoteTransport((method, input) => {
      if (method === "beginCredentialUpload") return create(BeginCredentialUploadResponseSchema, { ticket: {
        ticketId: "caller-ticket", relativeEndpoint: "/v1/credential-uploads/caller-ticket", maximumBytes: 1024n
      } });
      if (method !== "submitOperation") throw new Error(`Unexpected method: ${method}`);
      submissions.push(input);
      return create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, state: OperationState.SUCCEEDED } });
    });
    const gateway = createOrchestratorGateway(
      { id: "remote-caller", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "auth-key", {}, () => transport
    );
    await gateway.connect();
    await expect(gateway.saveCredential({ id: "key-reference", name: "Test key", kind: "sshPrivateKey", providerId: "", secret: "test-only-secret" }, caller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(submissions).toEqual([]);
    gateway.disconnect();
  });

  it.each(["provider", "voice"] as const)("fences the %s continuation after its credential upload has returned", async (consumer) => {
    const submissions: unknown[] = [];
    let tickets = 0;
    const transport = remoteTransport((method, input) => {
      if (method === "beginCredentialUpload") {
        tickets += 1;
        return create(BeginCredentialUploadResponseSchema, { ticket: {
          ticketId: "owned-ticket", relativeEndpoint: "/v1/credential-uploads/owned-ticket", maximumBytes: 1024n
        } });
      }
      if (method !== "submitOperation") throw new Error(`Unexpected method: ${method}`);
      submissions.push(input);
      return create(SubmitOperationResponseSchema, { operation: { operationId: input.operationId, state: OperationState.SUCCEEDED } });
    });
    const gateway = createOrchestratorGateway(
      { id: "credential-consumer", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "auth-key", {}, () => transport
    );
    await gateway.connect();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const response = new Response(undefined, { status: 204 });
      Object.defineProperty(response, "ok", { get: () => { gateway.disconnect(); return true; } });
      return response;
    }));
    const action = consumer === "provider"
      ? gateway.saveProviderCredentialSurface("backend", "provider", "apiKey", "test-only-secret")
      : gateway.updateVoiceInputServiceSettings({
          enabled: true, protocol: "openAiCompatibleBatch", endpoint: "https://voice.example/transcribe", model: "model", resourceId: "", keyless: false,
          secret: "test-only-secret", fallbackSecret: "test-only-fallback", fallbackEnabled: true,
          fallbackProtocol: "openAiCompatibleBatch", fallbackEndpoint: "https://voice.example/fallback", fallbackModel: "fallback", fallbackResourceId: "", fallbackKeyless: false,
          refinementEnabled: false, expectedRevision: 1n
        });
    await expect(action).rejects.toMatchObject({ name: "AbortError" });
    expect(tickets).toBe(1);
    expect(submissions).toEqual([]);
    gateway.disconnect();
  });

  it("submits an ordinary text question without opening or uploading through a credential channel", async () => {
    const methods: string[] = [];
    const submissions: any[] = [];
    let snapshot: AppSnapshot | undefined;
    const transport = remoteTransport((method, input) => {
      methods.push(method);
      if (method !== "submitOperation") throw new Error(`Unexpected method: ${method}`);
      submissions.push(input);
      return create(SubmitOperationResponseSchema, {
        operation: { operationId: input.operationId, state: OperationState.SUCCEEDED }
      });
    }, { interactions: [{
      interactionId: "question", sessionId: "task", kind: InteractionKind.QUESTION, state: InteractionState.PENDING,
      generation: 4n,
      request: { case: "question", value: { title: "Release notes", fields: [{
        fieldId: "notes", label: "Notes", required: true, input: { case: "text", value: { multiline: true } }
      }] } }
    }] });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const gateway = createOrchestratorGateway(
      { id: "question-answer", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" },
      "auth-key", { onSnapshot: (value) => { snapshot = value; } }, () => transport
    );
    await gateway.connect();
    await gateway.resolveInteraction(snapshot!.interactions[0]!, {
      kind: "question",
      answers: { notes: { kind: "text", value: "Ready" } }
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(methods).not.toContain("beginCredentialUpload");
    expect(methods.filter((method) => method === "submitOperation")).toHaveLength(1);
    expect(submissions[0]?.mutation?.payload?.value?.resolution?.decision).toMatchObject({
      case: "question",
      value: { answers: [{ fieldId: "notes", value: { case: "text", value: "Ready" } }] }
    });
    gateway.disconnect();
  });

  it("fails closed on an incomplete private-key projection", async () => {
    const transport = remoteTransport((method) => {
      if (method === "listRemoteHosts") {
        return create(ListRemoteHostsResponseSchema, {
          hosts: [host({ credentialReferenceId: undefined })],
          page: { totalSize: 1n }
        });
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const gateway = createOrchestratorGateway(
      { id: "remote-malformed", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      {},
      () => transport
    );
    await gateway.connect();
    await expect(gateway.listRemoteHosts("target-one")).rejects.toThrow("inconsistent Remote Host authentication");
    gateway.disconnect();
  });

  it("collects every Remote Host page and rejects a cyclic cursor without publishing a partial catalog", async () => {
    const pageTokens: string[] = [];
    const transport = remoteTransport((method, input) => {
      if (method !== "listRemoteHosts") throw new Error(`Unexpected method: ${method}`);
      pageTokens.push(input.page.pageToken);
      return input.page.pageToken === ""
        ? create(ListRemoteHostsResponseSchema, {
            hosts: [host({ hostId: "build-a", hostname: "a.internal" })],
            page: { nextPageToken: "page-2", totalSize: 2n }
          })
        : create(ListRemoteHostsResponseSchema, {
            hosts: [host({ hostId: "build-b", hostname: "b.internal" })],
            page: { totalSize: 2n }
          });
    });
    const gateway = createOrchestratorGateway(
      { id: "remote-pages", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      {},
      () => transport
    );
    await gateway.connect();

    await expect(gateway.listRemoteHosts("target-one")).resolves.toMatchObject([
      { id: "build-a" },
      { id: "build-b" }
    ]);
    expect(pageTokens).toEqual(["", "page-2"]);
    gateway.disconnect();

    let calls = 0;
    const cyclicGateway = createOrchestratorGateway(
      { id: "remote-cycle", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" },
      "auth-key",
      {},
      () => remoteTransport((method) => {
        if (method !== "listRemoteHosts") throw new Error(`Unexpected method: ${method}`);
        calls += 1;
        return create(ListRemoteHostsResponseSchema, {
          hosts: [host()],
          page: { nextPageToken: "loop", totalSize: 2n }
        });
      })
    );
    await cyclicGateway.connect();
    await expect(cyclicGateway.listRemoteHosts("target-one")).rejects.toThrow("cyclic Remote Host catalog page token");
    expect(calls).toBe(2);
    cyclicGateway.disconnect();
  });
});

function remoteTransport(handler: (method: string, input: any) => unknown, snapshotFields: { readonly interactions?: MessageInitShape<typeof SnapshotSchema>["interactions"] } = {}): Transport {
  return {
    unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
      if (method.localName === "getSnapshot") {
        return response(method, create(GetSnapshotResponseSchema, {
          snapshot: create(SnapshotSchema, {
            generation: 1n,
            resumeCursor: { generation: 1n, sequence: 0n },
            targets: [{
              targetId: "target-one",
              backendId: "pi",
              displayName: "Project",
              workspaceId: "workspace-one",
              version: { revision: { value: 7n } },
              remoteWorkspace: { hostId: "build-box", workspaceRootDisplay: "/srv/project" }
            }],
            ...snapshotFields
          })
        }));
      }
      return response(method, await handler(method.localName, input));
    }),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
}

function host(patch: Record<string, unknown> = {}): any {
  return {
    targetId: "target-one",
    hostId: "build-box",
    hostname: "build.internal",
    port: 22,
    user: "joko",
    source: RemoteHostSource.MANUAL,
    authenticationMode: RemoteHostAuthenticationMode.PRIVATE_KEY,
    credentialReferenceId: "ssh-key-reference",
    trust: {
      algorithm: "ssh-ed25519",
      sha256Fingerprint: "SHA256:public-fingerprint",
      pinnedAt: { seconds: 10n, nanos: 0 }
    },
    status: {
      state: RemoteHostStatus.FAILED,
      changedAt: { seconds: 11n, nanos: 0 },
      failure: { code: RemoteHostFailureCode.HOST_KEY_CHANGED, retryable: false }
    },
    revision: { value: 4n },
    ...patch
  };
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
