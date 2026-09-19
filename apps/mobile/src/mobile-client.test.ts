import { create, toBinary } from "@bufbuild/protobuf";
import {
  CapabilitySupport, ConnectionSchema, ConnectionState, DeviceKind, DevicePresenceState, DeviceSchema, EntityKind,
  JOKO_API_VERSION, OperationSchema,
  EventCursorSchema, EventSchema, MessageRole, OperationMutationSchema, OperationState, SessionState, SnapshotSchema, TargetState, capabilityNames
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileClient, type MobileStorage, type PendingOperation } from "./mobile-client";
import { MobileCredentialStorageError, profileFromCredential } from "./connection-storage";
import type { MobileDiscovery } from "./connection-discovery";
import { normalizeNodeOrigin, parseNodeIdentity, type MobileNetwork, type NodeIdentity, type PairedCredential } from "./network";
import type { Event } from "@joko/contracts";
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
  sessions: [{ sessionId: "session", backendId: "backend", targetId: "target", displayName: "Task", state: SessionState.IDLE,
    nativeBinding: { runtimeGeneration: 8n } }]
});
const extendedSnapshot = create(SnapshotSchema, {
  ...snapshot,
  connections: [connection, otherConnection],
  devices: [device, otherDevice]
});

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
    streamOwner: vi.fn(async function* (_credential, _after, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    prepareTarget: vi.fn(async () => undefined),
    submit: vi.fn(async (_credential, operationId, mutation) => {
      toBinary(OperationMutationSchema, mutation);
      return create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED
      });
    }),
    getOperation: vi.fn(async () => undefined)
  };
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
function client(network: MobileNetwork, storage: MobileStorage, discovery?: MobileDiscovery, now: () => number = () => 2_000) {
  const instance = new MobileClient(network, storage, discovery ?? { scan: vi.fn(async () => []) }, () => "operation-1", "android", now);
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
      { id: "assistant-message", text: "final", eventId: "start" }
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
