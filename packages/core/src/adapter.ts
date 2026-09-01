import type { EventPayload, InteractionPayload, MessageBlock, PiEventMetadata, PlanReviewDecision } from "./events.js";
import type {
  BackendDescriptor,
  BlobRef,
  ApprovedDirectory,
  DynamicInputSchema,
  NativeSessionBinding,
  NativeSessionCatalogEntry,
  NativeSessionCatalogResult,
  NativeSessionCandidate,
  NativeSessionStart,
  PermissionMode,
  PromptInput,
  ProviderModel,
  SessionId,
  TargetDescriptor,
  UsageSnapshot
} from "./types.js";
import type { SubagentControlInput } from "./subagents.js";
import type { PolicySnapshot } from "./policy.js";

export interface AdapterContext {
  readonly sessionId: SessionId;
  readonly generation: number;
  /** Orchestrator-owned Backend process-instance fence, distinct from Session generation. */
  readonly backendInstanceGeneration?: number;
  readonly target: TargetDescriptor;
  readonly binding?: NativeSessionBinding;
  /** Stable host operation identity for idempotent Backend mutations. */
  readonly operationId?: string;
  /** Private immutable creation snapshot used only to restore native runtime launch state. */
  readonly appendSystemPrompt?: string;
  /** Host-owned immutable isolation policy. Backends must fail closed on unknown values. */
  readonly runtimePolicy?: "review_read_only";
  /** Canonical service-node roots approved for this invocation. */
  readonly extraDirectories?: readonly ApprovedDirectory[];
  /** Current service-owned ordered policy authority for this Backend/Target/workspace. */
  readonly policySnapshot?: PolicySnapshot;
  readonly signal: AbortSignal;
  readonly emit: (payload: EventPayload, metadata?: AdapterEventMetadata) => Promise<void>;
  readonly requestInteraction: (
    interaction: InteractionPayload,
    options?: { readonly signal?: AbortSignal }
  ) => Promise<InteractionDecision>;
  /** Exact host ArtifactStore ceiling for this invocation. Adapters must
   * reject larger materializations before reading or decoding their bytes. */
  readonly artifactCapacityBytes: number;
  readonly storeArtifact: (sourcePath: string, options?: { fileName?: string; mimeType?: string }) => Promise<BlobRef>;
}

export interface AdapterEventMetadata {
  readonly namespace: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
  /** Backend-neutral persistence envelope for Pi's typed metadata oneof. */
  readonly pi?: PiEventMetadata;
}

export type InteractionDecision =
  | { readonly kind: "selected"; readonly value: string }
  | { readonly kind: "confirmed"; readonly confirmed: boolean }
  | {
      readonly kind: "question";
      readonly answers: Readonly<Record<string, string | boolean | readonly string[]>>;
    }
  | { readonly kind: "plan_review"; readonly decision: PlanReviewDecision; readonly feedback: string }
  | { readonly kind: "cancelled" };

export interface CreateNativeSessionInput {
  readonly target: TargetDescriptor;
  readonly name?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly appendSystemPrompt?: string;
  readonly nativeStart?: NativeSessionStart;
  /** Dedicated fresh reviewer runtime, separate from plan mode. */
  readonly runtimePolicy?: "review_read_only";
}

export interface NativeSessionState {
  readonly binding: NativeSessionBinding;
  readonly name?: string;
  readonly streaming: boolean;
  readonly compacting: boolean;
  readonly pendingMessages: number;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  /** Current Backend-native Plan mode when it can be observed exactly. */
  readonly planMode?: boolean;
  readonly usage?: UsageSnapshot;
  /** Current Backend-native automatic context-compaction policy when observable. */
  readonly autoCompaction?: boolean;
  /** Current Backend-native automatic retry policy when observable. */
  readonly autoRetry?: boolean;
  /** Optional closed, Backend-namespaced detail for a durable live observation. */
  readonly pi?: Extract<PiEventMetadata["payload"], { readonly case: "nativeState" }>["value"];
}

/**
 * A Backend-owned projection of one native history entry into the public event
 * model. Native entry taxonomies and raw persistence objects never cross the
 * Adapter boundary. The three identity fields are opaque to Orchestrator and exist
 * only to derive stable, collision-checked product Event IDs.
 */
export interface NativeHistoryProjectedEvent {
  readonly nativeEntryId: string;
  readonly nativeParentEntryId?: string;
  readonly projectionKind: string;
  readonly contentIndex: number;
  readonly emittedAt?: number;
  readonly payload: EventPayload;
  readonly metadata?: AdapterEventMetadata;
}

export interface NativeHistoryProjection {
  readonly events: readonly NativeHistoryProjectedEvent[];
  readonly activeEntryId?: string;
  /** Complete active native parent chain, including entries with no public projection. */
  readonly activeLineage?: readonly {
    readonly entryId: string;
    readonly parentEntryId?: string;
  }[];
  /** Optional typed Backend detail for the public native_session_changed marker. */
  readonly activeEntryMetadata?: AdapterEventMetadata;
}

export interface DurableNativeDispatchPreparation {
  /** Adapter-owned digest of the exact native user entry about to be persisted. */
  readonly inputFingerprint: string;
  /** Persistence-confirmed active history immediately before native dispatch. */
  readonly nativeHistory: NativeHistoryProjection;
}

export interface SessionTreeNode {
  readonly entryId: string;
  readonly parentId?: string;
  /** Native entry taxonomy (for Pi, for example `message` or `compaction`). */
  readonly kind: string;
  /** Message role is orthogonal to the native entry taxonomy. */
  readonly role?: "user" | "assistant" | "toolResult" | "custom";
  readonly label?: string;
  readonly timestamp: number;
  readonly children: readonly SessionTreeNode[];
}

export interface SessionTree {
  readonly roots: readonly SessionTreeNode[];
  readonly leafId?: string;
}

/**
 * Result of deriving a native session from a selected tree entry. Some native
 * runtimes return the selected user text so the product can restore it in the
 * new Session's composer without re-reading opaque native persistence.
 */
export interface NativeSessionForkResult {
  readonly binding: NativeSessionBinding;
  readonly editorText?: string;
}

/** Opaque native persistence bytes suitable for a user-authorized portable package. */
export interface PortableNativeSession {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly nativeSessionId: string;
}

export interface ImportPortableNativeSessionInput {
  readonly target: TargetDescriptor;
  readonly bytes: Uint8Array;
  readonly generation: number;
  /** Optional package-local identity. An Adapter may replace it to avoid collisions. */
  readonly nativeSessionId?: string;
}

/**
 * Redacted product-history material used only for a pending native-context
 * rebuild. The durable rebuild marker never contains these blocks.
 */
export interface ContextRebuildMessage {
  readonly role: "user" | "assistant";
  readonly blocks: readonly MessageBlock[];
}

export type ContextRebuildReason = "message_deletion" | "context_overflow" | "prompt_timeout";

export interface ContextRebuildInput {
  readonly reason: ContextRebuildReason;
  readonly messages: readonly ContextRebuildMessage[];
  /**
   * Exact redacted text injected into the replacement native context. Keeping
   * this host-authored makes the durable boundary card match the native
   * handoff instead of independently reconstructing private history.
   */
  readonly handoff: string;
}

export interface RuntimeCommand {
  readonly name: string;
  readonly description: string;
  readonly source: "extension" | "skill" | "prompt";
  readonly path?: string;
  readonly loaded: boolean;
}

export interface RuntimeResource {
  readonly id: string;
  readonly kind: "extension" | "skill" | "prompt" | "package";
  readonly name: string;
  readonly source: string;
  readonly state: "discovered" | "approved" | "loaded" | "disabled" | "error";
  /** Exact content revision captured into this immutable runtime snapshot. */
  readonly revision?: string;
  /** Exact managed-resource entity revision captured at runtime assembly. */
  readonly resourceVersion?: bigint;
  /** Runtime-private copied path used only to correlate authoritative Pi RPC observations. */
  readonly runtimePath?: string;
  /** Product runtime generation that made the observation. Required for loaded promotion. */
  readonly runtimeGeneration?: number;
  readonly version?: string;
  readonly detail?: string;
}

/**
 * Display-safe resource usage for one Backend runtime rooted in a process on
 * the service node. Command lines, executable paths, environment values, and
 * native Session references are deliberately not representable here.
 */
export interface RuntimeProcessUsage {
  readonly sessionId: SessionId;
  readonly generation: number;
  readonly pid: number;
  readonly cpuPercent: number;
  readonly memoryKb: number;
  readonly processCount: number;
  readonly terminable: boolean;
  /** Opaque spawn-instance fence. It contains no OS path or command content. */
  readonly processInstanceId?: string;
}

export interface RuntimeProcessUsageSnapshot {
  readonly capturedAt: number;
  readonly processes: readonly RuntimeProcessUsage[];
}

export interface TerminateRuntimeProcessInput {
  readonly sessionId: SessionId;
  readonly generation: number;
  readonly pid: number;
  readonly processInstanceId: string;
}

/** Display-safe provenance for one tool observed inside a live Backend runtime. */
export interface RuntimeToolSourceInfo {
  readonly path: string;
  readonly source: string;
  readonly scope: "user" | "project" | "temporary";
  readonly origin: "package" | "top-level";
  readonly baseDir?: string;
}

/**
 * Session-scoped tool registry observed from the running Backend. Permission
 * and streaming hints are deliberately absent because a dynamic registry may
 * expose only schemas and active membership.
 */
export interface RuntimeToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: DynamicInputSchema;
  readonly promptGuidelines: readonly string[];
  readonly active: boolean;
  readonly sourceInfo: RuntimeToolSourceInfo;
}

export interface RuntimeToolCatalog {
  readonly runtimeGeneration: number;
  readonly observedAt: number;
  readonly tools: readonly RuntimeToolDescriptor[];
}

/** A user-initiated command executed by the Backend in the Target workspace. */
export interface UserShellInput {
  readonly command: string;
  readonly excludeFromContext: boolean;
}

/** Backend-neutral completion state for a user-initiated workspace command. */
export interface UserShellResult {
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  /** Redacted complete output when Pi truncated the inline RPC response. */
  readonly artifact?: BlobRef;
}

export interface BackendAdapter {
  readonly id: string;
  describe(): Promise<BackendDescriptor>;
  validateTarget(target: TargetDescriptor): Promise<void>;
  /** Resolve and validate an opaque native reference without starting a runtime. */
  resolveNativeSessionReference?(
    nativeReference: string,
    target: TargetDescriptor,
    generation: number
  ): Promise<NativeSessionBinding>;
  /** Discover native sessions only through the Adapter that owns the Target. */
  listNativeSessions?(target: TargetDescriptor): Promise<readonly NativeSessionCandidate[]>;
  /** Scan the Adapter-owned local profile without requiring a pre-existing Target. */
  scanNativeSessionCatalog?(): Promise<NativeSessionCatalogResult>;
  /** Convert an entry returned by the Adapter's catalog into a dormant binding without starting a runtime. */
  bindCatalogSession?(
    entry: NativeSessionCatalogEntry,
    generation: number
  ): Promise<NativeSessionBinding>;
  createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding>;
  resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState>;
  inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState>;
  detachSession?(binding: NativeSessionBinding, context: AdapterContext): Promise<void>;
  closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void>;
  deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void>;
  /** True only when native persistence can be deleted without activating its parent runtime. */
  supportsDetachedSessionDeletion?(context: AdapterContext): boolean;
  /**
   * Classify an input that may bypass a live native compaction barrier. Most
   * inputs return undefined and stay in the durable product queue. A Backend
   * may return the exact disposition required for a natively immediate input
   * such as a catalogued extension command.
   */
  dispatchDuringCompaction?(
    input: PromptInput,
    context: AdapterContext
  ): Promise<PromptInput["disposition"] | undefined>;
  send(input: PromptInput, context: AdapterContext): Promise<void>;
  /**
   * Compose one exact native input, durably fence it through the supplied
   * callback, then dispatch those same bytes. Runtimes that can outlive the
   * service use this instead of `send`; synchronous commands that do not
   * persist a native user entry may deliberately use ordinary fail-closed send.
   */
  sendWithDurableNativeDispatchFence?(
    input: PromptInput,
    context: AdapterContext,
    persistFence: (preparation: DurableNativeDispatchPreparation) => Promise<void>
  ): Promise<void>;
  abort(context: AdapterContext): Promise<void>;
  setModel(providerId: string, modelId: string, context: AdapterContext): Promise<ProviderModel>;
  setEffort(level: string, context: AdapterContext): Promise<void>;
  /** Apply the service-tier policy for subsequent Provider requests. */
  setFastMode(enabled: boolean, context: AdapterContext): Promise<void>;
  setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void>;
  setPlanMode(enabled: boolean, context: AdapterContext): Promise<void>;
  /** Hot-replace ordered policy authority without starting a sleeping runtime. */
  setPolicySnapshot?(context: AdapterContext): Promise<void>;
  /** Atomically replace the invocation's approved extra-directory policy. */
  setExtraDirectories?(directories: readonly ApprovedDirectory[], context: AdapterContext): Promise<void>;
  compact(customInstructions: string | undefined, context: AdapterContext): Promise<"compacted" | "noop">;
  setAutoCompaction(enabled: boolean, context: AdapterContext): Promise<void>;
  setAutoRetry(enabled: boolean, context: AdapterContext): Promise<void>;
  /** Update the capability owner's default for runtimes created later. */
  configureSilentEncryptedRetry?(enabled: boolean): Promise<void>;
  /** Capability-gated transport recovery for Responses reasoning ciphertext. */
  setSilentEncryptedRetry?(enabled: boolean, context: AdapterContext): Promise<void>;
  abortRetry(context: AdapterContext): Promise<void>;
  exportSession(context: AdapterContext): Promise<BlobRef>;
  /** Read native persistence without exposing its service-node path to public layers. */
  exportPortableNativeSession?(context: AdapterContext): Promise<PortableNativeSession>;
  /** Materialize validated native persistence beneath the Adapter-owned Session store. */
  importPortableNativeSession?(
    input: ImportPortableNativeSessionInput,
    signal: AbortSignal
  ): Promise<NativeSessionBinding>;
  getTree(context: AdapterContext): Promise<SessionTree>;
  navigateTree(
    entryId: string,
    summarize: boolean,
    context: AdapterContext,
    customInstructions?: string
  ): Promise<void>;
  fork(entryId: string, context: AdapterContext): Promise<NativeSessionForkResult>;
  clone(context: AdapterContext): Promise<NativeSessionBinding>;
  /**
   * Replace the attached native context with a fresh same-Backend session.
   * Implementations must accept a fenced inactive or unhealthy source binding,
   * retire the attached runtime before starting the replacement, and return a
   * strictly newer generation. They must never resume or edit the replaced native
   * persistence while rebuilding it.
   */
  rebuildContext?(input: ContextRebuildInput, context: AdapterContext): Promise<NativeSessionBinding>;
  /**
   * Replace the attached native context with a truly empty same-Backend
   * session. Unlike rebuildContext, reset must not carry transcript handoff
   * content into the new native session.
   */
  resetContext?(context: AdapterContext): Promise<NativeSessionBinding>;
  setName(name: string, context: AdapterContext): Promise<void>;
  getCommands(context: AdapterContext): Promise<readonly RuntimeCommand[]>;
  /** Observe the exact dynamic registry of a capability-compatible live runtime. */
  getRuntimeTools?(context: AdapterContext): Promise<RuntimeToolCatalog>;
  getResources(context: AdapterContext): Promise<readonly RuntimeResource[]>;
  /** Inspect only process roots owned by this Adapter instance. */
  getRuntimeProcessUsage?(): Promise<RuntimeProcessUsageSnapshot>;
  /** Terminate only the exact spawn instance described by the complete fence. */
  terminateRuntimeProcess?(input: TerminateRuntimeProcessInput): Promise<void>;
  /**
   * Best-effort reconciliation of the node-owned process-priority policy for
   * runtimes that are already active. Adapters without a local process owner
   * omit the hook; shared settings code never infers support from their ID or
   * implementation class.
   */
  applyProcessPriorityToActive?(priority: "normal" | "low" | "lowest"): Promise<unknown>;
  /**
   * Cancel one live or durably resumable background task owned by this
   * Session. Implementations must fail closed unless the opaque task identity
   * belongs to the supplied runtime context.
   */
  cancelBackgroundTask?(context: AdapterContext, taskId: string): Promise<void>;
  /**
   * Control an observed delegated run owned by this exact product Session.
   * The Host verifies durable ownership and per-action capabilities before the
   * Adapter sees the opaque identities. Implementations must repeat their own
   * native ownership and generation checks and fail closed on uncertainty.
   */
  controlSubagent?(input: SubagentControlInput, context: AdapterContext): Promise<void>;
  /** True only when this exact action can be delivered without activating the parent runtime. */
  supportsDetachedSubagentControl?(
    action: SubagentControlInput["action"],
    context: AdapterContext
  ): boolean;
  /** Reconcile durable delegated work without activating the parent runtime. */
  observeDetachedSubagents?(context: AdapterContext): Promise<void>;
  /** Optional capability-gated user shell. Native command names stay inside the Adapter. */
  executeUserShell?(input: UserShellInput, context: AdapterContext): Promise<UserShellResult>;
  /** Abort only the user shell currently owned by this exact Session generation. */
  abortUserShell?(context: AdapterContext): Promise<void>;
  /** Read and project native append-only history at a persistence-confirmed sync point. */
  getNativeHistoryProjection?(context: AdapterContext): Promise<NativeHistoryProjection>;
  /** Fence and settle adapter-owned background transitions before a replacement generation is published. */
  quiesceForReplacement?(): Promise<void>;
  /**
   * Hard retirement for an exact, already-fenced Adapter instance. The
   * implementation may interrupt native cleanup, but it must never delete
   * durable Session evidence or act on a process it cannot still prove it
   * owns. Registry and Host use this only after graceful retirement exceeded
   * its bounded deadline.
   */
  forceDispose?(): Promise<void>;
  dispose(): Promise<void>;
}
