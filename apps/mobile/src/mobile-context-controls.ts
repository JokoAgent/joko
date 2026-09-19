import {
  CapabilitySupport,
  CompactionState,
  ConnectionState,
  DeviceKind,
  RunState,
  SessionState,
  capabilityNames,
  type BackendDescriptor,
  type ContextUsage,
  type Event,
  type Session,
  type Snapshot,
  type Usage
} from "@joko/contracts";

export interface MobileContextOwnerIdentity {
  readonly profileId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly serverId: string;
}

export interface MobileCumulativeUsage {
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly totalTokens: bigint;
}

export interface MobileContextUsage {
  readonly usedTokens: bigint;
  readonly contextWindowTokens: bigint;
  readonly reservedTokens: bigint;
  readonly utilizationRatio: number;
  readonly percent: number;
  readonly measuredAtMs?: number;
  readonly cumulative?: MobileCumulativeUsage;
}

export interface MobileActiveCompaction {
  readonly compactionId: string;
  readonly automatic: boolean;
  readonly reason: string;
  readonly tokensBefore: bigint;
}

export interface MobileContextControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly session: Session;
  readonly backend: BackendDescriptor;
  readonly usageSupported: boolean;
  readonly compactSupported: boolean;
  readonly usage?: MobileContextUsage;
  readonly activeCompaction?: MobileActiveCompaction;
  readonly canCompact: boolean;
  readonly compactUnavailableReason?: string;
}

export type MobileCompactOutcome = "compacted" | "noop";

const activeRunStates = new Set([
  RunState.ACCEPTED,
  RunState.QUEUED,
  RunState.DISPATCHING,
  RunState.DISPATCH_UNKNOWN,
  RunState.RUNNING,
  RunState.WAITING,
  RunState.RETRYING
]);

const blockedSessionStates = new Set([
  SessionState.CREATING,
  SessionState.RUNNING,
  SessionState.WAITING,
  SessionState.RECOVERING,
  SessionState.CLOSING,
  SessionState.CLOSED
]);

export function resolveMobileContextControls(
  identity: MobileContextOwnerIdentity | undefined,
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedSessionId: string | undefined
): MobileContextControls | undefined {
  if (!identity || !owner || !detail || !strictText(selectedSessionId)
    || !strictText(identity.profileId) || !strictText(identity.connectionId)
    || !strictText(identity.deviceId) || !strictText(identity.serverId)
    || owner.scope?.kind.case !== "owner"
    || detail.scope?.kind.case !== "session" || detail.scope.kind.value.sessionId !== selectedSessionId
    || owner.server?.serverId !== identity.serverId || detail.server?.serverId !== identity.serverId
    || !validPositive(owner.generation) || detail.generation !== owner.generation
    || !positiveRevision(owner) || !positiveRevision(detail)) return undefined;

  const connections = owner.connections.filter((candidate) => candidate.connectionId === identity.connectionId);
  const devices = owner.devices.filter((candidate) => candidate.deviceId === identity.deviceId);
  if (connections.length !== 1 || devices.length !== 1) return undefined;
  const connection = connections[0]!;
  const device = devices[0]!;
  if (connection.connectionProfileId !== identity.profileId || connection.deviceId !== identity.deviceId
    || connection.state !== ConnectionState.CONNECTED || device.kind !== DeviceKind.MOBILE
    || device.revoked || !device.connectionIds.includes(identity.connectionId)) return undefined;

  const detailSessions = detail.sessions.filter((candidate) => candidate.sessionId === selectedSessionId);
  const ownerSessions = owner.sessions.filter((candidate) => candidate.sessionId === selectedSessionId);
  if (detailSessions.length !== 1 || ownerSessions.length !== 1) return undefined;
  const session = detailSessions[0]!;
  const ownerSession = ownerSessions[0]!;
  const runtimeGeneration = session.nativeBinding?.runtimeGeneration;
  const sessionRevision = session.version?.revision?.value;
  if (!strictText(session.backendId) || !strictText(session.targetId)
    || !sameSessionAuthority(ownerSession, session)
    || !runtimeGeneration || !validPositive(runtimeGeneration)
    || !sessionRevision || !validPositive(sessionRevision)
    || session.version?.generation !== runtimeGeneration
    || session.state === SessionState.UNSPECIFIED) return undefined;

  const backends = detail.backends.filter((candidate) => candidate.backendId === session.backendId);
  const ownerBackends = owner.backends.filter((candidate) => candidate.backendId === session.backendId);
  const targets = detail.targets.filter((candidate) => candidate.targetId === session.targetId);
  const ownerTargets = owner.targets.filter((candidate) => candidate.targetId === session.targetId);
  if (backends.length !== 1 || ownerBackends.length !== 1 || targets.length !== 1 || ownerTargets.length !== 1) {
    return undefined;
  }
  const backend = backends[0]!;
  if (targets[0]!.backendId !== session.backendId || ownerTargets[0]!.backendId !== session.backendId
    || !sameBackendAuthority(ownerBackends[0]!, backend)
    || !sameTargetAuthority(ownerTargets[0]!, targets[0]!)) return undefined;

  const usageCapability = typedContextCapability(backend, capabilityNames.contextUsage);
  const compactCapability = typedContextCapability(backend, capabilityNames.contextCompact);
  const usageSupported = usageCapability?.reportsBoundary === true;
  const compactSupported = compactCapability?.manual === true;
  if (!usageSupported && !compactSupported) return undefined;

  const normalizedUsage = usageSupported ? normalizeContextUsage(session.context) : undefined;
  if (normalizedUsage === null) return undefined;
  const compaction = activeCompaction(detail, session);
  if (compaction === null) return undefined;
  const activeRuns = detail.runs.filter((run) => run.sessionId === session.sessionId && activeRunStates.has(run.state));
  const reviewReadOnly = detail.reviewRuns.some((review) => review.reviewerSessionId === session.sessionId);
  const stateBlocked = blockedSessionStates.has(session.state);
  const active = session.contextState?.compacting === true || compaction !== undefined;

  const compactUnavailableReason = !compactSupported
    ? "This Backend does not advertise manual context compaction."
    : normalizedUsage === undefined
      ? "Current context usage is unavailable."
      : normalizedUsage.usedTokens < 1n
        ? "There is no measured context to compact."
        : reviewReadOnly
          ? "Read-only review tasks cannot compact context."
          : stateBlocked || activeRuns.length > 0
            ? "Wait for the current task activity to finish before compacting."
            : active
              ? "This task is already compacting context."
              : undefined;
  const canCompact = compactUnavailableReason === undefined;

  const contextAuthority = normalizedUsage === undefined ? ["missing"] : [
    normalizedUsage.usedTokens.toString(10),
    normalizedUsage.contextWindowTokens.toString(10),
    normalizedUsage.reservedTokens.toString(10),
    normalizedUsage.utilizationRatio.toString(),
    normalizedUsage.measuredAtMs?.toString(10) ?? "",
    ...(normalizedUsage.cumulative === undefined ? ["no-cumulative"] : [
      normalizedUsage.cumulative.inputTokens.toString(10),
      normalizedUsage.cumulative.outputTokens.toString(10),
      normalizedUsage.cumulative.cacheReadTokens.toString(10),
      normalizedUsage.cumulative.cacheWriteTokens.toString(10),
      normalizedUsage.cumulative.totalTokens.toString(10)
    ])
  ];
  const activeRunAuthority = activeRuns
    .map((run) => [run.runId, run.state, run.version?.generation?.toString(10) ?? "",
      run.version?.revision?.value.toString(10) ?? ""])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const authorityKey = JSON.stringify([
    identity.profileId,
    identity.connectionId,
    identity.deviceId,
    identity.serverId,
    owner.generation.toString(10),
    owner.snapshotId,
    owner.revision?.value.toString(10) ?? "",
    owner.revision?.etag ?? "",
    detail.snapshotId,
    detail.revision?.value.toString(10) ?? "",
    detail.revision?.etag ?? "",
    session.sessionId,
    session.backendId,
    session.targetId,
    runtimeGeneration.toString(10),
    sessionRevision.toString(10),
    session.version?.revision?.etag ?? "",
    backend.entityVersion?.generation.toString(10) ?? "",
    backend.entityVersion?.revision?.value.toString(10) ?? "",
    backend.capabilities?.revision?.value.toString(10) ?? "",
    ...contextAuthority,
    session.contextState?.compacting ?? null,
    session.contextState?.autoCompaction ?? null,
    compaction?.compactionId ?? "",
    compaction?.tokensBefore.toString(10) ?? "",
    reviewReadOnly,
    activeRunAuthority
  ]);
  const surfaceOwnerKey = JSON.stringify([
    identity.profileId,
    identity.connectionId,
    identity.deviceId,
    identity.serverId,
    session.sessionId,
    session.backendId,
    session.targetId,
    runtimeGeneration.toString(10)
  ]);

  return {
    authorityKey,
    surfaceOwnerKey,
    session,
    backend,
    usageSupported,
    compactSupported,
    ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
    ...(compaction === undefined ? {} : { activeCompaction: compaction }),
    canCompact,
    ...(compactUnavailableReason === undefined ? {} : { compactUnavailableReason })
  };
}

export function assertMobileContextCompact(controls: MobileContextControls): Session {
  if (!controls.canCompact) {
    throw new Error(controls.compactUnavailableReason ?? "Context compaction is unavailable for the current task.");
  }
  return controls.session;
}

export function formatMobileContextTokens(value: bigint): string {
  if (value < 0n) return "Unavailable";
  if (value < 1_000n) return value.toString(10);
  if (value < 1_000_000n) return scaledTokenCount(value, 1_000n, "K");
  if (value < 1_000_000_000n) return scaledTokenCount(value, 1_000_000n, "M");
  return scaledTokenCount(value, 1_000_000_000n, "B");
}

function scaledTokenCount(value: bigint, divisor: bigint, suffix: string): string {
  const tenths = (value * 10n + divisor / 2n) / divisor;
  const whole = tenths / 10n;
  const decimal = tenths % 10n;
  return decimal === 0n ? `${whole}${suffix}` : `${whole}.${decimal}${suffix}`;
}

function normalizeContextUsage(value: ContextUsage | undefined): MobileContextUsage | undefined | null {
  if (value === undefined) return undefined;
  if (![value.usedTokens, value.contextWindowTokens, value.reservedTokens].every(validUnsigned)
    || value.contextWindowTokens < 1n
    || !Number.isFinite(value.utilizationRatio) || value.utilizationRatio < 0 || value.utilizationRatio > 1) {
    return null;
  }
  const expectedReserved = value.usedTokens >= value.contextWindowTokens
    ? 0n
    : value.contextWindowTokens - value.usedTokens;
  const expectedBasisPoints = value.contextWindowTokens === 0n
    ? 0n
    : value.usedTokens >= value.contextWindowTokens
      ? 10_000n
      : (value.usedTokens * 10_000n) / value.contextWindowTokens;
  const expectedRatio = Number(expectedBasisPoints) / 10_000;
  if (value.reservedTokens !== expectedReserved || Math.abs(expectedRatio - value.utilizationRatio) > 0.001) return null;
  const measuredAtMs = timestampMilliseconds(value.measuredAt);
  if (measuredAtMs === null) return null;
  const cumulative = normalizeCumulativeUsage(value.cumulativeUsage);
  if (cumulative === null) return null;
  return {
    usedTokens: value.usedTokens,
    contextWindowTokens: value.contextWindowTokens,
    reservedTokens: value.reservedTokens,
    utilizationRatio: expectedRatio,
    percent: Number((expectedBasisPoints + 50n) / 100n),
    ...(measuredAtMs === undefined ? {} : { measuredAtMs }),
    ...(cumulative === undefined ? {} : { cumulative })
  };
}

function normalizeCumulativeUsage(value: Usage | undefined): MobileCumulativeUsage | undefined | null {
  if (value === undefined) return undefined;
  if (![value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.totalTokens]
    .every(validUnsigned)) return null;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cacheReadTokens: value.cacheReadTokens,
    cacheWriteTokens: value.cacheWriteTokens,
    totalTokens: value.totalTokens
  };
}

function timestampMilliseconds(value: ContextUsage["measuredAt"]): number | undefined | null {
  if (value === undefined) return undefined;
  if (value.nanos < 0 || value.nanos >= 1_000_000_000) return null;
  const milliseconds = value.seconds * 1_000n + BigInt(Math.floor(value.nanos / 1_000_000));
  if (milliseconds < 0n || milliseconds > 8_640_000_000_000_000n) return null;
  return Number(milliseconds);
}

function activeCompaction(detail: Snapshot, session: Session): MobileActiveCompaction | undefined | null {
  const observations = new Map<string, { readonly sequence: bigint; readonly state: CompactionState;
    readonly automatic: boolean; readonly reason: string; readonly tokensBefore: bigint }>();
  for (const event of detail.timeline) {
    const payload = event.payload?.kind;
    if (payload?.case !== "compactionChanged" || event.identity?.sessionId !== session.sessionId) continue;
    if (event.identity.generation !== session.nativeBinding?.runtimeGeneration) continue;
    if (!validCompactionEvent(event, detail, session)) return null;
    const compaction = payload.value;
    const sequence = event.cursor!.sequence;
    const prior = observations.get(compaction.compactionId);
    if (prior && prior.sequence === sequence && prior.state !== compaction.state) return null;
    if (!prior || prior.sequence < sequence) {
      observations.set(compaction.compactionId, {
        sequence,
        state: compaction.state,
        automatic: compaction.automatic,
        reason: compaction.reason,
        tokensBefore: compaction.tokensBefore
      });
    }
  }
  const active = [...observations].filter(([, observation]) => observation.state === CompactionState.STARTED);
  if (active.length > 1) return null;
  if (active.length === 1) {
    const [compactionId, observation] = active[0]!;
    return {
      compactionId,
      automatic: observation.automatic,
      reason: observation.reason,
      tokensBefore: observation.tokensBefore
    };
  }
  if (session.contextState?.compacting === true) {
    return { compactionId: "active", automatic: false, reason: "", tokensBefore: session.context?.usedTokens ?? 0n };
  }
  return undefined;
}

function validCompactionEvent(event: Event, detail: Snapshot, session: Session): boolean {
  const payload = event.payload?.kind;
  const identity = event.identity;
  const cursor = event.cursor;
  if (payload?.case !== "compactionChanged" || !identity || !cursor
    || identity.backendId !== session.backendId || identity.targetId !== session.targetId
    || identity.sessionId !== session.sessionId
    || identity.generation !== session.nativeBinding?.runtimeGeneration
    || cursor.generation !== detail.generation || cursor.sequence < 1n
    || !strictText(payload.value.compactionId) || !validUnsigned(payload.value.tokensBefore)) return false;
  return [CompactionState.STARTED, CompactionState.COMPLETED, CompactionState.NO_OP,
    CompactionState.ABORTED, CompactionState.FAILED].includes(payload.value.state);
}

function typedContextCapability(backend: BackendDescriptor, name: string) {
  const matches = backend.capabilities?.capabilities.filter((candidate) => candidate.name === name) ?? [];
  if (matches.length !== 1 || matches[0]!.support !== CapabilitySupport.SUPPORTED
    || matches[0]!.options?.kind.case !== "context") return undefined;
  return matches[0]!.options.kind.value;
}

function sameBackendAuthority(left: BackendDescriptor, right: BackendDescriptor): boolean {
  return strictText(left.capabilities?.schemaVersion) && left.capabilities?.schemaVersion === right.capabilities?.schemaVersion
    && validPositive(left.entityVersion?.generation)
    && validPositive(left.entityVersion?.revision?.value)
    && validPositive(left.capabilities?.revision?.value)
    && left.entityVersion?.generation === right.entityVersion?.generation
    && left.entityVersion?.revision?.value === right.entityVersion?.revision?.value
    && left.entityVersion?.revision?.etag === right.entityVersion?.revision?.etag
    && left.capabilities?.revision?.value === right.capabilities?.revision?.value
    && left.capabilities?.revision?.etag === right.capabilities?.revision?.etag;
}

function sameSessionAuthority(left: Session, right: Session): boolean {
  return left.sessionId === right.sessionId
    && left.backendId === right.backendId
    && left.targetId === right.targetId
    && validPositive(left.version?.revision?.value)
    && left.version?.revision?.value === right.version?.revision?.value
    && left.version?.revision?.etag === right.version?.revision?.etag
    && left.version?.generation === right.version?.generation
    && left.nativeBinding?.backendId === right.nativeBinding?.backendId
    && left.nativeBinding?.opaqueReference === right.nativeBinding?.opaqueReference
    && left.nativeBinding?.runtimeGeneration === right.nativeBinding?.runtimeGeneration;
}

function sameTargetAuthority(left: Snapshot["targets"][number], right: Snapshot["targets"][number]): boolean {
  return left.targetId === right.targetId
    && left.backendId === right.backendId
    && left.state === right.state
    && validPositive(left.version?.revision?.value)
    && left.version?.revision?.value === right.version?.revision?.value
    && left.version?.revision?.etag === right.version?.revision?.etag
    && left.version?.generation === right.version?.generation;
}

function validUnsigned(value: bigint): boolean {
  return value >= 0n && value <= 18_446_744_073_709_551_615n;
}

function validPositive(value: bigint | undefined): value is bigint {
  return value !== undefined && value > 0n && validUnsigned(value);
}

function positiveRevision(snapshot: Snapshot): boolean {
  return validPositive(snapshot.revision?.value);
}

function strictText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.trim() === value;
}
