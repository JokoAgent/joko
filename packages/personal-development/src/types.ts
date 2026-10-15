export type DevelopmentChannel = "dev" | "beta" | "release";
export type DevelopmentErrorCode = "UNSUPPORTED_PLATFORM" | "ENVIRONMENT_NOT_READY" | "TOOL_UNAVAILABLE" | "TOOL_INTEGRITY"
  | "SOURCE_MISSING" | "TAG_NOT_FOUND" | "INVALID_VERSION" | "INVALID_ARGUMENT" | "UNSAFE_PATH" | "DIRTY" | "CONFLICT"
  | "BUSY" | "OWNER_CHANGED" | "SOURCE_CHANGED" | "COMMAND_FAILED" | "CANCELLED" | "PROCESS_UNKNOWN"
  | "BUILD_FAILED" | "ARTIFACT_CHANGED" | "VERSION_UNAVAILABLE" | "VERSION_INCOMPATIBLE" | "STATE_INVALID";
export class PersonalDevelopmentError extends Error {
  constructor(readonly code: DevelopmentErrorCode, readonly exitCode?: number) {
    super(`Personal development operation failed: ${code}.`);
    this.name = "PersonalDevelopmentError";
  }
}
export interface DevelopmentProcessInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly outputMode?: "strict" | "tail";
  /** Service-private durable command scope, never supplied by generated client mutations. */
  readonly operationId?: string;
  readonly commandJournalDirectory?: string;
  /** Bounded stdout only. Raw stderr, command environment and arguments never enter progress. */
  readonly onProgress?: (progress: DevelopmentProgress) => void;
}
export interface DevelopmentProgress {
  readonly stage: string; readonly percent?: number;
  readonly dependencyProgress?: { readonly resolved: number; readonly reused: number; readonly downloaded: number; readonly added: number };
}
export interface DevelopmentProcessResult { readonly stdout: string; readonly exitCode: number }
export interface DevelopmentProcessAuthority {
  /** Must settle only after the exact child and its writers have retired; ambiguous retirement throws PROCESS_UNKNOWN. */
  run(input: DevelopmentProcessInput): Promise<DevelopmentProcessResult>;
  /** Reads exact helper retirement receipts; never resumes or repeats a command. */
  recover?(input: { readonly operationId: string; readonly journalDirectory: string }): Promise<{ readonly status: "retired" | "unknown"; readonly commandIds: readonly string[] }>;
}
export interface DevelopmentProcessSupervisor {
  /** Called synchronously immediately after spawn, before any asynchronous observation. */
  claim(pid: number): unknown;
  retire(claim: unknown): Promise<"retired" | "unknown">;
  release(claim: unknown): Promise<void>;
}
export interface DevelopmentWorktreeLease {
  readonly taskId: string;
  readonly sessionId: string;
  readonly leaseId: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
}
export interface DevelopmentWorktreeAuthority {
  /** Service must have persisted the visible Session and its purpose before acquisition. */
  acquire(input: { readonly taskId: string; readonly sessionId: string; readonly repositoryRoot: string;
    readonly sourceRef: string; readonly signal: AbortSignal }): Promise<DevelopmentWorktreeLease>;
  assertCurrent(lease: DevelopmentWorktreeLease): Promise<void>;
  /** Holds source-use through retirement. PROCESS_UNKNOWN must retain the durable writer pin for reconciliation. */
  withUse<T>(lease: DevelopmentWorktreeLease, signal: AbortSignal, run: () => Promise<T>, context: { readonly operationId: string }): Promise<T>;
  release(lease: DevelopmentWorktreeLease, signal: AbortSignal): Promise<"released" | "preserved">;
  /** Only exact command retirement proof for the original operation may retire this Owner's retained writer pin. */
  reconcileRetiredUses(input: { readonly operationId: string; readonly commandIds: readonly string[] }): Promise<"retired" | "unknown">;
}
export interface DevelopmentOriginalVersion {
  readonly runtimeDirectory: string;
  readonly executable: string;
  readonly compatibilityIdentity: string;
  readonly version: string;
  readonly development: boolean;
}
export interface DevelopmentVersionTarget {
  readonly id: "original" | "personal";
  readonly generation?: string;
  readonly runtimeDirectory: string;
  readonly executable: string;
  readonly runtimeDigest: string;
  readonly compatibilityIdentity: string;
}
export interface DevelopmentNativeVersionAuthority {
  original(): Promise<DevelopmentOriginalVersion>;
  current(): Promise<{ readonly id: "original" | "personal"; readonly generation?: string }>;
  /** Busy includes live personal tasks, tests and unknown writers. */
  busy(): Promise<boolean>;
  /** Persists a native handoff ticket. It must not stop the service before terminal operation publication. */
  handoff(target: DevelopmentVersionTarget & { readonly operationId: string }, signal: AbortSignal): Promise<
    { readonly status: "queued"; readonly ticketId: string } | { readonly status: "failed" | "unknown" }>;
  /** Arms the exact persisted ticket after the owner has committed admission; never waits for a restart. */
  activateHandoff?(ticketId: string): Promise<void>;
  reveal(path: string): Promise<void>;
  /** Uses an isolated test profile; the launch receipt must identify the exact native process generation. */
  startTest?(input: { readonly taskId: string; readonly sessionId: string; readonly completionId: string;
    readonly runtimeDirectory: string; readonly executable: string; readonly runtimeDigest: string }, signal: AbortSignal): Promise<string>;
  stopTest?(receipt: string, signal: AbortSignal): Promise<"retired" | "unknown">;
  /** Reconciles a launch interrupted before its receipt was adopted by this owner. */
  findTest?(taskId: string, completionId: string): Promise<{ readonly status: "running" | "retired" | "unknown"; readonly receipt?: string }>;
}
export type DevelopmentToolId = "git" | "node" | "pnpm" | "python" | "gitLfs";
export interface DevelopmentToolArtifact {
  readonly id: DevelopmentToolId; readonly version: string; readonly host: string;
  readonly sha256: string; readonly url: string; readonly executable: string;
  readonly format: "zip" | "tar.gz";
}
export interface DevelopmentToolCheck {
  readonly id: DevelopmentToolId; readonly status: "ready" | "missing" | "unsupported" | "downloading" | "verifying" | "extracting" | "failed";
  readonly executable?: string; readonly version?: string;
  readonly source?: "system" | "managed";
  readonly progress?: { readonly loaded: number; readonly total: number | null; readonly percent: number | null };
}
export interface DevelopmentEnvironment {
  readonly status: "unchecked" | "checking" | "preparing" | "ready" | "failed";
  readonly checks: readonly DevelopmentToolCheck[];
}
export interface DevelopmentSource {
  readonly status: "missing" | "preparing" | "ready" | "failed" | "cancelled";
  readonly channel?: DevelopmentChannel; readonly version?: string; readonly ref?: string;
  readonly commit?: string; readonly upstreamCommit?: string; readonly error?: DevelopmentErrorCode;
  readonly currentBranch?: string; readonly baseCommit?: string; readonly mainCommit?: string; readonly mainRemoteCommit?: string;
  readonly mainAhead?: number; readonly mainBehind?: number; readonly personalAhead?: number; readonly personalBehind?: number;
  readonly latestVersion?: DevelopmentSourceLatestVersion;
}
export interface DevelopmentSourceLatestVersion {
  readonly status: "checking" | "ready" | "missing" | "unavailable";
  readonly channel: DevelopmentChannel; readonly ref?: string; readonly commit?: string;
  readonly ahead?: number; readonly behind?: number; readonly checkedAt: number;
}
export interface DevelopmentTask extends DevelopmentWorktreeLease {
  readonly request: string; readonly title: string;
  readonly status: "preparing" | "editing" | "completed" | "failed" | "cancelled" | "ended" | "cleanup";
  readonly createdAt: number; readonly completionId?: string; readonly completedTree?: string;
}
export interface DevelopmentHistoryEntry {
  readonly id: string; readonly taskId: string; readonly sessionId: string; readonly title: string;
  readonly baseCommit: string; readonly tree: string; readonly commit: string; readonly createdAt: number;
  readonly state: "available" | "integrated" | "removed"; readonly integratedCommit?: string;
  readonly hidden?: boolean;
  readonly receipts?: readonly { readonly id: string; readonly action: "integrate" | "revert" | "reapply";
    readonly beforeCommit: string; readonly beforeTree: string; readonly afterCommit: string; readonly afterTree: string; readonly at: number }[];
}
export interface DevelopmentArtifact {
  readonly id: string; readonly directory: string; readonly installer: string; readonly sha256: string;
  readonly commit: string; readonly tree: string; readonly runtimeDirectory: string; readonly runtimeDigest: string;
  readonly executable: string; readonly createdAt: number; readonly compatibilityIdentity: string;
}
export interface DevelopmentVersionState {
  readonly selected: "original" | "personal";
  readonly currentId?: "original" | "personal"; readonly currentGeneration?: string;
  readonly original?: { readonly version: string; readonly development: boolean };
  readonly personal?: DevelopmentArtifact;
  readonly switching: boolean;
  readonly pendingHandoff?: { readonly ticketId: string; readonly operationId: string; readonly targetId: "original" | "personal";
    readonly targetGeneration?: string; readonly previousId: "original" | "personal"; readonly previousGeneration?: string;
    readonly status: "queued" | "unknown" };
}
export interface DevelopmentTestState {
  readonly completionId: string; readonly status: "building" | "running" | "stopped" | "unknown";
  readonly receipt?: string; readonly runtimeDigest?: string;
}
export interface DevelopmentOperation {
  readonly id: string; readonly kind: string; readonly inputHash: string;
  readonly status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  readonly stage: string; readonly startedAt: number; readonly finishedAt?: number;
  readonly error?: DevelopmentErrorCode;
  readonly percent?: number;
  readonly dependencyProgress?: DevelopmentProgress["dependencyProgress"];
  readonly diagnostics?: readonly { readonly stage: string; readonly code: DevelopmentErrorCode; readonly exitCode?: number }[];
}
export interface DevelopmentState {
  readonly format: 1; readonly generation: number;
  readonly environment: DevelopmentEnvironment; readonly source: DevelopmentSource;
  readonly tasks: Readonly<Record<string, DevelopmentTask>>;
  readonly history: readonly DevelopmentHistoryEntry[];
  readonly versions: DevelopmentVersionState;
  readonly operations: Readonly<Record<string, DevelopmentOperation>>;
  readonly merge?: { readonly id: string; readonly status: "conflict" | "ready" | "adopted" | "cancelled";
    readonly candidate: string; readonly baselineCommit: string; readonly baselineTree: string; readonly upstreamCommit: string;
    readonly resolution?: { readonly sessionId: string; readonly leaseId: string; readonly status: "active" | "retired" | "unknown" } };
  readonly tests?: Readonly<Record<string, DevelopmentTestState>>;
  readonly syncLatestBeforeBuild?: boolean;
}
export interface DevelopmentOperationResult<T> { readonly operationId: string; readonly value: T; readonly replayed: boolean }
export interface DevelopmentOwnerOptions {
  readonly rootDirectory: string;
  readonly process: DevelopmentProcessAuthority;
  readonly worktrees: DevelopmentWorktreeAuthority;
  readonly nativeVersions: DevelopmentNativeVersionAuthority;
  readonly platform?: NodeJS.Platform; readonly arch?: string; readonly libc?: "glibc" | "musl"; readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly fetch?: typeof fetch; readonly now?: () => number;
  /** Trusted fixed catalog override, never accepted from a client mutation. */
  readonly toolArtifacts?: readonly DevelopmentToolArtifact[];
}
