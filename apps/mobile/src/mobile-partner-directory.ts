import { projectMobilePartnerAvatar, type MobilePartnerAvatarValue } from "./mobile-partner-avatar";
import {
  PartnerInitializationErrorCode,
  PartnerInitializationState,
  PartnerInvitationStage,
  PartnerLifecycle,
  PartnerSessionRole,
  PermissionMode,
  type ListPartnerSessionsResponse,
  type ListPartnersResponse,
  type MarkPartnerReadResponse,
  type PartnerActivity,
  type PartnerCapabilities,
  type PartnerDirectory,
  type PartnerProfile
} from "@joko/contracts";

const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_LABEL = /^[^\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u;
const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u;
const MAX_PARTNERS = 1_000;

export interface MobilePartnerModelRoute {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
}

export interface MobilePartnerCapabilities {
  readonly modelChain: readonly MobilePartnerModelRoute[];
  readonly permissionMode: "ask" | "auto";
  readonly planMode: boolean;
}

export interface MobilePartnerActivity {
  readonly partnerId: string;
  readonly unreadReplyCount: number;
  readonly latestReplyCursor?: bigint;
  readonly latestReplyAt?: number;
  readonly artifactCount: number;
  readonly activeDelegationCount: number;
  readonly readThroughCursor: bigint;
  readonly readUpdatedAt: number;
}

export interface MobilePartnerDirectoryProfile {
  readonly partnerId: string;
  readonly revision: bigint;
  readonly profileVersion: bigint;
  readonly displayName: string;
  readonly avatar: MobilePartnerAvatarValue;
  readonly identitySource: string;
  readonly templateId: string;
  readonly lifecycle: "active" | "archived";
  readonly initializationState: "pending" | "ready" | "error";
  readonly invitationStage: "home" | "avatar" | "session" | "ready" | "failed";
  readonly initializationErrorCode?: "homeUnavailable" | "avatarUnavailable" | "modelUnavailable" | "sessionUnavailable" | "stateChanged";
  readonly homeTargetId: string;
  readonly canonicalSessionId?: string;
  readonly capabilities: MobilePartnerCapabilities;
  readonly usesDirectoryDefaults: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly activity: MobilePartnerActivity;
}

export interface MobilePartnerDirectorySummary {
  readonly revision: bigint;
  readonly activeCount: number;
  readonly archivedCount: number;
  readonly errorCount: number;
  readonly updatedAt: number;
}

export interface MobilePartnerCatalog {
  readonly directory: MobilePartnerDirectorySummary;
  readonly partners: readonly MobilePartnerDirectoryProfile[];
}

export interface MobilePartnerDirectoryOpenResult {
  readonly sessionId: string;
}

export interface MobilePartnerDirectoryTransport {
  readonly ownerKey: string;
  list(signal: AbortSignal): Promise<MobilePartnerCatalog>;
  open(partner: MobilePartnerDirectoryProfile, signal: AbortSignal): Promise<MobilePartnerDirectoryOpenResult>;
}

export function mobilePartnerDirectoryIdentity(profile: MobilePartnerDirectoryProfile): string {
  return [profile.partnerId, profile.revision.toString(10), profile.profileVersion.toString(10),
    profile.homeTargetId, profile.canonicalSessionId ?? "", profile.lifecycle, profile.initializationState].join("\u001f");
}

export function filterMobilePartnerDirectory(
  partners: readonly MobilePartnerDirectoryProfile[],
  lifecycle: MobilePartnerDirectoryProfile["lifecycle"],
  query: string,
  locale: string
): readonly MobilePartnerDirectoryProfile[] {
  const needle = query.normalize("NFKC").trim().toLocaleLowerCase(locale);
  return partners.filter((partner) => partner.lifecycle === lifecycle && (needle === ""
    || partner.displayName.normalize("NFKC").toLocaleLowerCase(locale).includes(needle)
    || firstIdentityLine(partner.identitySource).normalize("NFKC").toLocaleLowerCase(locale).includes(needle)))
    .sort((left, right) => {
      const leftActivity = left.activity.latestReplyAt ?? left.updatedAt;
      const rightActivity = right.activity.latestReplyAt ?? right.updatedAt;
      return rightActivity - leftActivity || left.displayName.localeCompare(right.displayName, locale)
        || left.partnerId.localeCompare(right.partnerId);
    });
}

export function firstIdentityLine(identitySource: string): string {
  return identitySource.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
}

export function projectMobilePartnerCatalog(response: ListPartnersResponse): MobilePartnerCatalog {
  if (!response.directory || response.partners.length > MAX_PARTNERS) {
    throw new Error("The Joko node returned an invalid Partner directory.");
  }
  const directory = projectDirectory(response.directory);
  const ids = new Set<string>();
  const sessions = new Set<string>();
  const partners = response.partners.map((wire) => {
    const partner = projectMobilePartnerProfile(wire);
    if (ids.has(partner.partnerId)
      || partner.canonicalSessionId !== undefined && sessions.has(partner.canonicalSessionId)) {
      throw new Error("The Joko node returned duplicate Partner identities.");
    }
    ids.add(partner.partnerId);
    if (partner.canonicalSessionId !== undefined) sessions.add(partner.canonicalSessionId);
    return partner;
  });
  const activeCount = partners.filter((partner) => partner.lifecycle === "active").length;
  const archivedCount = partners.length - activeCount;
  const errorCount = partners.filter((partner) => partner.initializationState === "error").length;
  if (directory.activeCount !== activeCount || directory.archivedCount !== archivedCount
    || directory.errorCount !== errorCount) {
    throw new Error("The Joko node returned inconsistent Partner directory counts.");
  }
  return { directory, partners };
}

export function assertMobilePartnerDirectorySession(
  partner: MobilePartnerDirectoryProfile,
  response: ListPartnerSessionsResponse
): string {
  const sessionId = partner.canonicalSessionId;
  if (sessionId === undefined || partner.lifecycle !== "active" || partner.initializationState !== "ready"
    || response.sessions.length > 2_000) {
    throw new Error("The selected Partner does not have an available canonical task.");
  }
  const matches = response.sessions.filter((session) => session.sessionId === sessionId);
  if (matches.length !== 1 || matches[0]?.partnerId !== partner.partnerId
    || matches[0].role !== PartnerSessionRole.CANONICAL || !matches[0].available
    || matches[0].profileVersion < 1n || matches[0].profileVersion > partner.profileVersion || matches[0].readOnly
    || matches[0].deleted || matches[0].archived) {
    throw new Error("The selected Partner canonical task is no longer available.");
  }
  return sessionId;
}

export function projectMobilePartnerReadResponse(
  partnerId: string,
  requestedCursor: bigint,
  response: MarkPartnerReadResponse
): MobilePartnerActivity {
  const activity = projectActivity(response.activity);
  if (activity.partnerId !== partnerId || activity.readThroughCursor < requestedCursor) {
    throw new Error("The Joko node returned a mismatched Partner read acknowledgement.");
  }
  return activity;
}

export function projectMobilePartnerProfile(value: PartnerProfile): MobilePartnerDirectoryProfile {
  const partnerId = id(value.partnerId, "Partner ID");
  const lifecycle = value.lifecycle === PartnerLifecycle.ACTIVE ? "active" as const
    : value.lifecycle === PartnerLifecycle.ARCHIVED ? "archived" as const : undefined;
  const initializationState = value.initializationState === PartnerInitializationState.PENDING ? "pending" as const
    : value.initializationState === PartnerInitializationState.READY ? "ready" as const
      : value.initializationState === PartnerInitializationState.ERROR ? "error" as const : undefined;
  const invitationStage = value.invitationStage === PartnerInvitationStage.HOME ? "home" as const
    : value.invitationStage === PartnerInvitationStage.AVATAR ? "avatar" as const
      : value.invitationStage === PartnerInvitationStage.SESSION ? "session" as const
        : value.invitationStage === PartnerInvitationStage.READY ? "ready" as const
          : value.invitationStage === PartnerInvitationStage.FAILED ? "failed" as const : undefined;
  const initializationErrorCode = value.initializationErrorCode === undefined ? undefined
    : value.initializationErrorCode === PartnerInitializationErrorCode.HOME_UNAVAILABLE ? "homeUnavailable" as const
      : value.initializationErrorCode === PartnerInitializationErrorCode.AVATAR_UNAVAILABLE ? "avatarUnavailable" as const
        : value.initializationErrorCode === PartnerInitializationErrorCode.MODEL_UNAVAILABLE ? "modelUnavailable" as const
          : value.initializationErrorCode === PartnerInitializationErrorCode.SESSION_UNAVAILABLE ? "sessionUnavailable" as const
            : value.initializationErrorCode === PartnerInitializationErrorCode.STATE_CHANGED ? "stateChanged" as const : undefined;
  const canonicalSessionId = value.canonicalSessionId === undefined
    ? undefined : id(value.canonicalSessionId, "Partner canonical task ID");
  if (!lifecycle || !initializationState || !invitationStage
    || value.initializationErrorCode !== undefined && !initializationErrorCode
    || (initializationState === "error") !== (initializationErrorCode !== undefined)
    || (initializationState === "error") !== (invitationStage === "failed")
    || (initializationState === "ready") !== (invitationStage === "ready")
    || initializationState === "ready" && canonicalSessionId === undefined) {
    throw new Error("The Joko node returned an inconsistent Partner state.");
  }
  const activity = projectActivity(value.activity);
  if (activity.partnerId !== partnerId) throw new Error("The Joko node returned activity for another Partner.");
  return {
    partnerId,
    revision: revision(value.revision, "Partner"),
    profileVersion: positive(value.profileVersion, "Partner profile version"),
    displayName: label(value.displayName, 200, "Partner name"),
    avatar: projectMobilePartnerAvatar(value.avatar),
    identitySource: text(value.identitySource, 8_000, "Partner identity"),
    templateId: id(value.templateId, "Partner template ID"),
    lifecycle,
    initializationState,
    invitationStage,
    ...(initializationErrorCode === undefined ? {} : { initializationErrorCode }),
    homeTargetId: id(value.homeTargetId, "Partner home target ID"),
    ...(canonicalSessionId === undefined ? {} : { canonicalSessionId }),
    capabilities: projectMobilePartnerCapabilities(value.capabilities),
    usesDirectoryDefaults: value.usesDirectoryDefaults,
    createdAt: timestamp(value.createdAt, "Partner creation time"),
    updatedAt: timestamp(value.updatedAt, "Partner update time"),
    activity
  };
}

function projectDirectory(value: PartnerDirectory): MobilePartnerDirectorySummary {
  if (![value.activeCount, value.archivedCount, value.errorCount]
    .every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new Error("The Joko node returned invalid Partner directory counts.");
  }
  return {
    revision: revision(value.revision, "Partner directory"),
    activeCount: value.activeCount,
    archivedCount: value.archivedCount,
    errorCount: value.errorCount,
    updatedAt: timestamp(value.updatedAt, "Partner directory update time")
  };
}

export function projectMobilePartnerCapabilities(value: PartnerCapabilities | undefined): MobilePartnerCapabilities {
  if (!value || value.modelChain.length < 1 || value.modelChain.length > 3) {
    throw new Error("The Joko node returned an invalid Partner model chain.");
  }
  const modelChain = value.modelChain.map((route): MobilePartnerModelRoute => ({
    backendId: id(route.backendId, "Partner Backend ID"),
    providerId: id(route.providerId, "Partner Provider ID"),
    modelId: label(route.modelId, 128, "Partner model ID"),
    ...(route.effort === undefined ? {} : { effort: label(route.effort, 64, "Partner effort") }),
    fastMode: route.fastMode
  }));
  const backendId = modelChain[0]!.backendId;
  const routes = new Set(modelChain.map((route) => `${route.providerId}\u001f${route.modelId}`));
  if (modelChain.some((route) => route.backendId !== backendId) || routes.size !== modelChain.length) {
    throw new Error("The Joko node returned an inconsistent Partner model chain.");
  }
  const permissionMode = value.permissionMode === PermissionMode.ASK ? "ask" as const
    : value.permissionMode === PermissionMode.AUTO ? "auto" as const : undefined;
  if (!permissionMode) throw new Error("The Joko node returned an unsupported Partner permission mode.");
  return { modelChain, permissionMode, planMode: value.planMode };
}

function projectActivity(value: PartnerActivity | undefined): MobilePartnerActivity {
  if (!value) throw new Error("The Joko node returned no Partner activity.");
  const latestReplyCursor = value.latestReplyCursor === undefined
    ? undefined : cursor(value.latestReplyCursor, "Partner latest reply cursor");
  const latestReplyAt = value.latestReplyAt === undefined
    ? undefined : timestamp(value.latestReplyAt, "Partner latest reply time");
  const readThroughCursor = cursor(value.readThroughCursor, "Partner read cursor");
  const unreadReplyCount = count(value.unreadReplyCount, "Partner unread reply count");
  if ((latestReplyCursor === undefined) !== (latestReplyAt === undefined)
    || unreadReplyCount > 0 && (latestReplyCursor === undefined || latestReplyCursor <= readThroughCursor)) {
    throw new Error("The Joko node returned inconsistent Partner reply activity.");
  }
  return {
    partnerId: id(value.partnerId, "Partner activity owner"),
    unreadReplyCount,
    ...(latestReplyCursor === undefined ? {} : { latestReplyCursor }),
    ...(latestReplyAt === undefined ? {} : { latestReplyAt }),
    artifactCount: count(value.artifactCount, "Partner Artifact count"),
    activeDelegationCount: count(value.activeDelegationCount, "Partner active delegation count"),
    readThroughCursor,
    readUpdatedAt: timestamp(value.readUpdatedAt, "Partner read update time")
  };
}

function id(value: string, name: string): string {
  if (!ENTITY_ID.test(value)) throw new Error(`The Joko node returned an invalid ${name}.`);
  return value;
}

function label(value: string, maximum: number, name: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > maximum || !SAFE_LABEL.test(value)) {
    throw new Error(`The Joko node returned an invalid ${name}.`);
  }
  return value;
}

function text(value: string, maximum: number, name: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > maximum || !SAFE_TEXT.test(value)) {
    throw new Error(`The Joko node returned an invalid ${name}.`);
  }
  return value;
}

function revision(value: { readonly value: bigint } | undefined, name: string): bigint {
  if (!value || value.value < 1n) throw new Error(`The Joko node returned an invalid ${name} revision.`);
  return value.value;
}

function cursor(value: { readonly value: bigint } | undefined, name: string): bigint {
  if (!value || value.value < 0n) throw new Error(`The Joko node returned an invalid ${name}.`);
  return value.value;
}

function positive(value: bigint, name: string): bigint {
  if (value < 1n) throw new Error(`The Joko node returned an invalid ${name}.`);
  return value;
}

function count(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`The Joko node returned an invalid ${name}.`);
  }
  return Number(value);
}

function timestamp(value: { readonly seconds: bigint; readonly nanos: number } | undefined, name: string): number {
  if (!value || value.seconds < 0n || value.seconds > 8_640_000_000_000n
    || !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) {
    throw new Error(`The Joko node returned an invalid ${name}.`);
  }
  const milliseconds = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 8_640_000_000_000_000) {
    throw new Error(`The Joko node returned an invalid ${name}.`);
  }
  return milliseconds;
}
