import type { PartnerPrivateMessageOrigin } from "./events.js";

export const PARTNER_WORKBENCH_MAX_PROJECTS = 50;
export const PARTNER_WORKBENCH_MAX_JUDGMENTS = 200;
export const PARTNER_WORKBENCH_TITLE_MAX = 40;
export const PARTNER_WORKBENCH_NEXT_MAX = 120;
export const PARTNER_WORKBENCH_REF_MAX = 2_000;
export const PARTNER_WORKBENCH_TASK_ID_MAX = 256;
export const PARTNER_WORKBENCH_RECENT_WINDOW_MS = 30 * 24 * 60 * 60_000;
export const PARTNER_WORKBENCH_TRANSCRIPT_MAX = 4_000;

export type PartnerWorkbenchVerdict = "unfinished" | "idea" | "done";
export type PartnerWorkbenchTaskState = "running" | "waiting" | "queued" | "stopped" | "automation" | "done";
export type PartnerWorkbenchGroup = "waiting" | "running" | "todo" | "done";

export interface PartnerWorkbenchProject {
  readonly path: string;
  readonly addedAt: number;
}

export interface PartnerWorkbenchJudgment {
  readonly taskId: string;
  readonly project: string;
  readonly title: string;
  readonly verdict: PartnerWorkbenchVerdict;
  readonly next: string | null;
  readonly ref?: string;
  readonly updatedAt: number;
}

export interface PartnerWorkbenchState {
  readonly partnerId: string;
  readonly revision: bigint;
  readonly projects: readonly PartnerWorkbenchProject[];
  readonly judgments: readonly PartnerWorkbenchJudgment[];
}

export interface PartnerWorkbenchTranscriptItem {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: number;
  readonly privateMessageOrigin?: PartnerPrivateMessageOrigin;
}

export interface PartnerWorkbenchDigest {
  readonly purpose: string | null;
  readonly recent: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
}

export interface PartnerWorkbenchTask {
  readonly id: string;
  readonly kind: "session" | "external" | "item" | "automation";
  readonly project: string;
  readonly title: string;
  readonly state: PartnerWorkbenchTaskState;
  readonly group: PartnerWorkbenchGroup;
  readonly updatedAt: number;
  readonly sessionId?: string;
  readonly startedAt?: number;
  readonly scheduleSummary?: string;
  readonly scheduleId?: string;
  readonly sourceLabel: string;
  readonly ownedBackground: boolean;
  readonly unread: boolean;
  readonly judgment?: PartnerWorkbenchJudgment;
  readonly digest: PartnerWorkbenchDigest;
}

export interface PartnerWorkbenchProjectOption {
  readonly path: string;
  readonly name: string;
  readonly taskCount: number;
  readonly nativeCount: number;
  readonly automationCount: number;
  readonly repository: boolean;
  readonly granted: boolean;
}

export interface PartnerWorkbenchProjectBrief {
  readonly project: string;
  readonly docs: readonly string[];
  readonly recent: readonly { readonly path: string; readonly modifiedAt: number }[];
  readonly git?: {
    readonly branch?: string;
    readonly changes?: number;
    readonly commits: readonly { readonly sha: string; readonly date: string; readonly author: string; readonly subject: string }[];
    readonly branches: readonly { readonly name: string; readonly date: string }[];
    readonly remotes: readonly string[];
  };
  readonly codeHost: {
    readonly repository?: string;
    readonly pullRequests: readonly { readonly number: number; readonly title: string; readonly url: string; readonly updatedAt: number }[];
    readonly issues: readonly { readonly number: number; readonly title: string; readonly url: string; readonly updatedAt: number }[];
    readonly unavailable?: "not_supported" | "no_credential" | "unavailable";
  };
}

export interface PartnerWorkbenchDetail {
  readonly task: PartnerWorkbenchTask;
  readonly transcript: readonly PartnerWorkbenchTranscriptItem[];
  readonly truncated: boolean;
  readonly artifacts: readonly PartnerWorkbenchArtifact[];
}

export interface PartnerWorkbenchArtifact { readonly id: string; readonly title: string; readonly mimeType: string; readonly byteSize: number; readonly sessionId: string }

/** Durable Session, Queue, Interaction and effect owners supply these signals.
 * A quiet task alone cannot prove that it still needs work. */
export function derivePartnerWorkbenchTaskState(signals: {
  readonly queued?: boolean;
  readonly waiting?: boolean;
  readonly running?: boolean;
  readonly interrupted?: boolean;
  readonly errored?: boolean;
  readonly delegationStatus?: "preparing" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
}): PartnerWorkbenchTaskState {
  if (signals.queued || signals.delegationStatus === "preparing" || signals.delegationStatus === "queued") return "queued";
  if (signals.waiting || signals.delegationStatus === "waiting") return "waiting";
  if (signals.running || signals.delegationStatus === "running") return "running";
  if (signals.interrupted || signals.errored || ["failed", "cancelled", "unknown"].includes(signals.delegationStatus ?? "")) return "stopped";
  return "done";
}

export function derivePartnerWorkbenchAutomationState(signals: {
  readonly enabled: boolean;
  readonly running?: boolean;
  readonly queued?: boolean;
}): PartnerWorkbenchTaskState {
  if (signals.running) return "running";
  if (signals.queued) return "queued";
  return signals.enabled ? "automation" : "stopped";
}

export function partnerWorkbenchGroup(
  state: PartnerWorkbenchTaskState,
  kind: "session" | "external" | "item" | "automation",
  verdict?: PartnerWorkbenchVerdict
): PartnerWorkbenchGroup {
  if (state === "waiting" || state === "stopped" && (kind === "session" || kind === "external")) return "waiting";
  if (state === "running") return "running";
  if (state === "queued" || kind === "item" || verdict === "unfinished" || verdict === "idea") return "todo";
  return "done";
}

export function buildPartnerWorkbenchDigest(
  head: readonly PartnerWorkbenchTranscriptItem[],
  tail: readonly PartnerWorkbenchTranscriptItem[]
): PartnerWorkbenchDigest {
  const flatten = (value: string): string => value.replace(/\s+/gu, " ").trim();
  const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
  const purpose = head.filter((item) => item.role === "user").map((item) => flatten(item.text)).find(Boolean);
  const recent: { role: "user" | "assistant"; text: string }[] = [];
  for (let index = tail.length - 1; index >= 0 && recent.length < 3; index -= 1) {
    const item = tail[index];
    if (item === undefined) continue;
    const text = flatten(item.text);
    if (text !== "") recent.unshift({ role: item.role, text: clip(text, 300) });
  }
  return { purpose: purpose === undefined ? null : clip(purpose, 200), recent };
}

/** Removing a project hides its judgments; it never deletes their history. */
export function boundPartnerWorkbenchJudgments(
  judgments: readonly PartnerWorkbenchJudgment[],
  max = PARTNER_WORKBENCH_MAX_JUDGMENTS
): readonly PartnerWorkbenchJudgment[] {
  if (judgments.length <= max) return judgments;
  const age = (left: PartnerWorkbenchJudgment, right: PartnerWorkbenchJudgment): number => left.updatedAt - right.updatedAt || left.taskId.localeCompare(right.taskId);
  const eviction = [...judgments.filter((item) => item.verdict === "done").sort(age), ...judgments.filter((item) => item.verdict !== "done").sort(age)];
  const removed = new Set(eviction.slice(0, judgments.length - max).map((item) => item.taskId));
  return judgments.filter((item) => !removed.has(item.taskId));
}
