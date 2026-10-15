import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import type { ConnectionManager } from "./connection-manager.js";
import { PersonalDevelopmentNativeBroker, type DesktopDevelopmentRuntimeValue } from "./personal-development-native-broker.js";

function runtime(value: contract.DesktopDevelopmentRuntime | undefined): DesktopDevelopmentRuntimeValue {
  if (!value || (value.id !== "original" && value.id !== "personal")) throw new ConnectError("Native runtime proof is required.", Code.InvalidArgument);
  return { id: value.id, generation: value.generation, runtimeDirectory: value.runtimeDirectory, executable: value.executable,
    runtimeDigest: value.runtimeDigest, compatibilityIdentity: value.compatibilityIdentity, version: value.version, development: value.development };
}
export function createPersonalDevelopmentNativeConnectService(broker: PersonalDevelopmentNativeBroker | undefined,
  connections: ConnectionManager): ServiceImpl<typeof contract.DesktopPersonalDevelopmentHostService> {
  const scope = (context: HandlerContext) => {
    const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
    const authorization = context.requestHeader.get(DESKTOP_HOST_AUTHORIZATION_HEADER) ?? "";
    connections.authenticateDesktopHost(connection, authorization);
    if (!broker) throw new ConnectError("Local development host is unavailable.", Code.Unavailable);
    return { connection, authorization, broker };
  };
  const generation = (value: bigint): number => { if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("Invalid host generation.", Code.InvalidArgument); return Number(value); };
  return {
    registerDesktopDevelopmentHost: async (request, context) => {
      const auth = scope(context); context.signal.throwIfAborted();
      const hostGeneration = await auth.broker.register(auth.connection, auth.authorization, { hostInstanceId: request.hostInstanceId,
        profileIdentity: request.profileIdentity, original: runtime(request.original), current: runtime(request.current), busy: request.busy, launchTicketId: request.launchTicketId });
      context.signal.throwIfAborted(); connections.authenticateDesktopHost(auth.connection, auth.authorization);
      return create(contract.RegisterDesktopDevelopmentHostResponseSchema, { hostGeneration: BigInt(hostGeneration) });
    },
    pollDesktopDevelopmentCommand: async (request, context) => {
      const auth = scope(context), revoked = new AbortController();
      const stop = connections.onRevoked(auth.connection.id, () => revoked.abort());
      try {
        const command = await auth.broker.poll(auth.connection, auth.authorization, request.hostInstanceId, generation(request.hostGeneration), AbortSignal.any([context.signal, revoked.signal]));
        connections.authenticateDesktopHost(auth.connection, auth.authorization); context.signal.throwIfAborted();
        const kinds = { reveal: contract.DesktopDevelopmentCommandKind.REVEAL, handoff: contract.DesktopDevelopmentCommandKind.HANDOFF,
          testStart: contract.DesktopDevelopmentCommandKind.TEST_START, testStop: contract.DesktopDevelopmentCommandKind.TEST_STOP, testFind: contract.DesktopDevelopmentCommandKind.TEST_FIND,
          openDirectory: contract.DesktopDevelopmentCommandKind.OPEN_DIRECTORY };
        return create(contract.PollDesktopDevelopmentCommandResponseSchema, command === undefined ? {} : { command: { ...command, kind: kinds[command.kind],
          directory: command.directory === "source" ? contract.PersonalDevelopmentDirectoryKind.SOURCE : command.directory === "tools" ? contract.PersonalDevelopmentDirectoryKind.TOOLS : contract.PersonalDevelopmentDirectoryKind.UNSPECIFIED } });
      } finally { stop(); }
    },
    completeDesktopDevelopmentCommand: async (request, context) => {
      const auth = scope(context); context.signal.throwIfAborted();
      if (!["revealed", "opened", "prepared", "running", "retired", "unknown", "failed", "not_found"].includes(request.status)) throw new ConnectError("Invalid native result.", Code.InvalidArgument);
      const result = await auth.broker.complete(auth.connection, auth.authorization, request.hostInstanceId, generation(request.hostGeneration), request.commandId,
        { status: request.status as "prepared", receipt: request.receipt, ...(request.observedCurrent ? { observedCurrent: runtime(request.observedCurrent) } : {}) });
      connections.authenticateDesktopHost(auth.connection, auth.authorization); context.signal.throwIfAborted();
      return create(contract.CompleteDesktopDevelopmentCommandResponseSchema, result);
    }
  };
}
