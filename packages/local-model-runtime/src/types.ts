export const OLLAMA_LOOPBACK_ORIGIN = "http://127.0.0.1:11434";
export const OLLAMA_OPENAI_BASE_URL = `${OLLAMA_LOOPBACK_ORIGIN}/v1`;

export interface RuntimeOwnerGeneration {
  readonly ownerId: string;
  readonly generation: number;
}

export type LocalRuntimeState =
  | "absent"
  | "stopped"
  | "starting"
  | "ready"
  | "port_conflict"
  | "installing"
  | "error";

export interface LocalRuntimeCapabilities {
  readonly canInstall: boolean;
  readonly canStart: boolean;
  readonly canListModels: boolean;
  readonly canPullModels: boolean;
  readonly canDeleteModels: boolean;
  readonly canPausePulls: boolean;
}

export interface LocalRuntimeStatus {
  readonly runtime: "ollama";
  readonly state: LocalRuntimeState;
  readonly source: "running" | "application" | "cli" | "managed_sidecar" | "none";
  readonly version?: string;
  readonly publicErrorCode?: RuntimePublicErrorCode;
  readonly capabilities: LocalRuntimeCapabilities;
}

export interface OllamaTag {
  readonly name: string;
  readonly sizeBytes?: number;
  readonly digest?: string;
}

export interface OllamaModelDetails {
  readonly contextLength?: number;
  readonly capabilities: readonly string[];
  readonly requiredRuntimeVersion?: string;
}

export interface InstalledLocalModel extends OllamaTag, OllamaModelDetails {}

export interface CuratedLocalModel {
  readonly id: string;
  readonly displayName: string;
  readonly libraryName: string;
  readonly aliases: readonly string[];
  readonly sizeBytes: number;
  readonly minimumMemoryGb: number;
  readonly appleSiliconOnly: boolean;
}

export type PullPhase =
  | "starting"
  | "manifest"
  | "downloading"
  | "verifying"
  | "writing"
  | "success"
  | "paused"
  | "cancelled"
  | "error";

export interface ModelPullProgress {
  readonly name: string;
  readonly phase: PullPhase;
  readonly status: string;
  readonly completedBytes?: number;
  readonly totalBytes?: number;
  readonly percent?: number;
  readonly bytesPerSecond?: number;
  readonly done: boolean;
  readonly publicErrorCode?: RuntimePublicErrorCode;
}

export interface PausedModelPull {
  readonly ownerId: string;
  readonly ownerGeneration: number;
  readonly name: string;
  readonly completedBytes?: number;
  readonly totalBytes?: number;
  readonly percent?: number;
  readonly digests: readonly string[];
  readonly updatedAt: number;
}

export interface PausedPullRepository {
  list(owner: RuntimeOwnerGeneration): Promise<readonly PausedModelPull[]>;
  put(record: PausedModelPull): Promise<void>;
  remove(owner: RuntimeOwnerGeneration, name: string): Promise<PausedModelPull | undefined>;
}

export type InstallPhase =
  | "resolving"
  | "downloading"
  | "verifying"
  | "extracting"
  | "promoting"
  | "starting"
  | "success"
  | "cancelled"
  | "error";

export interface RuntimeInstallProgress {
  readonly phase: InstallPhase;
  readonly version?: string;
  readonly completedBytes?: number;
  readonly totalBytes?: number;
  readonly percent?: number;
  readonly bytesPerSecond?: number;
  readonly done: boolean;
  readonly publicErrorCode?: RuntimePublicErrorCode;
}

export interface RuntimePreflight {
  readonly allowed: boolean;
  readonly memory: "sufficient" | "constrained" | "unknown";
  readonly disk: "sufficient" | "insufficient" | "unknown";
  readonly requiredDiskBytes: number;
  readonly publicErrorCode?: RuntimePublicErrorCode;
}

export interface RuntimeInstallLeaseRepository {
  claim(input: {
    readonly owner: RuntimeOwnerGeneration;
    readonly operationId: string;
    readonly at: number;
    readonly leaseDurationMs: number;
  }): Promise<{ readonly claimed: boolean; readonly recovered: boolean; readonly state: "installing" | "installed" | "failed" | "cancelled" }>;
  heartbeat(input: {
    readonly owner: RuntimeOwnerGeneration;
    readonly operationId: string;
    readonly at: number;
    readonly leaseDurationMs: number;
  }): Promise<void>;
  complete(input: {
    readonly owner: RuntimeOwnerGeneration;
    readonly operationId: string;
    readonly version: string;
    readonly archiveSha256: string;
    readonly at: number;
  }): Promise<void>;
  fail(input: {
    readonly owner: RuntimeOwnerGeneration;
    readonly operationId: string;
    readonly state: "failed" | "cancelled";
    readonly publicErrorCode: RuntimePublicErrorCode;
    readonly at: number;
  }): Promise<void>;
}

export type RuntimePublicErrorCode =
  | "OWNER_CHANGED"
  | "RUNTIME_UNREACHABLE"
  | "PORT_CONFLICT"
  | "UNSUPPORTED_PLATFORM"
  | "INSTALL_BUSY"
  | "PULL_BUSY"
  | "MODEL_INVALID"
  | "MODEL_NOT_FOUND"
  | "MODEL_UNAUTHORIZED"
  | "MODEL_INCOMPATIBLE"
  | "DISK_SPACE_LOW"
  | "DOWNLOAD_REJECTED"
  | "DOWNLOAD_TOO_LARGE"
  | "DOWNLOAD_TIMEOUT"
  | "CHECKSUM_MISMATCH"
  | "ARCHIVE_REJECTED"
  | "START_FAILED"
  | "OPERATION_CANCELLED"
  | "RUNTIME_ERROR";

export interface RuntimeAuditEvent {
  readonly code:
    | "runtime_probe"
    | "runtime_install"
    | "runtime_start"
    | "model_pull"
    | "model_delete"
    | "model_sync";
  readonly outcome: "started" | "succeeded" | "failed" | "cancelled";
  readonly ownerId: string;
  readonly ownerGeneration: number;
  readonly modelName?: string;
  readonly publicErrorCode?: RuntimePublicErrorCode;
}

export type RuntimeAuditSink = (event: RuntimeAuditEvent) => void;

export interface OllamaPullEvent {
  readonly status?: string;
  readonly digest?: string;
  readonly completed?: number;
  readonly total?: number;
  readonly error?: string;
}

export interface ManagedRuntimeModel {
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow?: number;
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
}
