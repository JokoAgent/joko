import type { BlobRef } from "@joko/core";

export const REVIEW_FAILURE_CODES = [
  "no-visible-result",
  "reviewer-closed",
  "cancelled-before-start",
  "interrupted",
  "source-workspace-changed",
  "source-conversation-changed",
  "source-files-changed",
  "artifact-changed",
  "artifact-unavailable",
  "provider-failed"
] as const;

export type ReviewFailureCode = (typeof REVIEW_FAILURE_CODES)[number];

export const REVIEW_TARGET_KINDS = ["changes", "artifacts", "task", "mixed"] as const;
export type ReviewTargetKind = (typeof REVIEW_TARGET_KINDS)[number];

export const REVIEW_RUN_STATES = ["running", "completed", "failed"] as const;
export type ReviewRunState = (typeof REVIEW_RUN_STATES)[number];

export const MAX_REVIEW_FOCUS_CHARACTERS = 4_000;
export const MAX_REVIEW_ATTACHMENTS = 20;

const MAX_SESSION_ID_CHARACTERS = 256;
const MAX_ATTACHMENT_NAME_CHARACTERS = 500;
const MAX_MIME_TYPE_CHARACTERS = 255;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"]*"))*$/iu;

export type ReviewAttachmentKind = "file" | "image";

/**
 * A Review request may retain only the already-committed public BlobRef. It
 * deliberately has no path, base64, upload ticket, metadata, or credential
 * escape hatch.
 */
export interface ReviewAttachment {
  readonly kind: ReviewAttachmentKind;
  readonly displayName: string;
  readonly blob: BlobRef;
}

export interface StartReviewRequest {
  readonly sourceSessionId: string;
  readonly focus?: string;
  readonly attachments: readonly ReviewAttachment[];
}

export interface ReviewRunRecord {
  readonly id: string;
  readonly sourceSessionId: string;
  readonly reviewerSessionId?: string;
  readonly reviewerRunId?: string;
  readonly state: ReviewRunState;
  readonly targetKind: ReviewTargetKind;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly resultMarkdown?: string;
  readonly failureCode?: ReviewFailureCode;
}

/** Strictly parse the public operation body before it reaches evidence I/O. */
export function readStartReviewRequest(value: unknown): StartReviewRequest {
  const request = requireRecord(value, "Review request");
  requireOnlyKeys(request, new Set(["sourceSessionId", "focus", "attachments"]), "Review request");

  const sourceSessionId = normalizedRequiredText(
    request["sourceSessionId"],
    "Review sourceSessionId",
    MAX_SESSION_ID_CHARACTERS
  );
  const focus = optionalNormalizedText(request["focus"], "Review focus", MAX_REVIEW_FOCUS_CHARACTERS);
  const rawAttachments = request["attachments"] ?? [];
  if (!Array.isArray(rawAttachments)) throw new TypeError("Review attachments must be an array.");
  if (rawAttachments.length > MAX_REVIEW_ATTACHMENTS) {
    throw new RangeError(`Review accepts at most ${MAX_REVIEW_ATTACHMENTS} attachments.`);
  }
  const attachments = rawAttachments.map((attachment, index) => readReviewAttachment(attachment, index));
  const blobIds = new Set<string>();
  for (const attachment of attachments) {
    if (blobIds.has(attachment.blob.id)) throw new TypeError("Review attachments must not repeat a BlobRef.");
    blobIds.add(attachment.blob.id);
  }

  return {
    sourceSessionId,
    ...(focus === undefined ? {} : { focus }),
    attachments
  };
}

export function readReviewFailureCode(value: unknown): ReviewFailureCode | undefined {
  return typeof value === "string" && (REVIEW_FAILURE_CODES as readonly string[]).includes(value)
    ? value as ReviewFailureCode
    : undefined;
}

export function readReviewTargetKind(value: unknown): ReviewTargetKind | undefined {
  return typeof value === "string" && (REVIEW_TARGET_KINDS as readonly string[]).includes(value)
    ? value as ReviewTargetKind
    : undefined;
}

export function readReviewRunState(value: unknown): ReviewRunState | undefined {
  return typeof value === "string" && (REVIEW_RUN_STATES as readonly string[]).includes(value)
    ? value as ReviewRunState
    : undefined;
}

function readReviewAttachment(value: unknown, index: number): ReviewAttachment {
  const label = `Review attachment ${index + 1}`;
  const attachment = requireRecord(value, label);
  requireOnlyKeys(attachment, new Set(["kind", "displayName", "blob"]), label);
  const kind = attachment["kind"];
  if (kind !== "file" && kind !== "image") throw new TypeError(`${label} kind must be file or image.`);
  const displayName = normalizedFileName(attachment["displayName"], `${label} displayName`);
  const blob = readBlobRef(attachment["blob"], `${label} blob`);
  return { kind, displayName, blob };
}

function readBlobRef(value: unknown, label: string): BlobRef {
  const blob = requireRecord(value, label);
  requireOnlyKeys(blob, new Set(["id", "sha256", "byteLength", "mimeType", "fileName"]), label);
  const id = normalizedRequiredText(blob["id"], `${label} id`, 256);
  const sha256 = normalizedRequiredText(blob["sha256"], `${label} sha256`, 64).toLowerCase();
  if (!SHA256_HEX.test(sha256)) throw new TypeError(`${label} sha256 must be 64 hexadecimal characters.`);
  const byteLength = blob["byteLength"];
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0) {
    throw new TypeError(`${label} byteLength must be a non-negative safe integer.`);
  }
  const mimeType = normalizedRequiredText(blob["mimeType"], `${label} mimeType`, MAX_MIME_TYPE_CHARACTERS).toLowerCase();
  if (!MIME_TYPE.test(mimeType)) throw new TypeError(`${label} mimeType is invalid.`);
  const fileName = blob["fileName"] === undefined
    ? undefined
    : normalizedFileName(blob["fileName"], `${label} fileName`);
  return {
    id,
    sha256,
    byteLength: byteLength as number,
    mimeType,
    ...(fileName === undefined ? {} : { fileName })
  };
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object.`);
  return value as Readonly<Record<string, unknown>>;
}

function requireOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unsupported field '${unexpected.sort()[0]}'.`);
  }
}

function normalizedRequiredText(value: unknown, label: string, maximumCharacters: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  const normalized = normalizeText(value).trim();
  if (normalized.length === 0) throw new TypeError(`${label} must not be empty.`);
  if (unicodeLength(normalized) > maximumCharacters) {
    throw new RangeError(`${label} must not exceed ${maximumCharacters} characters.`);
  }
  if (/[\0\u202a-\u202e\u2066-\u2069]/u.test(normalized)) {
    throw new TypeError(`${label} contains forbidden control characters.`);
  }
  return normalized;
}

function optionalNormalizedText(value: unknown, label: string, maximumCharacters: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be text.`);
  const normalized = normalizeText(value).trim();
  if (unicodeLength(normalized) > maximumCharacters) {
    throw new RangeError(`${label} must not exceed ${maximumCharacters} characters.`);
  }
  if (/[\0\u202a-\u202e\u2066-\u2069]/u.test(normalized)) {
    throw new TypeError(`${label} contains forbidden control characters.`);
  }
  return normalized.length === 0 ? undefined : normalized;
}

function normalizedFileName(value: unknown, label: string): string {
  const normalized = normalizedRequiredText(value, label, MAX_ATTACHMENT_NAME_CHARACTERS);
  if (normalized === "." || normalized === ".." || /[\\/]/u.test(normalized)) {
    throw new TypeError(`${label} must be a file name, not a path.`);
  }
  if (/[\p{Cc}]/gu.test(normalized)) throw new TypeError(`${label} contains control characters.`);
  return normalized;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}

function unicodeLength(value: string): number {
  return [...value].length;
}
