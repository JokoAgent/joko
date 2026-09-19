import { create, toBinary } from "@bufbuild/protobuf";
import {
  ArtifactKind, ArtifactSchema, BackendDescriptorSchema, BackendModelAccessSettingsSchema, BackendSettingsSchema,
  CapabilityManifestSchema, CapabilitySchema, CapabilitySupport, ConnectionSchema, ConnectionState, DeviceKind, DevicePresenceState, DeviceSchema, EntityKind, EntityVersionSchema,
  FileKind, FilePreviewSchema, FileRevisionSchema, TargetSchema, WorkspaceEntrySchema, WorkspaceFileChangeKind, WorkspaceFileChangeSchema,
  JOKO_API_VERSION, NativeSessionBindingSchema, OperationSchema,
  InteractionKind, InteractionSchema, InteractionState, PermissionDecisionKind, PermissionRisk, PlanReviewDecisionKind,
  EventCursorSchema, EventSchema, MessageRole, ModelDescriptorSchema, ModelKeySchema, ModelOutputModality, ModelSelectionSchema,
  OperationMutationSchema, OperationState, OwnerSnapshotScopeSchema, PermissionMode,
  ProviderDescriptorSchema, ProviderKind, RevisionSchema, SessionMessageSearchMatchSchema, SessionSnapshotScopeSchema,
  SettingsSnapshotSchema, SnapshotScopeSchema,
  QueueControlSchema, QueueDeliveryMode, QueueDispatchState, QueueItemSchema, QueueItemState, QueueSourceKind,
  SessionMessageSearchSessionStatus, SessionSchema, SessionState, SnapshotSchema, TargetState, WorkspaceKind, capabilityNames
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileClient, type MobileStorage, type PendingOperation } from "./mobile-client";
import { MobileCredentialStorageError, profileFromCredential } from "./connection-storage";
import type { MobileDiscovery } from "./connection-discovery";
import { normalizeNodeOrigin, parseNodeIdentity, type MobileNetwork, type NodeIdentity, type PairedCredential } from "./network";
import type { Event, Operation, SessionMessageSearchMatch, Snapshot, WorkspaceEntry, WorkspaceFileChange } from "@joko/contracts";
import type { MobileInteractionDraftIdentity } from "./interaction-draft-store";
import { timelineRows } from "./timeline";

const credential: PairedCredential = {
  profileId: "mobile-profile", origin: "http://192.168.1.20:4318", serverId: "node-1", connectionId: "mobile-connection",
  deviceId: "mobile-device", displayName: "Phone", authKey: "private-key"
};
const node: NodeIdentity = {
  serverId: "node-1", displayName: "Joko", version: "1.0.0", apiVersion: JOKO_API_VERSION, health: 1, pairingEnabled: true
};
const connection = create(ConnectionSchema, {
  connectionId: credential.connectionId, connectionProfileId: credential.profileId, deviceId: credential.deviceId,
  state: ConnectionState.CONNECTED, version: { revision: { value: 4n } }
});
const device = create(DeviceSchema, {
  deviceId: credential.deviceId, displayName: "Phone", kind: DeviceKind.MOBILE, platform: "android",
  connectionIds: [credential.connectionId], presence: DevicePresenceState.ONLINE, version: { revision: { value: 5n } }
});
const otherCredential: PairedCredential = {
  ...credential,
  profileId: "mobile-profile-two",
  connectionId: "mobile-connection-two",
  deviceId: "mobile-device-two",
  displayName: "Tablet",
  authKey: "private-key-two"
};
const otherConnection = create(ConnectionSchema, {
  connectionId: otherCredential.connectionId, connectionProfileId: otherCredential.profileId,
  deviceId: otherCredential.deviceId, displayName: otherCredential.displayName,
  state: ConnectionState.CONNECTED, version: { revision: { value: 6n } }
});
const otherDevice = create(DeviceSchema, {
  deviceId: otherCredential.deviceId, displayName: otherCredential.displayName, kind: DeviceKind.MOBILE,
  platform: "ios", connectionIds: [otherCredential.connectionId], presence: DevicePresenceState.OFFLINE,
  version: { revision: { value: 7n } }
});
const snapshot = create(SnapshotSchema, {
  generation: 1n, resumeCursor: { opaqueToken: "cursor-10", sequence: 10n, generation: 1n },
  server: { serverId: node.serverId, displayName: node.displayName, version: node.version, apiVersion: node.apiVersion,
    health: node.health, pairingEnabled: node.pairingEnabled },
  connections: [connection], devices: [device],
  backends: [{ backendId: "backend", displayName: "Backend", capabilities: {
    capabilities: [{ name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }]
  } }],
  targets: [{ targetId: "target", backendId: "backend", displayName: "Project", state: TargetState.ACTIVE,
    version: { revision: { value: 3n } } }],
  workspaces: [{ workspaceId: "workspace", targetId: "target", displayName: "Project", kind: WorkspaceKind.USER_PROJECT }],
  sessions: [{ sessionId: "session", backendId: "backend", targetId: "target", displayName: "Task", state: SessionState.IDLE,
    nativeBinding: { runtimeGeneration: 8n }, version: { revision: { value: 9n } } }]
});
const extendedSnapshot = create(SnapshotSchema, {
  ...snapshot,
  connections: [connection, otherConnection],
  devices: [device, otherDevice]
});
const filesSnapshot = create(SnapshotSchema, {
  ...snapshot,
  snapshotId: "files-snapshot",
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    capabilities: create(CapabilityManifestSchema, { capabilities: [
      create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.workspaceFiles, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.workspaceFilesWatch, support: CapabilitySupport.SUPPORTED })
    ] })
  })],
  targets: [create(TargetSchema, { ...snapshot.targets[0]!, workspaceId: "workspace" })]
});
const messageEvent = create(EventSchema, {
  eventId: "event-completed",
  identity: { sessionId: "session" },
  cursor: { opaqueToken: "cursor-11", sequence: 11n, generation: 1n },
  payload: { kind: { case: "messageCompleted", value: {
    messageId: "message-1",
    role: MessageRole.ASSISTANT,
    blocks: [{ content: { case: "text", value: "Durable answer" } }]
  } } }
});
const messageActionSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    capabilities: create(CapabilityManifestSchema, { capabilities: [
      create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.sessionMessageDelete, support: CapabilitySupport.SUPPORTED })
    ] })
  })],
  timeline: [messageEvent]
});
const queueOne = create(QueueItemSchema, {
  queueItemId: "queue-1", backendId: "backend", targetId: "target", sessionId: "session",
  sourceKind: QueueSourceKind.UI, deliveryMode: QueueDeliveryMode.FOLLOW_UP,
  state: QueueItemState.ACCEPTED, ordinal: 10n, editLocked: false,
  version: { revision: { value: 11n, etag: "queue-1-r11" }, generation: 1n },
  input: { parts: [
    { content: { case: "text", value: "First queued input" } },
    { content: { case: "sessionMention", value: { sessionId: "related", displayText: "Related task" } } }
  ] }
});
const queueTwo = create(QueueItemSchema, {
  queueItemId: "queue-2", backendId: "backend", targetId: "target", sessionId: "session",
  sourceKind: QueueSourceKind.UI, deliveryMode: QueueDeliveryMode.PROMPT,
  state: QueueItemState.ACCEPTED, ordinal: 20n, editLocked: false,
  version: { revision: { value: 12n, etag: "queue-2-r12" }, generation: 1n },
  input: { parts: [{ content: { case: "text", value: "Second queued input" } }] }
});
const queueControl = create(QueueControlSchema, {
  sessionId: "session", backendId: "backend", targetId: "target",
  dispatchState: QueueDispatchState.PAUSED, queuedItemCount: 2n, interactionLocked: false,
  version: { revision: { value: 21n, etag: "queue-control-r21" }, generation: 1n }
});
const queueSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    capabilities: create(CapabilityManifestSchema, { capabilities: [
      create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.queueCancel, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.queueEdit, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.queueReorder, support: CapabilitySupport.SUPPORTED })
    ] })
  })],
  queueItems: [queueTwo, queueOne],
  queueControls: [queueControl]
});
const permissionInteraction = create(InteractionSchema, {
  interactionId: "interaction-permission",
  kind: InteractionKind.PERMISSION,
  state: InteractionState.PENDING,
  backendId: "backend",
  targetId: "target",
  sessionId: "session",
  generation: 8n,
  createdAt: { seconds: 20n },
  request: { case: "permission", value: {
    risk: PermissionRisk.HIGH,
    title: "Run command",
    allowedDecisions: [PermissionDecisionKind.ALLOW_ONCE, PermissionDecisionKind.DENY_ONCE]
  } },
  version: { revision: { value: 44n, etag: "interaction-r44" }, generation: 8n }
});
const questionInteraction = create(InteractionSchema, {
  interactionId: "interaction-question",
  kind: InteractionKind.QUESTION,
  state: InteractionState.PENDING,
  backendId: "backend",
  targetId: "target",
  sessionId: "session",
  generation: 8n,
  createdAt: { seconds: 10n },
  request: { case: "question", value: {
    title: "Choose",
    fields: [{ fieldId: "answer", label: "Answer", required: true, input: { case: "text", value: {} } }]
  } },
  version: { revision: { value: 45n, etag: "interaction-r45" }, generation: 8n }
});
const planInteraction = create(InteractionSchema, {
  interactionId: "interaction-plan",
  kind: InteractionKind.PLAN_REVIEW,
  state: InteractionState.PENDING,
  backendId: "backend",
  targetId: "target",
  sessionId: "session",
  generation: 8n,
  createdAt: { seconds: 30n },
  request: { case: "planReview", value: {
    title: "Plan",
    markdown: "# Plan",
    steps: [{ stepId: "step-one", title: "First" }],
    allowedDecisions: [PlanReviewDecisionKind.EXECUTE]
  } },
  version: { revision: { value: 46n, etag: "interaction-r46" }, generation: 8n }
});
const interactionSnapshot = create(SnapshotSchema, {
  ...snapshot,
  interactions: [questionInteraction, permissionInteraction, planInteraction]
});
const runtimeSession = create(SessionSchema, {
  ...snapshot.sessions[0]!,
  model: create(ModelSelectionSchema, {
    model: create(ModelKeySchema, { providerId: "alpha", modelId: "a" }), effortId: "low", fastMode: false
  }),
  permissionMode: PermissionMode.ASK,
  planMode: false,
  version: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 9n, etag: "session-r9" }), generation: 8n })
});
const runtimeBackend = create(BackendDescriptorSchema, {
  ...snapshot.backends[0]!,
  entityVersion: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 3n }), generation: 2n }),
  capabilities: create(CapabilityManifestSchema, {
    schemaVersion: "1",
    revision: create(RevisionSchema, { value: 4n }),
    capabilities: [
      create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.modelList, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "model", value: { providerAware: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.modelSwitch, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "model", value: { providerAware: true, switchDuringSession: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.modelEffort, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "model", value: { providerAware: true, switchDuringSession: true, supportsEffort: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.modelFastMode, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "model", value: { providerAware: true, switchDuringSession: true, supportsFastMode: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.permissionModes, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "permission", value: {
          modes: [PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS],
          mutableDuringSession: true
        } } } }),
      create(CapabilitySchema, { name: capabilityNames.permissionChange, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "permission", value: { mutableDuringSession: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.planMode, support: CapabilitySupport.SUPPORTED })
    ]
  })
});
const runtimeModels = [
  create(ModelDescriptorSchema, {
    backendId: "backend", key: { providerId: "alpha", modelId: "a" }, displayName: "Alpha",
    family: "alpha", contextWindowTokens: 64_000n, maximumOutputTokens: 8_000n,
    outputModalities: [ModelOutputModality.TEXT], available: true,
    effortLevels: [{ effortId: "low", displayName: "Low", order: 0, defaultLevel: true },
      { effortId: "high", displayName: "High", order: 1 }]
  }),
  create(ModelDescriptorSchema, {
    backendId: "backend", key: { providerId: "beta", modelId: "b" }, displayName: "Beta",
    family: "beta", contextWindowTokens: 128_000n, maximumOutputTokens: 16_000n,
    outputModalities: [ModelOutputModality.TEXT], available: true, supportsFastMode: true,
    effortLevels: [{ effortId: "medium", displayName: "Medium", order: 0, defaultLevel: true },
      { effortId: "high", displayName: "High", order: 1 }]
  })
];
const runtimeProviders = [
  create(ProviderDescriptorSchema, { backendId: "backend", providerId: "alpha", displayName: "Alpha Provider", kind: ProviderKind.SUBSCRIPTION }),
  create(ProviderDescriptorSchema, { backendId: "backend", providerId: "beta", displayName: "Beta Provider", kind: ProviderKind.SUBSCRIPTION })
];

function runtimeControlProjection(currentSession = runtimeSession, detail = false): Snapshot {
  return create(SnapshotSchema, {
    ...snapshot,
    snapshotId: detail ? "runtime-detail" : "runtime-owner",
    scope: create(SnapshotScopeSchema, { kind: detail
      ? { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId: "session", recentTimelineItems: 120 }) }
      : { case: "owner", value: create(OwnerSnapshotScopeSchema, {}) } }),
    revision: create(RevisionSchema, { value: detail ? 31n : 30n, etag: detail ? "detail-r31" : "owner-r30" }),
    sessions: [currentSession],
    backends: [runtimeBackend],
    ...(detail ? {
      connections: [], devices: [], models: [], providers: [], settings: undefined
    } : {
      models: runtimeModels,
      providers: runtimeProviders,
      settings: create(SettingsSnapshotSchema, {
        revision: create(RevisionSchema, { value: 6n }),
        backends: [create(BackendSettingsSchema, {
          backendId: "backend", enabled: true, modelAccess: create(BackendModelAccessSettingsSchema, {})
        })]
      })
    })
  });
}

function memoryStorage(saved?: PairedCredential | readonly PairedCredential[], automatic: boolean | string = saved !== undefined) {
  const initial = saved === undefined ? [] : Array.isArray(saved) ? [...saved] : [saved];
  let profiles = initial.map(profileFromCredential);
  const keys = new Map(initial.map((item) => [item.profileId, item]));
  let automaticProfileId = typeof automatic === "string" ? automatic : automatic ? initial[0]?.profileId : undefined;
  let pending: PendingOperation[] = [];
  const selections = new Map(initial.map((item) => [item.profileId, "session"]));
  const storage: MobileStorage = {
    loadConnectionIndex: vi.fn(async () => ({ profiles: [...profiles], ...(automaticProfileId ? { automaticProfileId } : {}) })),
    loadCredential: vi.fn(async (profileId) => keys.get(profileId)),
    saveConnection: vi.fn(async (value) => {
      keys.set(value.profileId, value);
      const profile = profileFromCredential(value);
      profiles = [...profiles.filter((item) => item.profileId !== profile.profileId && item.connectionId !== profile.connectionId), profile];
    }),
    deleteCredential: vi.fn(async (profileId) => {
      keys.delete(profileId);
      if (automaticProfileId === profileId) automaticProfileId = undefined;
    }),
    deleteConnection: vi.fn(async (profileId) => {
      keys.delete(profileId);
      profiles = profiles.filter((item) => item.profileId !== profileId);
      if (automaticProfileId === profileId) automaticProfileId = undefined;
    }),
    saveAutomaticProfile: vi.fn(async (profileId) => { automaticProfileId = profileId; }),
    loadPending: vi.fn(async () => pending), savePending: vi.fn(async (items) => { pending = [...items]; }),
    loadSelection: vi.fn(async (profileId) => selections.get(profileId)),
    saveSelection: vi.fn(async (profileId, id) => {
      if (id === undefined) selections.delete(profileId); else selections.set(profileId, id);
    })
  };
  return {
    storage,
    key: (profileId = credential.profileId) => keys.get(profileId),
    automatic: () => automaticProfileId !== undefined,
    automaticProfile: () => automaticProfileId,
    profiles: () => profiles,
    pending: () => pending
  };
}

function fakeNetwork(): MobileNetwork {
  return {
    inspect: vi.fn(async () => node),
    discover: vi.fn(async () => []),
    requestPairing: vi.fn(async () => ({ challengeId: "challenge", identity: node })),
    completePairing: vi.fn(async () => ({ credential, identity: node })),
    readOwner: vi.fn(async () => ({ connection, device, snapshot })),
    readSession: vi.fn(async () => snapshot),
    readHistory: vi.fn(async () => ({ events: [], before: undefined })),
    readAround: vi.fn(async () => []),
    searchSessionMessages: vi.fn(async () => []),
    streamOwner: vi.fn(async function* (_credential, _after, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    listWorkspaceDirectory: vi.fn(async () => ({ entries: [], revision: "directory-1" })),
    listWorkspaceFileIndex: vi.fn(async () => ({ paths: [], revision: "index-1", truncated: false })),
    searchWorkspace: vi.fn(async () => ({ matches: [], revision: "search-1", truncated: false, totalFiles: 0 })),
    watchWorkspace: vi.fn(async function* (_credential, _workspaceId, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    readWorkspaceFile: vi.fn(async () => { throw new Error("No Workspace file fixture was configured."); }),
    listSessionArtifacts: vi.fn(async () => ({ artifacts: [], revision: "artifacts-1" })),
    downloadBlob: vi.fn(async () => { throw new Error("No Blob fixture was configured."); }),
    prepareTarget: vi.fn(async () => undefined),
    submit: vi.fn(async (_credential, operationId, mutation) => {
      toBinary(OperationMutationSchema, mutation);
      return create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED
      });
    }),
    waitOperation: vi.fn(async (_credential, operationId) => create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED
    })),
    getOperation: vi.fn(async () => undefined)
  };
}

function projectedNetwork(projected: Snapshot): MobileNetwork {
  const network = fakeNetwork();
  network.readOwner = vi.fn(async () => ({ connection, device, snapshot: projected }));
  network.readSession = vi.fn(async () => projected);
  return network;
}

function event(id: string, sequence: bigint, sessionId = "session"): Event {
  return create(EventSchema, { eventId: id, identity: { sessionId },
    cursor: { opaqueToken: `cursor-${sequence}`, sequence, generation: 1n },
    payload: { kind: { case: "statusStream", value: { label: id } } } });
}

function eventFeed(network: MobileNetwork) {
  const queued: Event[] = [];
  let wake: (() => void) | undefined;
  network.streamOwner = vi.fn(async function* (_credential, _after, signal) {
    while (!signal.aborted) {
      if (!queued.length) await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener("abort", resolve, { once: true });
      });
      if (signal.aborted) return;
      const next = queued.shift();
      if (next) yield next;
    }
  });
  return (item: Event) => { queued.push(item); wake?.(); wake = undefined; };
}

const clients: MobileClient[] = [];
function client(
  network: MobileNetwork,
  storage: MobileStorage,
  discovery?: MobileDiscovery,
  now: () => number = () => 2_000,
  newId: () => string = () => "operation-1",
  clearInteractionDraft?: (identity: MobileInteractionDraftIdentity) => Promise<void>
) {
  const instance = new MobileClient(network, storage, discovery ?? { scan: vi.fn(async () => []) }, newId, "android", now, clearInteractionDraft);
  clients.push(instance);
  return instance;
}
afterEach(() => { for (const item of clients.splice(0)) item.dispose(); });

describe("native mobile connection and operation ownership", () => {
  it("accepts only the exact current Joko API identity before any authenticated work", () => {
    expect(parseNodeIdentity(node)).toEqual(node);
    expect(() => parseNodeIdentity({ ...node, apiVersion: "joko.v2" })).toThrow(/supports API joko\.v1/);
    expect(() => parseNodeIdentity({ ...node, apiVersion: "" })).toThrow(/valid Joko node identity/);
  });

  it("rejects public cleartext origins and never places credentials in an origin", () => {
    expect(normalizeNodeOrigin("http://192.168.1.20:4318/")).toBe("http://192.168.1.20:4318");
    expect(normalizeNodeOrigin("http://joko-node:4318/")).toBe("http://joko-node:4318");
    expect(normalizeNodeOrigin("http://joko-node.home.arpa:4318/")).toBe("http://joko-node.home.arpa:4318");
    expect(normalizeNodeOrigin("http://[fd12:3456:789a::20]:4318/")).toBe("http://[fd12:3456:789a::20]:4318");
    expect(() => normalizeNodeOrigin("http://example.com")).toThrow(/private-network/);
    expect(() => normalizeNodeOrigin("http://169.254.169.254:4318")).toThrow(/private-network/);
    expect(() => normalizeNodeOrigin("https://user:secret@example.com")).toThrow(/without credentials/);
    expect(() => normalizeNodeOrigin("https://example.com/path")).toThrow(/only the Joko node origin/);
  });

  it("probes identity anonymously before a credentialed read and preserves a drifted saved profile", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    expect(network.inspect).toHaveBeenCalledBefore(saved.storage.loadCredential as ReturnType<typeof vi.fn>);
    expect(network.inspect).toHaveBeenCalledBefore(network.readOwner as ReturnType<typeof vi.fn>);
    expect(app.state.status).toBe("connected");
    vi.mocked(network.inspect).mockResolvedValueOnce({ ...node, serverId: "other-node" });
    await app.refresh();
    expect(app.state.status).toBe("unpaired");
    expect(saved.key()).toEqual(credential);
    expect(saved.automaticProfile()).toBe(credential.profileId);
    expect(app.state.saved[0]).toMatchObject({ profileId: credential.profileId, credentialState: "identity-conflict" });
    expect(app.state.owner).toBeUndefined();
  });

  it("keeps the exact credential when an authenticated projection cannot prove its saved identity", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.readOwner).mockResolvedValueOnce({
      connection: create(ConnectionSchema, { ...connection, connectionProfileId: "different-profile" }),
      device,
      snapshot
    });

    await app.refresh();

    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved[0]).toMatchObject({
      profileId: credential.profileId,
      credentialState: "identity-conflict"
    });
    expect(saved.key()).toEqual(credential);
    expect(saved.automaticProfile()).toBe(credential.profileId);
    expect(saved.storage.deleteCredential).not.toHaveBeenCalled();
  });

  it("suspends a credential when the authenticated snapshot does not prove the inspected current API", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    vi.mocked(network.readOwner).mockResolvedValueOnce({
      connection,
      device,
      snapshot: create(SnapshotSchema, {
        ...snapshot,
        server: { ...snapshot.server!, apiVersion: "joko.v2" }
      })
    });
    const app = client(network, saved.storage);

    await app.start();

    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved[0]).toMatchObject({ credentialState: "identity-conflict" });
    expect(saved.key()).toEqual(credential);
    expect(saved.storage.deleteCredential).not.toHaveBeenCalled();
  });

  it("invalidates only the exact credential and automatic target after authoritative revocation", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    await saved.storage.savePending([{
      operationId: "unknown-before-revocation",
      connectionId: credential.connectionId,
      kind: "logout",
      targetConnectionId: credential.connectionId,
      state: "unknown"
    }]);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.readOwner).mockResolvedValueOnce({
      connection: create(ConnectionSchema, { ...connection, state: ConnectionState.DISCONNECTED }),
      device,
      snapshot
    });

    await app.refresh();

    expect(app.state.status).toBe("revoked");
    expect(saved.key()).toBeUndefined();
    expect(saved.key(otherCredential.profileId)).toEqual(otherCredential);
    expect(saved.automaticProfile()).toBeUndefined();
    expect(saved.storage.deleteCredential).toHaveBeenCalledWith(credential.profileId);
    expect(app.state.saved.find((profile) => profile.profileId === credential.profileId)?.pendingOperations)
      .toMatchObject([{ operationId: "unknown-before-revocation", state: "unknown" }]);
  });

  it("keeps a saved mobile node on the connection surface until the user opts into this launch", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential, false);
    const app = client(network, saved.storage);
    await app.start();
    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved[0]).toMatchObject({
      connectionId: credential.connectionId,
      origin: credential.origin,
      automatic: false
    });
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();

    app.setForeground(false);
    app.setForeground(true);
    await Promise.resolve();
    expect(app.state.status).toBe("unpaired");
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();

    await app.connectSaved(credential.profileId, true);
    expect(app.state.status).toBe("connected");
    expect(app.state.saved[0]?.automatic).toBe(true);
    expect(saved.automatic()).toBe(true);
    expect(network.inspect).toHaveBeenCalledBefore(network.readOwner as ReturnType<typeof vi.fn>);

    await app.disableAutomaticEntry();
    expect(app.state.status).toBe("connected");
    expect(app.state.saved[0]?.automatic).toBe(false);
    expect(saved.automatic()).toBe(false);
  });

  it("restores only the exact automatic profile even when two credentials share an origin and server", async () => {
    const network = fakeNetwork();
    vi.mocked(network.readOwner).mockImplementation(async (value) => value.profileId === otherCredential.profileId
      ? { connection: otherConnection, device: otherDevice, snapshot: extendedSnapshot }
      : { connection, device, snapshot: extendedSnapshot });
    const saved = memoryStorage([credential, otherCredential], otherCredential.profileId);
    const app = client(network, saved.storage);

    await app.start();

    expect(app.state.status).toBe("connected");
    expect(app.state.activeProfileId).toBe(otherCredential.profileId);
    expect(app.state.automaticProfileId).toBe(otherCredential.profileId);
    expect(saved.storage.loadCredential).toHaveBeenCalledWith(otherCredential.profileId);
    expect(saved.storage.loadCredential).not.toHaveBeenCalledWith(credential.profileId);
    expect(network.readOwner).toHaveBeenCalledWith(otherCredential, expect.any(AbortSignal));
  });

  it("keeps the active mobile home authority while a candidate is inspected or a saved switch fails", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    const app = client(network, saved.storage);
    await app.start();
    const activeStreamSignal = vi.mocked(network.streamOwner).mock.calls[0]?.[2];

    vi.mocked(network.inspect).mockResolvedValueOnce({ ...node, displayName: "Candidate Joko" });
    await app.inspect(otherCredential.origin);
    expect(app.state).toMatchObject({
      status: "connected",
      activeProfileId: credential.profileId,
      node: { displayName: node.displayName },
      candidate: { node: { displayName: "Candidate Joko" } }
    });
    app.cancel();
    expect(app.state.candidate).toBeUndefined();
    expect(app.state.activeProfileId).toBe(credential.profileId);
    expect(activeStreamSignal?.aborted).toBe(false);

    vi.mocked(network.readOwner).mockRejectedValueOnce(new Error("candidate unavailable"));
    await expect(app.connectSaved(otherCredential.profileId, false)).rejects.toThrow(/candidate unavailable/);
    expect(app.state).toMatchObject({
      status: "connected",
      activeProfileId: credential.profileId,
      node: { serverId: node.serverId },
      owner: { generation: snapshot.generation },
      connectionAttemptError: "candidate unavailable"
    });
    expect(app.state.saved.find((item) => item.profileId === otherCredential.profileId)).toMatchObject({
      credentialState: "offline"
    });
    expect(activeStreamSignal?.aborted).toBe(false);
  });

  it("adopts a different saved node only after its identity, credential, and snapshot all succeed", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    const app = client(network, saved.storage);
    await app.start();
    let resolveCandidate!: (value: { connection: typeof otherConnection; device: typeof otherDevice; snapshot: typeof extendedSnapshot }) => void;
    vi.mocked(network.readOwner).mockImplementationOnce(() => new Promise((resolve) => { resolveCandidate = resolve; }));

    const switching = app.connectSaved(otherCredential.profileId, false);
    await vi.waitFor(() => expect(network.readOwner).toHaveBeenCalledWith(otherCredential, expect.any(AbortSignal)));
    expect(app.state).toMatchObject({
      status: "connected",
      activeProfileId: credential.profileId,
      owner: { generation: snapshot.generation }
    });

    resolveCandidate({ connection: otherConnection, device: otherDevice, snapshot: extendedSnapshot });
    await switching;
    expect(app.state).toMatchObject({
      status: "connected",
      activeProfileId: otherCredential.profileId,
      owner: { generation: extendedSnapshot.generation }
    });
    expect(app.state.candidate).toBeUndefined();
  });

  it("retires a late saved-catalog result before it can read a credential or overwrite an adopted connection", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential, false);
    const app = client(network, saved.storage);
    await app.start();
    let resolveCatalog!: (value: NodeIdentity) => void;
    vi.mocked(network.inspect).mockImplementationOnce(() => new Promise((resolve) => { resolveCatalog = resolve; }));

    const catalog = app.refreshSaved();
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledOnce());
    await app.connectSaved(credential.profileId, false);
    resolveCatalog(node);
    await catalog;

    expect(saved.storage.loadCredential).toHaveBeenCalledTimes(1);
    expect(app.state).toMatchObject({ status: "connected", activeProfileId: credential.profileId });
    expect(app.state.saved[0]).toMatchObject({ credentialState: "available" });
  });

  it("keeps the in-memory mobile home projection during a transient reconnect failure", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.inspect).mockRejectedValueOnce(new Error("Wi-Fi changed"));

    await app.refresh();

    expect(app.state.status).toBe("offline");
    expect(app.state.owner).toEqual(snapshot);
    expect(app.state.detail).toEqual(snapshot);
    expect(app.state.error).toContain("Wi-Fi changed");
  });

  it("keeps an exact automatic target suspended when protected storage cannot be read", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    vi.mocked(saved.storage.loadCredential).mockRejectedValueOnce(new MobileCredentialStorageError(
      "unavailable",
      "Protected credential storage is unavailable."
    ));
    const app = client(network, saved.storage);

    await app.start();

    expect(network.inspect).toHaveBeenCalledOnce();
    expect(network.readOwner).not.toHaveBeenCalled();
    expect(saved.storage.deleteCredential).not.toHaveBeenCalled();
    expect(saved.automaticProfile()).toBe(credential.profileId);
    expect(app.state).toMatchObject({ status: "unpaired", automaticProfileId: credential.profileId });
    expect(app.state.saved[0]).toMatchObject({ credentialState: "unavailable", automatic: true });
  });

  it("keeps the last nearby list when a refresh fails and revalidates public identity before display", async () => {
    const network = fakeNetwork();
    const nearby = {
      serverId: node.serverId,
      displayName: "Untrusted announcement label",
      origin: credential.origin,
      version: "announcement-version",
      apiVersion: node.apiVersion,
      pairingEnabled: false,
      lastSeen: 1_000
    };
    const discovery: MobileDiscovery = { scan: vi.fn().mockResolvedValueOnce([nearby]).mockRejectedValueOnce(new Error("Wi-Fi discovery failed")) };
    const app = client(network, memoryStorage().storage, discovery);
    await app.start();

    await app.refreshNearby();
    expect(app.state.discoveryState).toBe("ready");
    expect(app.state.nearby).toEqual([expect.objectContaining({
      serverId: node.serverId,
      displayName: node.displayName,
      version: node.version,
      pairingEnabled: node.pairingEnabled
    })]);
    expect(network.inspect).toHaveBeenCalledWith(credential.origin, expect.any(AbortSignal));

    await app.refreshNearby();
    expect(app.state.discoveryState).toBe("error");
    expect(app.state.nearby).toHaveLength(1);
    expect(app.state.discoveryError).toContain("Wi-Fi discovery failed");
  });

  it("fails closed when a recently displayed server identity moves to another origin", async () => {
    const network = fakeNetwork();
    const first = {
      serverId: node.serverId,
      displayName: node.displayName,
      origin: credential.origin,
      version: node.version,
      apiVersion: node.apiVersion,
      pairingEnabled: true,
      lastSeen: 1_000
    };
    const moved = { ...first, origin: "http://192.168.1.21:4318", lastSeen: 1_500 };
    const discovery: MobileDiscovery = { scan: vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([moved]) };
    const app = client(network, memoryStorage().storage, discovery);
    await app.start();
    await app.refreshNearby();
    expect(app.state.nearby).toHaveLength(1);

    await app.refreshNearby();

    expect(app.state.discoveryState).toBe("ready");
    expect(app.state.nearby).toEqual([]);
  });

  it("forgets only the requested local profile without guessing by origin", async () => {
    const saved = memoryStorage([credential, otherCredential], false);
    const app = client(fakeNetwork(), saved.storage);
    await app.start();

    await app.forgetConnection(otherCredential.profileId);

    expect(saved.storage.deleteConnection).toHaveBeenCalledWith(otherCredential.profileId);
    expect(saved.key(otherCredential.profileId)).toBeUndefined();
    expect(saved.key(credential.profileId)).toEqual(credential);
    expect(app.state.saved.map((profile) => profile.profileId)).toEqual([credential.profileId]);
  });

  it("keeps a failed exact forget operable and does not report a stopped connection as connected", async () => {
    const saved = memoryStorage(credential);
    vi.mocked(saved.storage.deleteConnection).mockRejectedValueOnce(new MobileCredentialStorageError(
      "unavailable",
      "Protected credential storage is unavailable."
    ));
    const app = client(fakeNetwork(), saved.storage);
    await app.start();

    await expect(app.forgetConnection(credential.profileId)).rejects.toThrow(/unavailable/);

    expect(app.state.status).toBe("unpaired");
    expect(app.state.activeProfileId).toBeUndefined();
    expect(app.state.saved[0]).toMatchObject({
      profileId: credential.profileId,
      automatic: true,
      credentialState: "unavailable"
    });
    expect(saved.key()).toEqual(credential);
    expect(saved.automaticProfile()).toBe(credential.profileId);
  });

  it("clears receipts owned by an exact connection when it is forgotten", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    await app.send("hello");
    expect(saved.pending()).toHaveLength(1);

    await app.forgetConnection(credential.profileId);

    expect(saved.pending()).toEqual([]);
    expect(app.state.pending).toEqual([]);
  });

  it("restarts interrupted storage initialization when a background launch becomes active", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential, false);
    const app = client(network, saved.storage);
    app.setForeground(false);

    await app.start();
    expect(app.state.status).toBe("starting");
    expect(network.inspect).not.toHaveBeenCalled();

    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("unpaired"));
    expect(app.state.saved[0]).toMatchObject({ connectionId: credential.connectionId, automatic: false });
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();
  });

  it("reloads a newly durable pairing after backgrounding before in-memory adoption", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage();
    const app = client(network, saved.storage);
    await app.start();
    await app.inspect(credential.origin);
    await app.requestPairing(credential.origin, "Phone");
    const saveConnection = vi.mocked(saved.storage.saveConnection);
    const persist = saveConnection.getMockImplementation();
    if (!persist) throw new Error("Expected the in-memory connection writer.");
    saveConnection.mockImplementationOnce(async (value) => {
      await persist(value);
      app.setForeground(false);
    });

    await app.pair(credential.origin, "123456", "Phone", false);
    expect(saved.key()).toEqual(credential);
    expect(app.state.activeProfileId).toBeUndefined();

    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.saved).toHaveLength(1));
    expect(app.state.status).toBe("unpaired");
    expect(app.state.activeProfileId).toBeUndefined();
    expect(app.state.saved[0]).toMatchObject({ profileId: credential.profileId, automatic: false });
    expect(network.readOwner).toHaveBeenCalledTimes(1);
  });

  it("does not persist a cancelled pairing or a mismatched device identity", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage();
    const app = client(network, saved.storage);
    await app.start();
    await app.inspect(credential.origin);
    await app.requestPairing(credential.origin, "Phone");
    let resolve!: (result: { credential: PairedCredential; identity: typeof node }) => void;
    vi.mocked(network.completePairing).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = app.pair(credential.origin, "123456", "Phone");
    app.cancel();
    resolve({ credential, identity: node });
    await pending;
    expect(saved.storage.saveConnection).not.toHaveBeenCalled();

    await app.requestPairing(credential.origin, "Phone");
    vi.mocked(network.readOwner).mockResolvedValueOnce({ connection: create(ConnectionSchema, { ...connection, deviceId: "other" }), device, snapshot });
    await expect(app.pair(credential.origin, "123456", "Phone")).rejects.toThrow();
    expect(saved.storage.saveConnection).not.toHaveBeenCalled();
  });

  it("persists a paired credential before applying the shared automatic-entry choice", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage();
    const app = client(network, saved.storage);
    await app.start();
    await app.inspect(credential.origin);
    await app.requestPairing(credential.origin, "Phone");

    await app.pair(credential.origin, "123456", "Phone", false);

    expect(saved.storage.saveConnection).toHaveBeenCalledBefore(saved.storage.saveAutomaticProfile as ReturnType<typeof vi.fn>);
    expect(saved.storage.saveAutomaticProfile).toHaveBeenCalledWith(undefined);
    expect(app.state.status).toBe("connected");
    expect(app.state.saved[0]?.automatic).toBe(false);
  });

  it("keeps an unknown send receipt across restart and never repeats the mutation under another ID", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    expect(await app.send("hello")).toBe(false);
    expect(saved.pending()).toMatchObject([{ operationId: "operation-1", kind: "send", sessionId: "session", state: "unknown" }]);
    expect(network.submit).toHaveBeenCalledOnce();
    await expect(app.send("hello")).rejects.toThrow(/unknown result/);
    await app.refresh();
    expect(network.submit).toHaveBeenCalledOnce();
    expect(saved.pending()).toHaveLength(1);
    app.dispose();

    const restored = client(network, saved.storage);
    vi.mocked(network.getOperation).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-1", connectionId: credential.connectionId, state: OperationState.SUCCEEDED
    }));
    await restored.start();
    expect(restored.state.status).toBe("connected");
    expect(saved.pending()).toHaveLength(0);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("requires an authenticated authoritative absence before an explicit unknown receipt is cleared", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    await app.send("hello");
    vi.mocked(network.getOperation).mockRejectedValueOnce(new Error("offline"));
    await expect(app.dismissUnconfirmed("operation-1")).rejects.toThrow("offline");
    expect(saved.pending()).toHaveLength(1);
    await app.dismissUnconfirmed("operation-1");
    expect(saved.pending()).toHaveLength(0);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("logs out one exact server connection with its current revision before local cleanup", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();

    expect(await app.logoutConnection(credential.connectionId)).toBe(true);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { kind: EntityKind.CONNECTION, id: credential.connectionId }, expectedRevision: { value: 4n } }],
      payload: { case: "logoutConnection", value: { connectionId: credential.connectionId } }
    });
    expect(saved.storage.deleteConnection).toHaveBeenCalledWith(credential.profileId);
    expect(saved.key()).toBeUndefined();
    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved).toEqual([]);
  });

  it("preserves the exact credential and unknown receipt when logout acknowledgement is lost", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));

    expect(await app.logoutConnection(credential.connectionId)).toBe(false);

    expect(saved.storage.deleteConnection).not.toHaveBeenCalled();
    expect(saved.key()).toEqual(credential);
    expect(app.state.status).toBe("connected");
    expect(saved.pending()).toMatchObject([{
      kind: "logout",
      targetConnectionId: credential.connectionId,
      state: "unknown"
    }]);
    expect(app.state.saved[0]?.pendingOperations).toMatchObject([{
      kind: "logout",
      targetConnectionId: credential.connectionId,
      state: "unknown"
    }]);
  });

  it("revokes another exact device but requires logout for the current mobile device", async () => {
    const network = fakeNetwork();
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: extendedSnapshot });
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    const app = client(network, saved.storage);
    await app.start();

    await expect(app.revokeDevice(credential.deviceId)).rejects.toThrow(/Log out/);
    expect(await app.revokeDevice(otherCredential.deviceId)).toBe(true);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { kind: EntityKind.DEVICE, id: otherCredential.deviceId }, expectedRevision: { value: 7n } }],
      payload: { case: "revokeDevice", value: { deviceId: otherCredential.deviceId } }
    });
    expect(saved.storage.deleteConnection).toHaveBeenCalledWith(otherCredential.profileId);
    expect(saved.key(otherCredential.profileId)).toBeUndefined();
    expect(saved.key(credential.profileId)).toEqual(credential);
    expect(app.state.status).toBe("connected");
  });

  it("admits only one user mutation while its receipt is being persisted", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    let release!: () => void;
    vi.mocked(saved.storage.savePending).mockImplementationOnce(() => new Promise<void>((done) => { release = done; }));
    const first = app.send("one message");
    await expect(app.send("one message")).rejects.toThrow(/unknown result|already being submitted/);
    expect(network.submit).not.toHaveBeenCalled();
    release();
    expect(await first).toBe(true);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("retains an unsent operation warning when the app backgrounds during receipt persistence", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    let release!: () => void;
    const original = saved.storage.savePending;
    vi.mocked(saved.storage.savePending).mockImplementationOnce(async (items) => {
      await new Promise<void>((done) => { release = done; });
      await original(items);
    });
    const sending = app.send("one message");
    await vi.waitFor(() => expect(saved.storage.savePending).toHaveBeenCalledOnce());
    app.setForeground(false);
    release();
    expect(await sending).toBe(false);
    expect(network.submit).not.toHaveBeenCalled();
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("connected"));
    expect(app.state.pending).toMatchObject([{ operationId: "operation-1", state: "unknown" }]);
    expect(network.getOperation).toHaveBeenCalledWith(credential, "operation-1", expect.any(AbortSignal));
  });

  it("prepares the exact target revision and fences a new task and text input to durable generations", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.create("target", "Work");
    expect(network.prepareTarget).toHaveBeenCalledWith(credential, snapshot.targets[0], expect.any(AbortSignal));
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { id: "target" }, expectedRevision: { value: 3n } }],
      payload: { case: "createSession", value: { backendId: "backend", targetId: "target", displayName: "Work" } }
    });
    expect(await app.send("hello")).toBe(true);
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      preconditions: [{ entity: { id: "session" }, expectedGeneration: 8n }],
      payload: { case: "sendInput", value: { sessionId: "session", input: { parts: [{ content: { case: "text", value: "hello" } }] } } }
    });
  });

  it("retires a late task navigation read in the background and restores the selected task on foreground", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    await app.select(undefined);
    let resolve!: (value: typeof snapshot) => void;
    vi.mocked(network.readSession).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const selecting = app.select("session");
    await vi.waitFor(() => expect(network.readSession).toHaveBeenCalledTimes(2));
    app.setForeground(false);
    resolve(snapshot);
    await selecting;
    expect(app.state.detail).toBeUndefined();
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.detail?.sessions[0]?.sessionId).toBe("session"));
    expect(app.state.status).toBe("connected");
  });

  it("uses authoritative final message blocks over transient text and preserves other activity", () => {
    const events = [
      create(EventSchema, { eventId: "start", cursor: { sequence: 1n }, payload: { kind: { case: "messageStarted", value: {
        messageId: "message", role: MessageRole.ASSISTANT
      } } } }),
      create(EventSchema, { eventId: "delta", cursor: { sequence: 2n }, payload: { kind: { case: "textDelta", value: {
        messageId: "message", delta: "partial"
      } } } }),
      create(EventSchema, { eventId: "done", cursor: { sequence: 3n }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "message", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "final" } }]
      } } } }),
      create(EventSchema, { eventId: "status", cursor: { sequence: 4n }, payload: { kind: { case: "runAborted", value: { runId: "run" } } } })
    ];
    expect(timelineRows([...events, events[2]!])).toMatchObject([
      { id: "message", label: "Assistant", text: "final" },
      { id: "status", label: "Activity", text: "run Aborted" }
    ]);
  });

  it("anchors an exact session event and pages backward without mixing the latest window", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e6", 6n), event("e7", 7n), event("e8", 8n)]);
    await app.around("e7");
    expect(network.readAround).toHaveBeenCalledWith(credential, "session", "e7", expect.any(AbortSignal));
    expect(app.state.window?.map((item) => item.eventId)).toEqual(["e6", "e7", "e8"]);
    vi.mocked(network.readHistory).mockResolvedValueOnce({ events: [event("e4", 4n), event("e5", 5n)],
      before: event("e4", 4n).cursor });
    await app.older();
    expect(network.readHistory).toHaveBeenCalledWith(credential, "session", event("e6", 6n).cursor, expect.any(AbortSignal));
    expect(app.state.window?.map((item) => item.eventId)).toEqual(["e4", "e5", "e6", "e7", "e8"]);
    vi.mocked(network.readHistory).mockResolvedValueOnce({ events: [event("e3", 3n)], before: event("e4", 4n).cursor });
    await expect(app.older()).rejects.toThrow(/cyclic/);
    app.latest();
    expect(app.state.window).toBeUndefined();
  });

  it("retires an in-flight historic page when returning to the latest window", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    let release!: (page: { events: Event[]; before?: Event["cursor"] }) => void;
    vi.mocked(network.readHistory).mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const oldPage = app.older();
    app.latest();
    release({ events: [event("e5", 5n)], before: event("e5", 5n).cursor });
    await oldPage;
    expect(app.state.window).toBeUndefined();
    expect(app.state.older).toHaveLength(0);
  });

  it("rejects another task in an anchor and retires an old page after a background transition", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("foreign", 7n, "another-session")]);
    await expect(app.around("foreign")).rejects.toThrow(/mismatched/);
    let resolve!: (events: Event[]) => void;
    vi.mocked(network.readAround).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const anchor = app.around("e7");
    app.setForeground(false);
    resolve([event("e7", 7n)]);
    await anchor;
    expect(app.state.window).toBeUndefined();
    expect(app.state.liveStatus).toBe("paused");
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("connected"));
    expect(network.inspect).toHaveBeenCalledTimes(3);
  });

  it("merges only contiguous selected-task events and restores authoritative projections across gaps", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    expect(app.state.liveStatus).toBe("verifying");
    emit(event("eleven", 11n));
    await vi.waitFor(() => expect(app.state.live.map((item) => item.eventId)).toEqual(["eleven"]));
    expect(app.state.liveStatus).toBe("streaming");
    emit(event("eleven-duplicate", 11n));
    emit(event("foreign", 12n, "another-session"));
    await vi.waitFor(() => expect(app.state.live).toHaveLength(1));
    emit(event("gap", 14n));
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledTimes(2));
    expect(app.state.live).toHaveLength(0);
    expect(vi.mocked(network.streamOwner).mock.calls[0]?.[1]).toMatchObject({ sequence: 10n, generation: 1n });
  });

  it("replaces transient message deltas with final Snapshot content without replaying the input", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const started = create(EventSchema, { eventId: "start", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-11", sequence: 11n, generation: 1n }, payload: { kind: { case: "messageStarted", value: {
      messageId: "assistant-message", role: MessageRole.ASSISTANT
    } } } });
    const delta = create(EventSchema, { eventId: "delta", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-12", sequence: 12n, generation: 1n }, payload: { kind: { case: "textDelta", value: {
      messageId: "assistant-message", delta: "partial"
    } } } });
    const completed = create(EventSchema, { eventId: "completed", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-13", sequence: 13n, generation: 1n }, payload: { kind: { case: "messageCompleted", value: {
      messageId: "assistant-message", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "final" } }]
    } } } });
    const current = create(SnapshotSchema, { ...snapshot,
      resumeCursor: create(EventCursorSchema, { opaqueToken: "cursor-13", sequence: 13n, generation: 1n }), timeline: [started, delta, completed] });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: current });
    vi.mocked(network.readSession).mockResolvedValue(current);
    emit(started); emit(delta); emit(completed);
    await vi.waitFor(() => expect(app.state.detail?.timeline.map((item) => item.eventId)).toEqual(["start", "delta", "completed"]));
    expect(app.state.live).toHaveLength(0);
    expect(timelineRows([...(app.state.detail?.timeline ?? []), ...app.state.live])).toMatchObject([
      { id: "assistant-message", text: "final", eventId: "completed", completed: true }
    ]);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("releases the previous stream in background and resumes from a fresh generation without retaining history", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    const firstSignal = vi.mocked(network.streamOwner).mock.calls[0]?.[2];
    app.setForeground(false);
    expect(firstSignal?.aborted).toBe(true);
    expect(app.state.window).toBeUndefined();
    expect(app.state.older).toHaveLength(0);
    const restarted = create(SnapshotSchema, { ...snapshot, generation: 2n,
      resumeCursor: create(EventCursorSchema, { opaqueToken: "generation-2", sequence: 1n, generation: 2n }), timeline: [] });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: restarted });
    vi.mocked(network.readSession).mockResolvedValue(restarted);
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.owner?.generation).toBe(2n));
    expect(app.state.window).toBeUndefined();
    expect(app.state.live).toHaveLength(0);
    expect(vi.mocked(network.streamOwner).mock.calls[1]?.[1]).toMatchObject({ generation: 2n, sequence: 1n });
    emit(event("old", 11n));
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledTimes(3));
    expect(app.state.live).toHaveLength(0);
  });

  it("drops a historic window when a contiguous event changes its visible history", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    emit(create(EventSchema, { eventId: "deleted", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-11", sequence: 11n, generation: 1n }, payload: { kind: { case: "messageDeleted", value: {
      productSessionId: "session", requestedEventId: "e7", deletedEventIds: ["e7"]
    } } } }));
    await vi.waitFor(() => expect(app.state.window).toBeUndefined());
    expect(app.state.older).toHaveLength(0);
  });

  it("exposes a degraded polling state when the native stream fails without treating it as live", async () => {
    const network = fakeNetwork();
    network.streamOwner = vi.fn(async function* () { throw new Error("stream transport unavailable"); });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await vi.waitFor(() => expect(app.state.liveStatus).toBe("polling"));
    expect(app.state.status).toBe("connected");
    expect(app.state.live).toHaveLength(0);
  });
});

describe("mobile Home search and task mutations", () => {
  it("retires late message-search results when query or owner changes", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    let resolveOld!: (value: readonly SessionMessageSearchMatch[]) => void;
    vi.mocked(network.searchSessionMessages)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce([create(SessionMessageSearchMatchSchema, { sessionId: "session", eventId: "event-new" })]);

    const oldSearch = app.searchHome("old words", "active");
    await vi.waitFor(() => expect(app.state.homeSearchStatus).toBe("searching"));
    await app.searchHome("new words", "all");
    expect(network.searchSessionMessages).toHaveBeenLastCalledWith(
      credential, "new words", SessionMessageSearchSessionStatus.UNSPECIFIED, expect.any(AbortSignal)
    );
    expect(app.state).toMatchObject({
      homeSearchQuery: "new words",
      homeSearchFilter: "all",
      homeSearchStatus: "ready",
      homeSearchSessionIds: ["session"]
    });
    resolveOld([create(SessionMessageSearchMatchSchema, { sessionId: "session", eventId: "event-old" })]);
    await oldSearch;
    expect(app.state.homeSearchQuery).toBe("new words");

    let resolveOwnerSearch!: (value: readonly SessionMessageSearchMatch[]) => void;
    vi.mocked(network.searchSessionMessages).mockImplementationOnce(() => new Promise((resolve) => { resolveOwnerSearch = resolve; }));
    const ownerSearch = app.searchHome("owner", "active");
    await vi.waitFor(() => expect(app.state.homeSearchStatus).toBe("searching"));
    await app.refresh();
    resolveOwnerSearch([create(SessionMessageSearchMatchSchema, { sessionId: "session", eventId: "late" })]);
    await ownerSearch;
    expect(app.state.homeSearchSessionIds).toEqual([]);
    expect(app.state.homeSearchStatus).toBe("idle");

    let resolveClearedSearch!: (value: readonly SessionMessageSearchMatch[]) => void;
    vi.mocked(network.searchSessionMessages).mockImplementationOnce(() => new Promise((resolve) => { resolveClearedSearch = resolve; }));
    const clearedSearch = app.searchHome("clear me", "archived");
    await vi.waitFor(() => expect(app.state.homeSearchStatus).toBe("searching"));
    const clearedSignal = vi.mocked(network.searchSessionMessages).mock.calls.at(-1)?.[3];
    await app.searchHome("", "archived");
    expect(clearedSignal?.aborted).toBe(true);
    expect(app.state).toMatchObject({
      homeSearchQuery: "",
      homeSearchFilter: "archived",
      homeSearchStatus: "idle",
      homeSearchSessionIds: []
    });
    resolveClearedSearch([create(SessionMessageSearchMatchSchema, { sessionId: "session", eventId: "cleared" })]);
    await clearedSearch;
    expect(app.state.homeSearchSessionIds).toEqual([]);
  });

  it("submits every task action with the exact current Session revision", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();

    await expect(app.renameSession("session", "Renamed")).resolves.toBe(true);
    await expect(app.setSessionPinned("session", true)).resolves.toBe(true);
    await expect(app.setSessionArchived("session", true)).resolves.toBe(true);
    await expect(app.deleteSession("session")).resolves.toBe(true);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations.map((mutation) => mutation.payload.case)).toEqual([
      "renameSession", "pinSession", "archiveSession", "deleteSession"
    ]);
    for (const mutation of mutations) {
      expect(mutation.preconditions).toHaveLength(1);
      expect(mutation.preconditions[0]?.entity).toMatchObject({ kind: EntityKind.SESSION, id: "session" });
      expect(mutation.preconditions[0]?.expectedRevision?.value).toBe(9n);
    }
    expect(saved.pending()).toEqual([]);
  });

  it("persists an unknown task action before dispatch and never resends it", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));

    await expect(app.setSessionPinned("session", true)).resolves.toBe(false);
    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(app.state.pending).toMatchObject([{ kind: "pin", sessionId: "session", state: "unknown" }]);
    await expect(app.setSessionPinned("session", true)).rejects.toThrow(/still pending/);
    expect(network.submit).toHaveBeenCalledTimes(1);
  });

  it("keeps the authoritative task unchanged and exposes a conflict", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-1",
      connectionId: credential.connectionId,
      state: OperationState.CONFLICT,
      error: { code: "REVISION_CONFLICT", message: "The task changed on another client." }
    }));

    await expect(app.renameSession("session", "Rejected name")).resolves.toBe(false);

    expect(app.state.owner?.sessions.find((item) => item.sessionId === "session")?.displayName).toBe("Task");
    expect(app.state.error).toBe("The task changed on another client.");
    expect(saved.pending()).toEqual([]);
    expect(network.readOwner).toHaveBeenCalledTimes(2);
  });
});

describe("native current-task message and Queue actions", () => {
  const ids = () => {
    let value = 0;
    return () => `mobile-id-${++value}`;
  };

  it("deletes only an exact completed visible message with the current Session generation", async () => {
    const network = projectedNetwork(messageActionSnapshot);
    const saved = memoryStorage(credential);
    let deleted = false;
    network.readAround = vi.fn(async () => [messageEvent]);
    network.readSession = vi.fn(async () => deleted
      ? create(SnapshotSchema, { ...messageActionSnapshot, timeline: [] })
      : messageActionSnapshot);
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "deleteSessionMessage") deleted = true;
      return create(OperationSchema, {
        operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED
      });
    });
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    expect(app.canDeleteMessage(messageEvent.eventId)).toBe(true);
    expect(app.canDeleteMessage("message-1")).toBe(false);
    await app.around(messageEvent.eventId);
    expect(app.state.window?.map((event) => event.eventId)).toEqual([messageEvent.eventId]);
    await expect(app.deleteMessage(messageEvent.eventId)).resolves.toBe(true);
    expect(app.state.window).toBeUndefined();
    expect(app.canDeleteMessage(messageEvent.eventId)).toBe(false);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.SESSION, id: "session" },
        expectedGeneration: 8n
      }],
      payload: { case: "deleteSessionMessage", value: {
        sessionId: "session",
        eventId: messageEvent.eventId
      } }
    });
    expect(saved.pending()).toEqual([]);
  });

  it("cancels the exact accepted Queue item at its projected revision", async () => {
    const network = projectedNetwork(queueSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    expect(app.taskQueueCapabilities()).toEqual({ cancel: true, edit: true, reorder: true });
    expect(app.taskQueueItems().map((item) => item.queueItemId)).toEqual(["queue-1", "queue-2"]);
    await expect(app.cancelQueueItem("queue-1")).resolves.toBe(true);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_ITEM, id: "queue-1" },
        expectedRevision: { value: 11n, etag: "queue-1-r11" },
        expectedGeneration: 1n
      }],
      payload: { case: "cancelQueueItem", value: { queueItemId: "queue-1" } }
    });
  });

  it("locks, edits, and unlocks one Queue item while preserving non-text InputContent", async () => {
    const network = projectedNetwork(queueSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    const lease = await app.beginQueueEdit("queue-1");
    expect(lease).toMatchObject({
      connectionId: credential.connectionId,
      sessionId: "session",
      queueItemId: "queue-1",
      text: "First queued input"
    });
    await expect(app.saveQueueEdit(lease, "Revised queued input")).resolves.toBe(true);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations).toHaveLength(3);
    expect(mutations[0]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_ITEM, id: "queue-1" },
        expectedRevision: { value: 11n },
        expectedGeneration: 1n
      }],
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: lease.lockToken, locked: true
      } }
    });
    expect(mutations[1]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_ITEM, id: "queue-1" },
        expectedRevision: { value: 11n },
        expectedGeneration: 1n
      }],
      payload: { case: "editQueueItem", value: {
        queueItemId: "queue-1",
        deliveryMode: QueueDeliveryMode.FOLLOW_UP,
        lockToken: lease.lockToken,
        textSplices: [{ start: 0, end: 18, replacementText: "Revised queued input" }],
        input: { parts: [
          { content: { case: "text", value: "Revised queued input" } },
          { content: { case: "sessionMention", value: { sessionId: "related", displayText: "Related task" } } }
        ] }
      } }
    });
    expect(mutations[2]).toMatchObject({
      preconditions: [],
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: lease.lockToken, locked: false
      } }
    });
  });

  it("keeps the edit lease retryable when an unlock receipt cannot be persisted", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    const lease = await app.beginQueueEdit("queue-1");
    vi.mocked(saved.storage.savePending).mockRejectedValueOnce(new Error("device storage unavailable"));
    await expect(app.cancelQueueEdit(lease)).rejects.toThrow(/device storage unavailable/);
    expect(network.submit).toHaveBeenCalledTimes(1);

    await expect(app.cancelQueueEdit(lease)).resolves.toBeUndefined();
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: lease.lockToken, locked: false
      } }
    });
  });

  it("serializes Queue reorder under the exact QueueControl lock and disables edge moves", async () => {
    const network = projectedNetwork(queueSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    await expect(app.moveQueueItem("queue-1", "up")).resolves.toBe(false);
    expect(network.submit).not.toHaveBeenCalled();
    await expect(app.moveQueueItem("queue-2", "up")).resolves.toBe(true);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations).toHaveLength(3);
    const firstPayload = mutations[0]?.payload;
    if (firstPayload?.case !== "setQueueInteractionLock") throw new Error("Expected a Queue interaction-lock mutation.");
    const lockToken = firstPayload.value.lockToken;
    expect(mutations[0]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_CONTROL, id: "session" },
        expectedRevision: { value: 21n, etag: "queue-control-r21" },
        expectedGeneration: 1n
      }],
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", locked: true
      } }
    });
    expect(mutations[1]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_ITEM, id: "queue-2" },
        expectedRevision: { value: 12n, etag: "queue-2-r12" },
        expectedGeneration: 1n
      }],
      payload: { case: "reorderQueueItem", value: {
        queueItemId: "queue-2",
        placement: { anchor: { case: "beforeQueueItemId", value: "queue-1" } },
        interactionLockToken: lockToken
      } }
    });
    expect(mutations[2]).toMatchObject({
      preconditions: [],
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", lockToken, locked: false
      } }
    });
  });

  it("best-effort releases the Queue interaction lock after an unknown reorder without replaying it", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: mutation.payload.case === "reorderQueueItem" ? OperationState.RUNNING : OperationState.SUCCEEDED
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("reorder watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    await expect(app.moveQueueItem("queue-2", "up")).resolves.toBe(false);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations).toHaveLength(3);
    const lock = mutations[0]?.payload;
    if (lock?.case !== "setQueueInteractionLock") throw new Error("Expected a Queue interaction-lock mutation.");
    expect(mutations[1]?.payload.case).toBe("reorderQueueItem");
    expect(mutations[2]).toMatchObject({
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", lockToken: lock.value.lockToken, locked: false
      } }
    });
    expect(vi.mocked(network.submit).mock.calls.filter((call) => call[2].payload.case === "reorderQueueItem"))
      .toHaveLength(1);
    expect(saved.pending()).toMatchObject([{
      kind: "queue-reorder", sessionId: "session", queueItemId: "queue-2", state: "accepted"
    }]);
  });

  it("compensates with the same interaction token when backgrounding during reorder-lock acquisition", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    let resolveAcquire!: (operation: Operation) => void;
    let acquireOperationId = "";
    vi.mocked(network.submit).mockImplementationOnce((_credential, operationId) => new Promise((resolve) => {
      acquireOperationId = operationId;
      resolveAcquire = resolve;
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    const moving = app.moveQueueItem("queue-2", "up");
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(1));
    const acquire = vi.mocked(network.submit).mock.calls[0]?.[2].payload;
    if (acquire?.case !== "setQueueInteractionLock") throw new Error("Expected Queue interaction-lock acquisition.");
    app.setForeground(false);
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", lockToken: acquire.value.lockToken, locked: false
      } }
    });
    resolveAcquire(create(OperationSchema, {
      operationId: acquireOperationId,
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    await expect(moving).rejects.toThrow(/unknown result/);
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(3));
    expect(vi.mocked(network.submit).mock.calls[2]?.[2]).toMatchObject({
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", lockToken: acquire.value.lockToken, locked: false
      } }
    });
    await vi.waitFor(() => expect(saved.pending()).toMatchObject([{
      kind: "queue-interaction-lock", sessionId: "session", state: "unknown"
    }]));
  });

  it("waits for a terminal lock result and never replays an unknown Queue mutation", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    vi.mocked(network.submit).mockImplementationOnce(async (_credential, operationId) => create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    await expect(app.beginQueueEdit("queue-1")).rejects.toThrow(/unknown result/);
    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(saved.pending()).toMatchObject([{
      kind: "queue-edit-lock", sessionId: "session", queueItemId: "queue-1", state: "accepted"
    }]);
    await expect(app.beginQueueEdit("queue-1")).rejects.toThrow(/still pending/);
    expect(network.submit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(network.submit).mock.calls.map((call) => call[2].payload)).toMatchObject([
      { case: "setQueueItemEditLock", value: { queueItemId: "queue-1", locked: true } },
      { case: "setQueueItemEditLock", value: { queueItemId: "queue-1", locked: false } }
    ]);
    expect(network.waitOperation).toHaveBeenCalledTimes(1);
  });

  it("releases the exact Queue edit lock when switching tasks or leaving the foreground", async () => {
    const switchNetwork = projectedNetwork(queueSnapshot);
    const switching = client(switchNetwork, memoryStorage(credential).storage, undefined, undefined, ids());
    await switching.start();
    const switchLease = await switching.beginQueueEdit("queue-1");
    await switching.select(undefined);
    expect(vi.mocked(switchNetwork.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: switchLease.lockToken, locked: false
      } }
    });

    const backgroundNetwork = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    const backgrounding = client(backgroundNetwork, saved.storage, undefined, undefined, ids());
    await backgrounding.start();
    const backgroundLease = await backgrounding.beginQueueEdit("queue-1");
    backgrounding.setForeground(false);
    await vi.waitFor(() => expect(backgroundNetwork.submit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(backgroundNetwork.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: backgroundLease.lockToken, locked: false
      } }
    });
    await vi.waitFor(() => expect(saved.pending()).toEqual([]));
  });

  it("compensates with the same lock token when the app backgrounds during lock acquisition", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    let resolveAcquire!: (operation: Operation) => void;
    vi.mocked(network.submit).mockImplementationOnce((_credential, operationId) => new Promise((resolve) => {
      resolveAcquire = resolve;
      expect(operationId).toBe("mobile-id-2");
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    const opening = app.beginQueueEdit("queue-1");
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(1));
    const acquirePayload = vi.mocked(network.submit).mock.calls[0]?.[2].payload;
    if (acquirePayload?.case !== "setQueueItemEditLock") throw new Error("Expected Queue edit-lock acquisition.");
    app.setForeground(false);
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1",
        lockToken: acquirePayload.value.lockToken,
        locked: false
      } }
    });
    resolveAcquire(create(OperationSchema, {
      operationId: "mobile-id-2",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    await expect(opening).rejects.toThrow(/unknown result|task changed/);
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(3));
    expect(vi.mocked(network.submit).mock.calls[2]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1",
        lockToken: acquirePayload.value.lockToken,
        locked: false
      } }
    });
    await vi.waitFor(() => expect(saved.pending()).toMatchObject([{
      operationId: "mobile-id-2", kind: "queue-edit-lock", queueItemId: "queue-1", state: "unknown"
    }]));
  });
});

describe("native current-task Interaction ownership", () => {
  const ids = () => {
    let value = 0;
    return () => `interaction-operation-${++value}`;
  };

  it("sorts exact current requests and resolves an advertised decision at revision and generation", async () => {
    const network = projectedNetwork(interactionSnapshot);
    const saved = memoryStorage(credential);
    let settled = false;
    const current = () => settled
      ? create(SnapshotSchema, { ...interactionSnapshot, interactions: [questionInteraction, planInteraction] })
      : interactionSnapshot;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: current() }));
    network.readSession = vi.fn(async () => current());
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "resolveInteraction") settled = true;
      return create(OperationSchema, { operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED });
    });
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    expect(app.taskInteractions().map((interaction) => interaction.interactionId))
      .toEqual(["interaction-plan", "interaction-permission", "interaction-question"]);
    await expect(app.resolveInteraction(permissionInteraction.interactionId, {
      kind: "permission",
      decision: PermissionDecisionKind.ALLOW_ONCE
    })).resolves.toBe(true);

    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.INTERACTION, id: permissionInteraction.interactionId },
        expectedRevision: { value: 44n, etag: "interaction-r44" },
        expectedGeneration: 8n
      }],
      payload: { case: "resolveInteraction", value: {
        interactionId: permissionInteraction.interactionId,
        interactionGeneration: 8n,
        resolution: {
          connectionId: credential.connectionId,
          decision: { case: "permission", value: { decision: PermissionDecisionKind.ALLOW_ONCE } }
        }
      } }
    });
    expect(saved.pending()).toEqual([]);
    expect(app.taskInteractions().map((interaction) => interaction.interactionId))
      .toEqual(["interaction-plan", "interaction-question"]);
  });

  it("dismisses only the exact current request and refreshes its authoritative projection", async () => {
    const network = projectedNetwork(interactionSnapshot);
    let dismissed = false;
    const current = () => dismissed
      ? create(SnapshotSchema, { ...interactionSnapshot, interactions: [permissionInteraction, planInteraction] })
      : interactionSnapshot;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: current() }));
    network.readSession = vi.fn(async () => current());
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "dismissInteraction") dismissed = true;
      return create(OperationSchema, { operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED });
    });
    const clearInteractionDraft = vi.fn(async (_identity: MobileInteractionDraftIdentity) => undefined);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), clearInteractionDraft);
    await app.start();

    await expect(app.dismissInteraction(questionInteraction.interactionId)).resolves.toBe(true);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.INTERACTION, id: questionInteraction.interactionId },
        expectedRevision: { value: 45n },
        expectedGeneration: 8n
      }],
      payload: { case: "dismissInteraction", value: {
        interactionId: questionInteraction.interactionId,
        interactionGeneration: 8n,
        reason: "Dismissed by user on mobile"
      } }
    });
    expect(app.taskInteractions().some((interaction) => interaction.interactionId === questionInteraction.interactionId)).toBe(false);
    expect(clearInteractionDraft).toHaveBeenCalledWith({
      profileId: credential.profileId,
      sessionId: "session",
      interactionId: questionInteraction.interactionId,
      kind: "question",
      generation: 8n,
      revision: 45n
    });
  });

  it("clears the exact saved draft when a succeeded response is reconciled after restart", async () => {
    const network = projectedNetwork(interactionSnapshot);
    const saved = memoryStorage(credential);
    await saved.storage.savePending([{
      operationId: "interaction-operation-before-restart",
      connectionId: credential.connectionId,
      kind: "interaction-resolve",
      sessionId: "session",
      interactionId: planInteraction.interactionId,
      interactionGeneration: "8",
      interactionRevision: "46",
      interactionDraftKind: "plan",
      state: "accepted"
    }]);
    vi.mocked(network.getOperation).mockResolvedValue(create(OperationSchema, {
      operationId: "interaction-operation-before-restart",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    const clearInteractionDraft = vi.fn(async (_identity: MobileInteractionDraftIdentity) => undefined);
    const app = client(network, saved.storage, undefined, undefined, ids(), clearInteractionDraft);

    await app.start();

    expect(clearInteractionDraft).toHaveBeenCalledWith({
      profileId: credential.profileId,
      sessionId: "session",
      interactionId: planInteraction.interactionId,
      kind: "plan",
      generation: 8n,
      revision: 46n
    });
    expect(saved.pending()).toEqual([]);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("retains one unknown response receipt and never replays that decision", async () => {
    const network = projectedNetwork(interactionSnapshot);
    const saved = memoryStorage(credential);
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "interaction-operation-1",
      connectionId: credential.connectionId,
      state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("operation watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    await expect(app.resolveInteraction(questionInteraction.interactionId, {
      kind: "question",
      answers: { answer: { kind: "text", value: "Keep this draft" } }
    })).resolves.toBe(false);
    expect(saved.pending()).toMatchObject([{
      kind: "interaction-resolve",
      sessionId: "session",
      interactionId: questionInteraction.interactionId,
      state: "accepted"
    }]);
    await expect(app.resolveInteraction(questionInteraction.interactionId, {
      kind: "question",
      answers: { answer: { kind: "text", value: "Do not resend" } }
    })).rejects.toThrow(/still pending/u);
    expect(network.submit).toHaveBeenCalledTimes(1);
    expect(network.waitOperation).toHaveBeenCalledTimes(1);
  });

  it("rejects stale, unadvertised, and cross-generation responses before dispatch", async () => {
    const network = projectedNetwork(interactionSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    await expect(app.resolveInteraction(permissionInteraction.interactionId, {
      kind: "permission",
      decision: PermissionDecisionKind.ALLOW_FOR_SESSION
    })).rejects.toThrow(/not currently available/u);
    await expect(app.resolveInteraction("missing", {
      kind: "permission",
      decision: PermissionDecisionKind.ALLOW_ONCE
    })).rejects.toThrow(/no longer pending/u);
    expect(network.submit).not.toHaveBeenCalled();

    network.readSession = vi.fn(async () => create(SnapshotSchema, {
      ...interactionSnapshot,
      sessions: [create(SessionSchema, { ...interactionSnapshot.sessions[0]!,
        nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 9n }) })]
    }));
    await app.refresh();
    expect(app.taskInteractions()).toEqual([]);
    await expect(app.dismissInteraction(permissionInteraction.interactionId)).rejects.toThrow(/no longer pending/u);
    expect(network.submit).not.toHaveBeenCalled();
  });
});

describe("native current-task runtime controls", () => {
  const ids = () => {
    let value = 0;
    return () => `runtime-control-${++value}`;
  };

  it("applies model, permission, and Plan Mode with exact Session revision and generation receipts", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    let current = runtimeSession;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(current, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(current, true));
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      const nextRevision = (current.version?.revision?.value ?? 0n) + 1n;
      if (mutation.payload.case === "setSessionModel") {
        current = create(SessionSchema, { ...current, model: mutation.payload.value.model,
          version: create(EntityVersionSchema, {
            revision: create(RevisionSchema, { value: nextRevision, etag: `session-r${nextRevision}` }), generation: 8n
          }) });
      } else if (mutation.payload.case === "setSessionPermission") {
        current = create(SessionSchema, { ...current, permissionMode: mutation.payload.value.permissionMode,
          version: create(EntityVersionSchema, {
            revision: create(RevisionSchema, { value: nextRevision, etag: `session-r${nextRevision}` }), generation: 8n
          }) });
      } else if (mutation.payload.case === "setSessionPlanMode") {
        current = create(SessionSchema, { ...current, planMode: mutation.payload.value.enabled,
          version: create(EntityVersionSchema, {
            revision: create(RevisionSchema, { value: nextRevision, etag: `session-r${nextRevision}` }), generation: 8n
          }) });
      }
      return create(OperationSchema, { operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED });
    });
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    let controls = app.taskRuntimeControls();
    expect(controls).toMatchObject({ canSwitchModel: true, canSetEffort: true, canSetFastMode: true,
      canSetPermission: true, canSetPlanMode: true });
    await expect(app.setTaskModel(controls!.authorityKey, {
      providerId: "beta", modelId: "b", effortId: "high", fastMode: true
    })).resolves.toBe(true);
    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.SESSION, id: "session" },
        expectedRevision: { value: 9n, etag: "session-r9" },
        expectedGeneration: 8n
      }],
      payload: { case: "setSessionModel", value: {
        sessionId: "session",
        model: { model: { providerId: "beta", modelId: "b" }, effortId: "high", fastMode: true }
      } }
    });

    controls = app.taskRuntimeControls();
    await expect(app.setTaskPermission(controls!.authorityKey, PermissionMode.AUTO)).resolves.toBe(true);
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      preconditions: [{ expectedRevision: { value: 10n }, expectedGeneration: 8n }],
      payload: { case: "setSessionPermission", value: { sessionId: "session", permissionMode: PermissionMode.AUTO } }
    });

    controls = app.taskRuntimeControls();
    await expect(app.setTaskPlanMode(controls!.authorityKey, true)).resolves.toBe(true);
    expect(vi.mocked(network.submit).mock.calls[2]?.[2]).toMatchObject({
      preconditions: [{ expectedRevision: { value: 11n }, expectedGeneration: 8n }],
      payload: { case: "setSessionPlanMode", value: { sessionId: "session", enabled: true } }
    });
    expect(saved.pending()).toEqual([]);
    expect(app.taskRuntimeControls()?.session).toMatchObject({
      permissionMode: PermissionMode.AUTO,
      planMode: true,
      model: { model: { providerId: "beta", modelId: "b" }, effortId: "high", fastMode: true }
    });
  });

  it("retains an unknown control receipt and never replays the mutation", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "runtime-control-1",
      connectionId: credential.connectionId,
      state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("operation watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();
    const authorityKey = app.taskRuntimeControls()!.authorityKey;

    await expect(app.setTaskPlanMode(authorityKey, true)).resolves.toBe(false);
    expect(saved.pending()).toMatchObject([{
      kind: "session-plan", sessionId: "session", state: "accepted"
    }]);
    await expect(app.setTaskPlanMode(authorityKey, true)).rejects.toThrow(/still pending/u);
    expect(network.submit).toHaveBeenCalledTimes(1);
    expect(network.waitOperation).toHaveBeenCalledTimes(1);
  });

  it("reconciles a saved control receipt after restart without dispatching it again", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    await saved.storage.savePending([{
      operationId: "runtime-before-restart",
      connectionId: credential.connectionId,
      kind: "session-permission",
      sessionId: "session",
      state: "accepted"
    }]);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    vi.mocked(network.getOperation).mockResolvedValue(create(OperationSchema, {
      operationId: "runtime-before-restart",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());

    await app.start();

    expect(saved.pending()).toEqual([]);
    expect(network.getOperation).toHaveBeenCalledWith(credential, "runtime-before-restart", expect.any(AbortSignal));
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("rejects invalid choices and retired control authority before dispatch", async () => {
    const network = fakeNetwork();
    let detailRevision = 31n;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => create(SnapshotSchema, {
      ...runtimeControlProjection(runtimeSession, true),
      revision: create(RevisionSchema, { value: detailRevision, etag: `detail-r${detailRevision}` })
    }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();
    const staleKey = app.taskRuntimeControls()!.authorityKey;

    await expect(app.setTaskModel(staleKey, {
      providerId: "beta", modelId: "b", effortId: "unknown", fastMode: false
    })).rejects.toThrow(/not advertised/u);
    expect(network.submit).not.toHaveBeenCalled();

    detailRevision = 32n;
    await app.refresh();
    await expect(app.setTaskPermission(staleKey, PermissionMode.AUTO)).rejects.toThrow(/controls changed/u);
    expect(network.submit).not.toHaveBeenCalled();
  });
});

describe("native current-task Files ownership", () => {
  const revision = create(FileRevisionSchema, {
    opaqueRevision: "readme-1", sha256Hex: "a".repeat(64), byteSize: 6n,
    modifiedAt: { seconds: 10n, nanos: 2 }
  });
  const readme = create(WorkspaceEntrySchema, {
    workspaceId: "workspace", relativePath: "README.md", displayName: "README.md",
    kind: FileKind.REGULAR, mediaType: "text/markdown", revision
  });
  const sourceDirectory = create(WorkspaceEntrySchema, {
    workspaceId: "workspace", relativePath: "src", displayName: "src", kind: FileKind.DIRECTORY
  });
  const artifact = create(ArtifactSchema, {
    artifactId: "artifact-1", sessionId: "session", kind: ArtifactKind.FILE, title: "Report",
    blob: { blobId: "blob-1", fileName: "report.txt", mediaType: "text/plain", byteSize: 6n,
      sha256Hex: "b".repeat(64) }
  });

  function configureFiles(network: MobileNetwork): void {
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: filesSnapshot });
    vi.mocked(network.readSession).mockResolvedValue(filesSnapshot);
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "" ? [sourceDirectory, readme] : [], revision: `directory:${parentPath || "root"}`
    }));
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({
      paths: ["README.md", "src/App.tsx"], revision: "index-1", truncated: false
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [artifact], revision: "artifacts-1" });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, {
      entry: readme,
      content: { case: "text", value: {
        utf8Text: "# Joko", languageId: "markdown", startByte: 0n, endByte: 6n, totalLines: 1
      } },
      truncated: false
    }));
  }

  it("opens only for an exact capable Session Workspace and carries the observed revision into preview", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();

    expect(app.canOpenFiles()).toBe(true);
    await app.openFiles();
    expect(app.state.files).toMatchObject({
      open: true,
      status: "ready",
      sessionId: "session",
      location: { kind: "workspace", path: "" },
      entries: [{ relativePath: "src" }, { relativePath: "README.md" }],
      fileIndex: ["README.md", "src/App.tsx"],
      artifacts: [{ artifactId: "artifact-1", sessionId: "session" }],
      watchStatus: "watching"
    });

    await app.searchFiles("report", "name", false);
    expect(app.state.files.searchResults).toMatchObject([{ kind: "artifact", artifact: { artifactId: "artifact-1" } }]);
    await app.searchFiles("readme", "name", false);
    expect(app.state.files.searchResults).toEqual([{ kind: "workspace-name", relativePath: "README.md" }]);
    await app.previewFileSearchResult(app.state.files.searchResults[0]!);

    expect(network.readWorkspaceFile).toHaveBeenCalledWith(
      credential, "workspace", "README.md", revision, expect.any(AbortSignal)
    );
    expect(app.state.files.preview).toMatchObject({
      kind: "text", text: "# Joko", languageId: "markdown", startByte: 0n, endByte: 6n,
      totalLines: 1, truncated: false
    });
  });

  it("retires late directory and content-search results after foreground or Session ownership changes", async () => {
    const directoryNetwork = fakeNetwork();
    configureFiles(directoryNetwork);
    const directoryApp = client(directoryNetwork, memoryStorage(credential).storage);
    await directoryApp.start();
    await directoryApp.openFiles();
    let resolveDirectory!: (value: { entries: readonly WorkspaceEntry[]; revision: string }) => void;
    let directorySignal: AbortSignal | undefined;
    vi.mocked(directoryNetwork.listWorkspaceDirectory).mockImplementationOnce((_credential, _workspaceId, _path, signal) => {
      directorySignal = signal;
      return new Promise((resolve) => { resolveDirectory = resolve; });
    });
    const directoryRead = directoryApp.openFilesDirectory("src");
    await vi.waitFor(() => expect(directorySignal).toBeDefined());
    directoryApp.setForeground(false);
    expect(directorySignal?.aborted).toBe(true);
    resolveDirectory({ entries: [create(WorkspaceEntrySchema, {
      workspaceId: "workspace", relativePath: "src/late.ts", kind: FileKind.REGULAR,
      revision: { opaqueRevision: "late" }
    })], revision: "late-directory" });
    await directoryRead;
    expect(directoryApp.state.files.status).toBe("offline");
    expect(directoryApp.state.files.entries).toEqual([]);

    const searchNetwork = fakeNetwork();
    configureFiles(searchNetwork);
    const searchApp = client(searchNetwork, memoryStorage(credential).storage);
    await searchApp.start();
    await searchApp.openFiles();
    let resolveSearch!: (value: Awaited<ReturnType<MobileNetwork["searchWorkspace"]>>) => void;
    let searchSignal: AbortSignal | undefined;
    vi.mocked(searchNetwork.searchWorkspace).mockImplementationOnce((_credential, _workspaceId, _query, _caseSensitive, signal) => {
      searchSignal = signal;
      return new Promise((resolve) => { resolveSearch = resolve; });
    });
    const search = searchApp.searchFiles("late", "content", false);
    await vi.waitFor(() => expect(searchSignal).toBeDefined());
    await searchApp.select(undefined);
    expect(searchSignal?.aborted).toBe(true);
    resolveSearch({ matches: [], revision: "late-search", truncated: false, totalFiles: 0 });
    await search;
    expect(searchApp.state.files.authorityKey).toBeUndefined();
    expect(searchApp.state.files.searchResults).toEqual([]);
  });

  it("cancels Blob bytes on close and never adopts them into a later Files owner", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const imageArtifact = create(ArtifactSchema, {
      ...artifact,
      artifactId: "image-1",
      title: "Image",
      blob: { ...artifact.blob!, blobId: "image-blob", fileName: "image.png", mediaType: "image/png" }
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [imageArtifact], revision: "artifacts-image" });
    let resolveBlob!: (value: Awaited<ReturnType<MobileNetwork["downloadBlob"]>>) => void;
    let blobSignal: AbortSignal | undefined;
    vi.mocked(network.downloadBlob).mockImplementationOnce((_credential, _blob, signal) => {
      blobSignal = signal;
      return new Promise((resolve) => { resolveBlob = resolve; });
    });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.openFiles();

    const preview = app.previewArtifact(app.state.files.artifacts[0]!);
    await vi.waitFor(() => expect(blobSignal).toBeDefined());
    app.closeFiles();
    expect(blobSignal?.aborted).toBe(true);
    resolveBlob({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6]), mediaType: "image/png" });
    await preview;
    expect(app.state.files.open).toBe(false);
    expect(app.state.files.preview).toBeUndefined();
  });

  it("invalidates preview and refreshes current directory, index and Artifacts after a Workspace watch event", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const queued: WorkspaceFileChange[] = [];
    let wake: (() => void) | undefined;
    network.watchWorkspace = vi.fn(async function* (_credential, _workspaceId, signal) {
      while (!signal.aborted) {
        if (queued.length === 0) await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
        if (signal.aborted) return;
        const change = queued.shift();
        if (change) yield change;
      }
    });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.openFiles();
    await app.previewWorkspaceEntry(app.state.files.entries.find((entry) => entry.relativePath === "README.md")!);
    expect(app.state.files.preview?.kind).toBe("text");

    queued.push(create(WorkspaceFileChangeSchema, {
      workspaceId: "workspace", kind: WorkspaceFileChangeKind.MODIFIED, relativePath: "README.md",
      sequence: 1n, streamRevision: "watch-1"
    }));
    wake?.();
    wake = undefined;

    await vi.waitFor(() => expect(app.state.files.preview).toBeUndefined());
    await vi.waitFor(() => expect(network.listWorkspaceDirectory).toHaveBeenCalledTimes(2));
    expect(network.listWorkspaceFileIndex).toHaveBeenCalledTimes(2);
    expect(network.listSessionArtifacts).toHaveBeenCalledTimes(2);
  });
});
