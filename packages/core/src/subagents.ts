import type { PublicError, SessionId, UnixMillis } from "./types.js";

export type SubagentRunState = "queued" | "running" | "completed" | "failed" | "stopped";

export type SubagentActivityKind =
  | "started"
  | "progress"
  | "message"
  | "question"
  | "decision"
  | "resumed"
  | "steered"
  | "followed_up"
  | "completed"
  | "failed"
  | "stopped";

export type SubagentParentContext = "unknown" | "none" | "snapshot" | "live";

/** Run-local truth. Backend manifest capabilities still gate every public entry point. */
export interface SubagentCapabilities {
  readonly viewActivity: boolean;
  readonly viewReturnedResult: boolean;
  readonly viewFullTranscript: boolean;
  readonly stop: boolean;
  readonly steer: boolean;
  readonly followUp: boolean;
  readonly resume: boolean;
  readonly parentContext: SubagentParentContext;
}

export interface SubagentUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

export interface SubagentRoute {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
}

export interface SubagentActivityEntry {
  /** Monotonic inside one logical Subagent run. */
  readonly sequence: number;
  readonly kind: SubagentActivityKind;
  readonly state: SubagentRunState;
  readonly summary?: string;
  readonly lastToolName?: string;
  readonly occurredAt: UnixMillis;
}

export interface SubagentChildRun {
  readonly id: string;
  readonly parentChildId?: string;
  readonly identityAliases: readonly string[];
  readonly role: string;
  readonly title?: string;
  readonly assignment?: string;
  readonly state: SubagentRunState;
  readonly route?: SubagentRoute;
  readonly usage?: SubagentUsage;
  /** Run-local permission truth; false means the managed child may mutate through its policy bridge. */
  readonly readOnly?: boolean;
  readonly awaitingApproval?: boolean;
  readonly result?: string;
  readonly resultTruncated?: boolean;
  readonly error?: PublicError;
  readonly startedAt?: UnixMillis;
  readonly endedAt?: UnixMillis;
}

/** Durable public summary for one logical delegated run. */
export interface SubagentRun {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly parentRunId?: string;
  readonly parentSubagentRunId?: string;
  readonly parentTaskId?: string;
  /** Link to the parent task's spawning tool call, when exposed. */
  readonly parentToolCallId?: string;
  readonly logicalAgentId: string;
  readonly identityAliases: readonly string[];
  /** Opaque Backend-native identities, never local paths. */
  readonly providerRunIds: readonly string[];
  readonly state: SubagentRunState;
  readonly title?: string;
  readonly description?: string;
  readonly assignment?: string;
  readonly summary?: string;
  readonly route?: SubagentRoute;
  readonly usage?: SubagentUsage;
  /** Run-local permission truth; false means at least one delegated child is write-enabled. */
  readonly readOnly?: boolean;
  readonly capabilities: SubagentCapabilities;
  readonly startedAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly endedAt?: UnixMillis;
  readonly error?: PublicError;
}

export interface SubagentRunDetail extends SubagentRun {
  readonly activity: readonly SubagentActivityEntry[];
  /** Undefined means the producer did not observe child-level detail. */
  readonly children?: readonly SubagentChildRun[];
  readonly returnedResult?: string;
  readonly returnedResultTruncated?: boolean;
}

export type SubagentTranscriptRole = "parent" | "subagent" | "tool" | "system";
export type SubagentToolPhase = "start" | "update" | "end";
export type SubagentControlAction = "stop" | "steer" | "follow_up" | "resume";

export interface SubagentSystemEvent {
  readonly kind: string;
  readonly params?: Readonly<Record<string, string>>;
}

/** Append-only, display-safe transcript entry. Tool input must already be bounded and redacted. */
export interface SubagentTranscriptEntry {
  readonly id: string;
  readonly sequence: number;
  readonly role: SubagentTranscriptRole;
  readonly content: string;
  readonly occurredAt: UnixMillis;
  readonly childId?: string;
  readonly childTitle?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly toolPhase?: SubagentToolPhase;
  readonly toolInputJson?: string;
  readonly isError?: boolean;
  readonly controlAction?: SubagentControlAction;
  readonly systemEvent?: SubagentSystemEvent;
}

export interface SubagentControlInput {
  readonly runId: string;
  readonly childId?: string;
  readonly action: SubagentControlAction;
  readonly message?: string;
}
