import type { HostedExecution, NativeNavigationTarget, PermissionMode, PromptInput, SubagentControlInput, UserShellInput } from "@joko/core";

/** One isolated inference. It carries no task, workspace, tool or credential authority. */
export interface HostedNativeInferenceRequest {
  readonly requestId: string;
  readonly backendId: string;
  readonly backendInstanceGeneration: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly system: string;
  readonly user: string;
  readonly timeoutMs: number;
  readonly maxTokens?: number;
  readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
}

/** Closed private values shared by the native Provider actor and its Source
 * Adapter. Public clients use the generated protobuf service envelopes. */
export type HostedNativeCommand =
  | { readonly kind: "state" }
  | { readonly kind: "send"; readonly input: PromptInput; readonly durableFence: boolean; readonly newGroupRound?: boolean }
  | { readonly kind: "abort" }
  | { readonly kind: "delete" }
  | { readonly kind: "set_model"; readonly providerId: string; readonly modelId: string }
  | { readonly kind: "set_effort"; readonly effort: string }
  | { readonly kind: "set_fast"; readonly enabled: boolean | "ultrafast" }
  | { readonly kind: "set_permission"; readonly mode: PermissionMode }
  | { readonly kind: "set_plan"; readonly enabled: boolean }
  | { readonly kind: "set_name"; readonly name: string }
  | { readonly kind: "set_auto_compaction"; readonly enabled: boolean }
  | { readonly kind: "set_auto_retry"; readonly enabled: boolean }
  | { readonly kind: "abort_retry" }
  | { readonly kind: "compact"; readonly instructions?: string }
  | { readonly kind: "commands" }
  | { readonly kind: "resources" }
  | { readonly kind: "tools" }
  | { readonly kind: "tree" }
  | { readonly kind: "history" }
  | { readonly kind: "navigate"; readonly target: NativeNavigationTarget; readonly summarize: boolean; readonly instructions?: string }
  | { readonly kind: "dispatch_during_compaction"; readonly input: PromptInput }
  | { readonly kind: "shell"; readonly input: UserShellInput }
  | { readonly kind: "abort_shell" }
  | { readonly kind: "cancel_background"; readonly taskId: string }
  | { readonly kind: "background_output"; readonly taskId: string; readonly maximumBytes: number }
  | { readonly kind: "control_subagent"; readonly input: SubagentControlInput };
export interface HostedNativeOpen {
  readonly runId: string;
  readonly nativeSessionId: string;
  readonly start: "create" | "resume";
  readonly sessionId: string;
  readonly targetId: string;
  readonly generation: number;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly name?: string;
  readonly permissionMode: PermissionMode;
  readonly fastMode: boolean | "ultrafast";
  readonly effort?: string;
  /** One-use capability from this Provider's authenticated stream. */
  readonly groupSwitch?: string;
  /** Owner-only direct member selection. A guest payload cannot opt out of
   * its granting computer's server-owned group selection. */
  readonly groupMember?: boolean;
  readonly workspace: Omit<HostedExecution["workspace"], "root" | "additionalRoots">;
}
