import {
  PartnerInitializationState, PartnerLifecycle, PartnerPrivateMessageDeliveryStatus,
  PartnerPrivateThreadCloseReason, PartnerPrivateThreadStatus, PartnerSessionRole,
  type GetPartnerPrivateThreadResponse, type ListPartnerPrivateThreadsResponse,
  type ListPartnerSessionsResponse, type ListPartnersResponse,
  type MarkPartnerPrivateThreadReadResponse, type PartnerPrivateThreadReadState
} from "@joko/contracts";

export interface MobilePartner {
  readonly partnerId: string;
  readonly displayName: string;
  readonly avatar: string;
  readonly lifecycle: "active" | "archived";
  readonly initializationState: "pending" | "ready" | "error";
  readonly canonicalSessionId?: string;
  readonly profileVersion: number;
}

export interface MobilePrivateThread {
  readonly threadId: string;
  readonly firstPartnerId: string;
  readonly secondPartnerId: string;
  readonly otherPartnerId: string;
  readonly status: "active" | "closed";
  readonly closeReason?: "messageLimit" | "idleTimeout";
  readonly messageCount: number;
  readonly maxMessages: number;
  readonly expiresAt: number;
  readonly blockedUntil?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
}

export interface MobilePrivateMessage {
  readonly messageId: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly senderPartnerId: string;
  readonly recipientPartnerId: string;
  readonly content: string;
  readonly deliveryStatus: "pending" | "delivered";
  readonly createdAt: number;
  readonly deliveredAt?: number;
}

export interface MobilePrivateReadState {
  readonly threadId: string;
  readonly partnerId: string;
  readonly throughSequence: number;
  readonly updatedAt: number;
}

export interface MobilePrivateDetail {
  readonly thread: MobilePrivateThread;
  readonly messages: readonly MobilePrivateMessage[];
  readonly readState?: MobilePrivateReadState;
}

export interface MobilePartnerPrivateState {
  readonly open: boolean;
  readonly status: "idle" | "loading" | "ready" | "offline" | "error";
  readonly partners: readonly MobilePartner[];
  readonly selectedPartnerId?: string;
  readonly threads: readonly MobilePrivateThread[];
  readonly selectedThreadId?: string;
  readonly detail?: MobilePrivateDetail;
  readonly detailStatus: "idle" | "loading" | "ready" | "offline" | "error";
  readonly error?: string;
  readonly detailError?: string;
}

export function emptyMobilePartnerPrivateState(open = false, status: MobilePartnerPrivateState["status"] = "idle"):
  MobilePartnerPrivateState {
  return { open, status, partners: [], threads: [], detailStatus: "idle" };
}

const ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const FORBIDDEN_LABEL = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_CONTENT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_PARTNERS = 1_000;
const MAX_THREADS = 2_000;
const PRIVATE_MAX_MESSAGES = 12;
const MAX_PRIVATE_CONTENT = 16_000;

export function validMobilePartnerId(value: string): boolean { return ENTITY_ID.test(value); }

function requiredId(value: string, label: string): string {
  if (!validMobilePartnerId(value)) throw new Error(`The Joko node returned an invalid ${label}.`);
  return value;
}

function positiveSafe(value: bigint, label: string): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`The Joko node returned an invalid ${label}.`);
  }
  return Number(value);
}

function nonnegativeSafe(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`The Joko node returned an invalid ${label}.`);
  }
  return Number(value);
}

function requiredTimestamp(value: { readonly seconds: bigint; readonly nanos: number } | undefined, label: string): number {
  if (!value || value.seconds < 0n || value.seconds > 8_640_000_000_000n
    || !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) {
    throw new Error(`The Joko node returned an invalid ${label}.`);
  }
  const milliseconds = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 8_640_000_000_000_000) {
    throw new Error(`The Joko node returned an invalid ${label}.`);
  }
  return milliseconds;
}

function label(value: string, maximum: number, name: string): string {
  if (!value || value.trim() !== value || value.length > maximum || FORBIDDEN_LABEL.test(value)) {
    throw new Error(`The Joko node returned an invalid ${name}.`);
  }
  return value;
}

export function projectMobilePartners(response: ListPartnersResponse): readonly MobilePartner[] {
  const directory = response.directory;
  if (!directory || response.partners.length > MAX_PARTNERS
    || !Number.isSafeInteger(directory.activeCount) || !Number.isSafeInteger(directory.archivedCount)
    || directory.activeCount < 0 || directory.archivedCount < 0
    || directory.activeCount + directory.archivedCount !== response.partners.length) {
    throw new Error("The Joko node returned an invalid Partner directory.");
  }
  const ids = new Set<string>();
  const sessions = new Set<string>();
  const partners = response.partners.map((partner): MobilePartner => {
    const partnerId = requiredId(partner.partnerId, "Partner ID");
    if (ids.has(partnerId)) throw new Error("The Joko node returned duplicate Partners.");
    ids.add(partnerId);
    const lifecycle = partner.lifecycle === PartnerLifecycle.ACTIVE ? "active"
      : partner.lifecycle === PartnerLifecycle.ARCHIVED ? "archived" : undefined;
    const initializationState = partner.initializationState === PartnerInitializationState.PENDING ? "pending"
      : partner.initializationState === PartnerInitializationState.READY ? "ready"
        : partner.initializationState === PartnerInitializationState.ERROR ? "error" : undefined;
    if (!lifecycle || !initializationState) throw new Error("The Joko node returned an unknown Partner state.");
    const canonicalSessionId = partner.canonicalSessionId === undefined
      ? undefined : requiredId(partner.canonicalSessionId, "Partner canonical Session ID");
    if (canonicalSessionId !== undefined) {
      if (sessions.has(canonicalSessionId)) throw new Error("The Joko node returned duplicate Partner canonical Sessions.");
      sessions.add(canonicalSessionId);
    }
    return {
      partnerId,
      displayName: label(partner.displayName, 100, "Partner name"),
      avatar: label(partner.avatar, 256, "Partner avatar"),
      lifecycle,
      initializationState,
      ...(canonicalSessionId === undefined ? {} : { canonicalSessionId }),
      profileVersion: positiveSafe(partner.profileVersion, "Partner profile version")
    };
  });
  if (partners.filter((partner) => partner.lifecycle === "active").length !== directory.activeCount) {
    throw new Error("The Joko node returned inconsistent Partner counts.");
  }
  return partners;
}

function projectThread(partnerId: string, thread: ListPartnerPrivateThreadsResponse["threads"][number]): MobilePrivateThread {
  const threadId = requiredId(thread.threadId, "private thread ID");
  const firstPartnerId = requiredId(thread.firstPartnerId, "first private thread participant");
  const secondPartnerId = requiredId(thread.secondPartnerId, "second private thread participant");
  if (firstPartnerId >= secondPartnerId || partnerId !== firstPartnerId && partnerId !== secondPartnerId) {
    throw new Error("The Joko node returned a private thread with mismatched participants.");
  }
  const status = thread.status === PartnerPrivateThreadStatus.ACTIVE ? "active"
    : thread.status === PartnerPrivateThreadStatus.CLOSED ? "closed" : undefined;
  const closeReason = thread.closeReason === undefined ? undefined
    : thread.closeReason === PartnerPrivateThreadCloseReason.MESSAGE_LIMIT ? "messageLimit"
      : thread.closeReason === PartnerPrivateThreadCloseReason.IDLE_TIMEOUT ? "idleTimeout" : undefined;
  if (!status || thread.closeReason !== undefined && !closeReason
    || status === "active" && (closeReason !== undefined || thread.closedAt !== undefined || thread.blockedUntil !== undefined)
    || status === "closed" && (closeReason === undefined || thread.closedAt === undefined)) {
    throw new Error("The Joko node returned an invalid private thread state.");
  }
  const messageCount = thread.messageCount;
  const maxMessages = thread.maxMessages;
  if (!Number.isInteger(messageCount) || messageCount < 0 || messageCount > PRIVATE_MAX_MESSAGES
    || maxMessages !== PRIVATE_MAX_MESSAGES || messageCount > maxMessages
    || closeReason === "messageLimit" && messageCount !== maxMessages) {
    throw new Error("The Joko node returned an invalid private thread limit.");
  }
  const createdAt = requiredTimestamp(thread.createdAt, "private thread creation time");
  const updatedAt = requiredTimestamp(thread.updatedAt, "private thread update time");
  const expiresAt = requiredTimestamp(thread.expiresAt, "private thread expiry");
  const closedAt = thread.closedAt === undefined ? undefined : requiredTimestamp(thread.closedAt, "private thread close time");
  const blockedUntil = thread.blockedUntil === undefined
    ? undefined : requiredTimestamp(thread.blockedUntil, "private thread block time");
  if (updatedAt < createdAt || expiresAt < createdAt || closedAt !== undefined && closedAt < createdAt
    || blockedUntil !== undefined && (closeReason !== "messageLimit" || blockedUntil < createdAt)) {
    throw new Error("The Joko node returned inconsistent private thread times.");
  }
  return {
    threadId, firstPartnerId, secondPartnerId,
    otherPartnerId: partnerId === firstPartnerId ? secondPartnerId : firstPartnerId,
    status, ...(closeReason === undefined ? {} : { closeReason }),
    messageCount, maxMessages, expiresAt,
    ...(blockedUntil === undefined ? {} : { blockedUntil }),
    createdAt, updatedAt, ...(closedAt === undefined ? {} : { closedAt })
  };
}

export function projectMobilePrivateThreads(
  partnerId: string,
  response: ListPartnerPrivateThreadsResponse
): readonly MobilePrivateThread[] {
  requiredId(partnerId, "Partner ID");
  if (response.threads.length > MAX_THREADS) throw new Error("The Joko node returned too many private threads.");
  const ids = new Set<string>();
  let previous: MobilePrivateThread | undefined;
  return response.threads.map((wire): MobilePrivateThread => {
    const thread = projectThread(partnerId, wire);
    if (ids.has(thread.threadId) || previous && (previous.updatedAt < thread.updatedAt
      || previous.updatedAt === thread.updatedAt && previous.threadId <= thread.threadId)) {
      throw new Error("The Joko node returned duplicate or unordered private threads.");
    }
    ids.add(thread.threadId);
    previous = thread;
    return thread;
  });
}

export function projectMobilePrivateDetail(
  partnerId: string,
  threadId: string,
  response: GetPartnerPrivateThreadResponse
): MobilePrivateDetail {
  requiredId(partnerId, "Partner ID");
  requiredId(threadId, "private thread ID");
  if (!response.thread) throw new Error("The Joko node returned no private thread.");
  const thread = projectThread(partnerId, response.thread);
  if (thread.threadId !== threadId || response.messages.length !== thread.messageCount
    || response.messages.length > PRIVATE_MAX_MESSAGES) {
    throw new Error("The Joko node returned an incomplete private thread.");
  }
  let lastSequence = 0;
  const ids = new Set<string>();
  const messages = response.messages.map((wire): MobilePrivateMessage => {
    const messageId = requiredId(wire.messageId, "private message ID");
    const sequence = positiveSafe(wire.sequence, "private message sequence");
    if (ids.has(messageId) || wire.threadId !== threadId || sequence <= lastSequence
      || ![thread.firstPartnerId, thread.secondPartnerId].includes(wire.senderPartnerId)
      || wire.recipientPartnerId !== (wire.senderPartnerId === thread.firstPartnerId
        ? thread.secondPartnerId : thread.firstPartnerId)) {
      throw new Error("The Joko node returned a mismatched or unordered private message.");
    }
    ids.add(messageId);
    lastSequence = sequence;
    const deliveryStatus = wire.deliveryStatus === PartnerPrivateMessageDeliveryStatus.PENDING ? "pending"
      : wire.deliveryStatus === PartnerPrivateMessageDeliveryStatus.DELIVERED ? "delivered" : undefined;
    if (!deliveryStatus || wire.content.length < 1 || wire.content.length > MAX_PRIVATE_CONTENT
      || FORBIDDEN_CONTENT.test(wire.content)
      || deliveryStatus === "pending" && wire.deliveredAt !== undefined
      || deliveryStatus === "delivered" && wire.deliveredAt === undefined) {
      throw new Error("The Joko node returned an invalid private message.");
    }
    const createdAt = requiredTimestamp(wire.createdAt, "private message creation time");
    const deliveredAt = wire.deliveredAt === undefined
      ? undefined : requiredTimestamp(wire.deliveredAt, "private message delivery time");
    if (createdAt < thread.createdAt || deliveredAt !== undefined && deliveredAt < createdAt) {
      throw new Error("The Joko node returned inconsistent private message times.");
    }
    return { messageId, threadId, sequence, senderPartnerId: wire.senderPartnerId,
      recipientPartnerId: wire.recipientPartnerId, content: wire.content, deliveryStatus, createdAt,
      ...(deliveredAt === undefined ? {} : { deliveredAt }) };
  });
  const readState = response.readState === undefined ? undefined
    : projectMobilePrivateReadState(partnerId, threadId, response.readState, lastSequence);
  return { thread, messages, ...(readState === undefined ? {} : { readState }) };
}

export function projectMobilePrivateReadState(
  partnerId: string,
  threadId: string,
  wire: PartnerPrivateThreadReadState | undefined,
  maximumSequence: number
): MobilePrivateReadState {
  if (!wire || wire.partnerId !== partnerId || wire.threadId !== threadId) {
    throw new Error("The Joko node returned a mismatched private read position.");
  }
  const throughSequence = nonnegativeSafe(wire.throughSequence, "private read sequence");
  if (throughSequence > maximumSequence) throw new Error("The Joko node returned a future private read position.");
  return { threadId, partnerId, throughSequence,
    updatedAt: requiredTimestamp(wire.updatedAt, "private read update time") };
}

export function projectMobilePrivateReadResponse(
  partnerId: string,
  threadId: string,
  response: MarkPartnerPrivateThreadReadResponse,
  minimumSequence: number,
  maximumSequence: number
): MobilePrivateReadState {
  const state = projectMobilePrivateReadState(partnerId, threadId, response.readState, maximumSequence);
  if (state.throughSequence < minimumSequence) throw new Error("The Joko node did not confirm the private read position.");
  return state;
}

export function assertMobileCanonicalPartnerSession(
  partner: MobilePartner,
  sessionId: string,
  response: ListPartnerSessionsResponse
): void {
  requiredId(sessionId, "canonical Session ID");
  if (partner.canonicalSessionId !== sessionId || partner.lifecycle !== "active"
    || partner.initializationState !== "ready" || response.sessions.length > 2_000) {
    throw new Error("The selected task is not this Partner's current canonical Session.");
  }
  const matches = response.sessions.filter((session) => session.sessionId === sessionId);
  if (matches.length !== 1 || matches[0]?.partnerId !== partner.partnerId
    || matches[0].role !== PartnerSessionRole.CANONICAL || !matches[0].available
    || matches[0].readOnly || matches[0].deleted || matches[0].archived) {
    throw new Error("The selected task is not this Partner's available canonical Session.");
  }
}
