import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { capabilityNames, portableSessionNativeFormat, type ConnectionService, type PortableSessionService,
  type PortableTaskCopyGrant, type PortableTaskCopyReceipt } from "@joko/contracts";
import { formatTrustedNodeInvitation } from "@joko/connection-transport/trust";
import type { AppSnapshot, BackendView, ConnectionProfile, SessionView, TargetView } from "./model.js";
import { portableSessionExportSupported } from "./portable-session-ui.js";

export interface TaskCopyChannel {
  readonly portable: Client<typeof PortableSessionService>;
  readonly connection: Client<typeof ConnectionService>;
  readonly signal: AbortSignal;
}

export interface TaskCopyDestination {
  readonly profile: ConnectionProfile;
  readonly backends: readonly BackendView[];
  readonly parentProjects: readonly TargetView[];
}

export interface TaskCopySelection {
  readonly profile: ConnectionProfile;
  readonly backendId: string;
  readonly parent?: Pick<TargetView, "id" | "revision">;
}

export interface TaskCopyApi {
  readonly owner: string;
  readonly machines: readonly ConnectionProfile[];
  loadDestination(profileId: string, source: SessionView, signal: AbortSignal): Promise<TaskCopyDestination>;
  copy(selection: TaskCopySelection, source: SessionView, operationId: string, signal: AbortSignal,
    onPhase: (phase: "preparing" | "transferring") => void): Promise<PortableTaskCopyReceipt>;
  receipt(selection: TaskCopySelection, operationId: string, signal: AbortSignal): Promise<PortableTaskCopyReceipt | undefined>;
}

export class TaskCopyOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("The destination may have committed this copy.", { cause });
  }
}

export function taskCopySourceSupported(session: SessionView, snapshot: AppSnapshot): boolean {
  return !session.hidden && !session.archived && session.state !== "closed" && !session.automationOrigin && !session.derivationOrigin?.sideChat
    && snapshot.targets.some(target => target.id === session.targetId && target.trusted && !target.remoteWorkspace && !target.archived)
    && portableSessionExportSupported(session, snapshot);
}

export function taskCopyDestination(profile: ConnectionProfile, snapshot: AppSnapshot, source: SessionView): TaskCopyDestination {
  const format = portableSessionNativeFormat(source.backendId);
  return {
    profile,
    backends: snapshot.backends.filter(backend => backend.health !== "unavailable"
      && backend.capabilities.get(capabilityNames.sessionPortableTransfer)?.supported === true
      && portableSessionNativeFormat(backend.id) === format),
    parentProjects: snapshot.targets.filter(target => target.trusted && !target.archived && !target.remoteWorkspace
      && snapshot.workspaces.some(workspace => workspace.id === target.workspaceId && workspace.kind === "userProject"))
  };
}

async function sourceRoute(channel: TaskCopyChannel, profile: ConnectionProfile): Promise<{ readonly origin: string; readonly invitation?: string }> {
  let origin = profile.origin;
  const key = profile.endpointPublicKey;
  if (!key) return { origin };
  if (new URL(origin).protocol !== "https:" || (profile.transportKind !== undefined && profile.transportKind !== "https")) {
    const directory = await channel.connection.listConnectionEntries({}, { signal: channel.signal, timeoutMs: 15_000 });
    if (directory.serverId !== profile.serverId || directory.endpointPublicKey !== key) throw new Error("The source connection directory changed identity.");
    origin = directory.entries.find(entry => entry.transportKind === "https" && !entry.requiresClientIdentity
      && !entry.requiresServerSetup && new URL(entry.origin).protocol === "https:")?.origin ?? origin;
  }
  // The receiving node dials the paired node's public identity. A renderer's
  // approved device identity and private connection locator never leave it.
  return { origin, invitation: formatTrustedNodeInvitation({ origin, endpointPublicKey: key, serverId: profile.serverId }) };
}

export async function copyPortableTask(input: {
  readonly operationId: string;
  readonly source: SessionView;
  readonly sourceProfile: ConnectionProfile;
  readonly selection: TaskCopySelection;
  readonly sourceChannel: TaskCopyChannel;
  readonly cancelSource: (grant: PortableTaskCopyGrant) => void;
  readonly destination: TaskCopyChannel;
  readonly assertCurrent: () => void;
  readonly assertTask: () => void;
  readonly onPhase: (phase: "preparing" | "transferring") => void;
}): Promise<PortableTaskCopyReceipt> {
  const { operationId, source, sourceProfile, selection, sourceChannel, destination, assertCurrent, onPhase } = input;
  const read = () => destination.portable.getPortableTaskCopyReceipt({ operationId }, { signal: destination.signal, timeoutMs: 15_000 });
  const saved = await read();
  assertCurrent();
  if (saved.receipt?.task && saved.receipt.operationId === operationId) return saved.receipt;
  if (saved.receipt) throw new Error("The destination returned an invalid task copy receipt.");
  input.assertTask();
  const route = await sourceRoute(sourceChannel, sourceProfile);
  assertCurrent();
  onPhase("preparing");
  const { grant } = await sourceChannel.portable.preparePortableTaskCopy({
    operationId, sessionId: source.id, expectedSessionGeneration: source.generation, destinationServerId: selection.profile.serverId
  }, { signal: sourceChannel.signal });
  if (!grant || grant.operationId !== operationId || grant.sourceServerId !== sourceProfile.serverId || grant.sourceSessionId !== source.id
    || grant.sourceSessionGeneration !== source.generation || grant.destinationServerId !== selection.profile.serverId) {
    throw new Error("The task copy failed to confirm its original source and destination.");
  }
  let transferring = false;
  let release = false;
  try {
    assertCurrent();
    onPhase("transferring");
    transferring = true;
    const result = await destination.portable.importPortableTaskCopy({
      grant, sourceOrigin: route.origin, sourceInvitation: route.invitation, backendId: selection.backendId,
      ...(selection.parent ? { parentTargetId: selection.parent.id, expectedParentRevision: { value: selection.parent.revision } } : {})
    }, { signal: destination.signal });
    if (!result.receipt?.task || result.receipt.operationId !== operationId) throw new TaskCopyOutcomeUnknownError(undefined);
    release = true;
    assertCurrent();
    return result.receipt;
  } catch (error) {
    if (!transferring) { release = true; throw error; }
    if (sourceChannel.signal.aborted || destination.signal.aborted) {
      release = true;
      throw new TaskCopyOutcomeUnknownError(error);
    }
    const code = ConnectError.from(error).code;
    if (error instanceof TaskCopyOutcomeUnknownError || code === Code.Unavailable || code === Code.DeadlineExceeded
      || code === Code.Unknown || code === Code.Internal || code === Code.Canceled) {
      const recovered = await read().catch(() => undefined);
      assertCurrent();
      if (recovered?.receipt?.task && recovered.receipt.operationId === operationId) {
        release = true;
        return recovered.receipt;
      }
      throw new TaskCopyOutcomeUnknownError(error);
    }
    release = true;
    throw error;
  } finally {
    if (release) input.cancelSource(grant);
    grant.readSecret.fill(0);
  }
}
