import type { RuntimePreflight } from "@joko/local-model-runtime";
import type { ManagedModelRuntimeSnapshot } from "./managed-model-runtime-controller.js";

export interface ManagedRepositoryModel { readonly repository: string; readonly file: string }
export interface ManagedRuntimeProviderRoute { readonly backendId: string; readonly providerId: string }
export interface ManagedRuntimeHostProfile {
  readonly platform: string; readonly arch: string; readonly totalMemoryBytes: number;
  readonly memoryGb: number; readonly appleSilicon: boolean; readonly chip?: string;
}
export interface ManagedRuntimeRepositoryVariant {
  readonly repositoryModel: ManagedRepositoryModel; readonly quantization: string; readonly sizeBytes: number;
}
export interface ManagedRuntimeModelTarget extends ManagedRuntimeProviderRoute {
  readonly modelId: string; readonly repositoryModel?: ManagedRepositoryModel;
}
export interface ManagedRuntimeModelContext {
  readonly target: ManagedRuntimeModelTarget;
  readonly defaultContextWindowTokens: number; readonly effectiveContextWindowTokens: number;
  readonly maximumContextWindowTokens: number; readonly presets: readonly number[];
  readonly customized: boolean; readonly canConfigure: boolean; readonly pendingApply: boolean; readonly mixed: boolean;
}
export interface ManagedRuntimeRepositoryFiles {
  readonly repository: string; readonly sourceRevision: string;
  readonly files: readonly { readonly file: string; readonly sizeBytes: number }[];
}
export interface ManagedRuntimeTransferTarget {
  readonly transferId: string; readonly repositoryModel: ManagedRepositoryModel;
}
export type ManagedRuntimeConfigureBlockedReason = "owned_elsewhere" | "ownership_unknown" | "operation_busy" | "stop_unconfirmed";
export type ManagedRuntimeRepositoryDownloadAction = "pause" | "resume" | "cancel";

/** A registry entry owns its engine and every operation; callers only select an exact public identity. */
export interface ManagedModelRuntimePort {
  readonly runtimeId: string;
  snapshot(): Promise<ManagedModelRuntimeSnapshot>;
  preflight(catalogId: string): Promise<RuntimePreflight>;
  beginStart(): Promise<ManagedModelRuntimeSnapshot>;
  beginInstall(): Promise<ManagedModelRuntimeSnapshot>;
  cancelInstall(): Promise<ManagedModelRuntimeSnapshot>;
  beginPull(modelName: string): Promise<ManagedModelRuntimeSnapshot>;
  pausePull(modelName: string): Promise<ManagedModelRuntimeSnapshot>;
  resumePull(modelName: string): Promise<ManagedModelRuntimeSnapshot>;
  cancelPull(modelName: string): Promise<ManagedModelRuntimeSnapshot>;
  deleteModel(modelName: string): Promise<ManagedModelRuntimeSnapshot>;
  close(): Promise<void>;
  ensureProvider?(signal?: AbortSignal): Promise<ManagedModelRuntimeSnapshot>;
  stop?(signal?: AbortSignal): Promise<ManagedModelRuntimeSnapshot>;
  restart?(signal?: AbortSignal): Promise<ManagedModelRuntimeSnapshot>;
  listRepositoryFiles?(repository: string, signal?: AbortSignal): Promise<ManagedRuntimeRepositoryFiles>;
  downloadRepositoryModel?(selection: ManagedRepositoryModel): Promise<ManagedModelRuntimeSnapshot>;
  controlRepositoryDownload?(target: ManagedRuntimeTransferTarget, action: ManagedRuntimeRepositoryDownloadAction): Promise<ManagedModelRuntimeSnapshot>;
  getModelContext?(targets: readonly ManagedRuntimeModelTarget[], signal?: AbortSignal): Promise<ManagedRuntimeModelContext>;
  setModelContext?(targets: readonly ManagedRuntimeModelTarget[], limit: number | undefined, signal?: AbortSignal): Promise<ManagedRuntimeModelContext>;
}
