import type { MessageKey } from "./i18n.js";

export type TimelineErrorKind =
  | "unknown"
  | "capacity"
  | "connection"
  | "authentication"
  | "usage"
  | "service"
  | "model"
  | "request"
  | "context"
  | "attachment"
  | "workspace"
  | "busy"
  | "state"
  | "uncertain"
  | "policy"
  | "runtime";

export interface TimelineErrorCopy {
  readonly kind: TimelineErrorKind;
  readonly titleKey: MessageKey;
  readonly messageKey: MessageKey;
  readonly recoveryKey: MessageKey;
  readonly titleFallback: string;
  readonly messageFallback: string;
  readonly recoveryFallback: string;
}

const COPY_BY_KIND = {
  unknown: copy(
    "unknown",
    "timeline.errorUnknownTitle",
    "timeline.errorUnknownMessage",
    "timeline.errorUnknownRecovery",
    "Something went wrong",
    "The task could not continue because of an unexpected problem.",
    "Try again once. If the problem continues, open diagnostics for details."
  ),
  capacity: copy(
    "capacity",
    "timeline.errorCapacityTitle",
    "timeline.errorCapacityMessage",
    "timeline.errorCapacityRecovery",
    "Model service is busy",
    "The model service has no available capacity right now.",
    "Wait a moment and retry, or choose another available model."
  ),
  connection: copy(
    "connection",
    "timeline.errorConnectionTitle",
    "timeline.errorConnectionMessage",
    "timeline.errorConnectionRecovery",
    "Connection interrupted",
    "The task lost its connection to the model runtime before the response finished.",
    "Wait for the runtime to reconnect, then retry. Check diagnostics if it keeps disconnecting."
  ),
  authentication: copy(
    "authentication",
    "timeline.errorAuthenticationTitle",
    "timeline.errorAuthenticationMessage",
    "timeline.errorAuthenticationRecovery",
    "Sign-in required",
    "The selected model service cannot accept requests until authorization is restored.",
    "Open Settings, finish authorization, then retry."
  ),
  usage: copy(
    "usage",
    "timeline.errorUsageTitle",
    "timeline.errorUsageMessage",
    "timeline.errorUsageRecovery",
    "Usage limit reached",
    "The active provider account has reached a usage, rate, or budget limit.",
    "Wait for the limit to reset, adjust the account limit, or choose another available model."
  ),
  service: copy(
    "service",
    "timeline.errorServiceTitle",
    "timeline.errorServiceMessage",
    "timeline.errorServiceRecovery",
    "Model service unavailable",
    "The selected runtime is disabled, unavailable, or not ready.",
    "Check the runtime in Settings or choose another available model."
  ),
  model: copy(
    "model",
    "timeline.errorModelTitle",
    "timeline.errorModelMessage",
    "timeline.errorModelRecovery",
    "Model unavailable",
    "The current model selection is no longer available for this task.",
    "Refresh the model list and choose an available model or supported mode."
  ),
  request: copy(
    "request",
    "timeline.errorRequestTitle",
    "timeline.errorRequestMessage",
    "timeline.errorRequestRecovery",
    "Request needs changes",
    "The request is empty, invalid, or uses an unsupported input.",
    "Update the request and try again."
  ),
  context: copy(
    "context",
    "timeline.errorContextTitle",
    "timeline.errorContextMessage",
    "timeline.errorContextRecovery",
    "Context limit reached",
    "The request or task history is too large for the selected model.",
    "Shorten the request, remove large attachments, compact the task, or start a new task."
  ),
  attachment: copy(
    "attachment",
    "timeline.errorAttachmentTitle",
    "timeline.errorAttachmentMessage",
    "timeline.errorAttachmentRecovery",
    "Attachment unavailable",
    "One or more attached files or images could not be read safely.",
    "Remove or replace the affected attachment, then retry."
  ),
  workspace: copy(
    "workspace",
    "timeline.errorWorkspaceTitle",
    "timeline.errorWorkspaceMessage",
    "timeline.errorWorkspaceRecovery",
    "Workspace unavailable",
    "The runtime cannot access the requested project, file, or worktree.",
    "Open an available trusted project and verify its workspace access before retrying."
  ),
  busy: copy(
    "busy",
    "timeline.errorBusyTitle",
    "timeline.errorBusyMessage",
    "timeline.errorBusyRecovery",
    "Task is busy",
    "Another task operation must finish before this request can continue.",
    "Wait for the current operation to finish, refresh the task, then retry."
  ),
  state: copy(
    "state",
    "timeline.errorStateTitle",
    "timeline.errorStateMessage",
    "timeline.errorStateRecovery",
    "Task state changed",
    "The task or native session changed while this operation was being prepared.",
    "Refresh the task and retry from its latest state."
  ),
  uncertain: copy(
    "uncertain",
    "timeline.errorUncertainTitle",
    "timeline.errorUncertainMessage",
    "timeline.errorUncertainRecovery",
    "Delivery status is uncertain",
    "The request may have reached the runtime, but its final outcome could not be confirmed.",
    "Check the latest timeline before retrying to avoid duplicate work."
  ),
  policy: copy(
    "policy",
    "timeline.errorPolicyTitle",
    "timeline.errorPolicyMessage",
    "timeline.errorPolicyRecovery",
    "Action not allowed",
    "The current trust, permission, or review policy blocks this action.",
    "Review the task permissions and workspace trust, then try an allowed action."
  ),
  runtime: copy(
    "runtime",
    "timeline.errorRuntimeTitle",
    "timeline.errorRuntimeMessage",
    "timeline.errorRuntimeRecovery",
    "Task runtime failed",
    "The runtime could not complete this part of the task.",
    "Retry if available. If it fails again, open diagnostics and repair or switch the runtime."
  )
} as const satisfies Readonly<Record<TimelineErrorKind, TimelineErrorCopy>>;

const PUBLISHED_ERROR_CODES = {
  capacity: [
    "TOO_MANY_REQUESTS",
    "UPSTREAM_OVERLOAD"
  ],
  connection: [
    "BACKGROUND_TASK_RUNTIME_LOST",
    "BACKEND_RUN_SILENCE_TIMEOUT",
    "CLAUDE_CODE_STREAM_ENDED",
    "CODEX_ADAPTER_CLOSED",
    "CODEX_APP_SERVER_DISCONNECTED",
    "PI_PROTOCOL_FAILURE",
    "PI_RPC_WRITE_FAILED",
    "PI_SERVICE_RECOVERY_FAILED",
    "UPSTREAM_STREAM_INTERRUPTED"
  ],
  authentication: [
    "BACKEND_AUTHENTICATION_REQUIRED",
    "CLAUDE_CODE_AUTHENTICATION_FAILED",
    "CLAUDE_CODE_LOGIN_METHOD_UNSUPPORTED",
    "CLAUDE_CODE_LOGIN_UNSUPPORTED",
    "CODEX_AUTH_REQUIRED",
    "CODEX_AUTH_PROTOCOL_INCOMPATIBLE",
    "CODEX_LOGIN_ID_INVALID",
    "PI_NATIVE_AUTH_LOAD_FAILED",
    "PI_NATIVE_AUTH_LOAD_REQUIRED"
  ],
  usage: [
    "CLAUDE_CODE_BUDGET_LIMIT",
    "CODEX_RATE_LIMITED"
  ],
  service: [
    "BACKEND_CAPABILITY_INCONSISTENT",
    "BACKEND_CAPABILITY_UNAVAILABLE",
    "BACKEND_DISABLED",
    "BACKEND_INSTANCE_UNAVAILABLE",
    "BACKEND_TEXT_INPUT_UNAVAILABLE",
    "BACKEND_UNAVAILABLE",
    "CLAUDE_CODE_BILLING_UNAVAILABLE",
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_PROVIDER_UNAVAILABLE",
    "CLAUDE_CODE_STARTUP_PROBE_FAILED",
    "CODEX_APP_SERVER_UNAVAILABLE",
    "NATIVE_HISTORY_UNSUPPORTED",
    "NATIVE_SESSION_CATALOG_UNSUPPORTED",
    "NATIVE_SESSION_DISCOVERY_UNSUPPORTED",
    "NATIVE_SESSION_START_UNSUPPORTED",
    "PI_ADAPTER_DISPOSED",
    "PI_AGENT_HOME_PROVISION_FAILED",
    "PI_COMPATIBILITY_PROCESS_SPAWN_FAILED",
    "PI_EXECUTABLE_INCOMPATIBLE",
    "PI_PROCESS_SPAWN_FAILED",
    "PI_RECONFIGURE_PROVISION_FAILED",
    "PI_RUNTIME_DIRECTORY_FAILED",
    "PI_RUNTIME_NOT_ACTIVE",
    "PI_RUNTIME_NOT_READY",
    "PI_RUNTIME_START_CLEANUP_FAILED",
    "PI_RUNTIME_START_FAILED",
    "PROVIDER_UNAVAILABLE",
    "CODEX_NOT_INSTALLED"
  ],
  model: [
    "CLAUDE_CODE_MODEL_UNAVAILABLE",
    "CODEX_EFFORT_SWITCH_FAILED",
    "CODEX_EFFORT_UNAVAILABLE",
    "CODEX_FAST_MODE_UNAVAILABLE",
    "CODEX_FAST_MODE_SWITCH_FAILED",
    "CODEX_MODEL_DISCOVERY_FAILED",
    "CODEX_MODEL_SELECTION_INCOMPLETE",
    "CODEX_MODEL_SELECTION_REQUIRED",
    "CODEX_MODEL_SWITCH_FAILED",
    "CODEX_MODEL_UNAVAILABLE",
    "CODEX_PROVIDER_ID_MISMATCH",
    "MODEL_ACCESS_DISABLED",
    "MODEL_FAST_MODE_UNAVAILABLE",
    "MODEL_ROUTE_UNAVAILABLE",
    "MODEL_SELECTION_INCOMPLETE",
    "PI_MODEL_EMPTY_PROVIDER",
    "PI_MODEL_INVALID_PROVIDER",
    "PI_THINKING_LEVEL_UNAVAILABLE"
  ],
  request: [
    "APPEND_SYSTEM_PROMPT_INVALID",
    "CODEX_MENTION_REFERENCE_UNSUPPORTED",
    "CODEX_OPERATION_ID_REQUIRED",
    "CODEX_PROMPT_EMPTY",
    "CODEX_SESSION_NAME_INVALID",
    "INPUT_CAPABILITY_UNAVAILABLE",
    "INPUT_EMPTY",
    "PI_BACKGROUND_TASK_ID_INVALID",
    "PI_BACKGROUND_TASK_ID_REQUIRED",
    "PI_PROMPT_EMPTY",
    "PI_SUBAGENT_CONTROL_ACTION_INVALID",
    "PI_SUBAGENT_CONTROL_INPUT_INVALID",
    "PORTABLE_SESSION_PASSWORD_REQUIRED",
    "PORTABLE_SESSION_TITLE_INVALID"
  ],
  context: [
    "APPEND_SYSTEM_PROMPT_TOO_LONG",
    "CLAUDE_CODE_CONTEXT_LIMIT",
    "CLAUDE_CODE_TURN_LIMIT",
    "CODEX_COMPACTION_FAILED",
    "CODEX_COMPACTION_INTERRUPTED",
    "CODEX_COMPACTION_TIMEOUT",
    "CODEX_INPUT_ITEM_LIMIT",
    "CODEX_NATIVE_COMPACTION_FAILED",
    "CODEX_NATIVE_HISTORY_SIZE_LIMIT",
    "CODEX_PROMPT_TOO_LARGE",
    "CONTEXT_OVERFLOW",
    "PI_AUTO_COMPACTION_FAILED",
    "PI_TREE_SUMMARY_INSTRUCTIONS_TOO_LONG"
  ],
  attachment: [
    "CODEX_FILE_RESOLVER_MISSING",
    "CODEX_FILE_UNAVAILABLE",
    "CODEX_FILE_UNSAFE",
    "CODEX_IMAGE_INTEGRITY_FAILED",
    "CODEX_IMAGE_REFERENCE_INVALID",
    "CODEX_IMAGE_RESOLVER_MISSING",
    "CODEX_IMAGE_TOO_LARGE",
    "CODEX_IMAGE_TYPE_UNSUPPORTED",
    "CODEX_IMAGE_UNAVAILABLE",
    "PI_FILE_PATH_DENIED",
    "PI_FILE_RESOLUTION_FAILED",
    "PI_FILE_RESOLVER_MISSING",
    "PI_FILE_UNAVAILABLE",
    "PI_FILE_UNSAFE",
    "PI_IMAGE_INTEGRITY_FAILED",
    "PI_IMAGE_INVALID_BYTES",
    "PI_IMAGE_READ_FAILED",
    "PI_IMAGE_RESOLVER_MISSING",
    "PI_IMAGE_TYPE_UNSUPPORTED"
  ],
  workspace: [
    "CODEX_FULL_ACCESS_REQUIRES_TRUST",
    "CODEX_NATIVE_SESSION_TARGET_MISMATCH",
    "CODEX_REMOTE_TARGET_UNSUPPORTED",
    "CODEX_TARGET_BACKEND_MISMATCH",
    "CODEX_TARGET_PATH_INVALID",
    "CODEX_TARGET_UNAVAILABLE",
    "CODEX_WORKSPACE_PATH_DENIED",
    "CODEX_WORKSPACE_UNAVAILABLE",
    "PI_CREATE_TARGET_MISMATCH",
    "PI_EXTRA_DIRECTORY_UNAVAILABLE",
    "PI_EXTRA_DIRECTORY_UNSAFE",
    "PI_REMOTE_WORKSPACE_UNAVAILABLE",
    "PI_SESSION_IMPORT_WORKSPACE_UNAVAILABLE",
    "PI_SESSION_PATH_RESOLUTION_FAILED",
    "PI_SESSION_WORKSPACE_MISMATCH",
    "PI_TARGET_BACKEND_MISMATCH",
    "PI_WORKSPACE_ALIAS_DENIED",
    "PI_WORKSPACE_NOT_ABSOLUTE",
    "PI_WORKSPACE_RESOLUTION_FAILED",
    "PI_WORKSPACE_UNAVAILABLE",
    "PI_WORKSPACE_UNSAFE",
    "REMOTE_WORKTREE_UNSUPPORTED",
    "WORKTREE_NATIVE_START_UNSUPPORTED",
    "WORKTREE_UNAVAILABLE"
  ],
  busy: [
    "CODEX_ACTIVE_TURN_REQUIRED",
    "CODEX_COMPACTION_IN_PROGRESS",
    "CODEX_FORK_BOUNDARY_BUSY",
    "COMPACTION_IN_PROGRESS",
    "NATIVE_SESSION_ALREADY_BOUND",
    "PI_SESSION_ACTIVE",
    "PI_SESSION_ALREADY_ACTIVE",
    "PI_TREE_RUNTIME_BUSY",
    "PORTABLE_SESSION_REPLACEMENT_BUSY"
  ],
  state: [
    "BACKEND_INSTANCE_STALE",
    "CODEX_BACKEND_GENERATION_STALE",
    "CODEX_CATALOG_MATERIALIZATION_UNAVAILABLE",
    "CODEX_CATALOG_REFERENCE_EXPIRED",
    "CODEX_CATALOG_SOURCE_CHANGED",
    "CODEX_CATALOG_TARGET_CONFLICT",
    "CODEX_CONTEXT_TARGET_MISMATCH",
    "CODEX_FORK_BOUNDARY_INVALID",
    "CODEX_FORK_BOUNDARY_NOT_FOUND",
    "CODEX_FORK_BOUNDARY_UNAVAILABLE",
    "CODEX_MODEL_PAGINATION_INVALID",
    "CODEX_MODEL_PAGINATION_LIMIT",
    "CODEX_NATIVE_HISTORY_UNAVAILABLE",
    "CODEX_NATIVE_REFERENCE_INVALID",
    "CODEX_NATIVE_SESSION_UNAVAILABLE",
    "CODEX_RUNTIME_GENERATION_STALE",
    "CODEX_SESSION_BINDING_MISMATCH",
    "CODEX_SESSION_BINDING_REQUIRED",
    "CODEX_SESSION_RESUME_FAILED",
    "DISPATCH_ADMISSION_STALE",
    "NATIVE_CONTEXT_REPLACED",
    "NATIVE_SESSION_CONTINUITY_GAP",
    "PI_SESSION_BIND_FAILED",
    "PI_SESSION_BINDING_MISMATCH",
    "PI_SESSION_BINDING_REQUIRED",
    "PI_SESSION_SWITCH_MISMATCH",
    "PI_STALE_GENERATION",
    "PORTABLE_SESSION_ACTIVATION_FAILED",
    "PORTABLE_SESSION_DRAFT_EXPIRED",
    "PORTABLE_SESSION_IMPORT_CONFLICT",
    "SCHEDULE_EXECUTION_SNAPSHOT_FAILED"
  ],
  uncertain: [
    "CODEX_DISPATCH_UNKNOWN",
    "CODEX_TURN_FAILED",
    "EFFECT_OUTCOME_UNKNOWN",
    "PI_NATIVE_AUTH_REFRESH_OUTCOME_UNKNOWN",
    "dispatch_unknown_after_restart"
  ],
  policy: [
    "CLAUDE_CODE_FULL_ACCESS_REQUIRES_TRUST",
    "CLAUDE_CODE_REVIEW_OPERATION_DENIED",
    "CLAUDE_CODE_REVIEW_PROFILE_INVALID",
    "CODEX_PERMISSION_MODE_FAILED",
    "CODEX_REVIEW_OPERATION_DENIED",
    "PI_REVIEW_OPERATION_DENIED",
    "PI_REVIEW_POLICY_IMMUTABLE",
    "REVIEW_RUNTIME_EVENT_DENIED"
  ],
  runtime: [
    "BACKEND_DISPATCH_FAILED",
    "BACKEND_RUN_FAILED",
    "CLAUDE_CODE_EXECUTION_FAILED",
    "EFFECT_FAILED",
    "ORCHESTRATOR_ASYNC_EFFECT_FAILED",
    "PI_ARTIFACT_STORE_FAILED",
    "PI_CONTROL_READ_FAILED",
    "PI_EVENT_TRANSLATION_FAILED",
    "PI_EXPORT_STORE_FAILED",
    "PI_FORK_MATERIALIZATION_FAILED",
    "PI_PROCESS_KILL_FAILED",
    "PI_PROCESS_TERMINATE_FAILED",
    "PI_PROVIDER_RESPONSE_FAILED",
    "PI_RESOURCE_SNAPSHOT_FAILED",
    "PI_RUNTIME_CLEANUP_FAILED",
    "PI_SESSION_DELETE_INCOMPLETE",
    "CODEX_SESSION_CREATE_FAILED",
    "CODEX_SESSION_DELETE_FAILED",
    "CODEX_SESSION_FORK_FAILED",
    "CODEX_SESSION_RENAME_FAILED",
    "CODEX_THREAD_DISCOVERY_FAILED",
    "CODEX_THREAD_PAGINATION_INVALID",
    "CODEX_THREAD_PAGINATION_LIMIT",
    "CODEX_TURN_INTERRUPT_FAILED",
    "CODEX_TURN_START_FAILED",
    "PI_SESSION_EXPORT_OPEN_FAILED",
    "PI_SESSION_IMPORT_WRITE_FAILED",
    "PI_SESSION_LIST_FAILED",
    "PI_SESSION_STORE_INIT_FAILED",
    "PI_SESSION_TRASH_UNAVAILABLE",
    "PI_STALE_RUNTIME_CLEANUP_FAILED",
    "PI_SUBAGENT_DELETION_RECOVERY_INCOMPLETE",
    "PI_SUBAGENT_FAILED",
    "PI_SUMMARIZATION_RETRY",
    "PI_TRANSIENT_PROVIDER_ERROR",
    "PI_RETRY_EXHAUSTED",
    "PORTABLE_SESSION_EXPORT_FORMAT_LIMIT_EXCEEDED",
    "PORTABLE_SESSION_EXPORT_UNSUPPORTED",
    "PORTABLE_SESSION_IMPORT_UNSUPPORTED",
    "REVIEWER_DISPATCH_FAILED",
    "SUBAGENT_EVENT_UNSUPPORTED"
  ]
} as const satisfies Readonly<Record<Exclude<TimelineErrorKind, "unknown">, readonly string[]>>;

export type PublishedTimelineErrorCode = (typeof PUBLISHED_ERROR_CODES)[keyof typeof PUBLISHED_ERROR_CODES][number];

const KIND_BY_CODE = new Map<string, Exclude<TimelineErrorKind, "unknown">>(
  (Object.entries(PUBLISHED_ERROR_CODES) as Array<[
    Exclude<TimelineErrorKind, "unknown">,
    readonly PublishedTimelineErrorCode[]
  ]>).flatMap(([kind, codes]) => codes.map((code) => [code, kind] as const))
);

export function timelineErrorCopy(code: string): TimelineErrorCopy {
  return COPY_BY_KIND[KIND_BY_CODE.get(code) ?? "unknown"];
}

function copy(
  kind: TimelineErrorKind,
  titleKey: MessageKey,
  messageKey: MessageKey,
  recoveryKey: MessageKey,
  titleFallback: string,
  messageFallback: string,
  recoveryFallback: string
): TimelineErrorCopy {
  return { kind, titleKey, messageKey, recoveryKey, titleFallback, messageFallback, recoveryFallback };
}
