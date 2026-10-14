import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { BlobRef, MessageBlock } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import { extractPdfText, PDF_TEXT_MAX_BYTES, PdfTextExtractionError, type PdfTextWorkerResult } from "@joko/tool-document";
import type { ArtifactStore } from "./artifact-store.js";
import type { ReviewEvidenceProvider } from "./review-coordinator.js";
import {
  isSensitiveReviewPath,
  MAX_REVIEW_SOURCE_DIFFS,
  type BuildReviewEvidenceInput,
  type ReviewSourceArtifact,
  type ReviewSourceBranchEvidence,
  type ReviewSourceDiffEvidence,
  type ReviewSourceFileSnapshot
} from "./review-evidence.js";
import { MAX_REVIEW_ATTACHMENTS, type StartReviewRequest } from "./review-types.js";
import { MAX_REVIEW_ARTIFACT_EXCERPT_CHARACTERS } from "./review-prompt.js";
import type { WorkspaceChange, WorkspaceChangeSetRecord, WorkspaceChangeSetService } from "./workspace-change-set.js";
import type { GitState, WorkspaceGitDiff, WorkspaceService } from "./workspace-service.js";
import { listAllQueueItems, listAllVisibleSessionEvents } from "./operational-pagination.js";

const MAX_ARTIFACT_EXCERPT_BYTES = 48_000;
const MAX_REVIEW_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_REVIEW_ARTIFACT_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_SELECTED_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SELECTED_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_SELECTED_PATHS = 20_000;
const MAX_REVIEW_PDF_FILES = 4;
const MAX_PATCH_CHARACTERS = 2_000_000;

export type ReviewEvidenceCaptureCode = "source-busy" | "nothing-to-review" | "artifact-unavailable" | "source-changed";

/** Publicly mappable error with no service path, evidence body, or credential text. */
export class ReviewEvidenceCaptureError extends Error {
  constructor(readonly code: ReviewEvidenceCaptureCode, message: string) {
    super(message);
    this.name = "ReviewEvidenceCaptureError";
  }
}

export interface DurableReviewEvidenceProviderOptions {
  readonly store: OperationalStore;
  readonly workspaces: WorkspaceService;
  readonly workspaceChanges: WorkspaceChangeSetService;
  readonly artifacts: ArtifactStore;
  readonly pdfText?: (data: Uint8Array, maxChars: number) => Promise<PdfTextWorkerResult>;
}

/** Captures transient Review evidence; only its domain-separated seal is durable. */
export class DurableReviewEvidenceProvider implements ReviewEvidenceProvider {
  readonly #store: OperationalStore;
  readonly #workspaces: WorkspaceService;
  readonly #workspaceChanges: WorkspaceChangeSetService;
  readonly #artifacts: ArtifactStore;
  readonly #pdfText: (data: Uint8Array, maxChars: number) => Promise<PdfTextWorkerResult>;

  constructor(options: DurableReviewEvidenceProviderOptions) {
    this.#store = options.store;
    this.#workspaces = options.workspaces;
    this.#workspaceChanges = options.workspaceChanges;
    this.#artifacts = options.artifacts;
    this.#pdfText = options.pdfText ?? extractPdfText;
  }

  async capture(
    request: StartReviewRequest,
    purpose: "start" | "reobserve" = "start"
  ): Promise<BuildReviewEvidenceInput> {
    assertSourceIdle(this.#store, request.sourceSessionId);
    const source = this.#store.getSession(request.sourceSessionId);
    const target = this.#store.getTarget(source.descriptor.targetId);
    const registration = exactWorkspaceRegistration(target.metadata, target.descriptor.id, this.#workspaces);
    const events = listAllVisibleSessionEvents(this.#store, request.sourceSessionId);
    const visible = visibleMessages(this.#store, request.sourceSessionId, events);
    const messages = visible.map((event, ordinal) => ({
      id: event.id,
      ordinal,
      role: event.payload.role,
      text: event.payload.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("")
    }));

    const git = await this.#workspaces.gitState(registration.id).catch(() => {
      throw new ReviewEvidenceCaptureError("artifact-unavailable", "Review workspace Git identity is unavailable.");
    });
    const workingDiff = git.repository
      ? await this.#workspaces.gitDiff(registration.id).catch(() => {
          throw new ReviewEvidenceCaptureError("artifact-unavailable", "Review workspace changes are unavailable.");
        })
      : undefined;
    const patchBudget = { remaining: MAX_PATCH_CHARACTERS };
    const workspaceDiffs = git.repository ? dirtyEvidence(git, workingDiff!, patchBudget) : [];

    let branch: ReviewSourceBranchEvidence | null = null;
    let branchDiff: WorkspaceGitDiff | undefined;
    let branchUnavailableReason: string | undefined;
    if (git.repository && !git.dirty) {
      try {
        // WorkspaceService resolves the configured default/upstream base and
        // returns immutable base/head/merge-base fences.
        branchDiff = await this.#workspaces.gitReviewDiff(registration.id, { source: "branch" });
        const diffs = unifiedDiffEvidence(branchDiff.comparison, "branch", patchBudget);
        branch = {
          baseRefLabel: branchDiff.resolvedBaseRef ?? branchDiff.baseRevision ?? "default branch",
          fileCount: uniqueDiffPaths(diffs).size,
          diffs
        };
      } catch {
        branchUnavailableReason = "The default or upstream branch comparison is unavailable.";
      }
    }

    const latestChangeSet = (await this.#workspaceChanges.listChangeSets({
      workspaceId: registration.id,
      sessionId: request.sourceSessionId
    }))[0];
    // Turn change-set is fallback evidence only when Git has no review target.
    const selectedChangeSet = !git.dirty && (branch?.fileCount ?? 0) === 0 ? latestChangeSet : undefined;
    if (selectedChangeSet?.complete === false) {
      throw new ReviewEvidenceCaptureError("artifact-unavailable", "The selected turn change-set is incomplete.");
    }
    const changeSetEvidence = selectedChangeSet === undefined ? null : {
      state: "complete" as const,
      diffs: selectedChangeSet.changes.map(changeSetEvidenceItem),
      incompleteReasons: []
    };

    const selectedPaths = new Set<string>();
    for (const change of git.changes) {
      addReviewPath(selectedPaths, change.path);
      if (change.originalPath !== undefined) addReviewPath(selectedPaths, change.originalPath);
    }
    for (const diff of branch?.diffs ?? []) {
      addReviewPath(selectedPaths, diff.relativePath);
      if (diff.oldRelativePath !== undefined) addReviewPath(selectedPaths, diff.oldRelativePath);
    }
    for (const change of selectedChangeSet?.changes ?? []) addReviewPath(selectedPaths, change.path);
    if (selectedPaths.size > MAX_SELECTED_PATHS) {
      throw new ReviewEvidenceCaptureError("artifact-unavailable", "Review selected too many workspace paths.");
    }
    const files = await hashSelectedFiles(registration.root, [...selectedPaths].sort((a, b) => a.localeCompare(b, "en-US")));

    const attachments = collectAttachments(request, visible);
    assertArtifactBudget(attachments.values);
    const artifacts: ReviewSourceArtifact[] = [];
    let pdfFiles = 0;
    let remainingPdfCharacters = MAX_REVIEW_ARTIFACT_EXCERPT_CHARACTERS;
    for (const attachment of attachments.values) {
      const pdf = attachment.kind !== "image" && (attachment.blob.mimeType.toLowerCase() === "application/pdf" ||
        attachment.displayName.toLowerCase().endsWith(".pdf"));
      const artifact = await this.#artifactEvidence(attachment, {
        pdf, enabled: !pdf || pdfFiles++ < MAX_REVIEW_PDF_FILES, maxChars: remainingPdfCharacters
      });
      artifacts.push(artifact);
      if (pdf && artifact.excerpt !== undefined) remainingPdfCharacters -= artifact.excerpt.content.length;
    }
    assertSourceIdle(this.#store, request.sourceSessionId);
    const currentSource = this.#store.getSession(request.sourceSessionId);
    if (currentSource.descriptor.deletedAt !== source.descriptor.deletedAt ||
        currentSource.descriptor.archived !== source.descriptor.archived ||
        currentSource.descriptor.targetId !== source.descriptor.targetId ||
        currentSource.descriptor.binding.generation !== source.descriptor.binding.generation ||
        currentSource.descriptor.binding.opaqueRef !== source.descriptor.binding.opaqueRef ||
        currentSource.descriptor.binding.nativeSessionId !== source.descriptor.binding.nativeSessionId ||
        this.#store.getTarget(target.descriptor.id).revision !== target.revision) {
      throw new ReviewEvidenceCaptureError("source-changed", "Review source authority changed during evidence capture.");
    }
    const hasContext = messages.some((message) => message.text.trim() !== "");
    const hasFocus = (request.focus?.trim().length ?? 0) > 0;
    const hasChanges = workspaceDiffs.length > 0 || (branch?.fileCount ?? 0) > 0 || (changeSetEvidence?.diffs.length ?? 0) > 0;
    if (purpose === "start" && !hasContext && !hasFocus && artifacts.length === 0 && !hasChanges) {
      if (branchUnavailableReason !== undefined) {
        throw new ReviewEvidenceCaptureError("artifact-unavailable", branchUnavailableReason);
      }
      throw new ReviewEvidenceCaptureError("nothing-to-review", "There is no visible evidence to review.");
    }

    return {
      ...(request.focus === undefined ? {} : { focus: request.focus }),
      conversation: {
        sessionId: request.sourceSessionId,
        sessionGeneration: source.descriptor.binding.generation,
        nativeBindingIdentity: sha256(JSON.stringify([
          target.descriptor.id,
          registration.id,
          source.descriptor.binding.opaqueRef,
          source.descriptor.binding.nativeSessionId ?? ""
        ])),
        messages
      },
      workspace: {
        workspaceId: registration.id,
        files,
        git: git.repository ? {
          headOid: git.head ?? workingDiff?.headRevision ?? null,
          indexTreeOid: workingDiff === undefined ? null : sha256(workingDiff.index),
          worktreeRevision: workspaceRevision(registration.id, target.descriptor.id, git, workingDiff, branchDiff),
          baseOid: branchDiff?.baseRevision ?? null,
          mergeBaseOid: branchDiff?.mergeBaseRevision ?? null
        } : null,
        changeSet: selectedChangeSet === undefined ? null : {
          id: selectedChangeSet.id,
          revision: changeSetRevision(selectedChangeSet)
        }
      },
      workspaceEvidence: git.repository ? {
        dirty: git.dirty,
        totalFiles: git.changes.length,
        stagedFiles: git.changes.filter((item) => item.index !== " " && item.index !== "?").length,
        unstagedFiles: git.changes.filter((item) => item.worktree !== " ").length,
        untrackedFiles: git.changes.filter((item) => item.index === "?" || item.worktree === "?").length,
        diffs: workspaceDiffs
      } : null,
      ...(branch === null ? {} : { branchEvidence: branch }),
      ...(branchUnavailableReason === undefined ? {} : { branchUnavailableReason }),
      changeSetEvidence,
      artifacts,
      ...(attachments.omitted ? { artifactsOmitted: true } : {}),
      coverageGaps: [
        ...(git.repository ? [] : ["Workspace is not a Git repository."]),
        ...(branchUnavailableReason === undefined ? [] : [branchUnavailableReason])
      ]
    };
  }

  async #artifactEvidence(attachment: ReviewSourceArtifact, pdf: {
    readonly pdf: boolean; readonly enabled: boolean; readonly maxChars: number;
  }): Promise<ReviewSourceArtifact> {
    try {
      const stored = await this.#artifacts.get(attachment.blob.id);
      if (normalizeSha(stored.sha256) !== normalizeSha(attachment.blob.sha256)
        || stored.byteLength !== attachment.blob.byteLength
        || stored.mimeType.toLowerCase() !== attachment.blob.mimeType.toLowerCase()) throw new Error("identity mismatch");
      // Images, binaries and large files participate in freshness by their
      // actual bytes even when they do not receive a textual prompt excerpt.
      const read = await this.#artifacts.readBlob(attachment.blob);
      if (sha256(read.data) !== normalizeSha(attachment.blob.sha256)) throw new Error("content mismatch");
      if (attachment.kind === "image") return attachment;
      if (pdf.pdf) {
        const visualWarning = "PDF text does not prove page layout, images, forms, signatures or scanned-page coverage.";
        if (!pdf.enabled || pdf.maxChars < 1) return { ...attachment,
          warning: `The bounded PDF count or text limit was reached; this PDF's contents were not read. ${visualWarning}` };
        if (read.data.byteLength > PDF_TEXT_MAX_BYTES) return { ...attachment,
          warning: `PDF exceeds the 20 MiB text extraction limit; its contents were not read. ${visualWarning}` };
        try {
          const extracted = await this.#pdfText(read.data, pdf.maxChars);
          if (extracted.sections.length === 0) return { ...attachment,
            warning: `PDF has no extractable text; its contents were not reviewed. ${visualWarning}` };
          const limited = extracted.clipped || extracted.pagesInspected < extracted.numPages;
          return { ...attachment,
            excerpt: { format: "pdf-text", content: extracted.sections.join("\n\n"),
              coverage: limited ? `Bounded text from ${extracted.pagesInspected} of ${extracted.numPages} pages; later or clipped text is not covered.`
                : `Extractable text from all ${extracted.numPages} pages.` },
            warning: `${visualWarning}${limited ? " PDF text reached the page or character limit." : ""}` };
        } catch (error) {
          return { ...attachment, warning: `${error instanceof PdfTextExtractionError && error.code === "RETIREMENT_UNKNOWN"
            ? "PDF worker exit could not be confirmed; no text was adopted."
            : "PDF text extraction was unavailable; its contents were not read."} ${visualWarning}` };
        }
      }
      if (stored.byteLength > MAX_ARTIFACT_EXCERPT_BYTES) {
        return { ...attachment, warning: "File exceeds the bounded Review excerpt limit." };
      }
      if (!isTextMime(read.mimeType) || read.data.includes(0)) {
        return { ...attachment, warning: "Binary file has no textual Review excerpt." };
      }
      return {
        ...attachment,
        excerpt: {
          format: read.mimeType,
          coverage: "full file",
          content: new TextDecoder("utf-8", { fatal: false }).decode(read.data)
        }
      };
    } catch {
      throw new ReviewEvidenceCaptureError("artifact-unavailable", "A selected Review artifact is unavailable or changed.");
    }
  }
}

function assertArtifactBudget(artifacts: readonly ReviewSourceArtifact[]): void {
  let total = 0;
  for (const artifact of artifacts) {
    if (artifact.blob.byteLength > MAX_REVIEW_ARTIFACT_BYTES) {
      throw new ReviewEvidenceCaptureError("artifact-unavailable", "A selected Review artifact exceeds its byte limit.");
    }
    total += artifact.blob.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_REVIEW_ARTIFACT_TOTAL_BYTES) {
      throw new ReviewEvidenceCaptureError("artifact-unavailable", "Selected Review artifacts exceed the aggregate byte limit.");
    }
  }
}

function exactWorkspaceRegistration(metadata: unknown, targetId: string, workspaces: WorkspaceService) {
  const registrations = workspaces.listRegistrations();
  let workspaceId: string | undefined;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)["workspaceId"];
    if (typeof value === "string" && value.trim() !== "") workspaceId = value;
  }
  workspaceId ??= registrations.some((item) => item.id === targetId) ? targetId : undefined;
  const registration = workspaceId === undefined ? undefined : registrations.find((item) => item.id === workspaceId);
  if (registration === undefined) {
    throw new ReviewEvidenceCaptureError("artifact-unavailable", "The source target has no exact workspace registration.");
  }
  return registration;
}

function assertSourceIdle(store: OperationalStore, sessionId: string): void {
  const activeRun = store.listRuns({ sessionId, activeOnly: true, limit: 1 }).length > 0;
  const activeQueue = store.listQueueItems({
    sessionId,
    states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"],
    limit: 1
  }).length > 0;
  if (activeRun || activeQueue) throw new ReviewEvidenceCaptureError("source-busy", "The source task has an active or queued turn.");
}

type ListedEvent = ReturnType<OperationalStore["listEvents"]>[number];
type MessageEvent = ListedEvent & {
  readonly payload: Extract<ListedEvent["payload"], { readonly type: "message_complete" }>;
};

function visibleMessages(store: OperationalStore, sessionId: string, events: ListedEvent[]): MessageEvent[] {
  const deleted = new Set(events.flatMap((event) => event.payload.type === "message_deleted" ? event.payload.deletedEventIds : []));
  const disposition = new Map(listAllQueueItems(store, { sessionId }).map((item) => [item.runId, item.disposition] as const));
  return events.flatMap((event) => {
    if (
      event.payload.type !== "message_complete"
      || event.payload.automaticContinuation !== undefined
      || event.payload.objectiveContinuation !== undefined
      || deleted.has(event.id)
    ) return [];
    if (event.payload.role === "user" && event.runId !== undefined && disposition.get(event.runId) !== "prompt") return [];
    return [event as MessageEvent];
  });
}

function collectAttachments(request: StartReviewRequest, messages: readonly MessageEvent[]): {
  readonly values: readonly ReviewSourceArtifact[];
  readonly omitted: boolean;
} {
  const values: ReviewSourceArtifact[] = request.attachments.map((item) => ({ ...item }));
  const seen = new Set(values.map((item) => item.blob.id));
  let omitted = false;
  for (const event of messages) {
    for (const block of event.payload.blocks) {
      const artifact = blockAttachment(block);
      if (artifact === undefined || seen.has(artifact.blob.id)) continue;
      if (values.length >= MAX_REVIEW_ATTACHMENTS) {
        omitted = true;
        continue;
      }
      seen.add(artifact.blob.id);
      values.push(artifact);
    }
  }
  return { values, omitted };
}

function blockAttachment(block: MessageBlock): ReviewSourceArtifact | undefined {
  if (block.kind === "image") return { kind: "image", displayName: block.blob.fileName ?? block.alt ?? "image", blob: block.blob };
  if (block.kind === "artifact") return { kind: "file", displayName: block.blob.fileName ?? block.label ?? "artifact", blob: block.blob };
  return undefined;
}

function dirtyEvidence(git: GitState, diff: WorkspaceGitDiff, budget: { remaining: number }): ReviewSourceDiffEvidence[] {
  const staged = unifiedDiffEvidence(diff.index, "staged", budget);
  const unstaged = unifiedDiffEvidence(diff.workingTree, "unstaged", budget);
  const byPath = new Set([...staged, ...unstaged].map((item) => `${item.source}\0${item.relativePath}`));
  for (const change of git.changes) {
    if (change.index !== " " && change.index !== "?" && !byPath.has(`staged\0${change.path}`)) staged.push(metadataOnlyDiff(change, "staged"));
    if ((change.worktree !== " " || change.index === "?") && !byPath.has(`unstaged\0${change.path}`)) unstaged.push(metadataOnlyDiff(change, "unstaged"));
  }
  return [...staged, ...unstaged];
}

function unifiedDiffEvidence(
  patch: string,
  source: ReviewSourceDiffEvidence["source"],
  budget: { remaining: number }
): ReviewSourceDiffEvidence[] {
  if (patch === "") return [];
  const blocks = patch.split(/(?=^diff --git )/gmu).filter((block) => block.startsWith("diff --git "));
  if (blocks.length > MAX_REVIEW_SOURCE_DIFFS) throw new ReviewEvidenceCaptureError("artifact-unavailable", "Review diff exceeds its file limit.");
  return blocks.map((block) => {
    const newline = block.indexOf("\n");
    const first = block.slice(0, newline < 0 ? undefined : newline);
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(first);
    if (match === null || match[1]!.startsWith('"') || match[2]!.startsWith('"')) {
      throw new ReviewEvidenceCaptureError("artifact-unavailable", "Review diff contains an unsupported path encoding.");
    }
    const oldPath = canonicalReviewPath(match[1]!);
    const path = canonicalReviewPath(match[2]!);
    const lines = block.split("\n");
    const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const allowed = Math.min(budget.remaining, [...block].length);
    const clipped = [...block].slice(0, allowed).join("");
    budget.remaining -= allowed;
    return {
      relativePath: path,
      ...(oldPath === path ? {} : { oldRelativePath: oldPath }),
      source,
      status: statusFromPatch(block),
      additions,
      deletions,
      ...(clipped === "" ? {} : { patch: clipped }),
      ...(block.includes("GIT binary patch") || block.includes("Binary files ") ? { binary: true } : {})
    };
  });
}

function metadataOnlyDiff(change: GitState["changes"][number], source: "staged" | "unstaged"): ReviewSourceDiffEvidence {
  return {
    relativePath: canonicalReviewPath(change.path),
    ...(change.originalPath === undefined ? {} : { oldRelativePath: canonicalReviewPath(change.originalPath) }),
    source,
    status: `${change.index}${change.worktree}`,
    additions: 0,
    deletions: 0,
    binary: true
  };
}

function changeSetEvidenceItem(change: WorkspaceChange): ReviewSourceDiffEvidence {
  return {
    relativePath: canonicalReviewPath(change.path),
    source: "turn",
    status: change.kind,
    additions: 0,
    deletions: 0,
    binary: true
  };
}

async function hashSelectedFiles(root: string, paths: readonly string[]): Promise<ReviewSourceFileSnapshot[]> {
  const result: ReviewSourceFileSnapshot[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    if (isSensitiveReviewPath(path)) continue;
    const snapshot = await stableFileSnapshot(root, path);
    totalBytes += snapshot.byteLength;
    if (totalBytes > MAX_SELECTED_TOTAL_BYTES) {
      throw new ReviewEvidenceCaptureError("artifact-unavailable", "Review selected files exceed the aggregate byte limit.");
    }
    result.push(snapshot);
  }
  return result;
}

async function stableFileSnapshot(root: string, path: string): Promise<ReviewSourceFileSnapshot> {
  const canonical = canonicalReviewPath(path);
  const absolute = resolve(root, ...canonical.split("/"));
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(absolute);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { relativePath: canonical, sha256: sha256(`absent\0${canonical}`), byteLength: 0 };
    }
    throw new ReviewEvidenceCaptureError("artifact-unavailable", "A selected Review file is unavailable.");
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > MAX_SELECTED_FILE_BYTES) {
    throw new ReviewEvidenceCaptureError("artifact-unavailable", "A selected Review file is unsafe or exceeds its byte limit.");
  }
  const actual = await realpath(absolute);
  if (!isWithinRoot(root, actual)) throw new ReviewEvidenceCaptureError("artifact-unavailable", "A selected Review file escaped its workspace root.");
  const handle = await open(actual, "r");
  try {
    const opened = await handle.stat();
    if (!sameIdentity(before, opened)) throw new ReviewEvidenceCaptureError("source-changed", "A selected Review file changed while opening.");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    const afterHandle = await handle.stat();
    const afterPath = await lstat(absolute);
    const afterActual = await realpath(absolute);
    if (!sameIdentity(opened, afterHandle) || !sameIdentity(opened, afterPath) || afterActual !== actual) {
      throw new ReviewEvidenceCaptureError("source-changed", "A selected Review file changed while hashing.");
    }
    return { relativePath: canonical, sha256: hash.digest("hex"), byteLength: opened.size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameIdentity(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && ((error as { readonly code?: unknown }).code === "ENOENT" || (error as { readonly code?: unknown }).code === "ENOTDIR");
}

function addReviewPath(target: Set<string>, path: string): void {
  const canonical = canonicalReviewPath(path);
  if (!isSensitiveReviewPath(canonical)) target.add(canonical);
}

function canonicalReviewPath(value: string): string {
  const path = value.normalize("NFC");
  if (path === "" || isAbsolute(path) || path.includes("\\")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    || /[\0\p{Cc}]/u.test(path)) {
    throw new ReviewEvidenceCaptureError("artifact-unavailable", "Review evidence contains an unsafe workspace path.");
  }
  return path;
}

function uniqueDiffPaths(diffs: readonly ReviewSourceDiffEvidence[]): Set<string> {
  return new Set(diffs.map((item) => item.relativePath));
}

function statusFromPatch(block: string): string {
  if (block.includes("new file mode ")) return "created";
  if (block.includes("deleted file mode ")) return "deleted";
  if (block.includes("rename from ")) return "renamed";
  return "modified";
}

function workspaceRevision(
  workspaceId: string,
  targetId: string,
  git: GitState,
  working: WorkspaceGitDiff | undefined,
  branch: WorkspaceGitDiff | undefined
): string {
  return sha256(JSON.stringify({
    workspaceId,
    targetId,
    repository: git.repository,
    branch: git.branch ?? null,
    head: git.head ?? null,
    status: git.changes.map((change) => [change.path, change.originalPath ?? null, change.index, change.worktree]),
    workingRevision: working?.repositoryRevision ?? null,
    branchRevision: branch?.repositoryRevision ?? null,
    base: branch?.baseRevision ?? null,
    mergeBase: branch?.mergeBaseRevision ?? null
  }));
}

function changeSetRevision(value: WorkspaceChangeSetRecord): string {
  return sha256(JSON.stringify({
    id: value.id,
    runId: value.runId,
    complete: value.complete,
    gaps: value.gaps,
    changes: value.changes.map((change) => [
      change.path,
      change.kind,
      change.before?.sha256 ?? null,
      change.before?.byteLength ?? null,
      change.after?.sha256 ?? null,
      change.after?.byteLength ?? null
    ])
  }));
}

function normalizeSha(value: string): string {
  return value.toLowerCase().replace(/^sha256:/u, "");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isTextMime(value: string): boolean {
  return value.startsWith("text/") || /(?:json|javascript|typescript|xml|yaml|toml|markdown)/iu.test(value);
}
