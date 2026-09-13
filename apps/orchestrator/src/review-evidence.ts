import { createHash } from "node:crypto";

import type { BlobRef } from "@joko/core";

import type {
  BuildReviewPromptInput,
  ReviewArtifactExcerpt,
  ReviewArtifactLabel,
  ReviewBranchEvidence,
  ReviewCappedEvidence,
  ReviewChangeSetEvidence,
  ReviewContextMessage,
  ReviewDiffEvidence,
  ReviewEvidenceWarning,
  ReviewWorkspaceEvidence
} from "./review-prompt.js";
import type { ReviewAttachmentKind, ReviewFailureCode } from "./review-types.js";
import { MAX_REVIEW_ATTACHMENTS, MAX_REVIEW_FOCUS_CHARACTERS } from "./review-types.js";

export const REVIEW_FRESHNESS_SEAL_VERSION = 1 as const;
export const MAX_REVIEW_SOURCE_MESSAGES = 10_000;
export const MAX_REVIEW_SOURCE_FILES = 100_000;
export const MAX_REVIEW_SOURCE_DIFFS = 10_000;
export const MAX_REVIEW_SOURCE_TEXT_CHARACTERS = 4_000_000;

const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ALIAS_SEGMENT = /^[\p{L}\p{N} ._+@()\[\]{}'!,=-]+$/u;
const DOMAIN = "joko.review.freshness/v1";

export interface ReviewSourceMessage {
  readonly id: string;
  readonly ordinal: number;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ReviewSourceConversationSnapshot {
  readonly sessionId: string;
  readonly sessionGeneration: number;
  /** Opaque native binding identity. Hashed into the seal and never returned. */
  readonly nativeBindingIdentity: string;
  readonly messages: readonly ReviewSourceMessage[];
}

export interface ReviewSourceFileSnapshot {
  /** Workspace-relative path. Absolute paths and traversal are rejected. */
  readonly relativePath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ReviewSourceGitSnapshot {
  readonly headOid: string | null;
  readonly indexTreeOid: string | null;
  readonly worktreeRevision: string;
  readonly baseOid: string | null;
  readonly mergeBaseOid: string | null;
}

export interface ReviewSourceChangeSetSnapshot {
  readonly id: string;
  readonly revision: string;
}

export interface ReviewSourceWorkspaceSnapshot {
  readonly workspaceId: string;
  readonly files: readonly ReviewSourceFileSnapshot[];
  readonly git: ReviewSourceGitSnapshot | null;
  readonly changeSet: ReviewSourceChangeSetSnapshot | null;
}

export interface ReviewSourceDiffEvidence {
  readonly relativePath: string;
  readonly oldRelativePath?: string;
  readonly source: ReviewDiffEvidence["source"];
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patch?: string;
  readonly binary?: boolean;
}

export interface ReviewSourceCappedEvidence {
  readonly reason: string;
  readonly fileCount: number;
  readonly totalChangedLines: number;
  readonly files: readonly Omit<ReviewSourceDiffEvidence, "source" | "patch">[];
}

export interface ReviewSourceWorkspaceEvidence {
  readonly dirty: boolean;
  readonly totalFiles: number;
  readonly stagedFiles: number;
  readonly unstagedFiles: number;
  readonly untrackedFiles: number;
  readonly unavailableReason?: string;
  readonly diffs: readonly ReviewSourceDiffEvidence[];
  readonly capped?: readonly ReviewSourceCappedEvidence[];
}

export interface ReviewSourceBranchEvidence {
  readonly baseRefLabel: string;
  readonly fileCount: number;
  readonly diffs: readonly ReviewSourceDiffEvidence[];
  readonly capped?: ReviewSourceCappedEvidence;
  readonly unavailableReason?: string;
}

export interface ReviewSourceChangeSetEvidence {
  readonly state: ReviewChangeSetEvidence["state"];
  readonly diffs: readonly ReviewSourceDiffEvidence[];
  readonly incompleteReasons: readonly string[];
}

export interface ReviewSourceArtifact {
  readonly kind: ReviewAttachmentKind;
  readonly displayName: string;
  readonly blob: BlobRef;
  readonly excerpt?: {
    readonly format: string;
    readonly coverage: string;
    readonly content: string;
  };
  readonly warning?: string;
}

export interface BuildReviewEvidenceInput {
  readonly focus?: string;
  readonly conversation: ReviewSourceConversationSnapshot;
  readonly workspace: ReviewSourceWorkspaceSnapshot;
  readonly workspaceEvidence: ReviewSourceWorkspaceEvidence | null;
  readonly branchEvidence?: ReviewSourceBranchEvidence | null;
  readonly branchUnavailableReason?: string;
  readonly changeSetEvidence: ReviewSourceChangeSetEvidence | null;
  readonly artifacts: readonly ReviewSourceArtifact[];
  readonly artifactsOmitted?: boolean;
  readonly coverageGaps?: readonly string[];
}

/** Safe to persist: contains only versioned domain-separated digests. */
export interface ReviewFreshnessSeal {
  readonly version: typeof REVIEW_FRESHNESS_SEAL_VERSION;
  readonly conversationSha256: string;
  readonly workspaceSha256: string;
  readonly filesSha256: string;
  readonly artifactsSha256: string;
  readonly sealSha256: string;
}

export interface BuiltReviewEvidence {
  /** Transient prompt material. Persist only `freshness`, never this value. */
  readonly promptInput: BuildReviewPromptInput;
  readonly freshness: ReviewFreshnessSeal;
}

export function buildReviewEvidence(input: BuildReviewEvidenceInput): BuiltReviewEvidence {
  validateBoundaries(input);
  const files = normalizeFiles(input.workspace.files);
  const artifacts = normalizeArtifacts(input.artifacts);
  const workspaceEvidence = input.workspaceEvidence === null ? null : mapWorkspaceEvidence(input.workspaceEvidence);
  const branchEvidence = input.branchEvidence === undefined || input.branchEvidence === null
    ? input.branchEvidence
    : mapBranchEvidence(input.branchEvidence);
  const changeSetEvidence = input.changeSetEvidence === null ? null : mapChangeSetEvidence(input.changeSetEvidence);

  const context: ReviewContextMessage[] = input.conversation.messages.map(({ role, text }) => ({ role, text: normalizeText(text) }));
  const labels: ReviewArtifactLabel[] = artifacts.map(({ source, alias }) => ({ kind: source.kind, alias }));
  const artifactExcerpts: ReviewArtifactExcerpt[] = artifacts.flatMap(({ source, alias }) => source.excerpt === undefined ? [] : [{ alias, ...source.excerpt }]);
  const artifactWarnings: ReviewEvidenceWarning[] = artifacts.flatMap(({ source, alias }) => source.warning === undefined ? [] : [{ alias, message: source.warning }]);
  const freshness = buildFreshness(input, files, artifacts);

  return {
    promptInput: {
      ...(input.focus === undefined ? {} : { focus: normalizeText(input.focus) }),
      context,
      workspace: workspaceEvidence,
      ...(branchEvidence === undefined ? {} : { branch: branchEvidence }),
      ...(input.branchUnavailableReason === undefined ? {} : { branchUnavailableReason: input.branchUnavailableReason }),
      changeSet: changeSetEvidence,
      artifacts: labels,
      ...(input.artifactsOmitted === undefined ? {} : { artifactsOmitted: input.artifactsOmitted }),
      ...(artifactExcerpts.length === 0 ? {} : { artifactExcerpts }),
      ...(artifactWarnings.length === 0 ? {} : { artifactWarnings }),
      ...(input.coverageGaps === undefined ? {} : { coverageGaps: input.coverageGaps })
    },
    freshness
  };
}

export function compareReviewFreshness(expected: ReviewFreshnessSeal, current: ReviewFreshnessSeal): ReviewFailureCode | undefined {
  if (expected.version !== REVIEW_FRESHNESS_SEAL_VERSION || current.version !== REVIEW_FRESHNESS_SEAL_VERSION) return "source-workspace-changed";
  if (!sealIsInternallyConsistent(expected) || !sealIsInternallyConsistent(current)) return "source-workspace-changed";
  if (expected.conversationSha256 !== current.conversationSha256) return "source-conversation-changed";
  if (expected.workspaceSha256 !== current.workspaceSha256) return "source-workspace-changed";
  if (expected.filesSha256 !== current.filesSha256) return "source-files-changed";
  if (expected.artifactsSha256 !== current.artifactsSha256) return "artifact-changed";
  return undefined;
}

export function isSensitiveReviewPath(relativePath: string): boolean {
  const path = canonicalRelativePath(relativePath).toLowerCase();
  const segments = path.split("/");
  return segments.some((segment) => segment === ".ssh"
    || segment === ".npmrc"
    || segment === ".pypirc"
    || segment === ".netrc"
    || segment === ".env"
    || segment.startsWith(".env.")
    || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..*)?$/u.test(segment)
    || /\.(?:pem|key|p12|pfx)$/u.test(segment)
    || /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|keychain)(?:$|[._-])/u.test(segment));
}

function buildFreshness(
  input: BuildReviewEvidenceInput,
  files: readonly NormalizedFile[],
  artifacts: readonly NormalizedArtifact[]
): ReviewFreshnessSeal {
  const conversationSha256 = digest("conversation", {
    sessionId: input.conversation.sessionId,
    sessionGeneration: input.conversation.sessionGeneration,
    nativeBindingIdentity: input.conversation.nativeBindingIdentity,
    messages: input.conversation.messages.map((message) => [message.id, message.ordinal, message.role, normalizeText(message.text)])
  });
  const workspaceSha256 = digest("workspace", {
    workspaceId: input.workspace.workspaceId,
    git: input.workspace.git === null ? null : {
      headOid: normalizeOid(input.workspace.git.headOid),
      indexTreeOid: normalizeOid(input.workspace.git.indexTreeOid),
      worktreeRevision: input.workspace.git.worktreeRevision,
      baseOid: normalizeOid(input.workspace.git.baseOid),
      mergeBaseOid: normalizeOid(input.workspace.git.mergeBaseOid)
    },
    changeSet: input.workspace.changeSet
  });
  const filesSha256 = digest("files", files.map((file) => [file.path, file.sha256, file.byteLength]));
  const artifactsSha256 = digest("artifacts", artifacts.map(({ source }) => [
    source.kind,
    source.displayName.normalize("NFC"),
    source.blob.id,
    source.blob.sha256.toLowerCase(),
    source.blob.byteLength,
    source.blob.mimeType.toLowerCase(),
    source.blob.fileName?.normalize("NFC") ?? null
  ]));
  const sealSha256 = digest("seal", [conversationSha256, workspaceSha256, filesSha256, artifactsSha256]);
  return { version: REVIEW_FRESHNESS_SEAL_VERSION, conversationSha256, workspaceSha256, filesSha256, artifactsSha256, sealSha256 };
}

interface NormalizedFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

interface NormalizedArtifact {
  readonly source: ReviewSourceArtifact;
  readonly alias: string;
}

function normalizeFiles(files: readonly ReviewSourceFileSnapshot[]): readonly NormalizedFile[] {
  const seen = new Set<string>();
  return files.map((file) => {
    const path = canonicalRelativePath(file.relativePath);
    const collisionKey = path.toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) throw new TypeError(`Review source file alias collision: ${path}`);
    seen.add(collisionKey);
    return { path, sha256: requireSha256(file.sha256, "Review source file sha256"), byteLength: requireCount(file.byteLength, "Review source file byteLength") };
  }).sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

function normalizeArtifacts(artifacts: readonly ReviewSourceArtifact[]): readonly NormalizedArtifact[] {
  const seenIds = new Set<string>();
  const sorted = artifacts.map((source) => {
    validateBlob(source.blob);
    if (seenIds.has(source.blob.id)) throw new TypeError(`Duplicate review artifact blob id: ${source.blob.id}`);
    seenIds.add(source.blob.id);
    return source;
  }).sort((left, right) => artifactSortKey(left).localeCompare(artifactSortKey(right), "en-US"));
  const aliases = new Set<string>();
  return sorted.map((source, index) => {
    const alias = `[review-artifact]/${String(index + 1).padStart(2, "0")}-${artifactName(source.displayName)}`;
    if (aliases.has(alias)) throw new TypeError(`Review artifact alias collision: ${alias}`);
    aliases.add(alias);
    return { source, alias };
  });
}

function artifactSortKey(value: ReviewSourceArtifact): string {
  return [value.blob.id, value.blob.sha256.toLowerCase(), value.displayName.normalize("NFC"), value.kind].join("\0");
}

function artifactName(value: string): string {
  const leaf = normalizeText(value).split(/[\\/]/u).at(-1)?.trim() ?? "";
  const safe = [...leaf.replace(/[^\p{L}\p{N} ._+@()\[\]{}'!,=-]+/gu, "-")].slice(0, 120).join("").replace(/^\.+$/u, "").trim();
  return safe || "artifact";
}

function mapWorkspaceEvidence(value: ReviewSourceWorkspaceEvidence): ReviewWorkspaceEvidence {
  const mapped = filterDiffs(value.diffs);
  const mappedCapped = (value.capped ?? []).map(mapCapped);
  const capped = mappedCapped.flatMap((item) => item.evidence === null ? [] : [item.evidence]);
  const cappedOmitted = mappedCapped.reduce((sum, item) => sum + item.omitted, 0);
  const totalOmitted = mapped.omitted + cappedOmitted;
  return {
    dirty: value.dirty,
    totalFiles: Math.max(0, value.totalFiles - totalOmitted),
    stagedFiles: Math.max(0, value.stagedFiles - mapped.omittedStaged),
    unstagedFiles: Math.max(0, value.unstagedFiles - mapped.omittedUnstaged),
    untrackedFiles: Math.max(0, value.untrackedFiles - mapped.omittedUntracked),
    ...(value.unavailableReason === undefined ? {} : { unavailableReason: value.unavailableReason }),
    diffs: mapped.diffs,
    ...(capped.length === 0 ? {} : { capped }),
    sensitiveFilesOmitted: totalOmitted
  };
}

function mapBranchEvidence(value: ReviewSourceBranchEvidence): ReviewBranchEvidence {
  const mapped = filterDiffs(value.diffs);
  const mappedCapped = value.capped === undefined ? undefined : mapCapped(value.capped);
  const capped = mappedCapped?.evidence;
  const totalOmitted = mapped.omitted + (mappedCapped?.omitted ?? 0);
  return {
    baseRefLabel: value.baseRefLabel,
    fileCount: Math.max(0, value.fileCount - totalOmitted),
    diffs: mapped.diffs,
    ...(capped === undefined || capped === null ? {} : { capped }),
    sensitiveFilesOmitted: totalOmitted,
    ...(value.unavailableReason === undefined ? {} : { unavailableReason: value.unavailableReason })
  };
}

function mapChangeSetEvidence(value: ReviewSourceChangeSetEvidence): ReviewChangeSetEvidence {
  const mapped = filterDiffs(value.diffs);
  return {
    state: mapped.omitted > 0 && value.state === "complete" ? "partial" : value.state,
    diffs: mapped.diffs,
    incompleteReasons: mapped.omitted > 0
      ? [...value.incompleteReasons, `${mapped.omitted} sensitive path change(s) omitted`]
      : value.incompleteReasons
  };
}

function filterDiffs(values: readonly ReviewSourceDiffEvidence[]): {
  readonly diffs: readonly ReviewDiffEvidence[];
  readonly omitted: number;
  readonly omittedStaged: number;
  readonly omittedUnstaged: number;
  readonly omittedUntracked: number;
} {
  const diffs: ReviewDiffEvidence[] = [];
  let omitted = 0;
  let omittedStaged = 0;
  let omittedUnstaged = 0;
  let omittedUntracked = 0;
  for (const value of values) {
    const path = canonicalRelativePath(value.relativePath);
    const oldPath = value.oldRelativePath === undefined ? undefined : canonicalRelativePath(value.oldRelativePath);
    if (isSensitiveReviewPath(path) || (oldPath !== undefined && isSensitiveReviewPath(oldPath))) {
      omitted += 1;
      if (value.source === "staged") omittedStaged += 1;
      if (value.source === "unstaged") omittedUnstaged += 1;
      if (/untracked/iu.test(value.status)) omittedUntracked += 1;
      continue;
    }
    diffs.push({
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      source: value.source,
      status: value.status,
      additions: value.additions,
      deletions: value.deletions,
      ...(value.patch === undefined ? {} : { patch: value.patch }),
      ...(value.binary === undefined ? {} : { binary: value.binary })
    });
  }
  return { diffs: diffs.sort(compareDiffs), omitted, omittedStaged, omittedUnstaged, omittedUntracked };
}

function mapCapped(value: ReviewSourceCappedEvidence): { readonly evidence: ReviewCappedEvidence | null; readonly omitted: number } {
  let omitted = 0;
  const files = value.files.flatMap((file) => {
    const path = canonicalRelativePath(file.relativePath);
    const oldPath = file.oldRelativePath === undefined ? undefined : canonicalRelativePath(file.oldRelativePath);
    if (isSensitiveReviewPath(path) || (oldPath !== undefined && isSensitiveReviewPath(oldPath))) {
      omitted += 1;
      return [];
    }
    return [{
      path,
      ...(oldPath === undefined ? {} : { oldPath }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.binary === undefined ? {} : { binary: file.binary })
    }];
  }).sort(compareDiffs);
  if (files.length === 0) return { evidence: null, omitted };
  return {
    evidence: { reason: value.reason, fileCount: files.length, totalChangedLines: files.reduce((sum, file) => sum + file.additions + file.deletions, 0), files },
    omitted
  };
}

function compareDiffs(left: { readonly path: string; readonly source?: ReviewDiffEvidence["source"] }, right: { readonly path: string; readonly source?: ReviewDiffEvidence["source"] }): number {
  return `${left.path}\0${left.source ?? ""}`.localeCompare(`${right.path}\0${right.source ?? ""}`, "en-US");
}

function canonicalRelativePath(value: string): string {
  const normalized = normalizeText(value).replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized) || /^[a-z][a-z0-9+.-]*:/iu.test(normalized)) {
    throw new TypeError("Review evidence paths must be workspace-relative.");
  }
  const segments = normalized.split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new TypeError("Review evidence paths must not contain empty or traversal segments.");
  }
  if (segments.some((segment) => !ALIAS_SEGMENT.test(segment))) throw new TypeError("Review evidence paths contain characters unsupported by stable aliases.");
  return segments.join("/");
}

function validateBoundaries(input: BuildReviewEvidenceInput): void {
  if (input.conversation.messages.length > MAX_REVIEW_SOURCE_MESSAGES) throw new RangeError("Too many review source messages.");
  if (input.workspace.files.length > MAX_REVIEW_SOURCE_FILES) throw new RangeError("Too many review source files.");
  if (input.artifacts.length > MAX_REVIEW_ATTACHMENTS) throw new RangeError("Too many review artifacts.");
  if ([...(input.focus ?? "")].length > MAX_REVIEW_FOCUS_CHARACTERS) throw new RangeError("Review focus exceeds its character limit.");
  requireText(input.conversation.sessionId, "Review source session id");
  requireCount(input.conversation.sessionGeneration, "Review source session generation");
  requireText(input.conversation.nativeBindingIdentity, "Review native binding identity");
  requireText(input.workspace.workspaceId, "Review workspace id");
  const messageIds = new Set<string>();
  let previousOrdinal = -1;
  let totalText = 0;
  for (const message of input.conversation.messages) {
    requireText(message.id, "Review source message id");
    if (messageIds.has(message.id)) throw new TypeError(`Duplicate review source message id: ${message.id}`);
    messageIds.add(message.id);
    requireCount(message.ordinal, "Review source message ordinal");
    if (message.ordinal <= previousOrdinal) throw new TypeError("Review source messages must have strictly increasing ordinals in conversation order.");
    previousOrdinal = message.ordinal;
    totalText += [...message.text].length;
  }
  const diffs = [...(input.workspaceEvidence?.diffs ?? []), ...(input.branchEvidence?.diffs ?? []), ...(input.changeSetEvidence?.diffs ?? [])];
  const capped = [...(input.workspaceEvidence?.capped ?? []), ...(input.branchEvidence?.capped === undefined ? [] : [input.branchEvidence.capped])];
  const cappedFiles = capped.flatMap((bucket) => bucket.files);
  if (diffs.length + cappedFiles.length > MAX_REVIEW_SOURCE_DIFFS) throw new RangeError("Too many review source diffs.");
  totalText += diffs.reduce((sum, diff) => sum + [...(diff.patch ?? "")].length, 0);
  totalText += input.artifacts.reduce((sum, artifact) => sum + [...(artifact.excerpt?.content ?? "")].length, 0);
  if (totalText > MAX_REVIEW_SOURCE_TEXT_CHARACTERS) throw new RangeError("Review source text exceeds its aggregate character limit.");
  for (const diff of diffs) {
    requireCount(diff.additions, "Review diff additions");
    requireCount(diff.deletions, "Review diff deletions");
  }
  for (const bucket of capped) {
    requireText(bucket.reason, "Review capped evidence reason");
    requireCount(bucket.fileCount, "Review capped evidence fileCount");
    requireCount(bucket.totalChangedLines, "Review capped evidence totalChangedLines");
    for (const file of bucket.files) {
      requireCount(file.additions, "Review capped file additions");
      requireCount(file.deletions, "Review capped file deletions");
    }
  }
  if ((input.coverageGaps?.length ?? 0) > 1_000) throw new RangeError("Too many review coverage gaps.");
  for (const gap of input.coverageGaps ?? []) requireText(gap, "Review coverage gap");
  for (const artifact of input.artifacts) {
    requireText(artifact.displayName, "Review artifact displayName");
    if (artifact.excerpt !== undefined) {
      requireText(artifact.excerpt.format, "Review artifact excerpt format");
      requireText(artifact.excerpt.coverage, "Review artifact excerpt coverage");
    }
    if (artifact.warning !== undefined) requireText(artifact.warning, "Review artifact warning");
  }
  if (input.workspace.git !== null) {
    normalizeOid(input.workspace.git.headOid);
    normalizeOid(input.workspace.git.indexTreeOid);
    normalizeOid(input.workspace.git.baseOid);
    normalizeOid(input.workspace.git.mergeBaseOid);
    requireText(input.workspace.git.worktreeRevision, "Review worktree revision");
  }
  if (input.workspace.changeSet !== null) {
    requireText(input.workspace.changeSet.id, "Review change-set id");
    requireText(input.workspace.changeSet.revision, "Review change-set revision");
  }
}

function validateBlob(blob: BlobRef): void {
  const keys = Object.keys(blob);
  if (keys.some((key) => !["id", "sha256", "byteLength", "mimeType", "fileName"].includes(key))) throw new TypeError("Review artifact BlobRef contains forbidden fields.");
  requireText(blob.id, "Review artifact blob id");
  requireSha256(blob.sha256, "Review artifact blob sha256");
  requireCount(blob.byteLength, "Review artifact blob byteLength");
  requireText(blob.mimeType, "Review artifact blob mimeType");
  if (blob.fileName !== undefined && /[\\/]/u.test(blob.fileName)) throw new TypeError("Review artifact blob fileName must be a basename.");
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n");
}

function normalizeOid(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (!OBJECT_ID.test(normalized)) throw new TypeError("Review Git object id must be 40 or 64 hexadecimal characters.");
  return normalized;
}

function requireSha256(value: string, label: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized)) throw new TypeError(`${label} must be 64 hexadecimal characters.`);
  return normalized;
}

function requireCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
  return value;
}

function requireText(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_000 || /[\p{Cc}\u2028\u2029]/u.test(value)) throw new TypeError(`${label} is invalid.`);
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256").update(DOMAIN).update("\0").update(domain).update("\0").update(JSON.stringify(value)).digest("hex");
}

function sealIsInternallyConsistent(value: ReviewFreshnessSeal): boolean {
  return SHA256.test(value.conversationSha256)
    && SHA256.test(value.workspaceSha256)
    && SHA256.test(value.filesSha256)
    && SHA256.test(value.artifactsSha256)
    && value.sealSha256 === digest("seal", [value.conversationSha256, value.workspaceSha256, value.filesSha256, value.artifactsSha256]);
}
