import type { PermissionMode } from "@joko/core";
import type { DevelopmentOperation, DevelopmentSource } from "@joko/personal-development";

export interface DevelopmentDoctorCheck {
  readonly id: string; readonly status: "pending" | "checking" | "downloading" | "verifying" | "extracting" | "ready" | "missing" | "unsupported" | "warning" | "failed" | "cancelled";
  readonly version?: string; readonly reason?: string; readonly freeGiB?: number;
  readonly source?: "system" | "managed";
  readonly progress?: { readonly loaded: number; readonly total: number | null; readonly percent: number | null };
}
export interface DevelopmentDoctorEnvironment {
  readonly status: "unchecked" | "checking" | "preparing" | "ready" | "failed" | "cancelled" | "unknown";
  readonly checks: readonly DevelopmentDoctorCheck[]; readonly operation?: DevelopmentOperation;
  readonly platform: string; readonly arch: string;
}
export interface DevelopmentUpstreamRuntime {
  readonly channel: "dev" | "beta" | "release"; readonly version: string;
  readonly commit?: string; readonly confidence: "exact" | "unknown";
}
export interface DevelopmentUpstreamItem {
  readonly number: number; readonly title: string; readonly state: "open" | "merged" | "closed" | "unknown";
  readonly htmlUrl: string; readonly author?: string; readonly updatedAt?: string; readonly summary?: string;
  readonly inclusion?: "included" | "notIncluded" | "unknown"; readonly draft?: boolean;
}
export interface DevelopmentUpstreamQuery {
  readonly status: "pending" | "needsRequest" | "searching" | "notFound" | "found" | "failed" | "cancelled";
  readonly items: readonly DevelopmentUpstreamItem[]; readonly terms?: readonly string[]; readonly runtime?: DevelopmentUpstreamRuntime;
  readonly excludedIncluded?: number; readonly hasMore?: boolean; readonly failure?: "network" | "rateLimit" | "timeout" | "invalidResponse";
}
export interface DevelopmentDoctorRoute {
  readonly targetId: string; readonly title: string; readonly providerId?: string; readonly modelId?: string; readonly effort?: string;
  readonly fastMode: boolean; readonly permissionMode: PermissionMode; readonly planMode: boolean;
}
export interface DevelopmentDoctorStartInput extends DevelopmentDoctorRoute {
  readonly operationId: string; readonly sessionId?: string; readonly mode: "check" | "prepare"; readonly request: string;
}
export interface DevelopmentDoctorRun {
  readonly runId: string; readonly sessionId: string; readonly mode: "check" | "prepare"; readonly request: string;
  readonly status: "running" | "completed" | "cancelled" | "failed" | "unknown"; readonly stage: string;
  readonly checks: readonly DevelopmentDoctorCheck[]; readonly source?: DevelopmentSource; readonly upstream?: DevelopmentUpstreamQuery;
  readonly decision?: "wait" | "personal"; readonly taskId?: string; readonly codeSessionId?: string; readonly error?: string;
  readonly createdAt: number; readonly updatedAt: number; readonly attempt: number; readonly platform: string; readonly arch: string;
  readonly operation?: DevelopmentOperation;
}
