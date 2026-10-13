import type { ChildProcess, spawn } from "node:child_process";
import type { RuntimeOwnerGeneration, RuntimePublicErrorCode } from "./types.js";
import { LocalRuntimeError } from "./errors.js";

export const LLAMA_CPP_MANAGED_ORIGIN = "http://127.0.0.1:11435";
export const LLAMA_CPP_OPENAI_BASE_URL = `${LLAMA_CPP_MANAGED_ORIGIN}/v1`;
export const LLAMA_CPP_MANAGED_PORT = 11435;
export const LLAMA_CPP_DEFAULT_CONTEXT = 32768;

export interface LlamaCppSelection { readonly repository: string; readonly file: string }
export interface LlamaCppFile { readonly name: string; readonly sizeBytes: number; readonly sha256: string }
export interface LlamaCppRepository { readonly revision: string; readonly files: readonly LlamaCppFile[] }
export interface LlamaCppModel extends LlamaCppSelection {
  readonly id: string; readonly sizeBytes: number; readonly revision: string; readonly shards: readonly LlamaCppFile[];
}
export interface LlamaCppTransferTarget { readonly transferId: string; readonly selection?: LlamaCppSelection }
export interface LlamaCppOperation {
  readonly transferId: string; readonly kind: "install" | "download" | "start";
  readonly selection?: LlamaCppSelection; readonly completed: number; readonly total: number;
  readonly bytesPerSecond?: number; readonly paused?: boolean;
}
export interface LlamaCppCatalogVariant extends LlamaCppSelection {
  readonly quantization: string; readonly sizeBytes: number; readonly verifiedAt: string;
}
export interface LlamaCppCatalogEntry {
  readonly id: string; readonly name: string; readonly aliases: readonly string[];
  readonly descriptions?: Readonly<Partial<Record<"en" | "zh-CN" | "zh-TW" | "ja" | "ko", string>>>;
  readonly variants: readonly LlamaCppCatalogVariant[];
}
export type LlamaCppBlockedReason = "owned_elsewhere" | "ownership_unknown" | "operation_busy" | "stop_unconfirmed";
export interface LlamaCppSnapshot {
  readonly installed: boolean; readonly supported: boolean; readonly running: boolean;
  readonly canManageRuntime: boolean; readonly canConfigure: boolean; readonly canPauseDownload: boolean;
  readonly blockedReason?: LlamaCppBlockedReason; readonly version?: string;
  readonly models: readonly LlamaCppModel[]; readonly operation?: LlamaCppOperation;
  readonly catalog: readonly LlamaCppCatalogEntry[];
  readonly recommendation: { readonly featuredIds: readonly string[]; readonly memoryGb: number; readonly appleSilicon: boolean; readonly chip?: string };
}
export type LlamaCppFailure = "BUSY" | "OWNED_ELSEWHERE" | "OWNER_UNKNOWN" | "NOT_INSTALLED" | "INVALID_MODEL" | "MODEL_INCOMPLETE"
  | "RELEASE_UNAVAILABLE" | "DOWNLOAD_FAILED" | "RESUME_READ_FAILED" | "STOP_TIMEOUT" | "INVALID_CONTEXT" | "TRANSFER_CHANGED";
export class LlamaCppRuntimeError extends LocalRuntimeError {
  constructor(code: RuntimePublicErrorCode, readonly reason: LlamaCppFailure, message: string) { super(code, message); this.name = "LlamaCppRuntimeError"; }
}
export interface LlamaCppRuntimeOptions {
  readonly dataRoot: string;
  readonly currentOwner: () => RuntimeOwnerGeneration | undefined;
  readonly fetchStreaming: typeof fetch;
  readonly validateConnection: (owner: RuntimeOwnerGeneration) => Promise<void>;
  readonly contextLimits?: (model: LlamaCppModel) => readonly number[];
  readonly onModelsChanged?: (owner: RuntimeOwnerGeneration, models: readonly LlamaCppModel[]) => Promise<void>;
  readonly platform?: NodeJS.Platform; readonly arch?: string; readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number; readonly totalMemoryBytes?: () => number; readonly chip?: () => string;
  readonly freeDiskBytes?: (directory: string) => Promise<number>;
  readonly spawnProcess?: typeof spawn;
  readonly extractArchive?: (input: { readonly archivePath: string; readonly destination: string; readonly platform: NodeJS.Platform; readonly signal: AbortSignal }) => Promise<string>;
  readonly terminateTree?: (child: ChildProcess) => Promise<boolean>;
  readonly healthFetch?: typeof fetch;
  readonly stopTimeoutMs?: number; readonly startPollMs?: number; readonly startPollCount?: number;
}
