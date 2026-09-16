import { Code, ConnectError, createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  ConnectionService, DeviceKind, EventService, OperationService, SessionService, TargetService,
  type Connection, type Device, type Event, type EventCursor, type Operation,
  type OperationMutation, type Snapshot, type Target
} from "@joko/contracts";

export interface PairedCredential {
  readonly origin: string;
  readonly serverId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly authKey: string;
}

export interface NodeIdentity {
  readonly serverId: string;
  readonly displayName: string;
  readonly pairingEnabled: boolean;
}

export interface MobileNetwork {
  inspect(origin: string, signal?: AbortSignal): Promise<NodeIdentity>;
  requestPairing(origin: string, deviceName: string, platform: string, signal?: AbortSignal): Promise<{ identity: NodeIdentity; challengeId: string }>;
  completePairing(origin: string, challengeId: string, code: string, deviceName: string, platform: string, signal?: AbortSignal): Promise<{ credential: PairedCredential; identity: NodeIdentity }>;
  readOwner(credential: PairedCredential, signal?: AbortSignal): Promise<{ connection: Connection; device: Device; snapshot: Snapshot }>;
  readSession(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<Snapshot>;
  readHistory(credential: PairedCredential, sessionId: string, before?: EventCursor, signal?: AbortSignal): Promise<{ events: Event[]; before?: EventCursor }>;
  readAround(credential: PairedCredential, sessionId: string, eventId: string, signal?: AbortSignal): Promise<Event[]>;
  streamOwner(credential: PairedCredential, after: EventCursor, signal: AbortSignal): AsyncIterable<Event>;
  prepareTarget(credential: PairedCredential, target: Target, signal?: AbortSignal): Promise<void>;
  submit(credential: PairedCredential, operationId: string, mutation: OperationMutation, signal?: AbortSignal): Promise<Operation>;
  getOperation(credential: PairedCredential, operationId: string, signal?: AbortSignal): Promise<Operation | undefined>;
}

export function normalizeNodeOrigin(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Use an HTTP(S) Joko node address.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Use only the Joko node origin, without credentials, path, query or fragment.");
  }
  if (parsed.protocol === "http:" && !isPrivateLanHost(parsed.hostname)) {
    throw new Error("Unencrypted HTTP is allowed only for a local/private-network Joko node. Use HTTPS elsewhere.");
  }
  return parsed.origin;
}

function isPrivateLanHost(host: string): boolean {
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local")) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function transport(origin: string, authKey?: string): Transport {
  const interceptors: Interceptor[] = authKey === undefined ? [] : [
    (next) => async (request) => {
      request.header.set("authorization", `Bearer ${authKey}`);
      request.header.set("x-joko-client-version", "0.1.0");
      return next(request);
    }
  ];
  return createConnectTransport({ baseUrl: origin, useBinaryFormat: true, interceptors });
}

function identity(server: { serverId: string; displayName: string; apiVersion: string; pairingEnabled: boolean } | undefined): NodeIdentity {
  if (!server?.serverId.trim() || !server.apiVersion.trim()) throw new Error("This address did not return a valid Joko node identity.");
  return { serverId: server.serverId, displayName: server.displayName || "Joko node", pairingEnabled: server.pairingEnabled };
}

function options(signal?: AbortSignal): { signal: AbortSignal } | undefined { return signal === undefined ? undefined : { signal }; }

export const mobileNetwork: MobileNetwork = {
  async inspect(origin, signal) {
    const response = await createClient(ConnectionService, transport(normalizeNodeOrigin(origin))).getServerInfo({}, options(signal));
    return identity(response.server);
  },
  async requestPairing(rawOrigin, deviceName, platform, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const client = createClient(ConnectionService, transport(origin));
    const node = identity((await client.getServerInfo({}, options(signal))).server);
    if (!node.pairingEnabled) throw new Error("Pairing is closed on this Joko node. Ask the node owner to open pairing.");
    const args = { deviceDisplayName: deviceName.trim(), deviceKind: DeviceKind.MOBILE, platform, appVersion: "0.1.0" };
    const challenge = (await client.beginPairing(args, options(signal))).challenge;
    if (!challenge?.challengeId) throw new Error("The Joko node did not return a pairing challenge.");
    return { identity: node, challengeId: challenge.challengeId };
  },
  async completePairing(rawOrigin, challengeId, code, deviceName, platform, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const client = createClient(ConnectionService, transport(origin));
    const node = identity((await client.getServerInfo({}, options(signal))).server);
    const args = { deviceDisplayName: deviceName.trim(), deviceKind: DeviceKind.MOBILE, platform, appVersion: "0.1.0" };
    const result = (await client.completePairing({ ...args, challengeId, humanCode: code.trim() }, options(signal))).result;
    if (!result?.connection?.connectionId || !result.device?.deviceId || result.connection.deviceId !== result.device.deviceId || !result.authKey) {
      throw new Error("Pairing completed without a matching device and connection credential.");
    }
    return {
      identity: node,
      credential: {
        origin, serverId: node.serverId, connectionId: result.connection.connectionId,
        deviceId: result.device.deviceId, displayName: result.connection.displayName || deviceName.trim(), authKey: result.authKey
      }
    };
  },
  async readOwner(credential, signal) {
    const client = createClient(ConnectionService, transport(credential.origin, credential.authKey));
    const [connection, device, snapshot] = await Promise.all([
      client.getConnection({ connectionId: credential.connectionId }, options(signal)),
      client.getDevice({ deviceId: credential.deviceId }, options(signal)),
      createClient(EventService, transport(credential.origin, credential.authKey)).getSnapshot({ scope: { kind: { case: "owner", value: {} } } }, options(signal))
    ]);
    if (!connection.connection || !device.device || !snapshot.snapshot) throw new Error("The Joko node returned an incomplete owner snapshot.");
    return { connection: connection.connection, device: device.device, snapshot: snapshot.snapshot };
  },
  async readSession(credential, sessionId, signal) {
    const response = await createClient(EventService, transport(credential.origin, credential.authKey)).getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    }, options(signal));
    if (!response.snapshot || !response.snapshot.sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error("The selected task is no longer available on this Joko node.");
    }
    return response.snapshot;
  },
  async readHistory(credential, sessionId, before, signal) {
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey)).listSessionTimeline({
      sessionId, limit: 120, ...(before === undefined ? {} : { beforeCursor: before })
    }, options(signal));
    return { events: response.events, ...(response.nextBeforeCursor === undefined ? {} : { before: response.nextBeforeCursor }) };
  },
  async readAround(credential, sessionId, eventId, signal) {
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey)).listSessionTimeline({
      sessionId, aroundEventId: eventId, limit: 120
    }, options(signal));
    return response.events;
  },
  async *streamOwner(credential, after, signal) {
    const client = createClient(EventService, transport(credential.origin, credential.authKey));
    for await (const response of client.streamEvents({
      scope: { kind: { case: "owner", value: {} } }, afterCursor: after
    }, { signal })) {
      if (response.event) yield response.event;
    }
  },
  async prepareTarget(credential, target, signal) {
    const revision = target.version?.revision;
    if (!target.targetId || !revision || revision.value < 1n) throw new Error("A current target revision is required.");
    const response = await createClient(TargetService, transport(credential.origin, credential.authKey)).prepareTargetWorkspace({
      targetId: target.targetId, expectedTargetRevision: revision
    }, options(signal));
    if (!response.workspace || response.workspace.targetId !== target.targetId
      || response.workspace.version?.revision?.value !== revision.value || !response.workspace.workspaceId) {
      throw new Error("The prepared workspace did not match the selected target revision.");
    }
  },
  async submit(credential, operationId, mutation, signal) {
    const response = await createClient(OperationService, transport(credential.origin, credential.authKey)).submitOperation({
      operationId, connectionId: credential.connectionId, mutation
    }, options(signal));
    if (!response.operation || response.operation.operationId !== operationId || response.operation.connectionId !== credential.connectionId) {
      throw new Error("The Joko node returned a mismatched operation receipt.");
    }
    return response.operation;
  },
  async getOperation(credential, operationId, signal) {
    let response;
    try {
      response = await createClient(OperationService, transport(credential.origin, credential.authKey)).getOperation({ operationId }, options(signal));
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
      throw error;
    }
    if (response.operation && (response.operation.operationId !== operationId || response.operation.connectionId !== credential.connectionId)) {
      throw new Error("The Joko node returned a mismatched operation identity.");
    }
    return response.operation;
  }
};
