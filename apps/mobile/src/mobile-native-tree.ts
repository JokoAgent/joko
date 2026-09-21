import {
  BackgroundTaskState,
  CapabilitySupport,
  ConnectionState,
  DeviceKind,
  InteractionState,
  NativeEntryKind,
  QueueItemState,
  RunState,
  SessionState,
  capabilityNames,
  nativeSessionTreeRoots,
  type BackendDescriptor,
  type NativeSessionTree,
  type NativeSessionTreeNestedNode,
  type Session,
  type Snapshot
} from "@joko/contracts";

export interface MobileNativeTreeOwnerIdentity {
  readonly profileId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly serverId: string;
}

export interface MobileNativeTreeControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly session: Session;
  readonly backend: BackendDescriptor;
  readonly canNavigate: boolean;
  readonly navigationUnavailableReason?: string;
}

export interface MobileNativeTreeRow {
  readonly entryId: string;
  readonly parentEntryId?: string;
  readonly kind: "message" | "model" | "compaction" | "summary" | "custom";
  readonly role?: "user" | "assistant" | "tool";
  readonly label: string;
  readonly createdAtMs?: number;
  readonly active: boolean;
  readonly activePath: boolean;
  readonly branchDepth: number;
  readonly branching: boolean;
}

export interface MobileNativeTreeSnapshot {
  readonly authorityKey: string;
  readonly controlsAuthorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly sessionId: string;
  readonly revisionValue: bigint;
  readonly revisionEtag: string;
  readonly activeEntryId?: string;
  readonly rows: readonly MobileNativeTreeRow[];
}

export interface MobileNativeTreeNavigation {
  readonly entryId: string;
  readonly summarize: boolean;
  readonly customInstructions: string;
}

const maximumTreeDepth = 64;
const maximumTreeNodes = 2_000;
const maximumEntryText = 16_384;
const maximumInstructions = 4_000;

const activeRunStates = new Set([
  RunState.ACCEPTED,
  RunState.QUEUED,
  RunState.DISPATCHING,
  RunState.DISPATCH_UNKNOWN,
  RunState.RUNNING,
  RunState.WAITING,
  RunState.RETRYING
]);

const activeQueueStates = new Set([
  QueueItemState.ACCEPTED,
  QueueItemState.DISPATCHING,
  QueueItemState.BACKEND_ACCEPTED,
  QueueItemState.DISPATCH_UNKNOWN
]);

const activeBackgroundStates = new Set([
  BackgroundTaskState.QUEUED,
  BackgroundTaskState.RUNNING,
  BackgroundTaskState.WAITING
]);

export function resolveMobileNativeTreeControls(
  identity: MobileNativeTreeOwnerIdentity | undefined,
  owner: Snapshot | undefined,
  detail: Snapshot | undefined,
  selectedSessionId: string | undefined
): MobileNativeTreeControls | undefined {
  if (!identity || !owner || !detail || !strictText(selectedSessionId)
    || !strictText(identity.profileId) || !strictText(identity.connectionId)
    || !strictText(identity.deviceId) || !strictText(identity.serverId)
    || owner.scope?.kind.case !== "owner"
    || detail.scope?.kind.case !== "session" || detail.scope.kind.value.sessionId !== selectedSessionId
    || owner.server?.serverId !== identity.serverId || detail.server?.serverId !== identity.serverId
    || !validPositive(owner.generation) || detail.generation !== owner.generation
    || !validPositive(owner.revision?.value) || !validPositive(detail.revision?.value)) return undefined;

  const connections = owner.connections.filter((candidate) => candidate.connectionId === identity.connectionId);
  const devices = owner.devices.filter((candidate) => candidate.deviceId === identity.deviceId);
  if (connections.length !== 1 || devices.length !== 1) return undefined;
  const connection = connections[0]!;
  const device = devices[0]!;
  if (connection.connectionProfileId !== identity.profileId || connection.deviceId !== identity.deviceId
    || connection.state !== ConnectionState.CONNECTED || device.kind !== DeviceKind.MOBILE || device.revoked
    || !device.connectionIds.includes(identity.connectionId)) return undefined;

  const ownerSessions = owner.sessions.filter((candidate) => candidate.sessionId === selectedSessionId);
  const detailSessions = detail.sessions.filter((candidate) => candidate.sessionId === selectedSessionId);
  if (ownerSessions.length !== 1 || detailSessions.length !== 1) return undefined;
  const session = detailSessions[0]!;
  const ownerSession = ownerSessions[0]!;
  const generation = session.nativeBinding?.runtimeGeneration;
  const revision = session.version?.revision;
  if (!sameSessionAuthority(ownerSession, session) || !strictText(session.backendId) || !strictText(session.targetId)
    || !validPositive(generation) || session.version?.generation !== generation
    || !validPositive(revision?.value) || session.state === SessionState.UNSPECIFIED) return undefined;

  const ownerBackends = owner.backends.filter((candidate) => candidate.backendId === session.backendId);
  const detailBackends = detail.backends.filter((candidate) => candidate.backendId === session.backendId);
  const ownerTargets = owner.targets.filter((candidate) => candidate.targetId === session.targetId);
  const detailTargets = detail.targets.filter((candidate) => candidate.targetId === session.targetId);
  if (ownerBackends.length !== 1 || detailBackends.length !== 1 || ownerTargets.length !== 1 || detailTargets.length !== 1
    || !sameBackendAuthority(ownerBackends[0]!, detailBackends[0]!)
    || !sameTargetAuthority(ownerTargets[0]!, detailTargets[0]!)) return undefined;
  const backend = detailBackends[0]!;
  if (!exactSupportedCapability(backend, capabilityNames.sessionTree)) return undefined;

  const navigateSupported = exactSupportedCapability(backend, capabilityNames.sessionRewind);
  const activeRuns = detail.runs.filter((run) => run.sessionId === session.sessionId && activeRunStates.has(run.state));
  const activeQueue = detail.queueItems.filter((item) => item.sessionId === session.sessionId && activeQueueStates.has(item.state));
  const openInteractions = detail.interactions.filter((item) => item.sessionId === session.sessionId
    && item.state === InteractionState.PENDING);
  const activeBackground = detail.backgroundTasks.filter((item) => item.sessionId === session.sessionId
    && activeBackgroundStates.has(item.state));
  const reviewReadOnly = detail.reviewRuns.some((review) => review.reviewerSessionId === session.sessionId);
  const navigationUnavailableReason = !navigateSupported
    ? "This Backend does not advertise native branch navigation."
    : reviewReadOnly
      ? "Read-only review tasks cannot change native branches."
      : session.state !== SessionState.IDLE || activeRuns.length > 0 || activeQueue.length > 0
        || openInteractions.length > 0 || activeBackground.length > 0
        ? "Wait for the current task activity to finish before changing branches."
        : undefined;

  const authorityKey = JSON.stringify([
    identity.profileId,
    identity.connectionId,
    identity.deviceId,
    identity.serverId,
    owner.generation.toString(10),
    owner.snapshotId,
    owner.revision.value.toString(10),
    owner.revision.etag,
    detail.snapshotId,
    detail.revision.value.toString(10),
    detail.revision.etag,
    session.sessionId,
    session.backendId,
    session.targetId,
    generation.toString(10),
    revision.value.toString(10),
    revision.etag,
    backend.entityVersion?.generation.toString(10) ?? "",
    backend.entityVersion?.revision?.value.toString(10) ?? "",
    backend.entityVersion?.revision?.etag ?? "",
    backend.capabilities?.revision?.value.toString(10) ?? "",
    backend.capabilities?.revision?.etag ?? "",
    ownerTargets[0]!.version?.generation.toString(10) ?? "",
    ownerTargets[0]!.version?.revision?.value.toString(10) ?? "",
    ownerTargets[0]!.version?.revision?.etag ?? "",
    session.state,
    reviewReadOnly,
    activeRuns.map(versionedIdentity).sort(compareIdentity),
    activeQueue.map(versionedIdentity).sort(compareIdentity),
    openInteractions.map(versionedIdentity).sort(compareIdentity),
    activeBackground.map(versionedIdentity).sort(compareIdentity)
  ]);
  const surfaceOwnerKey = JSON.stringify([
    identity.profileId,
    identity.connectionId,
    identity.deviceId,
    identity.serverId,
    session.sessionId,
    session.backendId,
    session.targetId,
    generation.toString(10)
  ]);
  return {
    authorityKey,
    surfaceOwnerKey,
    session,
    backend,
    canNavigate: navigationUnavailableReason === undefined,
    ...(navigationUnavailableReason === undefined ? {} : { navigationUnavailableReason })
  };
}

export function projectMobileNativeTree(
  controls: MobileNativeTreeControls,
  tree: NativeSessionTree
): MobileNativeTreeSnapshot {
  const revision = controls.session.version?.revision;
  if (tree.sessionId !== controls.session.sessionId || !revision || !tree.revision
    || tree.revision.value !== revision.value || tree.revision.etag !== revision.etag) {
    throw new Error("The Joko node returned a native tree for a different task revision.");
  }
  if (tree.activeEntryId && !validIdentifier(tree.activeEntryId)) {
    throw new Error("The Joko node returned an invalid active native entry.");
  }
  let roots: NativeSessionTreeNestedNode[];
  try { roots = nativeSessionTreeRoots(tree); }
  catch { throw new Error("The Joko node returned an invalid native tree encoding."); }

  const flat: Array<{
    readonly node: NativeSessionTreeNestedNode;
    readonly depth: number;
    readonly expectedParent?: string;
  }> = [];
  const stack: Array<{ readonly node: NativeSessionTreeNestedNode; readonly depth: number; readonly expectedParent?: string }> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) stack.push({ node: roots[index]!, depth: 0 });
  const parents = new Map<string, string | undefined>();
  let activeCount = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (flat.length >= maximumTreeNodes || frame.depth > maximumTreeDepth) {
      throw new Error("The native tree exceeds the mobile display limit.");
    }
    const node = frame.node;
    if (!validIdentifier(node.entryId) || node.parentEntryId !== (frame.expectedParent ?? "")
      || node.kind === NativeEntryKind.UNSPECIFIED || node.summary.length > maximumEntryText
      || node.summary.includes("\0") || timestampMilliseconds(node.createdAt) === null) {
      throw new Error("The Joko node returned an invalid native tree node.");
    }
    if (node.active) activeCount += 1;
    parents.set(node.entryId, frame.expectedParent);
    flat.push(frame);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: node.children[index]!, depth: frame.depth + 1, expectedParent: node.entryId });
    }
  }
  const activeEntry = tree.activeEntryId || undefined;
  if ((activeEntry === undefined && activeCount !== 0)
    || (activeEntry !== undefined && (activeCount !== 1 || !parents.has(activeEntry)))) {
    throw new Error("The Joko node returned inconsistent native tree activity.");
  }
  if (activeEntry !== undefined && !flat.some(({ node }) => node.entryId === activeEntry && node.active)) {
    throw new Error("The Joko node returned an inconsistent active native entry.");
  }

  const activePath = new Set<string>();
  let current = activeEntry;
  while (current !== undefined) {
    if (activePath.has(current)) throw new Error("The Joko node returned a cyclic native tree path.");
    activePath.add(current);
    current = parents.get(current);
  }

  const rows = layoutRows(roots, activePath);
  const authorityKey = JSON.stringify([
    controls.authorityKey,
    tree.sessionId,
    revision.value.toString(10),
    revision.etag,
    activeEntry ?? "",
    rows.map((row) => [row.entryId, row.parentEntryId ?? "", row.kind, row.role ?? "", row.active])
  ]);
  return {
    authorityKey,
    controlsAuthorityKey: controls.authorityKey,
    surfaceOwnerKey: controls.surfaceOwnerKey,
    sessionId: tree.sessionId,
    revisionValue: revision.value,
    revisionEtag: revision.etag,
    ...(activeEntry === undefined ? {} : { activeEntryId: activeEntry }),
    rows
  };
}

export function assertMobileNativeTreeNavigation(
  controls: MobileNativeTreeControls,
  tree: MobileNativeTreeSnapshot,
  entryId: string,
  summarize: boolean,
  customInstructions: string
): MobileNativeTreeNavigation {
  if (!controls.canNavigate) {
    throw new Error(controls.navigationUnavailableReason ?? "Native branch navigation is unavailable.");
  }
  const revision = controls.session.version?.revision;
  if (!revision || tree.controlsAuthorityKey !== controls.authorityKey
    || tree.surfaceOwnerKey !== controls.surfaceOwnerKey || tree.sessionId !== controls.session.sessionId
    || tree.revisionValue !== revision.value || tree.revisionEtag !== revision.etag) {
    throw new Error("The task branch tree changed. Refresh it before navigating.");
  }
  if (!validIdentifier(entryId) || !tree.rows.some((row) => row.entryId === entryId)) {
    throw new Error("Choose an entry from the current native branch tree.");
  }
  if (tree.activeEntryId === entryId) throw new Error("This native branch is already active.");
  const focus = customInstructions.trim();
  if (focus.length > maximumInstructions) throw new Error("Branch summary focus must not exceed 4000 characters.");
  return { entryId, summarize, customInstructions: summarize ? focus : "" };
}

function layoutRows(
  roots: readonly NativeSessionTreeNestedNode[],
  activePath: ReadonlySet<string>
): MobileNativeTreeRow[] {
  const rows: MobileNativeTreeRow[] = [];
  const multipleRoots = roots.length > 1;
  const stack: Array<{ readonly node: NativeSessionTreeNestedNode; readonly branchDepth: number; readonly justBranched: boolean }> = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({ node: roots[index]!, branchDepth: multipleRoots ? 1 : 0, justBranched: multipleRoots });
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const branching = frame.node.children.length > 1;
    rows.push({
      entryId: frame.node.entryId,
      ...(frame.node.parentEntryId ? { parentEntryId: frame.node.parentEntryId } : {}),
      kind: mobileNodeKind(frame.node.kind),
      ...roleFor(frame.node.kind),
      label: frame.node.summary || fallbackLabel(frame.node.kind),
      ...timestampField(frame.node.createdAt),
      active: frame.node.active,
      activePath: activePath.has(frame.node.entryId),
      branchDepth: frame.branchDepth,
      branching
    });
    const childDepth = branching
      ? frame.branchDepth + 1
      : frame.justBranched && frame.branchDepth > 0
        ? frame.branchDepth + 1
        : frame.branchDepth;
    for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: frame.node.children[index]!, branchDepth: childDepth, justBranched: branching });
    }
  }
  return rows;
}

function roleFor(kind: NativeEntryKind): Pick<MobileNativeTreeRow, "role"> {
  if (kind === NativeEntryKind.USER_MESSAGE) return { role: "user" };
  if (kind === NativeEntryKind.ASSISTANT_MESSAGE) return { role: "assistant" };
  if (kind === NativeEntryKind.TOOL_RESULT) return { role: "tool" };
  return {};
}

function mobileNodeKind(kind: NativeEntryKind): MobileNativeTreeRow["kind"] {
  if ([NativeEntryKind.USER_MESSAGE, NativeEntryKind.ASSISTANT_MESSAGE, NativeEntryKind.TOOL_RESULT].includes(kind)) return "message";
  if (kind === NativeEntryKind.MODEL_CHANGE) return "model";
  if (kind === NativeEntryKind.COMPACTION) return "compaction";
  if (kind === NativeEntryKind.BRANCH_SUMMARY) return "summary";
  return "custom";
}

function fallbackLabel(kind: NativeEntryKind): string {
  if (kind === NativeEntryKind.USER_MESSAGE) return "User message";
  if (kind === NativeEntryKind.ASSISTANT_MESSAGE) return "Assistant message";
  if (kind === NativeEntryKind.TOOL_RESULT) return "Tool result";
  if (kind === NativeEntryKind.MODEL_CHANGE) return "Model change";
  if (kind === NativeEntryKind.COMPACTION) return "Context compaction";
  if (kind === NativeEntryKind.BRANCH_SUMMARY) return "Branch summary";
  return "Native entry";
}

function timestampField(value: NativeSessionTreeNestedNode["createdAt"]): Pick<MobileNativeTreeRow, "createdAtMs"> {
  const milliseconds = timestampMilliseconds(value);
  return milliseconds === undefined || milliseconds === null ? {} : { createdAtMs: milliseconds };
}

function timestampMilliseconds(value: NativeSessionTreeNestedNode["createdAt"]): number | undefined | null {
  if (value === undefined) return undefined;
  if (value.nanos < 0 || value.nanos >= 1_000_000_000) return null;
  const milliseconds = value.seconds * 1_000n + BigInt(Math.floor(value.nanos / 1_000_000));
  if (milliseconds < 0n || milliseconds > 8_640_000_000_000_000n) return null;
  return Number(milliseconds);
}

function versionedIdentity(value: {
  readonly runId?: string;
  readonly queueItemId?: string;
  readonly interactionId?: string;
  readonly backgroundTaskId?: string;
  readonly state: number;
  readonly version?: { readonly generation: bigint; readonly revision?: { readonly value: bigint; readonly etag: string } };
}): readonly (string | number)[] {
  return [value.runId ?? value.queueItemId ?? value.interactionId ?? value.backgroundTaskId ?? "", value.state,
    value.version?.generation.toString(10) ?? "", value.version?.revision?.value.toString(10) ?? "",
    value.version?.revision?.etag ?? ""];
}

function compareIdentity(left: readonly (string | number)[], right: readonly (string | number)[]): number {
  return String(left[0]).localeCompare(String(right[0]));
}

function exactSupportedCapability(backend: BackendDescriptor, name: string): boolean {
  const matches = backend.capabilities?.capabilities.filter((candidate) => candidate.name === name) ?? [];
  return matches.length === 1 && matches[0]!.support === CapabilitySupport.SUPPORTED;
}

function sameBackendAuthority(left: BackendDescriptor, right: BackendDescriptor): boolean {
  return strictText(left.capabilities?.schemaVersion) && left.capabilities?.schemaVersion === right.capabilities?.schemaVersion
    && validPositive(left.entityVersion?.generation) && validPositive(left.entityVersion?.revision?.value)
    && validPositive(left.capabilities?.revision?.value)
    && left.entityVersion?.generation === right.entityVersion?.generation
    && left.entityVersion?.revision?.value === right.entityVersion?.revision?.value
    && left.entityVersion?.revision?.etag === right.entityVersion?.revision?.etag
    && left.capabilities?.revision?.value === right.capabilities?.revision?.value
    && left.capabilities?.revision?.etag === right.capabilities?.revision?.etag;
}

function sameSessionAuthority(left: Session, right: Session): boolean {
  return left.sessionId === right.sessionId && left.backendId === right.backendId && left.targetId === right.targetId
    && validPositive(left.version?.revision?.value)
    && left.version?.revision?.value === right.version?.revision?.value
    && left.version?.revision?.etag === right.version?.revision?.etag
    && left.version?.generation === right.version?.generation
    && left.nativeBinding?.backendId === right.nativeBinding?.backendId
    && left.nativeBinding?.opaqueReference === right.nativeBinding?.opaqueReference
    && left.nativeBinding?.runtimeGeneration === right.nativeBinding?.runtimeGeneration;
}

function sameTargetAuthority(left: Snapshot["targets"][number], right: Snapshot["targets"][number]): boolean {
  return left.targetId === right.targetId && left.backendId === right.backendId && left.state === right.state
    && validPositive(left.version?.revision?.value)
    && left.version?.revision?.value === right.version?.revision?.value
    && left.version?.revision?.etag === right.version?.revision?.etag
    && left.version?.generation === right.version?.generation;
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validPositive(value: bigint | undefined): value is bigint {
  return value !== undefined && value > 0n && value <= 18_446_744_073_709_551_615n;
}

function strictText(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.trim() === value;
}
