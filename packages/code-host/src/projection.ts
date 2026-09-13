import { codeHostPullRequestReferenceKey, parseCodeHostPullRequestReference } from "./reference.js";
import {
  CODE_HOST_SESSION_PROJECTION_SCHEMA_VERSION,
  type CodeHostPullRequestProjection,
  type CodeHostPullRequestReference,
  type CodeHostSessionProjection,
  type CodeHostSessionReferenceProjection
} from "./types.js";
import { boundedCodeHostHeadBranch, boundedCodeHostPullRequestTitle } from "./validation.js";

const MAX_SESSION_OWNER_ID_LENGTH = 256;
const MAX_REFERENCE_COUNT = 16;

export function emptyCodeHostSessionProjection(sessionOwnerId: string): CodeHostSessionProjection {
  return {
    schemaVersion: CODE_HOST_SESSION_PROJECTION_SCHEMA_VERSION,
    sessionOwnerId: boundedOwnerId(sessionOwnerId),
    references: []
  };
}

export function materializeCodeHostSessionProjection(
  value: unknown,
  expectedSessionOwnerId?: string
): CodeHostSessionProjection | undefined {
  if (!isRecord(value) || value["schemaVersion"] !== CODE_HOST_SESSION_PROJECTION_SCHEMA_VERSION) return undefined;
  const sessionOwnerId = boundedOwnerIdOrUndefined(value["sessionOwnerId"]);
  if (sessionOwnerId === undefined || (expectedSessionOwnerId !== undefined && sessionOwnerId !== expectedSessionOwnerId)) return undefined;
  const rawReferences = value["references"];
  if (!Array.isArray(rawReferences) || rawReferences.length > MAX_REFERENCE_COUNT) return undefined;
  const references: CodeHostSessionReferenceProjection[] = [];
  const keys = new Set<string>();
  for (const rawReference of rawReferences) {
    const reference = materializeReferenceProjection(rawReference);
    if (reference === undefined || keys.has(reference.reference.key)) return undefined;
    keys.add(reference.reference.key);
    references.push(reference);
  }
  return {
    schemaVersion: CODE_HOST_SESSION_PROJECTION_SCHEMA_VERSION,
    sessionOwnerId,
    references
  };
}

export function reconcileCodeHostSessionReferences(
  current: CodeHostSessionProjection | undefined,
  sessionOwnerId: string,
  references: readonly CodeHostPullRequestReference[]
): CodeHostSessionProjection {
  const ownerId = boundedOwnerId(sessionOwnerId);
  const existing = current?.sessionOwnerId === ownerId
    ? new Map(current.references.map((entry) => [entry.reference.key, entry] as const))
    : new Map<string, CodeHostSessionReferenceProjection>();
  const next = [...new Map(references.slice(0, MAX_REFERENCE_COUNT).map((reference) => [reference.key, reference] as const)).values()]
    .map((reference) => {
      const previous = existing.get(reference.key);
      return previous === undefined ? { reference } : { ...previous, reference };
    });
  return {
    schemaVersion: CODE_HOST_SESSION_PROJECTION_SCHEMA_VERSION,
    sessionOwnerId: ownerId,
    references: next
  };
}

export function sameCodeHostSessionProjection(
  left: CodeHostSessionProjection | undefined,
  right: CodeHostSessionProjection
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function materializeReferenceProjection(value: unknown): CodeHostSessionReferenceProjection | undefined {
  if (!isRecord(value) || !isRecord(value["reference"])) return undefined;
  const raw = value["reference"];
  const host = boundedText(raw["host"], 255);
  const repositoryOwner = boundedRepositoryPart(raw["repositoryOwner"]);
  const repositoryName = boundedRepositoryPart(raw["repositoryName"]);
  const number = safeInteger(raw["number"], 1, 2_147_483_647);
  const key = boundedText(raw["key"], 512);
  const webUrl = boundedText(raw["webUrl"], 2_048);
  if (host === undefined || repositoryOwner === undefined || repositoryName === undefined || number === undefined || key === undefined || webUrl === undefined) return undefined;
  if (key !== codeHostPullRequestReferenceKey({ host, repositoryOwner, repositoryName, number })) return undefined;
  const reparsed = parseCodeHostPullRequestReference(webUrl);
  if (
    reparsed === undefined
    || reparsed.webUrl !== webUrl
    || reparsed.key !== key
    || reparsed.host !== host
    || reparsed.repositoryOwner !== repositoryOwner
    || reparsed.repositoryName !== repositoryName
    || reparsed.number !== number
  ) return undefined;
  const projection = value["projection"] === undefined ? undefined : materializeProjection(value["projection"]);
  if (value["projection"] !== undefined && projection === undefined) return undefined;
  const freshUntil = value["freshUntil"] === undefined ? undefined : safeInteger(value["freshUntil"], 0, Number.MAX_SAFE_INTEGER);
  const notFoundUntil = value["notFoundUntil"] === undefined ? undefined : safeInteger(value["notFoundUntil"], 0, Number.MAX_SAFE_INTEGER);
  const retryAfterUntil = value["retryAfterUntil"] === undefined ? undefined : safeInteger(value["retryAfterUntil"], 0, Number.MAX_SAFE_INTEGER);
  if (
    (value["freshUntil"] !== undefined && freshUntil === undefined)
    || (value["notFoundUntil"] !== undefined && notFoundUntil === undefined)
    || (value["retryAfterUntil"] !== undefined && retryAfterUntil === undefined)
  ) return undefined;
  return {
    reference: { key, host, repositoryOwner, repositoryName, number, webUrl },
    ...(projection === undefined ? {} : { projection }),
    ...(freshUntil === undefined ? {} : { freshUntil }),
    ...(notFoundUntil === undefined ? {} : { notFoundUntil }),
    ...(retryAfterUntil === undefined ? {} : { retryAfterUntil })
  };
}

function materializeProjection(value: unknown): CodeHostPullRequestProjection | undefined {
  if (!isRecord(value)) return undefined;
  const state = value["state"];
  const draft = value["draft"];
  const title = boundedCodeHostPullRequestTitle(value["title"]);
  const headBranch = boundedCodeHostHeadBranch(value["headBranch"]);
  const unresolvedReviewThreadCount = value["unresolvedReviewThreadCount"] === undefined
    ? undefined
    : safeInteger(value["unresolvedReviewThreadCount"], 0, 100);
  const observedAt = safeInteger(value["observedAt"], 0, Number.MAX_SAFE_INTEGER);
  if (
    (state !== "open" && state !== "closed" && state !== "merged")
    || typeof draft !== "boolean"
    || title === undefined
    || headBranch === undefined
    || (value["unresolvedReviewThreadCount"] !== undefined && unresolvedReviewThreadCount === undefined)
    || observedAt === undefined
  ) return undefined;
  return {
    state,
    draft,
    title,
    headBranch,
    ...(unresolvedReviewThreadCount === undefined ? {} : { unresolvedReviewThreadCount }),
    observedAt
  };
}

function boundedOwnerId(value: string): string {
  const bounded = boundedOwnerIdOrUndefined(value);
  if (bounded === undefined) throw new Error("The Session owner ID is invalid.");
  return bounded;
}

function boundedOwnerIdOrUndefined(value: unknown): string | undefined {
  return boundedText(value, MAX_SESSION_OWNER_ID_LENGTH);
}

function boundedRepositoryPart(value: unknown): string | undefined {
  const text = boundedText(value, 100);
  return text !== undefined && /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u.test(text) ? text : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
