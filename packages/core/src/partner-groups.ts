import type { BlobRef } from "./types.js";

export const PARTNER_GROUP_MIN_MEMBERS = 2;
export const PARTNER_GROUP_MAX_MEMBERS = 6;
export const PARTNER_GROUP_NAME_MAX_CHARS = 40;
export const PARTNER_GROUP_MESSAGE_MAX_CHARS = 8_000;
export const PARTNER_GROUP_REPLY_MAX_CHARS = 16_000;
export const PARTNER_GROUP_PAGE_SIZE = 100;
export const PARTNER_GROUP_PLAN_MAX_STEPS = 6;
export const PARTNER_GROUP_PLAN_TASK_MAX_CHARS = 80;
export const PARTNER_GROUP_STEP_FILES_MAX = 20;
export const PARTNER_GROUP_ATTACHMENTS_MAX = 20;
export const PARTNER_GROUP_TURN_ATTACHMENTS_MAX = 40;
export const PARTNER_GROUP_NO_REPLY_SENTINEL = "NO_REPLY";

export type PartnerGroupReplyMode = "all" | "mentioned";
export type PartnerGroupSpeakingMode = "auto" | "sequential";
export type PartnerGroupAuthorKind = "user" | "partner" | "system";
export type PartnerGroupMessageKind = "message" | "round-end" | "notice" | "plan" | "plan-end";
export type PartnerGroupNoticeCode = "member-failed" | "member-timeout" | "member-unavailable" | "plan-failed" | "plan-stopped" | "workdir-unavailable";
export type PartnerGroupMemberStatus = "active" | "paused" | "error" | "archived" | "deleting" | "missing";
export type PartnerGroupPlanStatus = "proposed" | "running" | "waiting" | "done" | "stopped" | "dismissed" | "superseded";
export type PartnerGroupPlanStepStatus = "pending" | "running" | "done" | "failed";
export type PartnerGroupSpeakerActivity = "reply" | "planning" | "step";
export type PartnerGroupChange = "created" | "updated" | "deleted" | "messages" | "round" | "plan" | "read";
export interface PartnerGroupChangeNotice {
  readonly sequence: number;
  readonly groupId: string;
  readonly groupRevision: number;
  readonly directoryRevision: number;
  readonly change: PartnerGroupChange;
  readonly createdAt: number;
}

export interface PartnerGroupMention {
  readonly all: boolean;
  readonly partnerIds: readonly string[];
}

/** Attachments keep the existing adopted Blob identity; paths and credentials are not wire authority. */
export interface PartnerGroupAttachment {
  readonly id: string;
  readonly name: string;
  readonly category: "image" | "pdf" | "text" | "office" | "file";
  readonly blob: BlobRef;
  readonly annotated: boolean;
}

export interface PartnerGroupRecord {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly replyMode: PartnerGroupReplyMode;
  readonly speakingMode: PartnerGroupSpeakingMode;
  readonly organizerPartnerId: string | null;
  readonly projectDir: string | null;
  readonly lifecycle: "active" | "deleting";
  readonly memberIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PartnerGroupMembership {
  readonly partnerId: string;
  readonly position: number;
  readonly lastSeenSequence: number;
  readonly joinedAt: number;
}

export interface PartnerGroupMessage {
  readonly id: string;
  readonly sequence: number;
  readonly kind: PartnerGroupMessageKind;
  readonly authorKind: PartnerGroupAuthorKind;
  readonly authorPartnerId: string | null;
  readonly authorName: string;
  readonly content: string;
  readonly mentions: PartnerGroupMention;
  readonly noticeCode: PartnerGroupNoticeCode | null;
  readonly planId: string | null;
  /** Handoff files are relative to the exact plan work directory. */
  readonly files: readonly string[];
  readonly attachments: readonly PartnerGroupAttachment[];
  readonly createdAt: number;
}

export interface PartnerGroupPlanStep {
  readonly position: number;
  readonly partnerId: string;
  readonly partnerName: string;
  readonly task: string;
  readonly status: PartnerGroupPlanStepStatus;
  readonly resultMessageId: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface PartnerGroupPlan {
  readonly id: string;
  readonly groupId: string;
  readonly revision: number;
  readonly status: PartnerGroupPlanStatus;
  readonly requestText: string;
  readonly attachments: readonly PartnerGroupAttachment[];
  readonly organizerPartnerId: string;
  readonly organizerName: string;
  readonly steps: readonly PartnerGroupPlanStep[];
  readonly currentStep: number | null;
  /** Private host location. Controller projections remove this field's content. */
  readonly workDir: string | null;
  readonly branch: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Creation is claimed before native work; unknown creation is observed, never replayed blindly. */
export interface PartnerGroupLane {
  readonly groupId: string;
  readonly partnerId: string;
  readonly planId: string | null;
  readonly operationId: string;
  readonly phase: "preparing" | "ready" | "unknown" | "archived";
  readonly sessionId: string | null;
  readonly profileVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PartnerGroupMember {
  readonly partnerId: string;
  readonly name: string;
  readonly status: PartnerGroupMemberStatus;
}

export interface PartnerGroupSpeaker {
  readonly partnerId: string;
  readonly sessionId: string | null;
  readonly activity: PartnerGroupSpeakerActivity;
}

export interface PartnerGroupRound {
  readonly status: "idle" | "running";
  readonly speakers: readonly PartnerGroupSpeaker[];
  readonly canContinue: boolean;
}

export interface PartnerGroupSummary {
  readonly id: string;
  readonly revision: number;
  readonly lifecycle: "active" | "deleting";
  readonly name: string;
  readonly replyMode: PartnerGroupReplyMode;
  readonly speakingMode: PartnerGroupSpeakingMode;
  readonly organizerPartnerId: string | null;
  readonly projectDir: string | null;
  readonly projectDirName: string | null;
  readonly members: readonly PartnerGroupMember[];
  readonly lastMessage: Pick<PartnerGroupMessage, "authorKind" | "authorName" | "content" | "createdAt"> | null;
  readonly lastReplyAt: number | null;
  readonly unread: boolean;
  readonly planningPartnerId: string | null;
  readonly speakers: readonly PartnerGroupSpeaker[];
  readonly openPlan: PartnerGroupPlan | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PartnerGroupDetail extends PartnerGroupSummary {
  readonly messages: readonly PartnerGroupMessage[];
  readonly hasMoreBefore: boolean;
  readonly round: PartnerGroupRound;
  readonly plans: readonly PartnerGroupPlan[];
}

export function isPartnerGroupPlanOpen(status: PartnerGroupPlanStatus): boolean {
  return status === "proposed" || status === "running" || status === "waiting";
}

export function isPartnerGroupNoReplyText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || trimmed === PARTNER_GROUP_NO_REPLY_SENTINEL;
}

export function isPartnerGroupNoReplyPrefix(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || PARTNER_GROUP_NO_REPLY_SENTINEL.startsWith(trimmed);
}

export function partnerGroupLaneRouteKey(groupId: string): string { return `group:${groupId}`; }
export function partnerGroupPlanRouteKey(groupId: string, planId: string): string { return `group:${groupId}:plan:${planId}`; }
