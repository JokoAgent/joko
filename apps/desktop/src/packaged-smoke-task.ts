import { createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { randomUUID } from "node:crypto";
import {
  AuthenticationState,
  BackendHealth,
  CapabilitySupport,
  ConnectionService,
  EntityKind,
  EventService,
  InstallationState,
  ModelInputModality,
  NativeSessionPlacement,
  OperationService,
  OperationState,
  PermissionMode,
  ProviderApiCompatibility,
  ProviderConfigurationField,
  ProviderKind,
  TargetService,
  TargetState,
  type BackendDescriptor,
  type Operation,
  type Snapshot,
  type Target
} from "@joko/contracts";

import type { DesktopManagedOrchestratorConnection } from "./channels.js";

const PACKAGED_SMOKE_TASK_TIMEOUT_MS = 35_000;
const PACKAGED_SMOKE_PROVIDER_ID = "packaged-smoke-local";
const PACKAGED_SMOKE_MODEL_ID = "packaged-smoke-model";
const MANAGED_RUNTIME_CAPABILITY = "provider.managed_catalog";
const SESSION_RUNTIME_CAPABILITY = "session.resume";

export interface PackagedSmokeTask {
  readonly sessionId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly displayName: string;
  readonly generation: bigint;
}

export interface PackagedSmokeTaskOptions {
  readonly connection: DesktopManagedOrchestratorConnection;
  readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
  readonly isAuthorityCurrent: (connection: DesktopManagedOrchestratorConnection) => boolean | Promise<boolean>;
  readonly displayName: string;
  readonly providerOrigin?: string;
  readonly reuseConfiguredProvider?: boolean;
  readonly timeoutMs?: number;
  readonly operationId?: () => string;
  readonly transportFactory?: (origin: string, authKey: string | undefined, timeoutMs: number) => Transport;
}

/**
 * Creates one real durable product Task through the same generated public
 * contracts as the UI. This is intentionally called only by the staged and
 * unpacked Desktop acceptance smoke; it never injects fixture state into the
 * managed Orchestrator.
 */
export async function createPackagedSmokeTask(options: PackagedSmokeTaskOptions): Promise<PackagedSmokeTask> {
  return withPackagedSmokeAuthority(options, async (transport, signal) => {
    const eventClient = createClient(EventService, transport);
    const operationClient = createClient(OperationService, transport);
    const initial = await ownerSnapshot(eventClient, signal);
    const candidate = selectTaskTarget(initial);
    const providerProtocol = selectPackagedSmokeProviderProtocol(candidate.backend);
    if (options.reuseConfiguredProvider !== true) {
      await configurePackagedSmokeProvider(
        options,
        operationClient,
        candidate.backend.backendId,
        providerProtocol,
        signal
      );
    }
    const selected = await waitForConfiguredTaskTarget(
      eventClient,
      candidate,
      providerProtocol,
      signal
    );
    const targetRevision = selected.target.version?.revision?.value;
    if (targetRevision === undefined || targetRevision < 1n) {
      throw new Error("Packaged smoke selected a Target without a current revision.");
    }

    const prepared = await createClient(TargetService, transport).prepareTargetWorkspace({
      targetId: selected.target.targetId,
      expectedTargetRevision: { value: targetRevision }
    }, { signal });
    if (prepared.workspace === undefined
      || prepared.workspace.targetId !== selected.target.targetId
      || prepared.workspace.workspaceId === ""
      || prepared.workspace.version?.revision?.value !== targetRevision) {
      throw new Error("Packaged smoke prepared a different Target workspace revision.");
    }

    const response = await operationClient.submitOperation({
      operationId: options.operationId?.() ?? randomUUID(),
      connectionId: options.connection.profileId,
      mutation: {
        preconditions: [{
          entity: { kind: EntityKind.TARGET, id: selected.target.targetId },
          expectedRevision: { value: targetRevision }
        }],
        payload: {
          case: "createSession",
          value: {
            backendId: selected.backend.backendId,
            targetId: selected.target.targetId,
            displayName: options.displayName,
            nativeStart: { kind: { case: "newSession", value: { parentNativeReference: "" } } },
            model: {
              model: { providerId: PACKAGED_SMOKE_PROVIDER_ID, modelId: PACKAGED_SMOKE_MODEL_ID },
              effortId: "",
              fastMode: false
            },
            permissionMode: PermissionMode.ASK,
            planMode: false,
            initialPlacement: NativeSessionPlacement.PROJECT
          }
        }
      }
    }, { signal });
    const operation = response.operation;
    const payload = operation?.result?.payload;
    if (operation?.state !== OperationState.SUCCEEDED || payload?.case !== "session") {
      throw operationFailure("Packaged smoke Task creation", operation, "session");
    }
    const session = payload.value;
    const generation = session.nativeBinding?.runtimeGeneration;
    if (session.sessionId === ""
      || session.backendId !== selected.backend.backendId
      || session.targetId !== selected.target.targetId
      || session.displayName !== options.displayName
      || generation === undefined
      || generation < 1n
      || generation > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Packaged smoke Task creation returned inconsistent durable state.");
    }
    const task = Object.freeze({
      sessionId: session.sessionId,
      backendId: session.backendId,
      targetId: session.targetId,
      displayName: session.displayName,
      generation
    });
    assertTaskInSnapshot(await ownerSnapshot(eventClient, signal), task);
    return task;
  });
}

/** Re-reads service authority after the child window closes. */
export async function verifyPackagedSmokeTask(
  options: PackagedSmokeTaskOptions,
  task: PackagedSmokeTask
): Promise<void> {
  await withPackagedSmokeAuthority(options, async (transport, signal) => {
    assertTaskInSnapshot(await ownerSnapshot(createClient(EventService, transport), signal), task);
  });
}

async function withPackagedSmokeAuthority<T>(
  options: PackagedSmokeTaskOptions,
  action: (transport: Transport, signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? PACKAGED_SMOKE_TASK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new TypeError("Packaged smoke Task timeout is invalid.");
  }
  if (options.displayName.trim() === "" || options.displayName !== options.displayName.trim()
    || options.displayName.length > 256 || /[\u0000-\u001f\u007f]/u.test(options.displayName)) {
    throw new TypeError("Packaged smoke Task display name is invalid.");
  }
  const origin = new URL(options.connection.origin);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || origin.origin !== options.connection.origin || origin.username !== "" || origin.password !== "") {
    throw new Error("Packaged smoke managed authority is invalid.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  const factory = options.transportFactory ?? createPackagedSmokeTransport;
  try {
    const identity = await createClient(
      ConnectionService,
      factory(origin.origin, undefined, timeoutMs)
    ).getServerInfo({}, { signal: controller.signal });
    if (identity.server?.serverId !== options.connection.serverId || identity.server.apiVersion !== "joko.v1") {
      throw new Error("Packaged smoke managed service identity changed.");
    }
    if (!await options.isAuthorityCurrent(options.connection)) {
      throw new Error("Packaged smoke managed authority changed.");
    }
    const authKey = await options.readAuthKey(options.connection.profileId);
    if (authKey === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(authKey)
      || !await options.isAuthorityCurrent(options.connection)) {
      throw new Error("Packaged smoke managed authority changed.");
    }
    const result = await action(factory(origin.origin, authKey, timeoutMs), controller.signal);
    if (!await options.isAuthorityCurrent(options.connection)) {
      throw new Error("Packaged smoke managed authority changed.");
    }
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function ownerSnapshot(
  client: Client<typeof EventService>,
  signal: AbortSignal
): Promise<Snapshot> {
  const response = await client.getSnapshot({ scope: { kind: { case: "owner", value: {} } } }, { signal });
  if (response.snapshot === undefined || response.snapshot.revision?.value === undefined
    || response.snapshot.revision.value < 1n) {
    throw new Error("Packaged smoke owner Snapshot is unavailable.");
  }
  return response.snapshot;
}

async function configurePackagedSmokeProvider(
  options: PackagedSmokeTaskOptions,
  client: Client<typeof OperationService>,
  backendId: string,
  protocol: ProviderApiCompatibility,
  signal: AbortSignal
): Promise<void> {
  const endpoint = packagedSmokeProviderEndpoint(options.providerOrigin);
  const response = await client.submitOperation({
    operationId: options.operationId?.() ?? randomUUID(),
    connectionId: options.connection.profileId,
    mutation: {
      preconditions: [],
      payload: {
        case: "upsertProvider",
        value: {
          provider: {
            providerId: PACKAGED_SMOKE_PROVIDER_ID,
            displayName: "Packaged smoke local runtime",
            kind: ProviderKind.LOCAL_KEYLESS,
            enabled: true,
            version: { revision: { value: 0n } },
            runtimes: [{
              backendId,
              apiCompatibility: protocol,
              endpoint,
              credentialOrigin: "",
              keyless: true,
              authHeader: false,
              headers: [],
              models: [{
                modelId: PACKAGED_SMOKE_MODEL_ID,
                displayName: "Packaged smoke model",
                apiCompatibility: protocol,
                reasoning: false,
                inputModalities: [ModelInputModality.TEXT]
              }]
            }]
          }
        }
      }
    }
  }, { signal });
  if (response.operation?.state !== OperationState.SUCCEEDED
    || response.operation.result?.payload.case !== "acknowledgement") {
    throw operationFailure("Packaged smoke local Provider configuration", response.operation, "acknowledgement");
  }
}

async function waitForConfiguredTaskTarget(
  client: Client<typeof EventService>,
  expected: { readonly backend: BackendDescriptor; readonly target: Target },
  protocol: ProviderApiCompatibility,
  signal: AbortSignal
): Promise<{ readonly backend: BackendDescriptor; readonly target: Target }> {
  const deadline = Date.now() + 10_000;
  do {
    const snapshot = await ownerSnapshot(client, signal);
    const backend = snapshot.backends.find((candidate) => candidate.backendId === expected.backend.backendId);
    const target = snapshot.targets.find((candidate) => candidate.targetId === expected.target.targetId);
    const provider = snapshot.providers.find((candidate) =>
      candidate.backendId === expected.backend.backendId
      && candidate.providerId === PACKAGED_SMOKE_PROVIDER_ID);
    const model = snapshot.models.find((candidate) =>
      candidate.backendId === expected.backend.backendId
      && candidate.key?.providerId === PACKAGED_SMOKE_PROVIDER_ID
      && candidate.key.modelId === PACKAGED_SMOKE_MODEL_ID);
    if (backend !== undefined && target !== undefined
      && target.backendId === backend.backendId
      && target.state === TargetState.ACTIVE
      && target.remoteWorkspace === undefined
      && target.version?.revision?.value !== undefined
      && target.version.revision.value >= 1n
      && (backend.health === BackendHealth.HEALTHY || backend.health === BackendHealth.DEGRADED)
      && (backend.installationState === InstallationState.INSTALLED
        || backend.installationState === InstallationState.UPDATE_AVAILABLE)
      && (backend.authenticationState === AuthenticationState.AUTHENTICATED
        || backend.authenticationState === AuthenticationState.NOT_REQUIRED)
      && backend.providerRuntimeSupport?.protocols.includes(protocol) === true
      && provider !== undefined
      && (provider.authenticationState === AuthenticationState.AUTHENTICATED
        || provider.authenticationState === AuthenticationState.NOT_REQUIRED)
      && model?.available === true) {
      return { backend, target };
    }
    signal.throwIfAborted();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  } while (Date.now() < deadline);
  throw new Error("Packaged smoke local Provider did not become available on the selected Task runtime.");
}

function selectPackagedSmokeProviderProtocol(backend: BackendDescriptor): ProviderApiCompatibility {
  const support = backend.providerRuntimeSupport;
  if (support === undefined || !support.fields.includes(ProviderConfigurationField.KEYLESS)) {
    throw new Error("Packaged smoke selected a Task runtime without local keyless Provider support.");
  }
  for (const protocol of [
    ProviderApiCompatibility.OPENAI_COMPLETIONS,
    ProviderApiCompatibility.OPENAI_RESPONSES
  ]) {
    if (support.protocols.includes(protocol)) return protocol;
  }
  throw new Error("Packaged smoke selected a Task runtime without a supported local Provider protocol.");
}

function packagedSmokeProviderEndpoint(raw: string | undefined): string {
  if (raw === undefined) throw new Error("Packaged smoke local Provider origin is unavailable.");
  const origin = new URL(raw);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.port === ""
    || origin.origin !== raw || origin.username !== "" || origin.password !== "") {
    throw new Error("Packaged smoke local Provider origin is invalid.");
  }
  return `${origin.origin}/v1`;
}

function operationFailure(stage: string, operation: Operation | undefined, expectedResult: string): Error {
  const failure = operation?.error;
  const result = operation?.result?.payload.case || "none";
  return new Error(
    `${stage} did not return a successful ${expectedResult} result `
    + `(state=${String(operation?.state ?? "missing")}, result=${result}, `
    + `code=${safeOperationDetail(failure?.code)}, phase=${safeOperationDetail(failure?.phase)}, `
    + `message=${safeOperationDetail(failure?.message)}).`
  );
}

function safeOperationDetail(value: string | undefined): string {
  const normalized = (value ?? "none").replace(/[\r\n\t]+/gu, " ").trim();
  return (normalized || "none").slice(0, 200);
}

function selectTaskTarget(snapshot: Snapshot): { readonly backend: BackendDescriptor; readonly target: Target } {
  const backends = new Map(snapshot.backends.map((backend) => [backend.backendId, backend]));
  const candidates = snapshot.targets.flatMap((target) => {
    const backend = backends.get(target.backendId);
    if (backend === undefined
      || target.state !== TargetState.ACTIVE
      || target.remoteWorkspace !== undefined
      || target.version?.revision?.value === undefined
      || target.version.revision.value < 1n
      || (backend.health !== BackendHealth.HEALTHY && backend.health !== BackendHealth.DEGRADED)
      || (backend.installationState !== InstallationState.INSTALLED
        && backend.installationState !== InstallationState.UPDATE_AVAILABLE)
      || !supports(backend, MANAGED_RUNTIME_CAPABILITY)
      || !supports(backend, SESSION_RUNTIME_CAPABILITY)) return [];
    return [{ backend, target }];
  }).sort((left, right) =>
    Number(left.backend.health !== BackendHealth.HEALTHY) - Number(right.backend.health !== BackendHealth.HEALTHY)
    || left.target.targetId.localeCompare(right.target.targetId, "en"));
  const selected = candidates[0];
  if (selected === undefined) {
    throw new Error("Packaged smoke found no installed local Target with a managed Task runtime.");
  }
  return selected;
}

function supports(backend: BackendDescriptor, capability: string): boolean {
  return backend.capabilities?.capabilities.some((entry) =>
    entry.name === capability && entry.support === CapabilitySupport.SUPPORTED) === true;
}

function assertTaskInSnapshot(snapshot: Snapshot, task: PackagedSmokeTask): void {
  const session = snapshot.sessions.find((candidate) => candidate.sessionId === task.sessionId);
  if (session === undefined
    || session.backendId !== task.backendId
    || session.targetId !== task.targetId
    || session.displayName !== task.displayName
    || session.nativeBinding?.runtimeGeneration !== task.generation) {
    throw new Error("Packaged smoke durable Task is absent or inconsistent.");
  }
}

function createPackagedSmokeTransport(origin: string, authKey: string | undefined, timeoutMs: number): Transport {
  const interceptors: Interceptor[] = [];
  if (authKey !== undefined) interceptors.push((next) => (request) => {
    request.header.set("authorization", `Bearer ${authKey}`);
    return next(request);
  });
  return createConnectTransport({
    baseUrl: origin,
    httpVersion: "1.1",
    useBinaryFormat: true,
    interceptors,
    defaultTimeoutMs: timeoutMs
  });
}
