export type ConnectionId = string;
export type BackendId = string;
export type TargetId = string;
export type SessionId = string;
export type RunId = string;
export type AttemptId = string;
export type QueueItemId = string;
export type OperationId = string;
export type EventId = string;
export type InteractionId = string;
export type ScheduleId = string;
export type ToolLeaseId = string;
export type ArtifactId = string;

export type UnixMillis = number;

export type CapabilityReason =
  | "upstream_missing"
  | "not_implemented"
  | "platform_limited"
  | "policy_denied";

export interface Capability {
  readonly key: string;
  readonly supported: boolean;
  readonly reason?: CapabilityReason;
  readonly detail?: string;
  readonly options?: readonly string[];
}

export type CapabilityManifest = ReadonlyMap<string, Capability>;

export const CAPABILITIES = [
  "session.discovery",
  "session.catalog",
  "session.auto_title",
  "session.ai_rename",
  "session.summary",
  "session.resume",
  "session.detach",
  "session.fork",
  "session.rewind",
  "session.tree",
  "session.clone",
  "session.export",
  "session.portable_transfer",
  "session.attention",
  "session.message_delete",
  "session.reset",
  "review.isolated",
  "turn.stream",
  "turn.abort",
  "turn.graceful_stop",
  "turn.steer",
  "turn.follow_up",
  "input.text",
  "input.image",
  "input.file",
  "input.mention",
  "model.list",
  "model.switch",
  "model.effort",
  "model.fast_mode",
  "provider.managed_catalog",
  "provider.account_usage",
  "provider.login",
  "provider.logout",
  "provider.refresh",
  "provider.model_refresh",
  "permission.modes",
  "permission.change",
  "plan_mode",
  "context.usage",
  "context.compact",
  "context.auto_compact",
  "context.auto_retry",
  "memory.curated",
  "memory.compaction_digest",
  "context.silent_encrypted_retry",
  "workspace.files",
  "workspace.files.watch",
  "workspace.files.write",
  "workspace.diff",
  "workspace.generated_files",
  "workspace.diff.sources",
  "workspace.diff.image_preview",
  "workspace.diff.stage",
  "workspace.diff.unstage",
  "workspace.diff.revert",
  "workspace.diff.commit",
  "workspace.diff.push",
  "workspace.rewind",
  "workspace.extra_dirs",
  "interaction.permission",
  "interaction.question",
  "interaction.plan_review",
  "background.tasks",
  "background.tasks.cancel",
  "subagents.list",
  "subagents.detail",
  "subagents.transcript",
  "subagents.stop",
  "subagents.steer",
  "subagents.follow_up",
  "subagents.resume",
  "runtime.commands",
  "runtime.tools",
  "runtime.resources",
  "runtime.process_usage",
  "runtime.process_terminate",
  "runtime.user_shell",
  "tool.mcp",
  "tool.browser",
  "tool.computer",
  "tool.android"
] as const;

export type KnownCapability = (typeof CAPABILITIES)[number];

/** Capabilities implemented entirely by the product Host and safely composed onto any Adapter. */
export const HOST_COMPOSED_CAPABILITIES = [
  "session.attention",
  "session.auto_title",
  "session.summary",
  "workspace.files",
  "workspace.files.watch",
  "workspace.files.write",
  "workspace.diff",
  "workspace.generated_files",
  "workspace.diff.sources",
  "workspace.diff.image_preview",
  "workspace.diff.stage",
  "workspace.diff.unstage",
  "workspace.diff.revert",
  "workspace.diff.commit",
  "workspace.diff.push",
  "workspace.rewind"
] as const satisfies readonly KnownCapability[];

export type HostComposedCapability = (typeof HOST_COMPOSED_CAPABILITIES)[number];

export type PermissionMode = "ask" | "auto" | "bypassPermissions";
export type InputDisposition = "prompt" | "steer" | "follow_up";
export type QueueState =
  | "accepted"
  | "dispatching"
  | "backend_accepted"
  | "dispatch_unknown"
  | "completed"
  | "cancelled"
  | "failed";
export type RunState =
  | "queued"
  | "running"
  | "waiting"
  | "retrying"
  | "completed"
  | "aborted"
  | "failed"
  | "dispatch_unknown";

export interface BlobRef {
  readonly id: ArtifactId;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly fileName?: string;
}

export interface ImageInput {
  readonly blob: BlobRef;
  readonly alt?: string;
}

export interface FileInput {
  readonly blob: BlobRef;
  readonly workspacePath?: string;
}

export interface MentionInput {
  readonly kind: "workspace_file" | "resource" | "artifact";
  readonly label: string;
  readonly reference: string;
}

/** UTF-16 offsets identifying an inline source span with a compact display label. */
export interface InlineTextRange {
  readonly start: number;
  readonly end: number;
  readonly display: string;
}

export const INLINE_TEXT_RANGE_DISPLAY_LIMIT = 500;

/**
 * Validate wire/durable inline ranges without reordering or repairing them.
 * Offsets use JavaScript UTF-16 code units and may not split a surrogate pair.
 */
export function validInlineTextRanges(
  text: string,
  ranges: readonly InlineTextRange[]
): boolean {
  let previousEnd = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start)
      || !Number.isSafeInteger(range.end)
      || range.start < previousEnd
      || range.start < 0
      || range.end <= range.start
      || range.end > text.length
      || !isUtf16Boundary(text, range.start)
      || !isUtf16Boundary(text, range.end)
      || typeof range.display !== "string"
      || range.display.trim().length === 0
      || range.display.length > INLINE_TEXT_RANGE_DISPLAY_LIMIT) return false;
    previousEnd = range.end;
  }
  return true;
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export interface PromptInput {
  readonly text: string;
  readonly images: readonly ImageInput[];
  readonly files: readonly FileInput[];
  readonly mentions: readonly MentionInput[];
  readonly disposition: InputDisposition;
  /** True only when the product encoded inline quote atoms into text. */
  readonly quotesEncoded?: boolean;
  /** Durable UTF-16 spans for compact sent-paste rendering. */
  readonly pastedTextRanges?: readonly InlineTextRange[];
  /**
   * Service-owned continuation identity. Public SendInput contracts never
   * accept this field; it exists so an internally replayed prompt can retain
   * its durable presentation and ownership fence through native history.
   */
  readonly automaticContinuation?: AutomaticContinuationInput;
}

export interface AutomaticContinuationInput {
  readonly recoveryId: string;
  readonly sourceRunId: string;
  readonly attempt: number;
  readonly maximumAttempts: number;
  readonly sessionTotal: number;
}

export interface ProviderModel {
  readonly providerId: string;
  readonly modelId: string;
  /** Stable cross-runtime identity; route mutations must continue to use modelId. */
  readonly logicalId?: string;
  readonly displayName: string;
  readonly api:
    | "anthropic-messages"
    | "openai-responses"
    | "openai-completions"
    | string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly supportsImages: boolean;
  /** Catalog default only; clients may keep an owner-scoped visibility override. */
  readonly defaultVisible?: boolean;
  /** Explicit Backend support; absence is conservatively treated as false. */
  readonly supportsFastMode?: boolean;
  readonly thinkingLevels: readonly string[];
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  /** Optional authoritative or catalog reference used for local cost estimates. */
  readonly pricing?: {
    readonly source: "providerReference" | "upstream";
    readonly currencyCode: string;
    readonly updatedAt?: number;
    readonly cacheReadAvailable?: boolean;
    readonly cacheWriteAvailable?: boolean;
  };
}

export type ProviderLoginMethod = "api_key" | "oauth_browser" | "device_code" | "subscription";

export type BackendProviderAccessKind =
  | "managed"
  | "apiKey"
  | "oauth"
  | "subscription"
  | "localKeyless"
  | "customEndpoint";

export interface BackendProviderCredentialSurface {
  readonly surfaceId: string;
  readonly capability: "image_generation";
  readonly kind: "api_key";
  /** Typed service-side execution protocol. Shared dispatch must never infer it from Provider identity. */
  readonly executionApi: "openai-images";
  readonly models: readonly {
    readonly modelId: string;
    readonly displayName: string;
  }[];
}

/** Stable, credential-free Provider identity advertised even when model discovery requires authentication. */
export interface BackendProviderDescriptor {
  readonly providerId: string;
  readonly displayName: string;
  /** Billing/access semantics for capability-driven client presentation. */
  readonly accessKind?: BackendProviderAccessKind;
  /** User-facing product attached to subscription access, when advertised. */
  readonly accessProduct?: string;
  /** False when the upstream model catalog omits price quotes. */
  readonly providesModelPricing?: boolean;
  readonly api: ProviderModel["api"];
  readonly authenticationState: BackendAuthenticationState;
  readonly loginMethods: readonly ProviderLoginMethod[];
  readonly supportsLogin: boolean;
  readonly supportsLogout: boolean;
  readonly supportsRefresh: boolean;
  readonly supportsModelRefresh: boolean;
  /** Service-owned supplemental credential inputs attached to this display source. */
  readonly credentialSurfaces?: readonly BackendProviderCredentialSurface[];
}

export type DynamicInputFieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "blob";

export interface DynamicInputFieldConstraints {
  readonly minimumLength?: number;
  readonly maximumLength?: number;
  readonly minimumNumber?: number;
  readonly maximumNumber?: number;
  readonly pattern?: string;
  /** Field path describing one array item, for example `edits[]`. */
  readonly itemFieldPath?: string;
}

/** Backend-neutral, display-safe projection of a runtime input schema. */
export interface DynamicInputField {
  readonly fieldPath: string;
  readonly title: string;
  readonly description: string;
  readonly type: DynamicInputFieldType;
  readonly required: boolean;
  readonly secret: boolean;
  readonly enumValues: readonly string[];
  readonly constraints?: DynamicInputFieldConstraints;
}

export interface DynamicInputSchema {
  readonly fields: readonly DynamicInputField[];
  readonly allowsAdditionalFields: boolean;
}

/** Tool identity is local to its owning BackendDescriptor. */
export interface BackendToolDescriptor {
  readonly toolId: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema: DynamicInputSchema;
  readonly requiresPermission: boolean;
  readonly streamingUpdates: boolean;
  readonly enabled: boolean;
}

export interface UsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly cost: number;
}

export type BackendInstallationState =
  | "not_installed"
  | "installing"
  | "installed"
  | "update_available"
  | "error";

export type BackendAuthenticationState =
  | "not_required"
  | "signed_out"
  | "pending"
  | "authenticated"
  | "expired"
  | "refreshing"
  | "error";

export interface BackendDescriptor {
  readonly id: BackendId;
  /** Private implementation family projected only for management surfaces. */
  readonly adapterKind: string;
  /** Monotonic Orchestrator-owned process-instance generation. */
  readonly instanceGeneration: number;
  readonly displayName: string;
  readonly version: string;
  readonly health: "healthy" | "degraded" | "unavailable";
  readonly installationState: BackendInstallationState;
  readonly authenticationState: BackendAuthenticationState;
  readonly error?: PublicError;
  readonly capabilities: CapabilityManifest;
  /** Provider identities remain visible while a signed-out Backend has no discoverable models. */
  readonly providers?: readonly BackendProviderDescriptor[];
  readonly models: readonly ProviderModel[];
  readonly tools: readonly BackendToolDescriptor[];
  readonly diagnostics: readonly string[];
}

export interface TargetDescriptor {
  readonly id: TargetId;
  readonly backendId: BackendId;
  readonly displayName: string;
  readonly workspaceRoot: string;
  readonly managed: boolean;
  readonly trusted: boolean;
  /** Optional capability-neutral process/filesystem location. */
  readonly remoteWorkspace?: RemoteWorkspaceBinding;
}

export interface RemoteWorkspaceBinding {
  readonly hostId: string;
  readonly workspaceRoot: string;
}

/** A service-node path explicitly approved for an agent in addition to its workspace. */
export interface ApprovedDirectory {
  readonly id: string;
  readonly path: string;
  readonly access: "read_only" | "read_write";
}

export type NativeSessionStart =
  | { readonly kind: "new"; readonly parentNativeReference?: string }
  | { readonly kind: "attach"; readonly nativeReference: string };

/** Settings applied only for the queued turn and restored after agent_settled. */
export interface TurnExecutionOverrides {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  /** Explicit false temporarily disables a fast session default for this turn. */
  readonly fastMode?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly planMode?: boolean;
  readonly extraDirectoryIds?: readonly string[];
}

export interface NativeSessionBinding {
  readonly opaqueRef: string;
  readonly nativeSessionId?: string;
  readonly generation: number;
}

export type SessionWorktreeSourceStrategy =
  | "explicit"
  | "remote_default_refreshed"
  | "remote_default_local"
  | "current_branch"
  | "local_default"
  | "head";

/** Durable, content-free binding between one product Session and an isolated checkout. */
export interface SessionWorktreeBinding {
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly sourceStrategy: SessionWorktreeSourceStrategy;
  readonly sourceRefreshed: boolean;
  readonly sourceRemote?: string;
  readonly state: "active" | "preserved";
  readonly acquiredAt: UnixMillis;
  readonly updatedAt: UnixMillis;
}

/** A native session discovered by its owning Adapter for an authorized Target. */
export interface NativeSessionCandidate {
  readonly nativeReference: string;
  readonly nativeSessionId?: string;
  readonly name?: string;
  readonly workspaceRoot?: string;
  readonly messageCount: number;
  readonly modifiedAt: UnixMillis;
  readonly state: "ready" | "error";
}

/** A native task surfaced by an Adapter-owned, read-only profile catalog scan. */
export interface NativeSessionCatalogEntry {
  readonly nativeReference: string;
  readonly nativeSessionId?: string;
  readonly title?: string;
  /** The original working directory used when the native task ran. */
  readonly workingDirectory?: string;
  /** Stable navigation grouping root. It may differ from a Worktree working directory. */
  readonly projectDirectory?: string;
  readonly createdAt: UnixMillis;
  readonly modifiedAt: UnixMillis;
  readonly archived: boolean;
  readonly placement: "project" | "dialogue";
  /** Adapter-owned rule for filtering an already-imported native binding. */
  readonly existingMatch: "binding" | "binding_and_placement";
}

/** Bounded result of scanning one Backend profile's importable native tasks. */
export interface NativeSessionCatalogResult {
  readonly entries: readonly NativeSessionCatalogEntry[];
  /** Semantically rejected internal or non-user tasks. Scan errors and limits are excluded. */
  readonly rejectedCount: number;
}

export interface SessionDescriptor {
  readonly id: SessionId;
  readonly backendId: BackendId;
  /** Immutable runtime/filesystem identity chosen when the Session is created. */
  readonly targetId: TargetId;
  /** Mutable navigation placement. Absence places the Session in Dialogue. */
  readonly projectId?: TargetId;
  /** Creation-time Scheduler ownership; cleared when that Schedule incarnation is deleted. */
  readonly automationOrigin?: SessionAutomationOrigin;
  /** Immutable product-level lineage for a task derived from another task. */
  readonly derivationOrigin?: SessionDerivationOrigin;
  readonly title: string;
  /** Durable ownership fence for automatic naming. Manual writes always win. */
  readonly titleSource?: "draft" | "attachment" | "placeholder" | "automatic" | "manual";
  /** Bounded, generated navigation aid. It is cleared when the Session is unpinned. */
  readonly summary?: string;
  readonly summarySourceCursor?: bigint;
  readonly summaryUpdatedAt?: UnixMillis;
  readonly binding: NativeSessionBinding;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly deletedAt?: UnixMillis;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly worktree?: SessionWorktreeBinding;
  /** Immutable creation-time copy of the Target's Remote workspace binding. */
  readonly remoteWorkspace?: RemoteWorkspaceBinding;
  /** Private creation-time system prompt snapshot; never map into public Session projections. */
  readonly appendSystemPrompt?: string;
  /** Durable, content-free attention/read receipt projected by Orchestrator. */
  readonly attention?: SessionAttention;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
}

export interface SessionDerivationOrigin {
  readonly kind: "fork" | "clone";
  readonly sourceSessionId: SessionId;
  /** Product timeline identity, never a Backend-native entry identifier. */
  readonly sourceMessageId?: string;
  /** Durable Event anchor used to reload the source message outside recent history. */
  readonly sourceEventId?: EventId;
}

export interface SessionAutomationOrigin {
  readonly kind: "scheduler";
  readonly scheduleId: ScheduleId;
  readonly scheduleName?: string;
  readonly runId: RunId;
}

export type SessionAttentionKind = "done" | "awaiting" | "error";

/**
 * Backend-neutral attention projection. Cursors refer to durable Session
 * Events; no prompt, response, credential, or provider payload is retained.
 */
export interface SessionAttention {
  readonly kind: SessionAttentionKind;
  readonly unread: boolean;
  /** Event that established `kind`; may precede the CAS fence. */
  readonly subjectCursor: bigint;
  readonly subjectGeneration: number;
  readonly attentionCursor: bigint;
  readonly attentionGeneration: number;
  readonly readThroughCursor: bigint;
  readonly readThroughGeneration: number;
  readonly updatedAt: UnixMillis;
}

export interface RunDescriptor {
  readonly id: RunId;
  readonly sessionId: SessionId;
  readonly source: "user" | "schedule" | "system";
  readonly state: RunState;
  readonly parentRunId?: RunId;
  readonly activeAttemptId?: AttemptId;
  readonly createdAt: UnixMillis;
  readonly startedAt?: UnixMillis;
  readonly endedAt?: UnixMillis;
  readonly error?: PublicError;
}

export interface AttemptDescriptor {
  readonly id: AttemptId;
  readonly runId: RunId;
  readonly ordinal: number;
  /** Backend process instance selected by durable dispatch admission. */
  readonly backendInstanceGeneration?: number;
  readonly generation: number;
  readonly startedAt: UnixMillis;
  readonly endedAt?: UnixMillis;
  readonly error?: PublicError;
}

export interface QueueItemDescriptor {
  readonly id: QueueItemId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly operationId: OperationId;
  readonly disposition: InputDisposition;
  readonly state: QueueState;
  /** Absent until the accepted item wins a durable Backend dispatch claim. */
  readonly backendInstanceGeneration?: number;
  readonly createdAt: UnixMillis;
  readonly dispatchedAt?: UnixMillis;
  readonly backendAcceptedAt?: UnixMillis;
  readonly bodyHash: string;
}

export interface PublicError {
  readonly code: string;
  readonly message: string;
  readonly phase: string;
  readonly retryable: boolean;
  readonly stateMayHaveChanged: boolean;
  readonly recovery: string;
}
