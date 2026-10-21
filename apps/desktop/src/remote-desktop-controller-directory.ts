import { randomUUID } from "node:crypto";
import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ConnectionService, ConnectionState, OperationService, OperationState } from "@joko/contracts";

export interface DesktopRemoteDesktopControllerDirectory {
  name(deviceId: string): Promise<string | undefined>;
  revoke(deviceId: string): Promise<void>;
}

/** Uses the host's original authenticated node; never follows renderer navigation. */
export function createDesktopRemoteDesktopControllerDirectory(options: {
  readonly profileId: string; readonly serverId: string; readonly deviceId: string; readonly origin: string;
  readonly current: () => boolean;
  readonly readAuthKey: () => Promise<string | undefined>;
  readonly transport?: (origin: string, key?: string) => Transport;
}): DesktopRemoteDesktopControllerDirectory {
  const check = (): void => { if (!options.current()) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED"); };
  const authenticated = async (signal: AbortSignal): Promise<Transport> => {
    check();
    const factory = options.transport ?? directoryTransport;
    const info = await createClient(ConnectionService, factory(options.origin)).getServerInfo({}, { signal });
    check();
    if (info.server?.serverId !== options.serverId) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    const key = await options.readAuthKey(); check();
    if (!key || !/^[A-Za-z0-9_-]{43}$/u.test(key)) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    const transport = factory(options.origin, key);
    const connection = (await createClient(ConnectionService, transport).getConnection({ connectionId: options.profileId }, { signal })).connection;
    check();
    if (connection?.deviceId !== options.deviceId || connection.connectionId !== options.profileId
      || connection.state !== ConnectionState.CONNECTED) throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
    return transport;
  };
  return {
    async name(deviceId) {
      const signal = AbortSignal.timeout(8_000);
      const transport = await authenticated(signal);
      const device = (await createClient(ConnectionService, transport).getDevice({ deviceId }, { signal })).device;
      check();
      return device?.deviceId === deviceId && !device.revoked
        ? device.displayName.trim().slice(0, 256) || undefined : undefined;
    },
    async revoke(deviceId) {
      const signal = AbortSignal.timeout(15_000);
      const client = createClient(OperationService, await authenticated(signal));
      check();
      const operationId = randomUUID();
      let operation = (await client.submitOperation({ operationId, connectionId: options.profileId,
        mutation: { payload: { case: "setDeviceControllerAllowed", value: { controllerDeviceId: deviceId, allowed: false } } }
      }, { signal })).operation;
      while (true) {
        check(); signal.throwIfAborted();
        if (!operation || operation.operationId !== operationId || operation.connectionId !== options.profileId) {
          throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
        }
        if (operation.state === OperationState.SUCCEEDED) return;
        if ([OperationState.FAILED, OperationState.CONFLICT, OperationState.CANCELLED].includes(operation.state)) {
          throw new Error("REMOTE_DESKTOP_ACCESS_REVOKED");
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        operation = (await client.getOperation({ operationId }, { signal })).operation;
      }
    }
  };
}
function directoryTransport(origin: string, key?: string): Transport {
  return createConnectTransport({ baseUrl: origin, httpVersion: "1.1", useBinaryFormat: true, defaultTimeoutMs: 15_000,
    interceptors: key === undefined ? [] : [next => request => {
      request.header.set("authorization", `Bearer ${key}`); return next(request);
    }] });
}
