import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { reviewImageRasterMimeByExtension, workspaceEntryAbsentRevision } from "@joko/contracts";
import { JokoError } from "@joko/core";
import { isWithin } from "@joko/core/policy";
import createIgnore from "ignore";

import {
  InMemoryWorkspaceChangeJournal,
  NodeWorkspaceWatcherProvider,
  WorkspaceChangeStream,
  type WorkspaceChangeJournal,
  type WorkspaceFileChangeRecord,
  type WorkspaceFileChangeScope,
  type WorkspaceWatcherProvider
} from "./workspace-change-stream.js";
import {
  isWorkspaceRipgrepMatch,
  runWorkspaceFileIndex,
  streamWorkspaceTextSearch,
  type WorkspaceRipgrepMatch
} from "./workspace-search.js";

export const WORKSPACE_TEXT_FILE_MAXIMUM_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_RASTER_PREVIEW_MAXIMUM_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_PDF_PREVIEW_MAXIMUM_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_MEDIA_PREVIEW_TOTAL_MAXIMUM_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES = 4 * 1024 * 1024;
export const WORKSPACE_GIT_COMMIT_MESSAGE_MAXIMUM_BYTES = 64 * 1024;
const WORKSPACE_IGNORE_FILE_MAXIMUM_BYTES = 1024 * 1024;
const WORKSPACE_SEARCH_DEFAULT_PAGE_SIZE = 500;
const WORKSPACE_SEARCH_MAXIMUM_PAGE_SIZE = 5_000;
const WORKSPACE_SEARCH_MAXIMUM_OFFSET = 100_000;
const WORKSPACE_ENTRY_MUTATION_MAXIMUM_ENTRIES = 100_000;
const WORKSPACE_ENTRY_COPY_MAXIMUM_BYTES = 256 * 1024 * 1024;
const DOCUMENT_TREE_EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "__pycache__",
  "vendor",
  ".venv",
  ".cache",
  ".vs",
  ".idea",
  ".vscode-test",
  "dist",
  "build",
  "out",
  ".next",
  "target",
  "bin",
  "obj",
  "library",
  "temp",
  "logs",
  "usersettings",
  "assetdepotoutput",
  "chuangxiangeditorcache"
]);
const DOCUMENT_TREE_EXCLUDED_FILE_NAMES = new Set([".ds_store", "thumbs.db"]);

export interface WorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly displayName: string;
  readonly trusted: boolean;
  readonly remote?: {
    readonly targetId: string;
    readonly hostId: string;
    readonly workspaceRoot: string;
  };
}

export interface RemoteWorkspaceDelegate {
  register(input: WorkspaceRegistration): Promise<WorkspaceRegistration>;
  unregister(id: string): void;
  watchChanges(scope: WorkspaceFileChangeScope, signal?: AbortSignal): AsyncGenerator<WorkspaceFileChangeRecord>;
  invoke<Result>(workspaceId: string, method: string, args: readonly unknown[]): Promise<Result>;
  stream<Result>(workspaceId: string, method: string, args: readonly unknown[]): AsyncGenerator<Result>;
  close(): Promise<void>;
}

export interface WorkspaceEntryRecord {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly size: number;
  readonly modifiedAt: number;
  readonly revision: string;
  readonly generated: boolean;
}

export type WorkspaceEntryListingPolicy = "default" | "document_tree";

export interface WorkspaceEntryListingOptions {
  readonly recursive?: boolean;
  readonly maximumEntries?: number;
  readonly listingPolicy?: WorkspaceEntryListingPolicy;
}

export interface WorkspaceFilePreview {
  readonly entry: WorkspaceEntryRecord;
  readonly mediaType: string;
  readonly text?: string;
  /**
   * Complete, revision-fenced bytes for a bounded local raster image or PDF.
   * Absolute workspace paths never cross this service boundary.
   */
  readonly bytes?: Buffer;
  readonly truncated: boolean;
}

export type WorkspaceFilePreviewErrorCode =
  | "WORKSPACE_FILE_PREVIEW_INVALID"
  | "WORKSPACE_FILE_PREVIEW_STALE"
  | "WORKSPACE_FILE_PREVIEW_UNSUPPORTED"
  | "WORKSPACE_FILE_PREVIEW_READ_FAILED";

export class WorkspaceFilePreviewError extends Error {
  readonly code: WorkspaceFilePreviewErrorCode;

  constructor(
    message: string,
    readonly kind: "invalid" | "stale" | "unsupported" | "read_failed"
  ) {
    super(message);
    this.name = "WorkspaceFilePreviewError";
    this.code = workspaceFilePreviewErrorCode(kind);
  }
}

export interface WorkspaceSearchResult {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endColumn: number;
  readonly startByte: number;
  readonly endByte: number;
  readonly preview: string;
  /** Every authoritative rg UTF-8 byte range, relative to the preview line. */
  readonly submatches: readonly WorkspaceSearchSubmatch[];
  /** File metadata fence observed immediately after ripgrep completed. */
  readonly revision: string;
}

export interface WorkspaceSearchSubmatch {
  readonly startByte: number;
  readonly endByte: number;
}

export interface WorkspaceSearchOptions {
  readonly glob?: string;
  readonly maximumResults?: number;
  readonly offset?: number;
  /** Defaults to false, matching the public Workspace search request. */
  readonly caseSensitive?: boolean;
  /** Defaults to false so untrusted user input is always a literal string. */
  readonly regularExpression?: boolean;
}

export interface WorkspaceSearchPage {
  readonly matches: readonly WorkspaceSearchResult[];
  readonly totalResults: number;
  readonly totalFiles: number;
  readonly truncated: boolean;
  readonly nextOffset?: number;
  /** Content-derived fence for the complete sorted result set across pages. */
  readonly revision: string;
}

export interface WorkspaceFileIndex {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  /** Content-derived fence for the exact ordered index snapshot. */
  readonly revision: string;
}

export type WorkspaceSearchStreamEvent =
  | { readonly kind: "match"; readonly match: WorkspaceSearchResult }
  | {
      readonly kind: "end";
      readonly truncated: boolean;
      readonly totalResults: number;
      readonly totalFiles: number;
      /** Content-derived fence for every match emitted before this event. */
      readonly revision: string;
    }
  | {
      readonly kind: "error";
      readonly code: WorkspaceSearchErrorCode;
      readonly message: string;
    };

export class WorkspaceScanError extends Error {
  constructor(
    message: string,
    readonly kind: "scan_failed" | "limit"
  ) {
    super(message);
    this.name = "WorkspaceScanError";
  }
}

export class WorkspaceSearchError extends Error {
  readonly code: WorkspaceSearchErrorCode;

  constructor(
    message: string,
    readonly kind: "invalid" | "search_failed" | "result_changed",
    code?: WorkspaceSearchErrorCode
  ) {
    super(message);
    this.name = "WorkspaceSearchError";
    this.code = code ?? workspaceSearchErrorCode(kind);
  }
}

export type WorkspaceSearchErrorCode =
  | "WORKSPACE_SEARCH_INVALID"
  | "WORKSPACE_SEARCH_FAILED"
  | "WORKSPACE_SEARCH_RESULT_CHANGED"
  | "RG_UNAVAILABLE";

export interface GitState {
  readonly repository: boolean;
  readonly branch?: string;
  readonly head?: string;
  readonly detachedHead: boolean;
  readonly operationInProgress: boolean;
  readonly unmerged: boolean;
  readonly dirty: boolean;
  readonly changes: readonly { path: string; index: string; worktree: string; originalPath?: string }[];
}

type WorkspaceGitWriteDisabledReason = "detached" | "unborn" | "unmerged" | "in-progress";

interface WorkspaceGitWriteState {
  readonly branch?: string;
  readonly head?: string;
  readonly detachedHead: boolean;
  readonly unborn: boolean;
  readonly unmerged: boolean;
  readonly operationInProgress: boolean;
  readonly disabledReasons: readonly WorkspaceGitWriteDisabledReason[];
}

export interface WorkspaceTextFileWriteInput {
  readonly path: string;
  readonly text: string;
  readonly expectedRevision: string;
}

export interface WorkspaceTextFileWriteResult {
  readonly entry: WorkspaceEntryRecord;
  readonly mediaType: string;
  readonly previousRevision: string;
  readonly revision: string;
}

export type WorkspaceEntryMutationErrorKind =
  | "invalid"
  | "stale"
  | "not_found"
  | "conflict"
  | "unsupported"
  | "unsafe"
  | "too_large"
  | "effect_failed";

export class WorkspaceEntryMutationError extends JokoError {
  readonly code: string;

  constructor(
    message: string,
    readonly kind: WorkspaceEntryMutationErrorKind,
    options?: { readonly stateMayHaveChanged?: boolean; readonly cause?: unknown }
  ) {
    const code = workspaceEntryMutationErrorCode(kind);
    super({
      code,
      message,
      phase: "workspace_entry_mutation",
      retryable: kind === "stale" || kind === "effect_failed",
      stateMayHaveChanged: options?.stateMayHaveChanged ?? false,
      recovery: workspaceEntryMutationRecovery(kind)
    }, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkspaceEntryMutationError";
    this.code = code;
  }
}

export type WorkspaceEntryCreateKind = "file" | "directory";

export interface WorkspaceEntryMutationResult {
  readonly entry: WorkspaceEntryRecord;
}

export type WorkspaceTextFileWriteErrorCode =
  | "WORKSPACE_TEXT_FILE_INVALID"
  | "WORKSPACE_TEXT_FILE_STALE"
  | "WORKSPACE_TEXT_FILE_UNSUPPORTED"
  | "WORKSPACE_TEXT_FILE_TOO_LARGE"
  | "WORKSPACE_TEXT_FILE_WRITE_FAILED";

export class WorkspaceTextFileWriteError extends Error {
  readonly code: WorkspaceTextFileWriteErrorCode;

  constructor(
    message: string,
    readonly kind: "invalid" | "stale" | "unsupported" | "too_large" | "write_failed"
  ) {
    super(message);
    this.name = "WorkspaceTextFileWriteError";
    this.code = workspaceTextFileWriteErrorCode(kind);
  }
}

export interface WorkspaceGitDiff {
  readonly index: string;
  readonly workingTree: string;
  readonly comparison: string;
  readonly repositoryRevision: string;
  readonly baseRevision?: string;
  readonly headRevision?: string;
  readonly mergeBaseRevision?: string;
  readonly source?: WorkspaceGitReviewSource;
  readonly sourceRevision?: string;
  readonly requestedBaseRef?: string;
  readonly resolvedBaseRef?: string;
  readonly branchBaseWarning?: {
    readonly kind: "requested_base_missing";
    readonly requestedBaseRef: string;
    readonly resolvedBaseRef: string;
  };
}

interface WorkspaceGitResolvedBranchBase {
  readonly oid: string;
  readonly ref: string;
  readonly warning?: WorkspaceGitDiff["branchBaseWarning"];
}

type WorkspaceGitBranchBaseCandidateKind = "remote-default" | "local" | "remote" | "upstream";

interface WorkspaceGitBranchBaseCandidate extends WorkspaceGitResolvedBranchBase {
  readonly kind: WorkspaceGitBranchBaseCandidateKind;
}

export type WorkspaceGitDiffSource = "index" | "workingTree" | "comparison";
export type WorkspaceGitReviewSource = "unstaged" | "staged" | "commit" | "branch";
export type WorkspaceGitMutableSource = "unstaged" | "staged";
export type WorkspaceGitDiffAction = "stage" | "unstage" | "revert";
export type WorkspaceGitDiffTarget = "file" | "hunk";

export interface WorkspaceGitReviewDiffInput {
  readonly source: WorkspaceGitReviewSource;
  readonly sourceRevision?: string;
  readonly expectedRepositoryRevision?: string;
  readonly expectedMergeBaseRevision?: string;
  readonly paths?: readonly string[];
  readonly ignoreWhitespace?: boolean;
}

export interface WorkspaceGitMutation {
  readonly action: WorkspaceGitDiffAction;
  readonly source: WorkspaceGitMutableSource;
  readonly target: WorkspaceGitDiffTarget;
  readonly path: string;
  readonly oldPath?: string;
  readonly hunkIndex?: number;
  readonly expectedRepositoryRevision: string;
  readonly ignoreWhitespace?: boolean;
  readonly confirmRevert?: boolean;
}

export interface WorkspaceGitHunkMutation {
  readonly action: WorkspaceGitDiffAction;
  readonly source: WorkspaceGitDiffSource | WorkspaceGitMutableSource;
  readonly path: string;
  readonly oldPath?: string;
  readonly hunkIndex: number;
  readonly expectedRepositoryRevision: string;
  readonly ignoreWhitespace?: boolean;
  readonly confirmRevert?: boolean;
}

export interface WorkspaceGitImageSide {
  readonly present: boolean;
  readonly tooLarge: boolean;
  readonly path?: string;
  readonly mediaType?: string;
  readonly bytes?: Buffer;
}

export interface WorkspaceGitImagePreview {
  readonly oldImage: WorkspaceGitImageSide;
  readonly newImage: WorkspaceGitImageSide;
  readonly repositoryRevision: string;
  readonly mergeBaseRevision?: string;
}

export interface WorkspaceGitCommitResult {
  readonly previousRepositoryRevision: string;
  readonly repositoryRevision: string;
  readonly headRevision: string;
}

export type WorkspaceGitPushResult =
  | {
      readonly kind: "pushed";
      readonly repositoryRevision: string;
      readonly headRevision: string;
      readonly remote: string;
      readonly remoteRef: string;
    }
  | {
      readonly kind: "needs_force";
      readonly repositoryRevision: string;
      readonly headRevision: string;
      readonly remote: string;
      readonly remoteRef: string;
      readonly remoteOid: string;
      readonly ahead: number;
      readonly behind: number;
    };

export class WorkspaceGitReviewError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "stale" | "lease_expired" | "unsupported" | "apply_failed"
  ) {
    super(message);
    this.name = "WorkspaceGitReviewError";
  }
}

export class WorkspaceService {
  readonly #workspaces = new Map<string, WorkspaceRegistration>();
  readonly #changeStream: WorkspaceChangeStream;
  readonly #ripgrepExecutable: string;
  readonly #gitExecutable: string;
  readonly #commitWorkspaceTextFile: (stagedPath: string, destinationPath: string) => Promise<void>;
  readonly #remoteDelegate: RemoteWorkspaceDelegate | undefined;
  readonly #afterWorkspacePreviewRead: ((input: {
    readonly workspaceId: string;
    readonly path: string;
  }) => Promise<void>) | undefined;
  readonly #afterWorkspaceArtifactRead: ((input: {
    readonly workspaceId: string;
    readonly path: string;
  }) => Promise<void>) | undefined;
  readonly #workspaceFileMutationTails = new Map<string, Promise<void>>();
  #gitMutationTail: Promise<void> = Promise.resolve();

  constructor(options?: {
    ripgrepExecutable?: string;
    gitExecutable?: string;
    commitWorkspaceTextFile?: (stagedPath: string, destinationPath: string) => Promise<void>;
    afterWorkspacePreviewRead?: (input: {
      readonly workspaceId: string;
      readonly path: string;
    }) => Promise<void>;
    afterWorkspaceArtifactRead?: (input: {
      readonly workspaceId: string;
      readonly path: string;
    }) => Promise<void>;
    watcherProvider?: WorkspaceWatcherProvider;
    changeJournal?: WorkspaceChangeJournal;
    now?: () => number;
    remoteDelegate?: RemoteWorkspaceDelegate;
  }) {
    this.#ripgrepExecutable = options?.ripgrepExecutable ?? "rg";
    this.#gitExecutable = options?.gitExecutable ?? "git";
    this.#commitWorkspaceTextFile = options?.commitWorkspaceTextFile ?? rename;
    this.#remoteDelegate = options?.remoteDelegate;
    this.#afterWorkspacePreviewRead = options?.afterWorkspacePreviewRead;
    this.#afterWorkspaceArtifactRead = options?.afterWorkspaceArtifactRead;
    this.#changeStream = new WorkspaceChangeStream({
      provider: options?.watcherProvider ?? new NodeWorkspaceWatcherProvider(),
      journal: options?.changeJournal ?? new InMemoryWorkspaceChangeJournal(),
      registrations: () => this.listRegistrations(),
      ...(options?.now === undefined ? {} : { now: options.now })
    });
  }

  async register(input: WorkspaceRegistration): Promise<WorkspaceRegistration> {
    const previous = this.#workspaces.get(input.id);
    if (input.remote !== undefined) {
      if (this.#remoteDelegate === undefined) throw new Error("Remote workspace files are unavailable.");
      const registration = await this.#remoteDelegate.register(input);
      if (previous !== undefined && previous.remote === undefined) {
        await this.#changeStream.workspaceUnregistered(input.id);
      }
      this.#workspaces.set(input.id, registration);
      return registration;
    }
    const root = await realpath(input.root);
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workspace root must be a real directory.");
    const registration = { ...input, root };
    if (previous?.remote !== undefined) this.#remoteDelegate?.unregister(input.id);
    this.#workspaces.set(input.id, registration);
    await this.#changeStream.workspaceRegistered(registration);
    return registration;
  }

  unregister(id: string): void {
    const workspace = this.#workspaces.get(id);
    if (!this.#workspaces.delete(id)) return;
    if (workspace?.remote !== undefined) {
      this.#remoteDelegate?.unregister(id);
      return;
    }
    void this.#changeStream.workspaceUnregistered(id);
  }

  listRegistrations(): readonly WorkspaceRegistration[] {
    return [...this.#workspaces.values()];
  }

  watchChanges(scope: WorkspaceFileChangeScope, signal?: AbortSignal): AsyncGenerator<WorkspaceFileChangeRecord> {
    if (scope.kind === "workspace" && this.#workspaces.get(scope.workspaceId)?.remote !== undefined) {
      if (this.#remoteDelegate === undefined) throw new Error("Remote workspace files are unavailable.");
      return this.#remoteDelegate.watchChanges(scope, signal);
    }
    return this.#changeStream.watch(scope, signal);
  }

  async close(): Promise<void> {
    await Promise.all([this.#changeStream.close(), this.#remoteDelegate?.close()]);
  }

  async list(workspaceId: string, directory = "", options?: WorkspaceEntryListingOptions): Promise<readonly WorkspaceEntryRecord[]> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "list", [directory, options]);
    }
    const workspace = this.requireWorkspace(workspaceId);
    await assertSafeWorkspaceListingDirectory(workspace, directory);
    const root = await this.resolveSafe(workspace, directory, true);
    const maximum = normalizeWorkspaceListMaximum(options?.maximumEntries);
    const listingPolicy = options?.listingPolicy ?? "default";
    const output: WorkspaceEntryRecord[] = [];
    try {
      const ignoreStrategy = listingPolicy === "default"
        ? await createWorkspaceIgnoreStrategy(workspace, this.#gitExecutable)
        : undefined;
      const visit = async (
        absoluteDirectory: string,
        inheritedScopes: readonly WorkspaceIgnoreScope[]
      ): Promise<void> => {
        const relativeDirectory = canonicalListedWorkspacePath(workspace.root, absoluteDirectory, true);
        const scopes = ignoreStrategy?.kind === "fallback"
          ? await appendWorkspaceIgnoreScope(absoluteDirectory, relativeDirectory, inheritedScopes)
          : inheritedScopes;
        const children = await readdir(absoluteDirectory, { withFileTypes: true });
        children.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || (
          listingPolicy === "document_tree"
            ? compareDocumentTreeNames(left.name, right.name)
            : compareWorkspaceNames(left.name, right.name)
        ));

        const candidates: WorkspaceListCandidate[] = [];
        for (const child of children) {
          if (child.name.toLocaleLowerCase("en-US") === ".git") continue;
          const absolute = resolve(absoluteDirectory, child.name);
          const info = await lstat(absolute);
          if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) continue;
          if (listingPolicy === "document_tree" && documentTreeEntryExcluded(child.name, info.isDirectory())) continue;
          const relativePath = canonicalListedWorkspacePath(workspace.root, absolute, false);
          candidates.push({ absolute, relativePath, name: child.name, info });
        }

        const ignored = ignoreStrategy?.kind === "git"
          ? await gitIgnoredWorkspacePaths(ignoreStrategy, candidates.map((candidate) => candidate.relativePath))
          : undefined;
        for (const candidate of candidates) {
          const directoryCandidate = candidate.info.isDirectory();
          const excluded = ignoreStrategy?.kind === "git"
            ? ignored?.has(candidate.relativePath) === true
            : ignoreStrategy?.kind === "fallback"
              ? fallbackWorkspacePathIgnored(candidate.relativePath, directoryCandidate, scopes)
              : false;
          if (excluded) continue;
          if (output.length >= maximum) {
            throw new WorkspaceScanError(`Workspace listing exceeded its ${maximum} entry limit.`, "limit");
          }
          output.push({
            path: candidate.relativePath,
            name: candidate.name,
            kind: directoryCandidate ? "directory" : "file",
            size: candidate.info.size,
            modifiedAt: candidate.info.mtimeMs,
            revision: metadataFileRevision(candidate.info),
            generated: isGeneratedPath(candidate.relativePath)
          });
          if (directoryCandidate && options?.recursive === true) await visit(candidate.absolute, scopes);
        }
      };
      await visit(root, []);
      return output;
    } catch (error) {
      if (error instanceof WorkspaceScanError) throw error;
      throw new WorkspaceScanError(`Workspace scan failed at ${directory === "" ? "." : directory}: ${errorMessage(error)}`, "scan_failed");
    }
  }

  async preview(workspaceId: string, path: string, maximumBytes = 2 * 1024 * 1024): Promise<WorkspaceFilePreview> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "preview", [path, maximumBytes]);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const resolved = await this.#resolveWorkspacePreviewFile(workspace, path);
    const mediaType = inferMediaType(resolved.path);
    const mediaLimit = workspaceMediaPreviewLimit(resolved.path);
    if (mediaLimit !== undefined) {
      const maximumMediaBytes = Math.min(mediaLimit, WORKSPACE_MEDIA_PREVIEW_TOTAL_MAXIMUM_BYTES);
      if (resolved.info.size > maximumMediaBytes) {
        return {
          entry: workspaceFileEntry(resolved.path, resolved.info, metadataFileRevision(resolved.info)),
          mediaType,
          truncated: false
        };
      }
      const snapshot = await this.#readWorkspacePreviewSnapshot(workspace, resolved, resolved.info.size);
      return {
        entry: workspaceFileEntry(resolved.path, snapshot.info, workspaceFileContentRevision(snapshot.bytes)),
        mediaType,
        bytes: snapshot.bytes,
        truncated: false
      };
    }

    const metadataEntry = workspaceFileEntry(resolved.path, resolved.info, metadataFileRevision(resolved.info));
    if (!isTextMediaType(mediaType) && mediaType !== "application/octet-stream") {
      return { entry: metadataEntry, mediaType, truncated: false };
    }

    // Writable text files receive a content-derived opaque revision. This is
    // intentionally based on the full file, even when the visible preview is
    // truncated, so callers can use the read revision as a write fence.
    const visibleMaximum = normalizeWorkspacePreviewMaximumBytes(maximumBytes);
    const readLength = resolved.info.size <= WORKSPACE_TEXT_FILE_MAXIMUM_BYTES
      ? resolved.info.size
      : Math.min(resolved.info.size, visibleMaximum);
    const snapshot = await this.#readWorkspacePreviewSnapshot(workspace, resolved, readLength);
    const content = snapshot.bytes;
    const entry = workspaceFileEntry(
      resolved.path,
      snapshot.info,
      content.byteLength === snapshot.info.size
        ? workspaceFileContentRevision(content)
        : metadataFileRevision(snapshot.info)
    );
    if (content.includes(0)) return { entry, mediaType: "application/octet-stream", truncated: false };
    if (content.byteLength === snapshot.info.size) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        return { entry, mediaType: "application/octet-stream", truncated: false };
      }
    } else if (mediaType === "application/octet-stream") {
      // An unknown, oversized file cannot be proven to be complete UTF-8
      // within the bounded preview and therefore stays binary/fail-closed.
      return { entry, mediaType, truncated: false };
    }
    const visible = content.subarray(0, Math.min(content.byteLength, visibleMaximum));
    return {
      entry,
      mediaType: mediaType === "application/octet-stream" ? "text/plain" : mediaType,
      text: visible.toString("utf8"),
      truncated: snapshot.info.size > visible.byteLength
    };
  }

  /**
   * Stream a canonical, symlink-free regular-file snapshot into a trusted
   * internal sink. The sink must stage privately and invoke beforeFinalize
   * after hashing but before publishing its BlobRef.
   */
  async materializeFile<Result>(
    workspaceId: string,
    path: string,
    expectedRevision: string,
    ingest: (handle: FileHandle, options: {
      readonly expectedSize: number;
      readonly signal?: AbortSignal;
      readonly beforeFinalize: (snapshot: { readonly sha256: string; readonly byteLength: number }) => Promise<void>;
    }) => Promise<Result>,
    signal?: AbortSignal
  ): Promise<Result> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "materializeFile", [path, expectedRevision, ingest, signal]);
    }
    signal?.throwIfAborted();
    const workspace = this.requireWorkspace(workspaceId);
    const resolved = await this.#resolveWorkspacePreviewFile(workspace, path);
    let handle: FileHandle;
    try {
      handle = await open(resolved.absolute, "r");
    } catch {
      throw new WorkspaceFilePreviewError("Workspace file could not be opened safely for download.", "read_failed");
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new WorkspaceFilePreviewError("Workspace download requires a regular file.", "unsupported");
      }
      if (!sameFileState(before, resolved.info)) {
        throw new WorkspaceFilePreviewError("Workspace file changed while it was being opened for download.", "stale");
      }
      if (!expectedRevision.startsWith("sha256:") && metadataFileRevision(before) !== expectedRevision) {
        throw new WorkspaceFilePreviewError("Workspace file revision changed before download.", "stale");
      }
      return await ingest(handle, {
        expectedSize: before.size,
        ...(signal === undefined ? {} : { signal }),
        beforeFinalize: async (snapshot) => {
          signal?.throwIfAborted();
          await this.#afterWorkspaceArtifactRead?.({ workspaceId: workspace.id, path: resolved.path });
          signal?.throwIfAborted();
          const after = await handle.stat();
          let current: WorkspaceResolvedPreviewFile;
          try {
            current = await this.#resolveWorkspacePreviewFile(workspace, resolved.path);
          } catch {
            throw new WorkspaceFilePreviewError("Workspace file changed while it was being downloaded.", "stale");
          }
          if (
            snapshot.byteLength !== before.size
            || current.absolute !== resolved.absolute
            || !sameFileState(before, after)
            || !sameFileState(after, current.info)
          ) {
            throw new WorkspaceFilePreviewError("Workspace file changed while it was being downloaded.", "stale");
          }
          const materializedRevision = expectedRevision.startsWith("sha256:")
            ? `sha256:${snapshot.sha256}:${snapshot.byteLength}`
            : metadataFileRevision(after);
          if (materializedRevision !== expectedRevision) {
            throw new WorkspaceFilePreviewError("Workspace file revision changed while it was being downloaded.", "stale");
          }
        }
      });
    } catch (error) {
      if (error instanceof WorkspaceFilePreviewError || isAbortError(error)) throw error;
      try {
        const current = await this.#resolveWorkspacePreviewFile(workspace, resolved.path);
        if (current.absolute !== resolved.absolute || !sameFileState(resolved.info, current.info)) {
          throw new WorkspaceFilePreviewError("Workspace file changed while it was being downloaded.", "stale");
        }
      } catch (verificationError) {
        if (verificationError instanceof WorkspaceFilePreviewError && verificationError.kind === "stale") throw verificationError;
        throw new WorkspaceFilePreviewError("Workspace file changed while it was being downloaded.", "stale");
      }
      throw new WorkspaceFilePreviewError("Workspace file could not be materialized safely for download.", "read_failed");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Lazy project filename index. Unlike the visible document tree,
   * this deliberately honours .gitignore/.ignore/.rgignore and includes
   * hidden files by delegating to `rg --files --hidden`.
   */
  async listFiles(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceFileIndex> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "listFiles", [signal]);
    }
    const workspace = this.requireWorkspace(workspaceId);
    try {
      return await runWorkspaceFileIndex({
        executable: this.#ripgrepExecutable,
        cwd: workspace.root,
        ...(signal === undefined ? {} : { signal })
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new WorkspaceScanError(`Workspace file index failed: ${errorMessage(error)}`, "scan_failed");
    }
  }

  async writeTextFile(workspaceId: string, input: WorkspaceTextFileWriteInput): Promise<WorkspaceTextFileWriteResult> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "writeTextFile", [input]);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const canonicalPath = canonicalWorkspaceRelativePath(input.path);
    if (input.expectedRevision.trim() === "") {
      throw new WorkspaceTextFileWriteError("A workspace file revision fence is required.", "invalid");
    }
    const bytes = encodeWorkspaceText(input.text);
    if (bytes.byteLength > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) {
      throw new WorkspaceTextFileWriteError("Workspace text exceeds the save size limit.", "too_large");
    }

    return this.#serializeWorkspaceFileMutation(`${workspace.root}\0*`, async () => {
      const before = await this.#readWorkspaceTextSnapshot(workspace, canonicalPath);
      if (before.revision !== input.expectedRevision) {
        throw new WorkspaceTextFileWriteError("Workspace file changed; read it again before saving.", "stale");
      }

      const temporaryPath = resolve(dirname(before.absolute), `.joko-write-${randomUUID()}.tmp`);
      try {
        let stagedInfo: Stats | undefined;
        try {
          const handle = await open(temporaryPath, "wx", before.info.mode & 0o777);
          try {
            await handle.writeFile(bytes);
            await handle.chmod(before.info.mode & 0o777);
            await handle.sync();
            stagedInfo = await handle.stat();
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (error instanceof WorkspaceTextFileWriteError) throw error;
          throw new WorkspaceTextFileWriteError("Workspace text could not be staged safely.", "write_failed");
        }

        let current: WorkspaceTextSnapshot;
        try {
          current = await this.#readWorkspaceTextSnapshot(workspace, canonicalPath);
        } catch {
          throw new WorkspaceTextFileWriteError("Workspace file changed; read it again before saving.", "stale");
        }
        if (current.absolute !== before.absolute || current.revision !== input.expectedRevision) {
          throw new WorkspaceTextFileWriteError("Workspace file changed; read it again before saving.", "stale");
        }

        try {
          await this.#commitWorkspaceTextFile(temporaryPath, before.absolute);
        } catch {
          throw new WorkspaceTextFileWriteError("Workspace text could not be committed safely.", "write_failed");
        }

        if (stagedInfo === undefined) {
          throw new WorkspaceTextFileWriteError("Workspace text staging did not produce file metadata.", "write_failed");
        }
        const revision = workspaceTextFileRevision(bytes);
        return {
          entry: workspaceFileEntry(canonicalPath, stagedInfo, revision),
          mediaType: before.mediaType,
          previousRevision: before.revision,
          revision
        };
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    });
  }

  async createEntry(
    workspaceId: string,
    input: { readonly path: string; readonly kind: WorkspaceEntryCreateKind; readonly expectedRevision: string }
  ): Promise<WorkspaceEntryMutationResult> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "createEntry", [input]);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const canonicalPath = canonicalWorkspaceMutationPath(input.path);
    if (input.kind !== "file" && input.kind !== "directory") {
      throw new WorkspaceEntryMutationError("A concrete workspace entry kind is required.", "invalid");
    }
    if (input.expectedRevision !== workspaceEntryAbsentRevision) {
      throw new WorkspaceEntryMutationError("Creation requires the explicit absent workspace revision fence.", "invalid");
    }
    return this.#serializeWorkspaceFileMutation(`${workspace.root}\0*`, async () => {
      const destination = await this.#resolveWorkspaceMutationDestination(workspace, canonicalPath);
      let effectCreated = false;
      try {
        if (input.kind === "file") {
          const handle = await open(destination.absolute, "wx", 0o666);
          effectCreated = true;
          await handle.close();
        } else {
          await mkdir(destination.absolute, { recursive: false, mode: 0o777 });
          effectCreated = true;
        }
      } catch (error) {
        if (filesystemEntryExists(error)) {
          throw new WorkspaceEntryMutationError("The workspace destination already exists.", "conflict");
        }
        throw new WorkspaceEntryMutationError("The workspace entry could not be created.", "effect_failed", {
          stateMayHaveChanged: effectCreated,
          cause: error
        });
      }
      let created: WorkspaceResolvedMutationEntry;
      try {
        created = await this.#resolveWorkspaceMutationEntry(workspace, canonicalPath);
        await this.#assertWorkspaceMutationDestinationStillSafe(workspace, destination, created.info);
      } catch (error) {
        throw workspaceEntryPostEffectError("The created workspace entry could not be identity-fenced.", error);
      }
      return { entry: workspaceMutationEntry(canonicalPath, created.info) };
    });
  }

  async moveEntry(
    workspaceId: string,
    input: {
      readonly sourcePath: string;
      readonly destinationPath: string;
      readonly expectedRevision: string;
    }
  ): Promise<WorkspaceEntryMutationResult> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "moveEntry", [input]);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const sourcePath = canonicalWorkspaceMutationPath(input.sourcePath);
    const destinationPath = canonicalWorkspaceMutationPath(input.destinationPath);
    requireWorkspaceEntryRevision(input.expectedRevision);
    if (sourcePath === destinationPath) {
      throw new WorkspaceEntryMutationError("The source and destination workspace paths are identical.", "invalid");
    }
    if (destinationPath.startsWith(`${sourcePath}/`)) {
      throw new WorkspaceEntryMutationError("A workspace directory cannot be moved inside itself.", "invalid");
    }
    return this.#serializeWorkspaceFileMutation(`${workspace.root}\0*`, async () => {
      const source = await this.#resolveWorkspaceMutationEntry(workspace, sourcePath);
      assertWorkspaceEntryRevision(source.info, input.expectedRevision);
      await this.#validateWorkspaceMutationTree(source.absolute);
      const destination = await this.#resolveWorkspaceMutationDestination(workspace, destinationPath, source.info);
      const current = await this.#resolveWorkspaceMutationEntry(workspace, sourcePath);
      assertSameWorkspaceMutationEntry(source, current, input.expectedRevision);
      await this.#validateWorkspaceMutationTree(current.absolute);
      await this.#assertWorkspaceMutationDestinationStillSafe(workspace, destination, source.info);
      try {
        await rename(source.absolute, destination.absolute);
      } catch (error) {
        if (filesystemEntryExists(error)) {
          throw new WorkspaceEntryMutationError("The workspace destination already exists.", "conflict");
        }
        throw new WorkspaceEntryMutationError("The workspace entry could not be moved.", "effect_failed", { cause: error });
      }
      let moved: WorkspaceResolvedMutationEntry;
      try {
        moved = await this.#resolveWorkspaceMutationEntry(workspace, destinationPath);
        await this.#assertWorkspaceMutationDestinationStillSafe(workspace, destination, moved.info);
        if (!sameFilesystemIdentity(source.info, moved.info)) {
          throw new WorkspaceEntryMutationError("The moved workspace entry has an unexpected identity.", "stale");
        }
      } catch (error) {
        throw workspaceEntryPostEffectError("The moved workspace entry could not be identity-fenced.", error);
      }
      return { entry: workspaceMutationEntry(destinationPath, moved.info) };
    });
  }

  async deleteEntry(
    workspaceId: string,
    input: {
      readonly path: string;
      readonly expectedRevision: string;
      readonly confirmRecursive: boolean;
    }
  ): Promise<void> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "deleteEntry", [input]);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const canonicalPath = canonicalWorkspaceMutationPath(input.path);
    requireWorkspaceEntryRevision(input.expectedRevision);
    return this.#serializeWorkspaceFileMutation(`${workspace.root}\0*`, async () => {
      const source = await this.#resolveWorkspaceMutationEntry(workspace, canonicalPath);
      assertWorkspaceEntryRevision(source.info, input.expectedRevision);
      if (source.info.isDirectory() && !input.confirmRecursive) {
        throw new WorkspaceEntryMutationError("Recursive workspace deletion requires explicit confirmation.", "unsafe");
      }
      await this.#validateWorkspaceMutationTree(source.absolute);
      const current = await this.#resolveWorkspaceMutationEntry(workspace, canonicalPath);
      assertSameWorkspaceMutationEntry(source, current, input.expectedRevision);
      await this.#validateWorkspaceMutationTree(current.absolute);
      const tombstonePath = resolve(dirname(source.absolute), `.joko-entry-delete-${randomUUID()}.tmp`);
      try {
        await rename(source.absolute, tombstonePath);
      } catch (error) {
        throw new WorkspaceEntryMutationError("The workspace entry could not be claimed for deletion.", "effect_failed", { cause: error });
      }
      try {
        const claimed = await lstat(tombstonePath);
        if (!sameFilesystemIdentity(source.info, claimed)) {
          throw new WorkspaceEntryMutationError("The workspace deletion target changed while it was being claimed.", "stale", { stateMayHaveChanged: true });
        }
        await this.#validateWorkspaceMutationTree(tombstonePath);
        await rm(tombstonePath, { recursive: source.info.isDirectory(), force: false });
      } catch (error) {
        const restored = await rename(tombstonePath, source.absolute).then(() => true).catch(() => false);
        if (!restored) {
          throw workspaceEntryPostEffectError("The failed workspace deletion could not be restored safely.", error);
        }
        if (error instanceof WorkspaceEntryMutationError) throw error;
        throw new WorkspaceEntryMutationError("The workspace entry could not be deleted.", "effect_failed", {
          stateMayHaveChanged: true,
          cause: error
        });
      }
    });
  }

  async copyEntry(
    workspaceId: string,
    input: {
      readonly sourcePath: string;
      readonly destinationPath: string;
      readonly expectedRevision: string;
    }
  ): Promise<WorkspaceEntryMutationResult> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "copyEntry", [input]);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const sourcePath = canonicalWorkspaceMutationPath(input.sourcePath);
    const destinationPath = canonicalWorkspaceMutationPath(input.destinationPath);
    requireWorkspaceEntryRevision(input.expectedRevision);
    if (sourcePath === destinationPath || destinationPath.startsWith(`${sourcePath}/`)) {
      throw new WorkspaceEntryMutationError("The workspace copy destination must be outside its source.", "invalid");
    }
    return this.#serializeWorkspaceFileMutation(`${workspace.root}\0*`, async () => {
      const source = await this.#resolveWorkspaceMutationEntry(workspace, sourcePath);
      assertWorkspaceEntryRevision(source.info, input.expectedRevision);
      const budget = {
        entries: 0,
        bytes: 0,
        maximumEntries: WORKSPACE_ENTRY_MUTATION_MAXIMUM_ENTRIES,
        maximumBytes: WORKSPACE_ENTRY_COPY_MAXIMUM_BYTES
      };
      await this.#validateWorkspaceMutationTree(source.absolute, budget);
      const destination = await this.#resolveWorkspaceMutationDestination(workspace, destinationPath);
      let destinationCreated = false;
      try {
        if (source.info.isDirectory()) {
          await mkdir(destination.absolute, { recursive: false, mode: source.info.mode & 0o777 });
          destinationCreated = true;
          await this.#copyWorkspaceMutationDirectory(source.absolute, destination.absolute, budget);
        } else {
          await this.#copyWorkspaceMutationFile(
            source.absolute,
            destination.absolute,
            source.info,
            () => { destinationCreated = true; }
          );
        }
        const current = await this.#resolveWorkspaceMutationEntry(workspace, sourcePath);
        assertSameWorkspaceMutationEntry(source, current, input.expectedRevision);
      } catch (error) {
        if (destinationCreated) {
          try {
            const currentDestination = await this.#resolveWorkspaceMutationEntry(workspace, destinationPath);
            await this.#assertWorkspaceMutationDestinationStillSafe(workspace, destination, currentDestination.info);
            await this.#validateWorkspaceMutationTree(currentDestination.absolute);
            await rm(currentDestination.absolute, { recursive: true, force: true });
          } catch (cleanupError) {
            throw workspaceEntryPostEffectError("The incomplete workspace copy could not be cleaned up safely.", cleanupError);
          }
        }
        if (error instanceof WorkspaceEntryMutationError) throw error;
        if (filesystemEntryExists(error)) {
          throw new WorkspaceEntryMutationError("The workspace destination already exists.", "conflict");
        }
        throw new WorkspaceEntryMutationError("The workspace entry could not be copied.", "effect_failed", { cause: error });
      }
      let copied: WorkspaceResolvedMutationEntry;
      try {
        copied = await this.#resolveWorkspaceMutationEntry(workspace, destinationPath);
        await this.#assertWorkspaceMutationDestinationStillSafe(workspace, destination, copied.info);
      } catch (error) {
        throw workspaceEntryPostEffectError("The copied workspace entry could not be identity-fenced.", error);
      }
      return { entry: workspaceMutationEntry(destinationPath, copied.info) };
    });
  }

  async search(workspaceId: string, query: string, options?: WorkspaceSearchOptions): Promise<readonly WorkspaceSearchResult[]> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "search", [query, options]);
    }
    return (await this.searchPage(workspaceId, query, options)).matches;
  }

  /**
   * Project search: fixed string only, hidden files included, ignore
   * files honoured, a 200-line per-file cap and a 1000-line global cap.
   * Results are yielded as ripgrep produces them so transport cancellation
   * terminates the owned child process instead of merely hiding late UI data.
   */
  async *searchStream(
    workspaceId: string,
    query: string,
    caseSensitive: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<WorkspaceSearchStreamEvent> {
    if (this.#isRemote(workspaceId)) {
      if (this.#remoteDelegate === undefined) throw new Error("Remote workspace files are unavailable.");
      yield* this.#remoteDelegate.stream<WorkspaceSearchStreamEvent>(workspaceId, "searchStream", [query, caseSensitive, signal]);
      return;
    }
    const workspace = this.requireWorkspace(workspaceId);
    const trimmed = query.trim();
    if (trimmed === "") {
      yield {
        kind: "end",
        truncated: false,
        totalResults: 0,
        totalFiles: 0,
        revision: workspaceSearchResultSetRevision([])
      };
      return;
    }
    const parsedMatches: ParsedWorkspaceSearchResult[] = [];
    const revisions = new Map<string, string>();
    try {
      for await (const event of streamWorkspaceTextSearch({
        executable: this.#ripgrepExecutable,
        cwd: workspace.root,
        query: trimmed,
        caseSensitive,
        ...(signal === undefined ? {} : { signal })
      })) {
        if (event.kind === "end") {
          yield {
            kind: "end",
            truncated: event.truncated,
            totalResults: event.totalMatches,
            totalFiles: event.totalFiles,
            revision: workspaceSearchResultSetRevision(parsedMatches)
          };
          continue;
        }
        if (event.match.data.submatches.length === 0) continue;
        const parsed = workspaceSearchResultFromRipgrep(event.match);
        let revision = revisions.get(parsed.path);
        if (revision === undefined) {
          revision = await this.#workspaceSearchResultRevision(workspace, parsed.path);
          revisions.set(parsed.path, revision);
        }
        parsedMatches.push(parsed);
        yield { kind: "match", match: { ...parsed, revision } };
      }
    } catch (error) {
      if (isAbortError(error)) throw error;
      const failure = workspaceSearchErrorFromUnknown(error);
      yield { kind: "error", code: failure.code, message: failure.message };
    }
  }

  async searchPage(workspaceId: string, query: string, options?: WorkspaceSearchOptions): Promise<WorkspaceSearchPage> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "searchPage", [query, options]);
    }
    if (query.trim() === "") return {
      matches: [],
      totalResults: 0,
      totalFiles: 0,
      truncated: false,
      revision: workspaceSearchResultSetRevision([])
    };
    const workspace = this.requireWorkspace(workspaceId);
    const pageSize = normalizeWorkspaceSearchPageSize(options?.maximumResults);
    const offset = normalizeWorkspaceSearchOffset(options?.offset);
    const scanLimit = offset + pageSize + 1;
    const args = [
      "--json",
      "--line-number",
      "--column",
      "--no-heading",
      "--color", "never",
      "--sort", "path",
      "--max-count", String(scanLimit),
      "--no-require-git"
    ];
    if (options?.caseSensitive !== true) args.push("--ignore-case");
    if (options?.regularExpression !== true) args.push("--fixed-strings");
    if (options?.glob !== undefined) args.push("--glob", options.glob);
    args.push("--", query, ".");
    try {
      const result = await runProcess(this.#ripgrepExecutable, args, workspace.root, 30_000, 16 * 1024 * 1024, new Set([0, 1, 2]));
      if (result.exitCode === 2) {
        throw new WorkspaceSearchError(
          options?.regularExpression === true
            ? "Workspace search regular expression is invalid."
            : "Workspace search request was rejected by the search provider.",
          options?.regularExpression === true ? "invalid" : "search_failed"
        );
      }
      const parsedMatches: ParsedWorkspaceSearchResult[] = [];
      for (const line of result.stdout.split("\n")) {
        if (line === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new WorkspaceSearchError("Workspace search returned malformed ripgrep JSON.", "search_failed");
        }
        if (!isWorkspaceRipgrepMatch(parsed)) continue;
        if (parsed.data.submatches.length === 0) continue;
        parsedMatches.push(workspaceSearchResultFromRipgrep(parsed));
      }
      parsedMatches.sort(compareWorkspaceSearchResults);
      const selected = parsedMatches.slice(offset, offset + pageSize);
      const matches: WorkspaceSearchResult[] = [];
      const revisions = new Map<string, string>();
      for (const match of selected) {
        let revision = revisions.get(match.path);
        if (revision === undefined) {
          try {
            revision = await this.#workspaceSearchResultRevision(workspace, match.path);
          } catch {
            throw new WorkspaceSearchError(`Workspace search result changed before it could be revision-fenced: ${match.path}`, "result_changed");
          }
          revisions.set(match.path, revision);
        }
        matches.push({ ...match, revision });
      }
      const truncated = parsedMatches.length > offset + matches.length;
      return {
        matches,
        totalResults: parsedMatches.length,
        totalFiles: new Set(parsedMatches.map((match) => match.path)).size,
        truncated,
        revision: workspaceSearchResultSetRevision(parsedMatches),
        ...(truncated ? { nextOffset: offset + matches.length } : {})
      };
    } catch (error) {
      throw workspaceSearchErrorFromUnknown(error);
    }
  }

  async gitState(workspaceId: string): Promise<GitState> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "gitState", []);
    }
    const workspace = this.requireWorkspace(workspaceId);
    const probe = await runProcess(this.#gitExecutable, ["rev-parse", "--show-toplevel"], workspace.root, 10_000, 1024 * 1024, new Set([0, 128]));
    if (probe.exitCode !== 0) return {
      repository: false,
      detachedHead: false,
      operationInProgress: false,
      unmerged: false,
      dirty: false,
      changes: []
    };
    const topLevel = await realpath(probe.stdout.trim());
    if (!isWithin(topLevel, workspace.root)) throw new Error("Detected Git repository extends outside the workspace boundary.");
    const result = await runProcess(this.#gitExecutable, ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], workspace.root, 20_000, 16 * 1024 * 1024);
    const records = result.stdout.split("\0").filter(Boolean);
    const changes: { path: string; index: string; worktree: string; originalPath?: string }[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.startsWith("## ")) {
        continue;
      }
      if (record.length < 4) continue;
      const unmerged = isUnmergedGitStatus(record.slice(0, 2));
      const change = {
        path: record.slice(3),
        index: unmerged ? "U" : record[0]!,
        worktree: unmerged ? "U" : record[1]!
      };
      if (record[0] === "R" || record[0] === "C") {
        const originalPath = records[++index];
        changes.push(originalPath === undefined ? change : { ...change, originalPath });
      } else {
        changes.push(change);
      }
    }
    const writeState = await this.#readGitReviewWriteState(workspace);
    return {
      repository: true,
      ...(writeState.branch === undefined ? {} : { branch: writeState.branch }),
      ...(writeState.head === undefined ? {} : { head: writeState.head }),
      detachedHead: writeState.detachedHead,
      operationInProgress: writeState.operationInProgress,
      unmerged: writeState.unmerged,
      dirty: changes.length > 0,
      changes
    };
  }

  async gitDiff(
    workspaceId: string,
    paths: readonly string[] = [],
    options: { readonly baseRevision?: string; readonly headRevision?: string; readonly ignoreWhitespace?: boolean } = {}
  ): Promise<WorkspaceGitDiff> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "gitDiff", [paths, options]);
    }
    await this.#gitMutationTail;
    return this.#readGitDiff(workspaceId, paths, options);
  }

  async gitReviewDiff(
    workspaceId: string,
    input: WorkspaceGitReviewDiffInput
  ): Promise<WorkspaceGitDiff> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "gitReviewDiff", [input]);
    }
    await this.#gitMutationTail;
    const current = await this.#readGitReviewDiff(workspaceId, input);
    this.#assertReviewFence(current, input.expectedRepositoryRevision, input.expectedMergeBaseRevision, false);
    return current;
  }

  async readGitDiffFile(
    workspaceId: string,
    input: {
      readonly path: string;
      readonly source: WorkspaceGitDiffSource;
      readonly expectedRepositoryRevision: string;
      readonly headRevision?: string;
      readonly maximumBytes?: number;
    }
  ): Promise<{ readonly text: string; readonly truncated: boolean; readonly repositoryRevision: string }> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "readGitDiffFile", [input]);
    }
    await this.#gitMutationTail;
    const workspace = this.requireWorkspace(workspaceId);
    await this.#requireGitRoot(workspace);
    await this.resolveSafe(workspace, input.path, false, true);
    const maximumBytes = Math.max(1, Math.min(input.maximumBytes ?? 1_048_576, 2 * 1024 * 1024));
    let repositoryRevision = input.expectedRepositoryRevision;
    let text: string;
    if (input.source === "comparison") {
      const oid = input.headRevision?.trim() ?? "";
      if (!/^[0-9a-f]{40,64}$/iu.test(oid)) {
        throw new WorkspaceGitReviewError("Comparison preview requires the resolved immutable head revision.", "invalid");
      }
      const result = await runProcessPrefix(
        this.#gitExecutable,
        ["show", `--format=`, `${oid}:${input.path}`],
        workspace.root,
        20_000,
        maximumBytes + 1
      );
      text = result.stdout;
    } else {
      const current = await this.#readGitDiff(workspaceId, [], {});
      repositoryRevision = current.repositoryRevision;
      if (input.expectedRepositoryRevision === "" || input.expectedRepositoryRevision !== repositoryRevision) {
        throw new WorkspaceGitReviewError("Workspace diff is stale; refresh Review and retry.", "stale");
      }
      if (input.source === "index") {
        const result = await runProcessPrefix(
          this.#gitExecutable,
          ["show", `:${input.path}`],
          workspace.root,
          20_000,
          maximumBytes + 1
        );
        text = result.stdout;
      } else {
        const preview = await this.preview(workspaceId, input.path, maximumBytes + 1);
        if (preview.text === undefined) throw new WorkspaceGitReviewError("The selected diff is not a text file.", "unsupported");
        text = preview.text;
      }
    }
    if (text.includes("\0")) throw new WorkspaceGitReviewError("The selected diff is not a text file.", "unsupported");
    const bytes = Buffer.from(text, "utf8");
    const truncated = bytes.byteLength > maximumBytes;
    return {
      text: truncated ? bytes.subarray(0, maximumBytes).toString("utf8") : text,
      truncated,
      repositoryRevision
    };
  }

  async readGitReviewFile(
    workspaceId: string,
    input: {
      readonly path: string;
      readonly source: WorkspaceGitReviewSource;
      readonly expectedRepositoryRevision: string;
      readonly sourceRevision?: string;
      readonly expectedMergeBaseRevision?: string;
      readonly maximumBytes?: number;
    }
  ): Promise<{ readonly text: string; readonly truncated: boolean; readonly repositoryRevision: string; readonly mergeBaseRevision?: string }> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "readGitReviewFile", [input]);
    }
    await this.#gitMutationTail;
    const workspace = this.requireWorkspace(workspaceId);
    await this.#requireGitRoot(workspace);
    const path = canonicalGitRelativePath(input.path);
    const maximumBytes = Math.max(1, Math.min(input.maximumBytes ?? 1_048_576, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES));
    if ((input.source === "commit" || input.source === "branch") && !isImmutableGitObjectId(input.sourceRevision ?? "")) {
      throw new WorkspaceGitReviewError("An immutable Review source revision is required.", "invalid");
    }
    const reviewInput: WorkspaceGitReviewDiffInput = {
      source: input.source,
      ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision })
    };
    const before = await this.#readGitReviewDiff(workspaceId, reviewInput);
    this.#assertReviewFence(before, input.expectedRepositoryRevision, input.expectedMergeBaseRevision, true);

    let bytes: Buffer;
    if (input.source === "unstaged") {
      bytes = await this.#readWorktreeFilePrefix(workspace, path, maximumBytes + 1);
    } else if (input.source === "staged") {
      const oid = await this.#readIndexBlobOid(workspace, path);
      if (oid === undefined) throw new WorkspaceGitReviewError("The selected Review file is unavailable.", "unsupported");
      bytes = await this.#readGitBlobPrefix(workspace, oid, maximumBytes + 1);
    } else {
      const treeish = input.source === "commit" ? before.headRevision : before.headRevision;
      if (treeish === undefined) throw new WorkspaceGitReviewError("The selected Review file is unavailable.", "unsupported");
      const oid = await this.#readTreeBlobOid(workspace, treeish, path);
      if (oid === undefined) throw new WorkspaceGitReviewError("The selected Review file is unavailable.", "unsupported");
      bytes = await this.#readGitBlobPrefix(workspace, oid, maximumBytes + 1);
    }
    if (bytes.includes(0)) throw new WorkspaceGitReviewError("The selected diff is not a text file.", "unsupported");
    const truncated = bytes.byteLength > maximumBytes;
    const visible = truncated ? safeUtf8Prefix(bytes, maximumBytes) : bytes;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(visible);
    } catch {
      throw new WorkspaceGitReviewError("The selected diff is not valid UTF-8 text.", "unsupported");
    }
    const after = await this.#readGitReviewDiff(workspaceId, reviewInput);
    this.#assertSameReviewFence(before, after);
    return {
      text,
      truncated,
      repositoryRevision: after.repositoryRevision,
      ...(after.mergeBaseRevision === undefined ? {} : { mergeBaseRevision: after.mergeBaseRevision })
    };
  }

  async readGitDiffImage(
    workspaceId: string,
    input: {
      readonly path: string;
      readonly oldPath?: string;
      readonly source: WorkspaceGitReviewSource;
      readonly expectedRepositoryRevision: string;
      readonly sourceRevision?: string;
      readonly expectedMergeBaseRevision?: string;
    }
  ): Promise<WorkspaceGitImagePreview> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "readGitDiffImage", [input]);
    }
    await this.#gitMutationTail;
    const workspace = this.requireWorkspace(workspaceId);
    await this.#requireGitRoot(workspace);
    const path = canonicalGitRelativePath(input.path);
    const oldPath = input.oldPath === undefined || input.oldPath === "" ? path : canonicalGitRelativePath(input.oldPath);
    if (imageMediaType(path) === undefined && imageMediaType(oldPath) === undefined) {
      throw new WorkspaceGitReviewError("Only approved raster image formats can be previewed.", "unsupported");
    }
    if ((input.source === "commit" || input.source === "branch") && !isImmutableGitObjectId(input.sourceRevision ?? "")) {
      throw new WorkspaceGitReviewError("An immutable Review source revision is required.", "invalid");
    }
    const reviewInput: WorkspaceGitReviewDiffInput = {
      source: input.source,
      ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision })
    };
    const before = await this.#readGitReviewDiff(workspaceId, reviewInput);
    this.#assertReviewFence(before, input.expectedRepositoryRevision, input.expectedMergeBaseRevision, true);

    let oldImage: WorkspaceGitImageSide;
    let newImage: WorkspaceGitImageSide;
    if (input.source === "unstaged") {
      oldImage = await this.#readIndexImageSide(workspace, oldPath);
      newImage = await this.#readWorktreeImageSide(workspace, path);
    } else if (input.source === "staged") {
      oldImage = before.headRevision === undefined
        ? missingImageSide(oldPath)
        : await this.#readTreeImageSide(workspace, before.headRevision, oldPath);
      newImage = await this.#readIndexImageSide(workspace, path);
    } else if (input.source === "commit") {
      oldImage = before.baseRevision === undefined
        ? missingImageSide(oldPath)
        : await this.#readTreeImageSide(workspace, before.baseRevision, oldPath);
      newImage = before.headRevision === undefined
        ? missingImageSide(path)
        : await this.#readTreeImageSide(workspace, before.headRevision, path);
    } else {
      oldImage = before.mergeBaseRevision === undefined
        ? missingImageSide(oldPath)
        : await this.#readTreeImageSide(workspace, before.mergeBaseRevision, oldPath);
      newImage = before.headRevision === undefined
        ? missingImageSide(path)
        : await this.#readTreeImageSide(workspace, before.headRevision, path);
    }
    const after = await this.#readGitReviewDiff(workspaceId, reviewInput);
    this.#assertSameReviewFence(before, after);
    return {
      oldImage,
      newImage,
      repositoryRevision: after.repositoryRevision,
      ...(after.mergeBaseRevision === undefined ? {} : { mergeBaseRevision: after.mergeBaseRevision })
    };
  }

  async applyGitDiffHunk(workspaceId: string, input: WorkspaceGitHunkMutation): Promise<string> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "applyGitDiffHunk", [input]);
    }
    return this.applyGitDiff(workspaceId, {
      action: input.action,
      source: normalizeMutableGitSource(input.source),
      target: "hunk",
      path: input.path,
      ...(input.oldPath === undefined ? {} : { oldPath: input.oldPath }),
      hunkIndex: input.hunkIndex,
      expectedRepositoryRevision: input.expectedRepositoryRevision,
      ignoreWhitespace: input.ignoreWhitespace,
      confirmRevert: input.confirmRevert
    });
  }

  async applyGitDiff(workspaceId: string, input: WorkspaceGitMutation): Promise<string> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "applyGitDiff", [input]);
    }
    return this.#serializeGitMutation(async () => {
      const workspace = this.requireWorkspace(workspaceId);
      await this.#requireGitRoot(workspace);
      await this.#assertGitReviewWriteAllowed(workspace);
      if (input.target === "hunk" && (!Number.isSafeInteger(input.hunkIndex) || (input.hunkIndex ?? -1) < 0)) {
        throw new WorkspaceGitReviewError("A non-negative hunk index is required.", "invalid");
      }
      if (input.expectedRepositoryRevision.trim() === "") {
        throw new WorkspaceGitReviewError("A repository revision fence is required.", "invalid");
      }
      if (input.action === "revert" && input.confirmRevert !== true) {
        throw new WorkspaceGitReviewError("Reverting Review content requires explicit confirmation.", "invalid");
      }
      const requiredSource: WorkspaceGitMutableSource = input.action === "unstage" ? "staged" : "unstaged";
      if (input.source !== requiredSource) {
        throw new WorkspaceGitReviewError(`${input.action} cannot be applied to a ${input.source} diff.`, "invalid");
      }
      const path = canonicalGitRelativePath(input.path);
      const oldPath = input.oldPath === undefined || input.oldPath === "" ? undefined : canonicalGitRelativePath(input.oldPath);
      const current = await this.#readGitDiff(workspaceId, [], {});
      if (current.repositoryRevision !== input.expectedRepositoryRevision) {
        throw new WorkspaceGitReviewError("Workspace diff is stale; refresh Review and retry.", "stale");
      }
      const layer = input.source === "staged" ? "index" : "workingTree";
      const raw = await this.#readLayerDiff(workspace, layer, uniquePaths(oldPath, path), input.ignoreWhitespace === true);
      if (raw === "" && input.target === "file") {
        await this.#applyUntrackedFileMutation(workspace, input.action, path);
        return (await this.#readGitDiff(workspaceId, [], {})).repositoryRevision;
      }
      const filePatch = selectDiffFilePatch(raw);
      const patch = input.target === "hunk" ? selectDiffHunkPatch(filePatch, input.hunkIndex ?? -1) : filePatch;
      const applyArgs = ["apply", "--whitespace=nowarn"];
      if (input.action !== "revert") applyArgs.push("--cached");
      if (input.action === "unstage" || input.action === "revert") applyArgs.push("--reverse");
      if (input.ignoreWhitespace === true) applyArgs.push("--ignore-space-change");
      try {
        // `git apply` validates the complete patch before updating either the
        // index or worktree; it does not partially apply without `--reject`.
        await runProcess(this.#gitExecutable, [...applyArgs, "-"], workspace.root, 20_000, 4 * 1024 * 1024, new Set([0]), patch);
      } catch (error) {
        throw new WorkspaceGitReviewError("Git could not apply the confirmed Review change.", "apply_failed");
      }
      return (await this.#readGitDiff(workspaceId, [], {})).repositoryRevision;
    });
  }

  async commitGitReview(
    workspaceId: string,
    input: { readonly message: string; readonly expectedRepositoryRevision: string; readonly includeUnstaged?: boolean }
  ): Promise<WorkspaceGitCommitResult> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "commitGitReview", [input]);
    }
    return this.#serializeGitMutation(async () => {
      const workspace = this.requireWorkspace(workspaceId);
      await this.#requireGitRoot(workspace);
      await this.#assertGitReviewWriteAllowed(workspace);
      const message = validateGitCommitMessage(input.message);
      if (input.expectedRepositoryRevision.trim() === "") {
        throw new WorkspaceGitReviewError("A repository revision fence is required.", "invalid");
      }
      const before = await this.#readGitDiff(workspaceId, [], {});
      if (before.repositoryRevision !== input.expectedRepositoryRevision) {
        throw new WorkspaceGitReviewError("Workspace diff is stale; refresh Review and retry.", "stale");
      }
      if (input.includeUnstaged === true) {
        try {
          await runProcess(this.#gitExecutable, ["add", "-A", "--", ":/"], workspace.root, 120_000, 4 * 1024 * 1024);
        } catch {
          throw new WorkspaceGitReviewError("Git could not stage the confirmed workspace changes.", "apply_failed");
        }
      } else if (before.index === "") {
        throw new WorkspaceGitReviewError("There are no staged changes to commit.", "invalid");
      }
      try {
        await runProcess(this.#gitExecutable, ["commit", "-F", "-"], workspace.root, 120_000, 4 * 1024 * 1024, new Set([0]), message);
      } catch {
        throw new WorkspaceGitReviewError("Git commit failed.", "apply_failed");
      }
      const headRevision = await this.#requireHeadRevision(workspace);
      const after = await this.#readGitDiff(workspaceId, [], {});
      return {
        previousRepositoryRevision: before.repositoryRevision,
        repositoryRevision: after.repositoryRevision,
        headRevision
      };
    });
  }

  async pushGitReview(
    workspaceId: string,
    input: {
      readonly remote: string;
      readonly remoteRef: string;
      readonly expectedRepositoryRevision: string;
      readonly expectedHeadRevision: string;
      readonly confirmForceWithLease?: boolean;
      readonly expectedRemoteOid?: string;
    }
  ): Promise<WorkspaceGitPushResult> {
    if (this.#isRemote(workspaceId)) {
      return this.#remoteInvoke(workspaceId, "pushGitReview", [input]);
    }
    return this.#serializeGitMutation(async () => {
      const workspace = this.requireWorkspace(workspaceId);
      await this.#requireGitRoot(workspace);
      await this.#assertGitReviewWriteAllowed(workspace);
      const remote = validateGitRemoteName(input.remote);
      const remoteRef = await this.#validateGitRemoteRef(workspace, input.remoteRef);
      if (input.expectedRepositoryRevision.trim() === "" || !isImmutableGitObjectId(input.expectedHeadRevision)) {
        throw new WorkspaceGitReviewError("Repository and HEAD revision fences are required.", "invalid");
      }
      const before = await this.#readGitDiff(workspaceId, [], {});
      const headRevision = await this.#requireHeadRevision(workspace);
      await this.#requireCurrentBranch(workspace);
      if (before.repositoryRevision !== input.expectedRepositoryRevision || headRevision !== input.expectedHeadRevision) {
        throw new WorkspaceGitReviewError("Workspace branch is stale; refresh Review and retry.", "stale");
      }
      await this.#assertPushRemoteIsCredentialSafe(workspace, remote);
      if (input.confirmForceWithLease === true) {
        const expectedRemoteOid = input.expectedRemoteOid?.trim() ?? "";
        if (!isImmutableGitObjectId(expectedRemoteOid)) {
          throw new WorkspaceGitReviewError("An immutable remote lease revision is required.", "invalid");
        }
        const remoteOid = await this.#readRemoteRefOid(workspace, remote, remoteRef);
        if (remoteOid !== expectedRemoteOid) {
          throw new WorkspaceGitReviewError("The remote branch changed after confirmation; refresh and retry.", "lease_expired");
        }
        const counts = await this.#readRemoteAheadBehind(workspace, remote, remoteRef, headRevision, remoteOid);
        if (counts.ahead === 0) {
          throw new WorkspaceGitReviewError("The local branch has no new commits to push.", "invalid");
        }
        const forced = await runProcess(
          this.#gitExecutable,
          [
            "push",
            "--porcelain",
            `--force-with-lease=${remoteRef}:${expectedRemoteOid}`,
            remote,
            `HEAD:${remoteRef}`
          ],
          workspace.root,
          120_000,
          4 * 1024 * 1024,
          new Set([0, 1, 128])
        );
        if (forced.exitCode !== 0) {
          if (isForceLeaseRejection(forced)) {
            throw new WorkspaceGitReviewError("The remote branch changed after confirmation; refresh and retry.", "lease_expired");
          }
          throw new WorkspaceGitReviewError("Git push failed.", "apply_failed");
        }
      } else {
        if ((input.expectedRemoteOid ?? "").trim() !== "") {
          throw new WorkspaceGitReviewError("A remote lease revision is only valid with force-with-lease confirmation.", "invalid");
        }
        const pushed = await runProcess(
          this.#gitExecutable,
          ["push", "--porcelain", remote, `HEAD:${remoteRef}`],
          workspace.root,
          120_000,
          4 * 1024 * 1024,
          new Set([0, 1, 128])
        );
        if (pushed.exitCode !== 0) {
          if (!isNonFastForwardRejection(pushed)) {
            throw new WorkspaceGitReviewError("Git push failed.", "apply_failed");
          }
          const remoteOid = await this.#readRemoteRefOid(workspace, remote, remoteRef);
          const counts = await this.#readRemoteAheadBehind(workspace, remote, remoteRef, headRevision, remoteOid);
          if (counts.ahead === 0) {
            throw new WorkspaceGitReviewError("The local branch has no new commits to push.", "invalid");
          }
          return {
            kind: "needs_force",
            repositoryRevision: before.repositoryRevision,
            headRevision,
            remote,
            remoteRef,
            remoteOid,
            ahead: counts.ahead,
            behind: Math.max(counts.behind, 1)
          };
        }
      }
      const after = await this.#readGitDiff(workspaceId, [], {});
      const afterHead = await this.#requireHeadRevision(workspace);
      return { kind: "pushed", repositoryRevision: after.repositoryRevision, headRevision: afterHead, remote, remoteRef };
    });
  }

  async #readGitReviewDiff(
    workspaceId: string,
    input: WorkspaceGitReviewDiffInput
  ): Promise<WorkspaceGitDiff> {
    const workspace = this.requireWorkspace(workspaceId);
    await this.#requireGitRoot(workspace);
    const paths = (input.paths ?? []).map(canonicalGitRelativePath);
    if (input.source === "staged" || input.source === "unstaged") {
      if ((input.sourceRevision ?? "").trim() !== "") {
        throw new WorkspaceGitReviewError("Mutable Review sources do not accept a source revision.", "invalid");
      }
      const layers = await this.#readGitDiff(workspaceId, paths, { ignoreWhitespace: input.ignoreWhitespace });
      return {
        index: input.source === "staged" ? layers.index : "",
        workingTree: input.source === "unstaged" ? layers.workingTree : "",
        comparison: "",
        repositoryRevision: layers.repositoryRevision,
        ...(layers.headRevision === undefined ? {} : { headRevision: layers.headRevision }),
        source: input.source
      };
    }

    const selected = input.sourceRevision?.trim() ?? "";
    if (input.source === "commit") {
      if (selected === "") throw new WorkspaceGitReviewError("A commit Review source revision is required.", "invalid");
      const commitOid = await this.#resolveGitCommit(workspace, selected, "source");
      const parentOid = await this.#readCommitFirstParent(workspace, commitOid);
      const comparison = await this.#readCommitDiff(
        workspace,
        parentOid,
        commitOid,
        paths,
        input.ignoreWhitespace === true
      );
      const fenceComparison = paths.length === 0
        ? comparison
        : await this.#readCommitDiff(workspace, parentOid, commitOid, [], input.ignoreWhitespace === true);
      return {
        index: "",
        workingTree: "",
        comparison,
        repositoryRevision: createHash("sha256")
          .update(`commit\0${parentOid ?? "empty"}\0${commitOid}\0${fenceComparison}`)
          .digest("hex"),
        ...(parentOid === undefined ? {} : { baseRevision: parentOid }),
        headRevision: commitOid,
        ...(parentOid === undefined ? {} : { mergeBaseRevision: parentOid }),
        source: "commit",
        sourceRevision: commitOid
      };
    }

    const base = selected === ""
      ? await this.#resolveDefaultBranchBase(workspace)
      : await this.#resolveBranchBaseOrDefault(workspace, selected);
    const baseOid = base.oid;
    const headOid = await this.#requireHeadRevision(workspace);
    const mergeBaseOid = await this.#readMergeBase(workspace, baseOid, headOid);
    const comparison = await this.#readComparisonDiff(workspace, mergeBaseOid, headOid, paths, input.ignoreWhitespace === true);
    const fenceComparison = paths.length === 0
      ? comparison
      : await this.#readComparisonDiff(workspace, mergeBaseOid, headOid, [], input.ignoreWhitespace === true);
    return {
      index: "",
      workingTree: "",
      comparison,
      repositoryRevision: createHash("sha256")
        .update(`branch\0${baseOid}\0${headOid}\0${mergeBaseOid}\0${fenceComparison}`)
        .digest("hex"),
      baseRevision: baseOid,
      headRevision: headOid,
      mergeBaseRevision: mergeBaseOid,
      source: "branch",
      sourceRevision: baseOid,
      ...(selected === "" ? {} : { requestedBaseRef: selected }),
      resolvedBaseRef: base.ref,
      ...(base.warning === undefined ? {} : { branchBaseWarning: base.warning })
    };
  }

  #assertReviewFence(
    current: WorkspaceGitDiff,
    expectedRepositoryRevision: string | undefined,
    expectedMergeBaseRevision: string | undefined,
    required: boolean
  ): void {
    const repositoryFence = expectedRepositoryRevision?.trim() ?? "";
    if (required && repositoryFence === "") {
      throw new WorkspaceGitReviewError("A repository revision fence is required.", "invalid");
    }
    if (repositoryFence !== "" && repositoryFence !== current.repositoryRevision) {
      throw new WorkspaceGitReviewError("Workspace diff is stale; refresh Review and retry.", "stale");
    }
    const mergeBaseFence = expectedMergeBaseRevision?.trim() ?? "";
    if (current.source === "branch" && repositoryFence !== "") {
      if (mergeBaseFence === "") {
        throw new WorkspaceGitReviewError("A branch merge-base revision fence is required.", "invalid");
      }
      if (mergeBaseFence !== current.mergeBaseRevision) {
        throw new WorkspaceGitReviewError("Workspace branch comparison is stale; refresh Review and retry.", "stale");
      }
    } else if (mergeBaseFence !== "" && mergeBaseFence !== current.mergeBaseRevision) {
      throw new WorkspaceGitReviewError("Workspace comparison is stale; refresh Review and retry.", "stale");
    }
  }

  #assertSameReviewFence(before: WorkspaceGitDiff, after: WorkspaceGitDiff): void {
    if (
      before.repositoryRevision !== after.repositoryRevision ||
      before.mergeBaseRevision !== after.mergeBaseRevision ||
      before.headRevision !== after.headRevision ||
      before.sourceRevision !== after.sourceRevision
    ) {
      throw new WorkspaceGitReviewError("Workspace diff changed while it was being read.", "stale");
    }
  }

  async #readComparisonDiff(
    workspace: WorkspaceRegistration,
    baseOid: string,
    headOid: string,
    paths: readonly string[],
    ignoreWhitespace: boolean
  ): Promise<string> {
    return (await runProcess(
      this.#gitExecutable,
      [
        "diff",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        "--no-ext-diff",
        "--no-color",
        "--binary",
        "--find-renames",
        baseOid,
        headOid,
        "--",
        ...paths.map(literalGitPathspec)
      ],
      workspace.root,
      30_000,
      32 * 1024 * 1024
    )).stdout;
  }

  async #readCommitDiff(
    workspace: WorkspaceRegistration,
    parentOid: string | undefined,
    commitOid: string,
    paths: readonly string[],
    ignoreWhitespace: boolean
  ): Promise<string> {
    if (parentOid !== undefined) {
      return this.#readComparisonDiff(workspace, parentOid, commitOid, paths, ignoreWhitespace);
    }
    return (await runProcess(
      this.#gitExecutable,
      [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "-p",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        "--no-ext-diff",
        "--no-color",
        "--binary",
        "--find-renames",
        commitOid,
        "--",
        ...paths.map(literalGitPathspec)
      ],
      workspace.root,
      30_000,
      32 * 1024 * 1024
    )).stdout;
  }

  async #readCommitFirstParent(workspace: WorkspaceRegistration, commitOid: string): Promise<string | undefined> {
    const parents = await runProcess(
      this.#gitExecutable,
      ["rev-list", "--parents", "-n", "1", commitOid],
      workspace.root,
      10_000,
      1024 * 1024
    );
    const values = parents.stdout.trim().split(/\s+/u).filter(Boolean);
    const parent = values[1];
    if (parent === undefined) return undefined;
    if (!isImmutableGitObjectId(parent)) throw new WorkspaceGitReviewError("The selected commit parent is invalid.", "unsupported");
    return parent;
  }

  async #readMergeBase(workspace: WorkspaceRegistration, baseOid: string, headOid: string): Promise<string> {
    const result = await runProcess(
      this.#gitExecutable,
      ["merge-base", baseOid, headOid],
      workspace.root,
      10_000,
      1024 * 1024,
      new Set([0, 1])
    );
    const mergeBase = result.stdout.trim();
    if (result.exitCode !== 0 || !isImmutableGitObjectId(mergeBase)) {
      throw new WorkspaceGitReviewError("The selected branch has no valid merge base.", "invalid");
    }
    return mergeBase;
  }

  async #requireHeadRevision(workspace: WorkspaceRegistration): Promise<string> {
    const result = await runProcess(
      this.#gitExecutable,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      workspace.root,
      10_000,
      1024 * 1024,
      new Set([0, 128])
    );
    const oid = result.stdout.trim();
    if (result.exitCode !== 0 || !isImmutableGitObjectId(oid)) {
      throw new WorkspaceGitReviewError("The workspace has no current commit.", "unsupported");
    }
    return oid;
  }

  async #requireCurrentBranch(workspace: WorkspaceRegistration): Promise<string> {
    const result = await runProcess(
      this.#gitExecutable,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      workspace.root,
      10_000,
      1024 * 1024,
      new Set([0, 1, 128])
    );
    const branch = result.stdout.trim();
    if (result.exitCode !== 0 || branch === "") {
      throw new WorkspaceGitReviewError("Review push requires a current local branch.", "unsupported");
    }
    return branch;
  }

  async #readIndexBlobOid(workspace: WorkspaceRegistration, path: string): Promise<string | undefined> {
    const result = await runProcess(
      this.#gitExecutable,
      ["ls-files", "--stage", "-z", "--", literalGitPathspec(path)],
      workspace.root,
      10_000,
      2 * 1024 * 1024
    );
    const records = result.stdout.split("\0").filter(Boolean);
    if (records.length === 0) return undefined;
    if (records.length !== 1) throw new WorkspaceGitReviewError("Conflicted index entries cannot be previewed.", "unsupported");
    const tab = records[0]!.indexOf("\t");
    const fields = records[0]!.slice(0, tab).trim().split(/\s+/u);
    const listedPath = tab < 0 ? "" : records[0]!.slice(tab + 1);
    if (fields.length !== 3 || fields[2] !== "0" || !isRegularGitMode(fields[0] ?? "") || listedPath !== path) {
      throw new WorkspaceGitReviewError("The selected index entry is not a regular file.", "unsupported");
    }
    const oid = fields[1] ?? "";
    if (!isImmutableGitObjectId(oid)) throw new WorkspaceGitReviewError("The selected index object is invalid.", "unsupported");
    return oid;
  }

  async #readTreeBlobOid(workspace: WorkspaceRegistration, treeish: string, path: string): Promise<string | undefined> {
    if (!isImmutableGitObjectId(treeish)) throw new WorkspaceGitReviewError("An immutable tree revision is required.", "invalid");
    const result = await runProcess(
      this.#gitExecutable,
      ["ls-tree", "-z", treeish, "--", literalGitPathspec(path)],
      workspace.root,
      10_000,
      2 * 1024 * 1024
    );
    const records = result.stdout.split("\0").filter(Boolean);
    if (records.length === 0) return undefined;
    if (records.length !== 1) throw new WorkspaceGitReviewError("The selected tree entry is ambiguous.", "unsupported");
    const tab = records[0]!.indexOf("\t");
    const fields = records[0]!.slice(0, tab).trim().split(/\s+/u);
    const listedPath = tab < 0 ? "" : records[0]!.slice(tab + 1);
    if (fields.length !== 3 || fields[1] !== "blob" || !isRegularGitMode(fields[0] ?? "") || listedPath !== path) {
      throw new WorkspaceGitReviewError("The selected tree entry is not a regular file.", "unsupported");
    }
    const oid = fields[2] ?? "";
    if (!isImmutableGitObjectId(oid)) throw new WorkspaceGitReviewError("The selected tree object is invalid.", "unsupported");
    return oid;
  }

  async #readGitBlobPrefix(workspace: WorkspaceRegistration, oid: string, maximumBytes: number): Promise<Buffer> {
    if (!isImmutableGitObjectId(oid)) throw new WorkspaceGitReviewError("The selected Git object is invalid.", "invalid");
    return (await runProcessBufferPrefix(
      this.#gitExecutable,
      ["cat-file", "blob", "--end-of-options", oid],
      workspace.root,
      20_000,
      maximumBytes
    )).stdout;
  }

  async #readGitImageBlob(workspace: WorkspaceRegistration, oid: string, path: string): Promise<WorkspaceGitImageSide> {
    const mediaType = imageMediaType(path);
    if (mediaType === undefined) return missingImageSide(path);
    const sizeResult = await runProcess(
      this.#gitExecutable,
      ["cat-file", "-s", "--end-of-options", oid],
      workspace.root,
      10_000,
      1024 * 1024
    );
    const size = Number(sizeResult.stdout.trim());
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new WorkspaceGitReviewError("The selected image object has an invalid size.", "unsupported");
    }
    if (size > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES) {
      return { present: true, tooLarge: true, path, mediaType };
    }
    const bytes = await this.#readGitBlobPrefix(workspace, oid, WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES + 1);
    if (bytes.byteLength > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES) {
      return { present: true, tooLarge: true, path, mediaType };
    }
    return { present: true, tooLarge: false, path, mediaType, bytes };
  }

  async #readIndexImageSide(workspace: WorkspaceRegistration, path: string): Promise<WorkspaceGitImageSide> {
    const mediaType = imageMediaType(path);
    if (mediaType === undefined) return missingImageSide(path);
    const oid = await this.#readIndexBlobOid(workspace, path);
    return oid === undefined ? missingImageSide(path, mediaType) : this.#readGitImageBlob(workspace, oid, path);
  }

  async #readTreeImageSide(workspace: WorkspaceRegistration, treeish: string, path: string): Promise<WorkspaceGitImageSide> {
    const mediaType = imageMediaType(path);
    if (mediaType === undefined) return missingImageSide(path);
    const oid = await this.#readTreeBlobOid(workspace, treeish, path);
    return oid === undefined ? missingImageSide(path, mediaType) : this.#readGitImageBlob(workspace, oid, path);
  }

  async #readWorktreeImageSide(workspace: WorkspaceRegistration, path: string): Promise<WorkspaceGitImageSide> {
    const mediaType = imageMediaType(path);
    if (mediaType === undefined) return missingImageSide(path);
    const resolved = await this.#resolveGitRegularFile(workspace, path, true);
    if (resolved === undefined) return missingImageSide(path, mediaType);
    if (resolved.info.size > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES) {
      return { present: true, tooLarge: true, path, mediaType };
    }
    const bytes = await this.#readWorktreeFilePrefix(workspace, path, WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES + 1);
    if (bytes.byteLength > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES) {
      return { present: true, tooLarge: true, path, mediaType };
    }
    return { present: true, tooLarge: false, path, mediaType, bytes };
  }

  async #readWorktreeFilePrefix(workspace: WorkspaceRegistration, path: string, maximumBytes: number): Promise<Buffer> {
    const resolved = await this.#resolveGitRegularFile(workspace, path, false);
    if (resolved === undefined) throw new WorkspaceGitReviewError("The selected workspace file is unavailable.", "unsupported");
    const handle = await open(resolved.absolute, "r");
    try {
      const before = await handle.stat();
      if (!sameFileState(before, resolved.info)) {
        throw new WorkspaceGitReviewError("Workspace file changed while it was being read.", "stale");
      }
      const bytes = await readFileHandlePrefix(handle, Math.min(maximumBytes, before.size + 1));
      const after = await handle.stat();
      if (!sameFileState(before, after)) {
        throw new WorkspaceGitReviewError("Workspace file changed while it was being read.", "stale");
      }
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async #resolveGitRegularFile(
    workspace: WorkspaceRegistration,
    path: string,
    allowMissing: boolean
  ): Promise<{ readonly absolute: string; readonly info: Stats } | undefined> {
    const canonical = canonicalGitRelativePath(path);
    const absolute = resolve(workspace.root, ...canonical.split("/"));
    let current = workspace.root;
    let targetInfo: Stats | undefined;
    try {
      const parts = canonical.split("/");
      for (let index = 0; index < parts.length; index += 1) {
        current = resolve(current, parts[index]!);
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new WorkspaceGitReviewError("Workspace symbolic links are not supported by Review file actions.", "unsupported");
        }
        if (index < parts.length - 1 && !info.isDirectory()) {
          throw new WorkspaceGitReviewError("Workspace Review path parent is not a directory.", "unsupported");
        }
        if (index === parts.length - 1) targetInfo = info;
      }
      const real = await realpath(absolute);
      if (!isWithin(real, workspace.root) || toSlash(relative(workspace.root, real)) !== canonical) {
        throw new WorkspaceGitReviewError("Workspace Review path is not canonical.", "invalid");
      }
    } catch (error) {
      if (error instanceof WorkspaceGitReviewError) throw error;
      if (allowMissing && isMissingFilesystemError(error)) return undefined;
      throw new WorkspaceGitReviewError("The selected workspace file is unavailable.", "unsupported");
    }
    if (targetInfo === undefined || !targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new WorkspaceGitReviewError("Review file actions require a regular file.", "unsupported");
    }
    return { absolute, info: targetInfo };
  }

  async #applyUntrackedFileMutation(
    workspace: WorkspaceRegistration,
    action: WorkspaceGitDiffAction,
    path: string
  ): Promise<void> {
    if (action === "unstage") {
      throw new WorkspaceGitReviewError("The selected staged file diff is stale.", "stale");
    }
    const status = await runProcess(
      this.#gitExecutable,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", literalGitPathspec(path)],
      workspace.root,
      20_000,
      2 * 1024 * 1024
    );
    const records = status.stdout.split("\0").filter(Boolean);
    if (records.length !== 1 || records[0] !== `?? ${path}`) {
      throw new WorkspaceGitReviewError("The selected file diff is stale or unsupported.", "stale");
    }
    const resolved = await this.#resolveGitRegularFile(workspace, path, false);
    if (resolved === undefined) throw new WorkspaceGitReviewError("The selected file is unavailable.", "stale");
    try {
      if (action === "stage") {
        await runProcess(this.#gitExecutable, ["add", "--", literalGitPathspec(path)], workspace.root, 20_000, 4 * 1024 * 1024);
      } else {
        await unlink(resolved.absolute);
      }
    } catch {
      throw new WorkspaceGitReviewError("Git could not apply the confirmed Review file change.", "apply_failed");
    }
  }

  async #validateGitRemoteRef(workspace: WorkspaceRegistration, value: string): Promise<string> {
    if (
      !value.startsWith("refs/heads/") ||
      value.length > 300 ||
      !isSafeGitRevision(value, false)
    ) {
      throw new WorkspaceGitReviewError("A fully qualified branch destination is required.", "invalid");
    }
    const checked = await runProcess(
      this.#gitExecutable,
      ["check-ref-format", value],
      workspace.root,
      10_000,
      1024 * 1024,
      new Set([0, 1, 128])
    );
    if (checked.exitCode !== 0) throw new WorkspaceGitReviewError("The push destination ref is invalid.", "invalid");
    return value;
  }

  async #assertPushRemoteIsCredentialSafe(workspace: WorkspaceRegistration, remote: string): Promise<void> {
    const remotes = await runProcess(this.#gitExecutable, ["remote"], workspace.root, 10_000, 1024 * 1024);
    if (!remotes.stdout.split(/\r?\n/u).map((value) => value.trim()).includes(remote)) {
      throw new WorkspaceGitReviewError("The selected push remote is not configured.", "invalid");
    }
    const urls = await runProcess(
      this.#gitExecutable,
      ["remote", "get-url", "--push", "--all", remote],
      workspace.root,
      10_000,
      2 * 1024 * 1024,
      new Set([0, 2, 128])
    );
    const values = urls.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (urls.exitCode !== 0 || values.length === 0) {
      throw new WorkspaceGitReviewError("The selected push remote has no destination.", "invalid");
    }
    if (values.some(gitRemoteUrlContainsCredentials)) {
      throw new WorkspaceGitReviewError("Credential-bearing remote URLs are not supported by Review push.", "unsupported");
    }
  }

  async #readRemoteRefOid(workspace: WorkspaceRegistration, remote: string, remoteRef: string): Promise<string> {
    const result = await runProcess(
      this.#gitExecutable,
      ["ls-remote", "--refs", remote, remoteRef],
      workspace.root,
      120_000,
      2 * 1024 * 1024,
      new Set([0, 2, 128])
    );
    if (result.exitCode !== 0) throw new WorkspaceGitReviewError("The remote branch could not be read.", "apply_failed");
    const records = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
    if (records.length !== 1) throw new WorkspaceGitReviewError("The remote branch is unavailable.", "invalid");
    const [oid, ref] = records[0]!.split(/\s+/u);
    if (!isImmutableGitObjectId(oid ?? "") || ref !== remoteRef) {
      throw new WorkspaceGitReviewError("The remote branch identity is invalid.", "unsupported");
    }
    return oid!;
  }

  async #readRemoteAheadBehind(
    workspace: WorkspaceRegistration,
    remote: string,
    remoteRef: string,
    headRevision: string,
    expectedRemoteOid: string
  ): Promise<{ readonly ahead: number; readonly behind: number }> {
    const present = await runProcess(
      this.#gitExecutable,
      ["cat-file", "-e", `${expectedRemoteOid}^{commit}`],
      workspace.root,
      10_000,
      1024 * 1024,
      new Set([0, 1, 128])
    );
    if (present.exitCode !== 0) {
      const fetched = await runProcess(
        this.#gitExecutable,
        ["fetch", "--no-tags", "--quiet", remote, remoteRef],
        workspace.root,
        120_000,
        4 * 1024 * 1024,
        new Set([0, 1, 128])
      );
      if (fetched.exitCode !== 0) throw new WorkspaceGitReviewError("The remote branch could not be refreshed.", "apply_failed");
      const fetchedOid = await runProcess(
        this.#gitExecutable,
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        workspace.root,
        10_000,
        1024 * 1024,
        new Set([0, 128])
      );
      if (fetchedOid.stdout.trim() !== expectedRemoteOid) {
        throw new WorkspaceGitReviewError("The remote branch changed while it was being refreshed.", "lease_expired");
      }
    }
    const counts = await runProcess(
      this.#gitExecutable,
      ["rev-list", "--left-right", "--count", `${headRevision}...${expectedRemoteOid}`],
      workspace.root,
      20_000,
      1024 * 1024
    );
    const match = /^(\d+)\s+(\d+)$/u.exec(counts.stdout.trim());
    if (match === null) throw new WorkspaceGitReviewError("The remote branch relationship is unavailable.", "unsupported");
    const ahead = Number(match[1]);
    const behind = Number(match[2]);
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) {
      throw new WorkspaceGitReviewError("The remote branch relationship is invalid.", "unsupported");
    }
    return { ahead, behind };
  }

  async #readGitDiff(
    workspaceId: string,
    paths: readonly string[],
    options: { readonly baseRevision?: string; readonly headRevision?: string; readonly ignoreWhitespace?: boolean }
  ): Promise<WorkspaceGitDiff> {
    const workspace = this.requireWorkspace(workspaceId);
    await this.#requireGitRoot(workspace);
    const canonicalPaths = paths.map(canonicalGitRelativePath);
    const base = options.baseRevision?.trim() ?? "";
    const head = options.headRevision?.trim() ?? "";
    if ((base === "") !== (head === "")) {
      throw new WorkspaceGitReviewError("Base and head refs must be provided together.", "invalid");
    }
    if (base !== "") {
      const baseOid = await this.#resolveGitCommit(workspace, base, "base");
      const headOid = await this.#resolveGitCommit(workspace, head, "head");
      const mergeBase = await runProcess(this.#gitExecutable, ["merge-base", baseOid, headOid], workspace.root, 10_000, 1024 * 1024);
      const mergeBaseOid = mergeBase.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/iu.test(mergeBaseOid)) {
        throw new WorkspaceGitReviewError("The selected refs do not have a valid merge base.", "invalid");
      }
      const args = [
        "diff",
        ...(options.ignoreWhitespace === true ? ["--ignore-all-space"] : []),
        "--no-ext-diff",
        "--no-color",
        "--binary",
        "--find-renames",
        mergeBaseOid,
        headOid,
        "--",
        ...canonicalPaths.map(literalGitPathspec)
      ];
      const comparison = await runProcess(this.#gitExecutable, args, workspace.root, 30_000, 32 * 1024 * 1024);
      return {
        index: "",
        workingTree: "",
        comparison: comparison.stdout,
        repositoryRevision: createHash("sha256").update(`comparison\0${baseOid}\0${headOid}\0${mergeBaseOid}\0${comparison.stdout}`).digest("hex"),
        baseRevision: baseOid,
        headRevision: headOid,
        mergeBaseRevision: mergeBaseOid
      };
    }
    const [fullIndex, fullTrackedWorkingTree, fullUntrackedWorkingTree, status, headResult] = await Promise.all([
      this.#readLayerDiff(workspace, "index", [], false),
      this.#readLayerDiff(workspace, "workingTree", [], false),
      this.#readUntrackedDiff(workspace, [], false),
      runProcess(this.#gitExecutable, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace.root, 20_000, 16 * 1024 * 1024),
      runProcess(this.#gitExecutable, ["rev-parse", "--verify", "HEAD^{commit}"], workspace.root, 10_000, 1024 * 1024, new Set([0, 128]))
    ]);
    const fullWorkingTree = `${fullTrackedWorkingTree}${fullUntrackedWorkingTree}`;
    const index = canonicalPaths.length === 0 && options.ignoreWhitespace !== true
      ? fullIndex
      : await this.#readLayerDiff(workspace, "index", canonicalPaths, options.ignoreWhitespace === true);
    const workingTree = canonicalPaths.length === 0 && options.ignoreWhitespace !== true
      ? fullWorkingTree
      : `${await this.#readLayerDiff(workspace, "workingTree", canonicalPaths, options.ignoreWhitespace === true)}${await this.#readUntrackedDiff(workspace, canonicalPaths, options.ignoreWhitespace === true)}`;
    const headRevision = headResult.stdout.trim();
    return {
      index,
      workingTree,
      comparison: "",
      repositoryRevision: createHash("sha256")
        .update(`worktree\0${headRevision}\0${status.stdout}\0${fullIndex}\0${fullWorkingTree}`)
        .digest("hex"),
      ...(isImmutableGitObjectId(headRevision) ? { headRevision } : {})
    };
  }

  async #readLayerDiff(
    workspace: WorkspaceRegistration,
    source: Exclude<WorkspaceGitDiffSource, "comparison">,
    paths: readonly string[],
    ignoreWhitespace: boolean
  ): Promise<string> {
    const args = [
      "diff",
      ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
      ...(source === "index" ? ["--cached"] : []),
      "--no-ext-diff",
      "--no-color",
      "--binary",
      "--find-renames",
      "--",
      ...paths.map(literalGitPathspec)
    ];
    return (await runProcess(this.#gitExecutable, args, workspace.root, 30_000, 32 * 1024 * 1024)).stdout;
  }

  async #readUntrackedDiff(
    workspace: WorkspaceRegistration,
    paths: readonly string[],
    ignoreWhitespace: boolean
  ): Promise<string> {
    const listed = await runProcess(
      this.#gitExecutable,
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...paths.map(literalGitPathspec)
      ],
      workspace.root,
      20_000,
      16 * 1024 * 1024
    );
    const untracked = listed.stdout.split("\0").filter(Boolean).map(canonicalGitRelativePath);
    const patches: string[] = [];
    let totalBytes = 0;
    for (const path of untracked) {
      let patch: string;
      const resolved = await this.#resolveGitRegularFile(workspace, path, true).catch((error: unknown) => {
        if (error instanceof WorkspaceGitReviewError && error.kind === "unsupported") return undefined;
        throw error;
      });
      if (resolved === undefined || resolved.info.size > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) {
        const hash = await runProcess(
          this.#gitExecutable,
          ["hash-object", "--no-filters", "--", path],
          workspace.root,
          20_000,
          1024 * 1024,
          new Set([0, 128])
        );
        const oid = isImmutableGitObjectId(hash.stdout.trim()) ? hash.stdout.trim() : "0".repeat(40);
        patch = syntheticUntrackedBinaryPatch(path, oid);
      } else {
        const result = await runProcess(
          this.#gitExecutable,
          [
            "diff",
            "--no-index",
            ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
            "--no-ext-diff",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--",
            "/dev/null",
            path
          ],
          workspace.root,
          20_000,
          8 * 1024 * 1024,
          new Set([0, 1])
        );
        patch = result.stdout;
        if (patch.includes(workspace.root)) {
          throw new WorkspaceGitReviewError("Git produced an unsafe untracked file diff.", "unsupported");
        }
      }
      totalBytes += Buffer.byteLength(patch, "utf8");
      if (totalBytes > 32 * 1024 * 1024) {
        throw new WorkspaceGitReviewError("Workspace Review diff exceeds its safe size limit.", "unsupported");
      }
      patches.push(patch.endsWith("\n") ? patch : `${patch}\n`);
    }
    return patches.join("");
  }

  async #resolveGitCommit(workspace: WorkspaceRegistration, value: string, label: "base" | "head" | "source"): Promise<string> {
    const oid = await this.#tryResolveGitCommit(workspace, value, label);
    if (oid === undefined) {
      throw new WorkspaceGitReviewError(`The ${label} ref does not resolve to a commit.`, "invalid");
    }
    return oid;
  }

  async #tryResolveGitCommit(workspace: WorkspaceRegistration, value: string, label: "base" | "head" | "source"): Promise<string | undefined> {
    if (!isSafeGitRevision(value, label === "head")) {
      throw new WorkspaceGitReviewError(`The ${label} ref is invalid.`, "invalid");
    }
    if (value !== "HEAD" && !/^[0-9a-f]{40,64}$/iu.test(value)) {
      const checkArgs = value.startsWith("refs/")
        ? ["check-ref-format", value]
        : ["check-ref-format", "--branch", value];
      const checked = await runProcess(this.#gitExecutable, checkArgs, workspace.root, 10_000, 1024 * 1024, new Set([0, 1, 128]));
      if (checked.exitCode !== 0) throw new WorkspaceGitReviewError(`The ${label} ref is invalid.`, "invalid");
    }
    const result = await runProcess(
      this.#gitExecutable,
      ["rev-parse", "--verify", `${value}^{commit}`],
      workspace.root,
      10_000,
      1024 * 1024,
      new Set([0, 128])
    );
    const oid = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/iu.test(oid)) {
      return undefined;
    }
    return oid;
  }

  async #resolveBranchBaseOrDefault(workspace: WorkspaceRegistration, requested: string): Promise<WorkspaceGitResolvedBranchBase> {
    const candidates = await this.#listBranchBaseCandidates(workspace);
    const resolved = candidates.find((candidate) =>
      candidate.ref === requested || (isImmutableGitObjectId(requested) && candidate.oid === requested)
    );
    if (resolved !== undefined) return resolved;
    const fallback = this.#pickDefaultBranchBase(candidates);
    return {
      ...fallback,
      warning: {
        kind: "requested_base_missing",
        requestedBaseRef: requested,
        resolvedBaseRef: fallback.ref
      }
    };
  }

  async #resolveDefaultBranchBase(workspace: WorkspaceRegistration): Promise<WorkspaceGitResolvedBranchBase> {
    return this.#pickDefaultBranchBase(await this.#listBranchBaseCandidates(workspace));
  }

  #pickDefaultBranchBase(candidates: readonly WorkspaceGitBranchBaseCandidate[]): WorkspaceGitBranchBaseCandidate {
    const candidate = candidates.find((item) => item.kind !== "upstream");
    if (candidate !== undefined) return candidate;
    throw new WorkspaceGitReviewError(
      "No safe default branch base is configured. Select an explicit base ref.",
      "unsupported"
    );
  }

  async #listBranchBaseCandidates(workspace: WorkspaceRegistration): Promise<readonly WorkspaceGitBranchBaseCandidate[]> {
    const [currentResult, upstreamResult, remoteDefaultResult, configuredDefaultResult, refsResult] = await Promise.all([
      runProcess(this.#gitExecutable, ["symbolic-ref", "--quiet", "--short", "HEAD"], workspace.root, 10_000, 1024 * 1024, new Set([0, 1, 128])),
      runProcess(this.#gitExecutable, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], workspace.root, 10_000, 1024 * 1024, new Set([0, 128])),
      runProcess(this.#gitExecutable, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], workspace.root, 10_000, 1024 * 1024, new Set([0, 1, 128])),
      runProcess(this.#gitExecutable, ["config", "--get", "init.defaultBranch"], workspace.root, 10_000, 1024 * 1024, new Set([0, 1, 128])),
      runProcess(
        this.#gitExecutable,
        ["for-each-ref", "--format=%(refname)%1f%(refname:short)%1f%(objectname)%00", "refs/heads", "refs/remotes"],
        workspace.root,
        20_000,
        16 * 1024 * 1024
      )
    ]);
    const currentBranch = currentResult.exitCode === 0 ? currentResult.stdout.trim() : "";
    const configuredDefault = configuredDefaultResult.exitCode === 0
      ? normalizeBranchCandidateRef(configuredDefaultResult.stdout)
      : undefined;
    const customDefault = configuredDefault === "main" || configuredDefault === "master" ? undefined : configuredDefault;
    const remoteDefaultFullRef = remoteDefaultResult.exitCode === 0 ? remoteDefaultResult.stdout.trim() : "";
    const remoteDefaultRef = normalizeBranchCandidateRef(remoteDefaultFullRef);
    const upstreamRef = upstreamResult.exitCode === 0 ? normalizeBranchCandidateRef(upstreamResult.stdout) : undefined;
    const byRef = new Map<string, WorkspaceGitBranchBaseCandidate>();
    const add = (candidate: WorkspaceGitBranchBaseCandidate): void => {
      if (candidate.ref === "" || !isSafeGitRevision(candidate.ref, false) || byRef.has(candidate.ref)) return;
      byRef.set(candidate.ref, candidate);
    };

    if (remoteDefaultRef !== undefined && remoteDefaultFullRef !== "") {
      const oid = await this.#tryResolveGitCommit(workspace, remoteDefaultFullRef, "source");
      if (oid !== undefined) add({ ref: remoteDefaultRef, oid, kind: "remote-default" });
    }
    for (const record of refsResult.stdout.split("\0").map((item) => item.trim()).filter(Boolean)) {
      const [fullRef = "", fallbackRef = "", oid = ""] = record.split("\x1f");
      const local = fullRef.startsWith("refs/heads/");
      const remote = fullRef.startsWith("refs/remotes/");
      if ((!local && !remote) || fullRef.endsWith("/HEAD") || !isImmutableGitObjectId(oid)) continue;
      const ref = local
        ? fullRef.slice("refs/heads/".length)
        : remote ? fullRef.slice("refs/remotes/".length) : fallbackRef;
      if (local && ref === currentBranch) continue;
      add({ ref, oid, kind: local ? "local" : "remote" });
    }

    const defaultRefs = new Set([
      remoteDefaultRef,
      "origin/main",
      "origin/master",
      customDefault === undefined ? undefined : `origin/${customDefault}`,
      "main",
      "master",
      customDefault
    ].filter((value): value is string => value !== undefined));
    if (upstreamRef !== undefined && !defaultRefs.has(upstreamRef)) {
      const existing = byRef.get(upstreamRef);
      if (existing !== undefined) byRef.set(upstreamRef, { ...existing, kind: "upstream" });
    }
    const priority = (candidate: WorkspaceGitBranchBaseCandidate): number => {
      if (candidate.kind === "remote-default") return 0;
      if (candidate.ref === "origin/main") return 1;
      if (candidate.ref === "origin/master") return 2;
      if (customDefault !== undefined && candidate.ref === `origin/${customDefault}`) return 3;
      if (candidate.ref === "main") return 4;
      if (candidate.ref === "master") return 5;
      if (customDefault !== undefined && candidate.ref === customDefault) return 6;
      if (candidate.kind === "upstream") return 7;
      if (candidate.kind === "local") return 8;
      return 9;
    };
    return [...byRef.values()].sort((left, right) => priority(left) - priority(right) || left.ref.localeCompare(right.ref));
  }

  async #assertGitReviewWriteAllowed(workspace: WorkspaceRegistration): Promise<void> {
    const state = await this.#readGitReviewWriteState(workspace);
    if (state.disabledReasons.length === 0) return;
    throw new WorkspaceGitReviewError(
      `Git Review writes are unavailable while repository state is ${state.disabledReasons.join(", ")}.`,
      "unsupported"
    );
  }

  async #readGitReviewWriteState(workspace: WorkspaceRegistration): Promise<WorkspaceGitWriteState> {
    const [branchResult, headResult, unmergedResult, operationInProgress] = await Promise.all([
      runProcess(
        this.#gitExecutable,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        workspace.root,
        10_000,
        1024 * 1024,
        new Set([0, 1, 128])
      ),
      runProcess(
        this.#gitExecutable,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        workspace.root,
        10_000,
        1024 * 1024,
        new Set([0, 128])
      ),
      runProcess(
        this.#gitExecutable,
        ["ls-files", "--unmerged", "-z"],
        workspace.root,
        10_000,
        4 * 1024 * 1024
      ),
      this.#gitOperationInProgress(workspace)
    ]);
    const branch = branchResult.exitCode === 0 && branchResult.stdout.trim() !== ""
      ? branchResult.stdout.trim()
      : undefined;
    const head = headResult.exitCode === 0 && isImmutableGitObjectId(headResult.stdout.trim())
      ? headResult.stdout.trim()
      : undefined;
    const detachedHead = head !== undefined && branch === undefined;
    const unborn = head === undefined;
    const unmerged = unmergedResult.stdout !== "";
    const disabledReasons: WorkspaceGitWriteDisabledReason[] = [];
    if (detachedHead) disabledReasons.push("detached");
    if (unborn) disabledReasons.push("unborn");
    if (unmerged) disabledReasons.push("unmerged");
    if (operationInProgress) disabledReasons.push("in-progress");
    return {
      ...(branch === undefined ? {} : { branch }),
      ...(head === undefined ? {} : { head }),
      detachedHead,
      unborn,
      unmerged,
      operationInProgress,
      disabledReasons
    };
  }

  async #gitOperationInProgress(workspace: WorkspaceRegistration): Promise<boolean> {
    for (const marker of ["MERGE_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "SQUASH_MSG"] as const) {
      const result = await runProcess(
        this.#gitExecutable,
        ["rev-parse", "--git-path", marker],
        workspace.root,
        10_000,
        1024 * 1024,
        new Set([0, 128])
      );
      const value = result.stdout.trim();
      if (result.exitCode !== 0 || value === "") continue;
      const markerPath = isAbsolute(value) ? value : resolve(workspace.root, value);
      try {
        await lstat(markerPath);
        return true;
      } catch (error) {
        if (!isMissingFilesystemError(error)) {
          throw new WorkspaceGitReviewError("Git operation state could not be verified safely.", "unsupported");
        }
      }
    }
    return false;
  }

  async #requireGitRoot(workspace: WorkspaceRegistration): Promise<void> {
    const probe = await runProcess(this.#gitExecutable, ["rev-parse", "--show-toplevel"], workspace.root, 10_000, 1024 * 1024, new Set([0, 128]));
    if (probe.exitCode !== 0) throw new WorkspaceGitReviewError("Workspace is not a Git repository.", "unsupported");
    const topLevel = await realpath(probe.stdout.trim());
    if (!isWithin(topLevel, workspace.root)) {
      throw new WorkspaceGitReviewError("Detected Git repository extends outside the workspace boundary.", "unsupported");
    }
  }

  async #readWorkspacePreviewSnapshot(
    workspace: WorkspaceRegistration,
    resolved: WorkspaceResolvedPreviewFile,
    maximumBytes: number
  ): Promise<{ readonly info: Stats; readonly bytes: Buffer }> {
    let handle: FileHandle;
    try {
      handle = await open(resolved.absolute, "r");
    } catch {
      throw new WorkspaceFilePreviewError("Workspace preview file could not be opened safely.", "read_failed");
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new WorkspaceFilePreviewError("Workspace preview requires a regular file.", "unsupported");
      }
      if (!sameFileState(before, resolved.info)) {
        throw new WorkspaceFilePreviewError("Workspace preview file changed while it was being opened.", "stale");
      }
      const bytes = await readFileHandlePrefix(handle, maximumBytes);
      await this.#afterWorkspacePreviewRead?.({ workspaceId: workspace.id, path: resolved.path });
      const after = await handle.stat();
      const expectedLength = Math.min(before.size, maximumBytes);
      if (bytes.byteLength !== expectedLength || !sameFileState(before, after)) {
        throw new WorkspaceFilePreviewError("Workspace preview file changed while it was being read.", "stale");
      }

      let current: WorkspaceResolvedPreviewFile;
      try {
        current = await this.#resolveWorkspacePreviewFile(workspace, resolved.path);
      } catch {
        throw new WorkspaceFilePreviewError("Workspace preview file changed while it was being read.", "stale");
      }
      if (current.absolute !== resolved.absolute || !sameFileState(after, current.info)) {
        throw new WorkspaceFilePreviewError("Workspace preview file changed while it was being read.", "stale");
      }
      return { info: current.info, bytes };
    } catch (error) {
      if (error instanceof WorkspaceFilePreviewError) throw error;
      throw new WorkspaceFilePreviewError("Workspace preview file could not be read safely.", "read_failed");
    } finally {
      await handle.close();
    }
  }

  async #resolveWorkspacePreviewFile(
    workspace: WorkspaceRegistration,
    requestedPath: string
  ): Promise<WorkspaceResolvedPreviewFile> {
    const canonicalPath = canonicalWorkspacePreviewPath(requestedPath);
    const absolute = resolve(workspace.root, ...canonicalPath.split("/"));
    if (!isWithin(absolute, workspace.root) || toSlash(relative(workspace.root, absolute)) !== canonicalPath) {
      throw new WorkspaceFilePreviewError("Workspace preview path escapes its root or is not canonical.", "invalid");
    }

    let current = workspace.root;
    let targetInfo: Stats | undefined;
    try {
      const parts = canonicalPath.split("/");
      for (let index = 0; index < parts.length; index += 1) {
        current = resolve(current, parts[index]!);
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new WorkspaceFilePreviewError("Workspace symbolic links are not exposed through preview.", "unsupported");
        }
        if (index < parts.length - 1 && !info.isDirectory()) {
          throw new WorkspaceFilePreviewError("Workspace preview path parent is not a directory.", "unsupported");
        }
        if (index === parts.length - 1) targetInfo = info;
      }
      const canonical = await realpath(absolute);
      if (!isWithin(canonical, workspace.root) || toSlash(relative(workspace.root, canonical)) !== canonicalPath) {
        throw new WorkspaceFilePreviewError("Workspace preview path does not resolve to its canonical location.", "invalid");
      }
    } catch (error) {
      if (error instanceof WorkspaceFilePreviewError) throw error;
      throw new WorkspaceFilePreviewError("Workspace preview requires an existing regular file.", "unsupported");
    }
    if (targetInfo === undefined || !targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new WorkspaceFilePreviewError("Workspace preview requires an existing regular file.", "unsupported");
    }
    return { absolute, path: canonicalPath, info: targetInfo };
  }

  async #readWorkspaceTextSnapshot(
    workspace: WorkspaceRegistration,
    canonicalPath: string
  ): Promise<WorkspaceTextSnapshot> {
    const resolved = await this.#resolveWorkspaceTextFile(workspace, canonicalPath);
    const inferredMediaType = inferMediaType(canonicalPath);
    if (!isTextMediaType(inferredMediaType) && inferredMediaType !== "application/octet-stream") {
      throw new WorkspaceTextFileWriteError("Workspace save only supports recognized text files.", "unsupported");
    }
    const mediaType = inferredMediaType === "application/octet-stream" ? "text/plain" : inferredMediaType;

    let handle;
    try {
      handle = await open(resolved.absolute, "r");
    } catch {
      throw new WorkspaceTextFileWriteError("Workspace text file is not readable.", "unsupported");
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new WorkspaceTextFileWriteError("Workspace save target must be a regular file.", "unsupported");
      }
      if (before.size > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) {
        throw new WorkspaceTextFileWriteError("Existing workspace text exceeds the save size limit.", "too_large");
      }
      const bytes = await readFileHandlePrefix(handle, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES + 1);
      const after = await handle.stat();
      if (bytes.byteLength > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) {
        throw new WorkspaceTextFileWriteError("Existing workspace text exceeds the save size limit.", "too_large");
      }
      if (bytes.byteLength !== after.size || !sameFileState(before, after)) {
        throw new WorkspaceTextFileWriteError("Workspace file changed while it was being read.", "stale");
      }

      const current = await this.#resolveWorkspaceTextFile(workspace, canonicalPath);
      if (current.absolute !== resolved.absolute || !sameFileState(after, current.info)) {
        throw new WorkspaceTextFileWriteError("Workspace file changed while it was being read.", "stale");
      }
      if (bytes.includes(0)) {
        throw new WorkspaceTextFileWriteError("Workspace save does not support binary files.", "unsupported");
      }
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new WorkspaceTextFileWriteError("Workspace save requires valid UTF-8 text.", "unsupported");
      }
      return {
        absolute: resolved.absolute,
        info: current.info,
        bytes,
        mediaType,
        revision: workspaceTextFileRevision(bytes)
      };
    } catch (error) {
      if (error instanceof WorkspaceTextFileWriteError) throw error;
      throw new WorkspaceTextFileWriteError("Workspace text file could not be read safely.", "unsupported");
    } finally {
      await handle.close();
    }
  }

  async #workspaceSearchResultRevision(workspace: WorkspaceRegistration, canonicalPath: string): Promise<string> {
    const resolved = await this.#resolveWorkspaceTextFile(workspace, canonicalPath);
    const mediaType = inferMediaType(canonicalPath);
    if (
      resolved.info.size > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES
      || (!isTextMediaType(mediaType) && mediaType !== "application/octet-stream")
    ) return metadataFileRevision(resolved.info);

    const handle = await open(resolved.absolute, "r");
    try {
      const before = await handle.stat();
      const bytes = await readFileHandlePrefix(handle, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES + 1);
      const after = await handle.stat();
      if (bytes.byteLength !== after.size || !sameFileState(before, after)) {
        throw new WorkspaceSearchError("Workspace search result changed while its revision was computed.", "result_changed");
      }
      const current = await this.#resolveWorkspaceTextFile(workspace, canonicalPath);
      if (current.absolute !== resolved.absolute || !sameFileState(after, current.info)) {
        throw new WorkspaceSearchError("Workspace search result changed while its revision was computed.", "result_changed");
      }
      return workspaceTextFileRevision(bytes);
    } finally {
      await handle.close();
    }
  }

  async #resolveWorkspaceTextFile(
    workspace: WorkspaceRegistration,
    canonicalPath: string
  ): Promise<{ readonly absolute: string; readonly info: Stats }> {
    const absolute = resolve(workspace.root, ...canonicalPath.split("/"));
    if (!isWithin(absolute, workspace.root) || toSlash(relative(workspace.root, absolute)) !== canonicalPath) {
      throw new WorkspaceTextFileWriteError("Workspace path is not a canonical relative path.", "invalid");
    }

    let current = workspace.root;
    let targetInfo: Stats | undefined;
    try {
      const parts = canonicalPath.split("/");
      for (let index = 0; index < parts.length; index += 1) {
        current = resolve(current, parts[index]!);
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new WorkspaceTextFileWriteError("Workspace symbolic links cannot be saved through the file API.", "unsupported");
        }
        if (index < parts.length - 1 && !info.isDirectory()) {
          throw new WorkspaceTextFileWriteError("Workspace path parent is not a directory.", "unsupported");
        }
        if (index === parts.length - 1) targetInfo = info;
      }
      const real = await realpath(absolute);
      if (!isWithin(real, workspace.root) || toSlash(relative(workspace.root, real)) !== canonicalPath) {
        throw new WorkspaceTextFileWriteError("Workspace path does not resolve to its canonical location.", "invalid");
      }
    } catch (error) {
      if (error instanceof WorkspaceTextFileWriteError) throw error;
      throw new WorkspaceTextFileWriteError("Workspace save requires an existing regular file.", "unsupported");
    }
    if (targetInfo === undefined || !targetInfo.isFile() || targetInfo.isSymbolicLink()) {
      throw new WorkspaceTextFileWriteError("Workspace save target must be an existing regular file.", "unsupported");
    }
    return { absolute, info: targetInfo };
  }

  async #resolveWorkspaceMutationEntry(
    workspace: WorkspaceRegistration,
    canonicalPath: string
  ): Promise<WorkspaceResolvedMutationEntry> {
    const absolute = resolve(workspace.root, ...canonicalPath.split("/"));
    let current = workspace.root;
    let targetInfo: Stats | undefined;
    try {
      const parts = canonicalPath.split("/");
      for (let index = 0; index < parts.length; index += 1) {
        current = resolve(current, parts[index]!);
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new WorkspaceEntryMutationError("Workspace symbolic links cannot be mutated through the file API.", "unsupported");
        }
        if (index < parts.length - 1 && !info.isDirectory()) {
          throw new WorkspaceEntryMutationError("A workspace path parent is not a directory.", "unsupported");
        }
        if (index === parts.length - 1) targetInfo = info;
      }
      const canonical = await realpath(absolute);
      if (!isWithin(canonical, workspace.root) || toSlash(relative(workspace.root, canonical)) !== canonicalPath) {
        throw new WorkspaceEntryMutationError("The workspace path does not resolve to its canonical location.", "invalid");
      }
    } catch (error) {
      if (error instanceof WorkspaceEntryMutationError) throw error;
      if (isMissingFilesystemError(error)) {
        throw new WorkspaceEntryMutationError("The workspace entry no longer exists.", "not_found");
      }
      throw new WorkspaceEntryMutationError("The workspace entry could not be resolved safely.", "unsupported", { cause: error });
    }
    if (targetInfo === undefined || (!targetInfo.isFile() && !targetInfo.isDirectory()) || targetInfo.isSymbolicLink()) {
      throw new WorkspaceEntryMutationError("Workspace mutations support only regular files and directories.", "unsupported");
    }
    if (targetInfo.isFile() && targetInfo.nlink !== 1) {
      throw new WorkspaceEntryMutationError("Hard-linked workspace files cannot be mutated through the file API.", "unsafe");
    }
    return { absolute, path: canonicalPath, info: targetInfo };
  }

  async #resolveWorkspaceMutationDestination(
    workspace: WorkspaceRegistration,
    canonicalPath: string,
    allowedExistingIdentity?: Stats
  ): Promise<WorkspaceResolvedMutationDestination> {
    const absolute = resolve(workspace.root, ...canonicalPath.split("/"));
    const parentPath = dirname(absolute);
    const parentRelativePath = toSlash(relative(workspace.root, parentPath));
    if (!isWithin(absolute, workspace.root) || toSlash(relative(workspace.root, absolute)) !== canonicalPath) {
      throw new WorkspaceEntryMutationError("The workspace destination is not a canonical relative path.", "invalid");
    }
    let current = workspace.root;
    try {
      for (const part of parentRelativePath === "" ? [] : parentRelativePath.split("/")) {
        current = resolve(current, part);
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new WorkspaceEntryMutationError("The workspace destination parent is not a real directory.", "unsupported");
        }
      }
      const canonicalParent = await realpath(parentPath);
      if (!isWithin(canonicalParent, workspace.root) || canonicalParent !== parentPath) {
        throw new WorkspaceEntryMutationError("The workspace destination parent is outside its canonical root.", "invalid");
      }
      const parentInfo = await lstat(parentPath);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
        throw new WorkspaceEntryMutationError("The workspace destination parent is not a real directory.", "unsupported");
      }
      try {
        const existing = await lstat(absolute);
        if (existing.isSymbolicLink() || (!existing.isFile() && !existing.isDirectory())) {
          throw new WorkspaceEntryMutationError("The workspace destination is a symbolic link or special entry.", "unsupported");
        }
        if (existing.isFile() && existing.nlink !== 1) {
          throw new WorkspaceEntryMutationError("The workspace destination is a hard-linked file.", "unsafe");
        }
        if (allowedExistingIdentity === undefined || !sameFilesystemIdentity(existing, allowedExistingIdentity)) {
          throw new WorkspaceEntryMutationError("The workspace destination already exists.", "conflict");
        }
      } catch (error) {
        if (error instanceof WorkspaceEntryMutationError) throw error;
        if (!isMissingFilesystemError(error)) {
          throw new WorkspaceEntryMutationError("The workspace destination could not be checked safely.", "unsupported", { cause: error });
        }
      }
      return { absolute, path: canonicalPath, parentAbsolute: parentPath, parentInfo };
    } catch (error) {
      if (error instanceof WorkspaceEntryMutationError) throw error;
      if (isMissingFilesystemError(error)) {
        throw new WorkspaceEntryMutationError("The workspace destination parent no longer exists.", "not_found");
      }
      throw new WorkspaceEntryMutationError("The workspace destination could not be resolved safely.", "unsupported", { cause: error });
    }
  }

  async #assertWorkspaceMutationDestinationStillSafe(
    workspace: WorkspaceRegistration,
    destination: WorkspaceResolvedMutationDestination,
    allowedExistingIdentity?: Stats
  ): Promise<void> {
    const current = await this.#resolveWorkspaceMutationDestination(workspace, destination.path, allowedExistingIdentity);
    if (current.parentAbsolute !== destination.parentAbsolute || !sameFilesystemIdentity(current.parentInfo, destination.parentInfo)) {
      throw new WorkspaceEntryMutationError("The workspace destination parent changed before the mutation.", "stale");
    }
  }

  async #validateWorkspaceMutationTree(
    absolute: string,
    budget: WorkspaceMutationBudget = {
      entries: 0,
      bytes: 0,
      maximumEntries: Number.POSITIVE_INFINITY,
      maximumBytes: Number.POSITIVE_INFINITY
    }
  ): Promise<void> {
    const before = await lstat(absolute);
    assertSafeWorkspaceMutationInfo(before);
    budget.entries += 1;
    if (before.isFile()) budget.bytes += before.size;
    if (budget.entries > budget.maximumEntries || budget.bytes > budget.maximumBytes) {
      throw new WorkspaceEntryMutationError("The workspace entry exceeds the safe mutation limit.", "too_large");
    }
    if (before.isDirectory()) {
      const children = await readdir(absolute, { withFileTypes: true });
      children.sort((left, right) => compareWorkspaceNames(left.name, right.name));
      for (const child of children) {
        await this.#validateWorkspaceMutationTree(resolve(absolute, child.name), budget);
      }
    }
    const after = await lstat(absolute);
    if (!sameFileState(before, after)) {
      throw new WorkspaceEntryMutationError("The workspace entry changed while it was being inspected.", "stale");
    }
  }

  async #copyWorkspaceMutationDirectory(
    source: string,
    destination: string,
    validatedBudget: WorkspaceMutationBudget
  ): Promise<void> {
    // The first pass above bounds the complete tree. The copy pass still
    // rechecks every directory and file so external changes fail closed.
    const before = await lstat(source);
    assertSafeWorkspaceMutationInfo(before);
    if (!before.isDirectory()) {
      throw new WorkspaceEntryMutationError("The workspace copy source changed kind.", "stale");
    }
    const children = await readdir(source, { withFileTypes: true });
    children.sort((left, right) => compareWorkspaceNames(left.name, right.name));
    for (const child of children) {
      const sourceChild = resolve(source, child.name);
      const destinationChild = resolve(destination, child.name);
      const childInfo = await lstat(sourceChild);
      assertSafeWorkspaceMutationInfo(childInfo);
      if (childInfo.isDirectory()) {
        await mkdir(destinationChild, { recursive: false, mode: childInfo.mode & 0o777 });
        await this.#copyWorkspaceMutationDirectory(sourceChild, destinationChild, validatedBudget);
      } else {
        await this.#copyWorkspaceMutationFile(sourceChild, destinationChild, childInfo);
      }
    }
    const after = await lstat(source);
    if (!sameFileState(before, after)) {
      throw new WorkspaceEntryMutationError("The workspace copy source changed while it was being copied.", "stale");
    }
    // Referencing the bounded first-pass result prevents an implementation
    // regression from silently removing the preflight limit.
    if (validatedBudget.entries < 1 || validatedBudget.bytes < 0) {
      throw new WorkspaceEntryMutationError("The workspace copy budget is invalid.", "effect_failed");
    }
  }

  async #copyWorkspaceMutationFile(
    source: string,
    destination: string,
    expected: Stats,
    onDestinationCreated?: () => void
  ): Promise<void> {
    assertSafeWorkspaceMutationInfo(expected);
    const sourceHandle = await open(source, "r");
    let destinationHandle: FileHandle | undefined;
    try {
      const opened = await sourceHandle.stat();
      if (!sameFileState(expected, opened)) {
        throw new WorkspaceEntryMutationError("The workspace copy source changed while it was being opened.", "stale");
      }
      destinationHandle = await open(destination, "wx", expected.mode & 0o777);
      onDestinationCreated?.();
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < expected.size) {
        const read = await sourceHandle.read(buffer, 0, Math.min(buffer.byteLength, expected.size - position), position);
        if (read.bytesRead === 0) break;
        await destinationHandle.write(buffer, 0, read.bytesRead, position);
        position += read.bytesRead;
      }
      await destinationHandle.chmod(expected.mode & 0o777);
      await destinationHandle.sync();
      const after = await sourceHandle.stat();
      if (position !== expected.size || !sameFileState(opened, after)) {
        throw new WorkspaceEntryMutationError("The workspace copy source changed while it was being copied.", "stale");
      }
    } finally {
      await destinationHandle?.close().catch(() => undefined);
      await sourceHandle.close().catch(() => undefined);
    }
  }

  async #serializeWorkspaceFileMutation<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#workspaceFileMutationTails.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    this.#workspaceFileMutationTails.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release?.();
      if (this.#workspaceFileMutationTails.get(key) === current) this.#workspaceFileMutationTails.delete(key);
    }
  }

  async #serializeGitMutation<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#gitMutationTail;
    let release: (() => void) | undefined;
    this.#gitMutationTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    await previous;
    try {
      return await action();
    } finally {
      release?.();
    }
  }

  #isRemote(id: string): boolean {
    return this.#workspaces.get(id)?.remote !== undefined;
  }

  async #remoteInvoke<Result>(id: string, method: string, args: readonly unknown[]): Promise<Result> {
    if (this.#remoteDelegate === undefined) throw new Error("Remote workspace files are unavailable.");
    return this.#remoteDelegate.invoke<Result>(id, method, args);
  }

  private requireWorkspace(id: string): WorkspaceRegistration {
    const workspace = this.#workspaces.get(id);
    if (workspace === undefined) throw new Error(`Workspace ${id} is not registered.`);
    return workspace;
  }

  private async resolveSafe(workspace: WorkspaceRegistration, requested: string, directory: boolean, allowMissing = false): Promise<string> {
    if (isAbsolute(requested)) throw new Error("Workspace paths must be relative.");
    const absolute = resolve(workspace.root, requested || ".");
    if (!isWithin(absolute, workspace.root)) throw new Error("Workspace path escapes its root.");
    if (allowMissing) {
      const parent = await realpath(resolve(absolute, ".."));
      if (!isWithin(parent, workspace.root)) throw new Error("Workspace path parent escapes its root.");
      return absolute;
    }
    const canonical = await realpath(absolute);
    if (!isWithin(canonical, workspace.root)) throw new Error("Workspace path resolves outside its root.");
    const relativeParts = relative(workspace.root, canonical).split(sep).filter(Boolean);
    let current = workspace.root;
    for (const part of relativeParts) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error("Workspace symbolic links are not exposed through the file API.");
    }
    const info = await lstat(canonical);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(directory ? "Expected a workspace directory." : "Expected a workspace file.");
    return canonical;
  }
}

interface WorkspaceListCandidate {
  readonly absolute: string;
  readonly relativePath: string;
  readonly name: string;
  readonly info: Stats;
}

interface WorkspaceIgnoreScope {
  readonly basePath: string;
  readonly matcher: ReturnType<typeof createIgnore>;
}

async function assertSafeWorkspaceListingDirectory(
  workspace: WorkspaceRegistration,
  directory: string
): Promise<void> {
  if (directory === "") return;
  let canonical: string;
  try {
    canonical = canonicalWorkspaceRelativePath(directory);
  } catch {
    throw new WorkspaceScanError("Workspace listing paths must be canonical relative paths.", "scan_failed");
  }
  let current = workspace.root;
  for (const part of canonical.split("/")) {
    if (part.toLocaleLowerCase("en-US") === ".git") {
      throw new WorkspaceScanError("Workspace Git metadata is not exposed through the file API.", "scan_failed");
    }
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new WorkspaceScanError("Workspace symbolic links are not exposed through the file API.", "scan_failed");
    }
  }
}

type WorkspaceIgnoreStrategy =
  | { readonly kind: "git"; readonly executable: string; readonly root: string }
  | { readonly kind: "fallback" };

interface ParsedWorkspaceSearchResult extends Omit<WorkspaceSearchResult, "revision"> {}

async function createWorkspaceIgnoreStrategy(
  workspace: WorkspaceRegistration,
  gitExecutable: string
): Promise<WorkspaceIgnoreStrategy> {
  let marker: Stats;
  try {
    marker = await lstat(resolve(workspace.root, ".git"));
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return { kind: "fallback" };
    throw new WorkspaceScanError(`Workspace Git metadata could not be inspected: ${errorMessage(error)}`, "scan_failed");
  }
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    throw new WorkspaceScanError("Workspace .git metadata must be a regular directory or worktree file.", "scan_failed");
  }

  let probe: ProcessResult;
  try {
    probe = await runProcess(gitExecutable, ["--no-optional-locks", "rev-parse", "--show-toplevel"], workspace.root, 10_000, 1024 * 1024, new Set([0, 128]));
  } catch (error) {
    throw new WorkspaceScanError(`Git-backed workspace ignore discovery failed: ${errorMessage(error)}`, "scan_failed");
  }
  if (probe.exitCode !== 0) {
    throw new WorkspaceScanError(`Git-backed workspace ignore discovery failed: ${probe.stderr.trim() || "git rev-parse rejected the workspace"}`, "scan_failed");
  }
  const topLevel = await realpath(probe.stdout.trim());
  if (!isWithin(topLevel, workspace.root) || !isWithin(workspace.root, topLevel)) {
    throw new WorkspaceScanError("Git-backed workspace ignore discovery escaped the registered workspace root.", "scan_failed");
  }
  return { kind: "git", executable: gitExecutable, root: workspace.root };
}

async function gitIgnoredWorkspacePaths(
  strategy: Extract<WorkspaceIgnoreStrategy, { readonly kind: "git" }>,
  paths: readonly string[]
): Promise<ReadonlySet<string>> {
  if (paths.length === 0) return new Set();
  const input = `${paths.join("\0")}\0`;
  let result: ProcessResult;
  try {
    result = await runProcess(
      strategy.executable,
      ["--no-optional-locks", "check-ignore", "--stdin", "-z"],
      strategy.root,
      10_000,
      Math.max(1024 * 1024, Buffer.byteLength(input, "utf8") + 1024),
      new Set([0, 1]),
      input
    );
  } catch (error) {
    throw new WorkspaceScanError(`Git ignore evaluation failed: ${errorMessage(error)}`, "scan_failed");
  }
  const candidates = new Set(paths);
  return new Set(result.stdout
    .split("\0")
    .filter((path) => path !== "")
    .map(normalizeRelativePath)
    .filter((path) => candidates.has(path)));
}

async function appendWorkspaceIgnoreScope(
  absoluteDirectory: string,
  relativeDirectory: string,
  inherited: readonly WorkspaceIgnoreScope[]
): Promise<readonly WorkspaceIgnoreScope[]> {
  const ignorePath = resolve(absoluteDirectory, ".gitignore");
  let info: Stats;
  try {
    info = await lstat(ignorePath);
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return inherited;
    throw new WorkspaceScanError(`Workspace .gitignore metadata could not be read at ${relativeDirectory || "."}: ${errorMessage(error)}`, "scan_failed");
  }
  if (info.isSymbolicLink() || !info.isFile()) return inherited;
  if (info.size > WORKSPACE_IGNORE_FILE_MAXIMUM_BYTES) {
    throw new WorkspaceScanError(`Workspace .gitignore exceeds ${WORKSPACE_IGNORE_FILE_MAXIMUM_BYTES} bytes at ${relativeDirectory || "."}.`, "scan_failed");
  }
  let source: string;
  try {
    source = await readFile(ignorePath, "utf8");
  } catch (error) {
    throw new WorkspaceScanError(`Workspace .gitignore could not be read at ${relativeDirectory || "."}: ${errorMessage(error)}`, "scan_failed");
  }
  if (source === "") return inherited;
  const matcher = createIgnore({ ignorecase: process.platform === "win32" }).add(source);
  return [...inherited, { basePath: relativeDirectory, matcher }];
}

function fallbackWorkspacePathIgnored(
  path: string,
  directory: boolean,
  scopes: readonly WorkspaceIgnoreScope[]
): boolean {
  let ignored = false;
  for (const scope of scopes) {
    let scopedPath: string;
    if (scope.basePath === "") scopedPath = path;
    else {
      const prefix = `${scope.basePath}/`;
      if (!path.startsWith(prefix)) continue;
      scopedPath = path.slice(prefix.length);
    }
    const result = scope.matcher.test(directory ? `${scopedPath}/` : scopedPath);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function canonicalListedWorkspacePath(workspaceRoot: string, absolute: string, allowRoot: boolean): string {
  if (!isWithin(absolute, workspaceRoot)) throw new WorkspaceScanError("Workspace scan produced a path outside its root.", "scan_failed");
  const path = toSlash(relative(workspaceRoot, absolute));
  if (path === "" && allowRoot) return "";
  try {
    return canonicalWorkspaceRelativePath(path);
  } catch {
    throw new WorkspaceScanError(`Workspace scan produced a non-canonical path: ${path || "."}`, "scan_failed");
  }
}

function compareWorkspaceNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDocumentTreeNames(left: string, right: string): number {
  const foldedLeft = left.toLocaleLowerCase("en-US");
  const foldedRight = right.toLocaleLowerCase("en-US");
  return compareWorkspaceNames(foldedLeft, foldedRight) || compareWorkspaceNames(left, right);
}

function documentTreeEntryExcluded(name: string, directory: boolean): boolean {
  const folded = name.toLocaleLowerCase("en-US");
  if (folded.endsWith(".meta") || DOCUMENT_TREE_EXCLUDED_FILE_NAMES.has(folded)) return true;
  return directory && DOCUMENT_TREE_EXCLUDED_DIRECTORY_NAMES.has(folded);
}

function normalizeWorkspaceListMaximum(value: number | undefined): number {
  const maximum = value ?? 5_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100_000) {
    throw new WorkspaceScanError("Workspace listing maximumEntries must be an integer between 1 and 100000.", "limit");
  }
  return maximum;
}

function normalizeWorkspaceSearchPageSize(value: number | undefined): number {
  const size = value ?? WORKSPACE_SEARCH_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > WORKSPACE_SEARCH_MAXIMUM_PAGE_SIZE) {
    throw new WorkspaceSearchError(`Workspace search maximumResults must be an integer between 1 and ${WORKSPACE_SEARCH_MAXIMUM_PAGE_SIZE}.`, "invalid");
  }
  return size;
}

function normalizeWorkspaceSearchOffset(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > WORKSPACE_SEARCH_MAXIMUM_OFFSET) {
    throw new WorkspaceSearchError(`Workspace search offset must be an integer between 0 and ${WORKSPACE_SEARCH_MAXIMUM_OFFSET}.`, "invalid");
  }
  return offset;
}

function workspaceSearchResultFromRipgrep(match: WorkspaceRipgrepMatch): ParsedWorkspaceSearchResult {
  const path = normalizeRelativePath(match.data.path.text);
  try {
    canonicalWorkspaceRelativePath(path);
  } catch {
    throw new WorkspaceSearchError(`Workspace search returned a non-canonical path: ${path}`, "search_failed");
  }
  const preview = match.data.lines.text.replace(/[\r\n]+$/u, "");
  const previewBytes = Buffer.from(preview, "utf8");
  const byteBoundaries = workspaceSearchUtf8ByteBoundaries(preview);
  if (
    !Number.isSafeInteger(match.data.absolute_offset)
    || match.data.absolute_offset < 0
    || !Number.isSafeInteger(match.data.line_number)
    || match.data.line_number < 1
  ) {
    throw new WorkspaceSearchError("Workspace search returned an invalid byte or line range.", "search_failed");
  }
  const submatches = match.data.submatches.map((submatch) => {
    if (
      !Number.isSafeInteger(submatch.start)
      || !Number.isSafeInteger(submatch.end)
      || submatch.start < 0
      || submatch.end <= submatch.start
      || submatch.end > previewBytes.byteLength
      || !byteBoundaries.has(submatch.start)
      || !byteBoundaries.has(submatch.end)
    ) {
      throw new WorkspaceSearchError("Workspace search returned an invalid UTF-8 submatch range.", "search_failed");
    }
    return { startByte: submatch.start, endByte: submatch.end };
  });
  const firstSubmatch = submatches[0];
  if (firstSubmatch === undefined) {
    throw new WorkspaceSearchError("Workspace search returned a match without submatches.", "search_failed");
  }
  const startByte = match.data.absolute_offset + firstSubmatch.startByte;
  const endByte = match.data.absolute_offset + firstSubmatch.endByte;
  if (!Number.isSafeInteger(startByte) || !Number.isSafeInteger(endByte)) {
    throw new WorkspaceSearchError("Workspace search byte range exceeds the safe integer boundary.", "search_failed");
  }
  return {
    path,
    line: match.data.line_number,
    column: byteBoundaries.get(firstSubmatch.startByte)! + 1,
    endColumn: byteBoundaries.get(firstSubmatch.endByte)! + 1,
    startByte,
    endByte,
    preview,
    submatches
  };
}

function workspaceSearchUtf8ByteBoundaries(value: string): ReadonlyMap<number, number> {
  const boundaries = new Map<number, number>([[0, 0]]);
  let byteOffset = 0;
  let utf16Offset = 0;
  for (const character of value) {
    byteOffset += Buffer.byteLength(character, "utf8");
    utf16Offset += character.length;
    boundaries.set(byteOffset, utf16Offset);
  }
  return boundaries;
}

function compareWorkspaceSearchResults(left: ParsedWorkspaceSearchResult, right: ParsedWorkspaceSearchResult): number {
  return compareWorkspaceNames(left.path, right.path)
    || left.startByte - right.startByte
    || left.endByte - right.endByte
    || compareWorkspaceNames(left.preview, right.preview);
}

function workspaceSearchResultSetRevision(matches: readonly ParsedWorkspaceSearchResult[]): string {
  const hash = createHash("sha256");
  for (const match of matches) {
    hash.update(match.path);
    hash.update("\0");
    hash.update(String(match.startByte));
    hash.update("\0");
    hash.update(String(match.endByte));
    hash.update("\0");
    hash.update(match.preview);
    hash.update("\0");
    for (const submatch of match.submatches) {
      hash.update(String(submatch.startByte));
      hash.update(":");
      hash.update(String(submatch.endByte));
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function workspaceSearchErrorCode(kind: WorkspaceSearchError["kind"]): WorkspaceSearchErrorCode {
  return kind === "invalid" ? "WORKSPACE_SEARCH_INVALID"
    : kind === "result_changed" ? "WORKSPACE_SEARCH_RESULT_CHANGED"
      : "WORKSPACE_SEARCH_FAILED";
}

function workspaceSearchErrorFromUnknown(error: unknown): WorkspaceSearchError {
  if (error instanceof WorkspaceSearchError) return error;
  if (nodeErrorCode(error) === "ENOENT") {
    return new WorkspaceSearchError("ripgrep is unavailable.", "search_failed", "RG_UNAVAILABLE");
  }
  return new WorkspaceSearchError(`Workspace search failed: ${errorMessage(error)}`, "search_failed");
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WorkspaceResolvedPreviewFile {
  readonly absolute: string;
  readonly path: string;
  readonly info: Stats;
}

interface WorkspaceTextSnapshot {
  readonly absolute: string;
  readonly info: Stats;
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly revision: string;
}

interface WorkspaceResolvedMutationEntry {
  readonly absolute: string;
  readonly path: string;
  readonly info: Stats;
}

interface WorkspaceResolvedMutationDestination {
  readonly absolute: string;
  readonly path: string;
  readonly parentAbsolute: string;
  readonly parentInfo: Stats;
}

interface WorkspaceMutationBudget {
  entries: number;
  bytes: number;
  readonly maximumEntries: number;
  readonly maximumBytes: number;
}

function canonicalWorkspacePreviewPath(value: string): string {
  try {
    return canonicalWorkspaceRelativePath(value);
  } catch {
    throw new WorkspaceFilePreviewError("Workspace preview path escapes its root or is not canonical.", "invalid");
  }
}

function canonicalWorkspaceMutationPath(value: string): string {
  let canonical: string;
  try {
    canonical = canonicalWorkspaceRelativePath(value);
  } catch {
    throw new WorkspaceEntryMutationError("Workspace entry paths must be canonical relative paths.", "invalid");
  }
  if (canonical === ".git" || canonical.startsWith(".git/") || /(^|\/)\.joko-entry-[^/]*\.tmp(?:\/|$)/u.test(canonical)) {
    throw new WorkspaceEntryMutationError("Reserved workspace control paths cannot be mutated.", "unsafe");
  }
  return canonical;
}

function normalizeWorkspacePreviewMaximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceFilePreviewError("Workspace preview maximumBytes must be a non-negative safe integer.", "invalid");
  }
  return Math.min(value, WORKSPACE_TEXT_FILE_MAXIMUM_BYTES);
}

function canonicalWorkspaceRelativePath(value: string): string {
  if (
    value === "" ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    isAbsolute(value) ||
    /^[a-z]:\//iu.test(value) ||
    value.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(value) ||
    (process.platform === "win32" && /[:*?"<>|]/u.test(value))
  ) {
    throw new WorkspaceTextFileWriteError("Workspace path must be a canonical relative path.", "invalid");
  }
  const parts = value.split("/");
  const invalidPart = parts.some((part) => part === "" || part === "." || part === "..");
  const invalidWindowsPart = process.platform === "win32" && parts.some((part) => part.endsWith(".") || part.endsWith(" "));
  if (invalidPart || invalidWindowsPart) {
    throw new WorkspaceTextFileWriteError("Workspace path must be a canonical relative path.", "invalid");
  }
  return value;
}

async function readFileHandlePrefix(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maximumBytes);
  let offset = 0;
  while (offset < maximumBytes) {
    const result = await handle.read(buffer, offset, maximumBytes - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
}

function encodeWorkspaceText(value: string): Buffer {
  if (value.includes("\0") || hasUnpairedSurrogate(value)) {
    throw new WorkspaceTextFileWriteError("Workspace save requires valid UTF-8 text without NUL bytes.", "unsupported");
  }
  return Buffer.from(value, "utf8");
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function workspaceFileEntry(path: string, info: Stats, revision: string): WorkspaceEntryRecord {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind: "file",
    size: info.size,
    modifiedAt: info.mtimeMs,
    revision,
    generated: isGeneratedPath(path)
  };
}

function metadataFileRevision(info: Stats): string {
  return `meta:${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function workspaceFileContentRevision(content: Uint8Array): string {
  return `sha256:${fileHash(content)}:${content.byteLength}`;
}

function workspaceTextFileRevision(content: Uint8Array): string {
  return workspaceFileContentRevision(content);
}

function workspaceMutationEntry(path: string, info: Stats): WorkspaceEntryRecord {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind: info.isDirectory() ? "directory" : "file",
    size: info.isDirectory() ? 0 : info.size,
    modifiedAt: info.mtimeMs,
    revision: metadataFileRevision(info),
    generated: isGeneratedPath(path)
  };
}

function requireWorkspaceEntryRevision(value: string): void {
  if (value.trim() === "") {
    throw new WorkspaceEntryMutationError("A workspace entry revision fence is required.", "invalid");
  }
}

function assertWorkspaceEntryRevision(info: Stats, expectedRevision: string): void {
  if (metadataFileRevision(info) !== expectedRevision) {
    throw new WorkspaceEntryMutationError("The workspace entry changed; refresh Files before trying again.", "stale");
  }
}

function assertSameWorkspaceMutationEntry(
  expected: WorkspaceResolvedMutationEntry,
  actual: WorkspaceResolvedMutationEntry,
  expectedRevision: string
): void {
  if (expected.absolute !== actual.absolute || !sameFilesystemIdentity(expected.info, actual.info)) {
    throw new WorkspaceEntryMutationError("The workspace entry identity changed before the mutation.", "stale");
  }
  assertWorkspaceEntryRevision(actual.info, expectedRevision);
}

function assertSafeWorkspaceMutationInfo(info: Stats): void {
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
    throw new WorkspaceEntryMutationError("Workspace mutations support only real regular files and directories.", "unsupported");
  }
  if (info.isFile() && info.nlink !== 1) {
    throw new WorkspaceEntryMutationError("Hard-linked workspace files cannot be mutated through the file API.", "unsafe");
  }
}

function sameFilesystemIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function filesystemEntryExists(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return code === "EEXIST" || code === "ENOTEMPTY";
}

function workspaceEntryMutationErrorCode(kind: WorkspaceEntryMutationErrorKind): string {
  switch (kind) {
    case "invalid": return "WORKSPACE_ENTRY_INVALID";
    case "stale": return "WORKSPACE_ENTRY_STALE";
    case "not_found": return "WORKSPACE_ENTRY_NOT_FOUND";
    case "conflict": return "WORKSPACE_ENTRY_CONFLICT";
    case "unsupported": return "WORKSPACE_ENTRY_UNSUPPORTED";
    case "unsafe": return "WORKSPACE_ENTRY_UNSAFE";
    case "too_large": return "WORKSPACE_ENTRY_TOO_LARGE";
    case "effect_failed": return "WORKSPACE_ENTRY_EFFECT_FAILED";
  }
}

function workspaceEntryMutationRecovery(kind: WorkspaceEntryMutationErrorKind): string {
  switch (kind) {
    case "invalid": return "Choose a canonical relative workspace path and retry.";
    case "stale": return "Refresh Files, review the current entry, and retry with its new revision.";
    case "not_found": return "Refresh Files and choose an entry that still exists.";
    case "conflict": return "Choose a destination name that does not already exist.";
    case "unsupported": return "Use a regular file or directory with no symbolic-link components.";
    case "unsafe": return "Remove the unsafe link or special-path condition outside Joko before retrying.";
    case "too_large": return "Use a workspace-native tool for this unusually large copy.";
    case "effect_failed": return "Refresh Files and inspect the source and destination before retrying.";
  }
}

function workspaceEntryPostEffectError(message: string, cause: unknown): WorkspaceEntryMutationError {
  return new WorkspaceEntryMutationError(message, "effect_failed", {
    stateMayHaveChanged: true,
    cause
  });
}

function workspaceTextFileWriteErrorCode(
  kind: WorkspaceTextFileWriteError["kind"]
): WorkspaceTextFileWriteErrorCode {
  switch (kind) {
    case "invalid": return "WORKSPACE_TEXT_FILE_INVALID";
    case "stale": return "WORKSPACE_TEXT_FILE_STALE";
    case "unsupported": return "WORKSPACE_TEXT_FILE_UNSUPPORTED";
    case "too_large": return "WORKSPACE_TEXT_FILE_TOO_LARGE";
    case "write_failed": return "WORKSPACE_TEXT_FILE_WRITE_FAILED";
  }
}

function workspaceFilePreviewErrorCode(
  kind: WorkspaceFilePreviewError["kind"]
): WorkspaceFilePreviewErrorCode {
  switch (kind) {
    case "invalid": return "WORKSPACE_FILE_PREVIEW_INVALID";
    case "stale": return "WORKSPACE_FILE_PREVIEW_STALE";
    case "unsupported": return "WORKSPACE_FILE_PREVIEW_UNSUPPORTED";
    case "read_failed": return "WORKSPACE_FILE_PREVIEW_READ_FAILED";
  }
}

interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maximumOutput: number,
  accepted = new Set([0]),
  stdin?: string
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { cwd, windowsHide: true, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maximumOutput) {
        child.kill();
        reject(new Error("Process output exceeded its limit."));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", reject);
    if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Process timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? -1
      };
      if (!accepted.has(result.exitCode)) reject(new Error(`${executable} failed (${result.exitCode}): ${result.stderr.trim()}`));
      else resolvePromise(result);
    });
  });
}

interface BufferProcessResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number;
}

async function runProcessPrefix(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maximumStdout: number
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maximumStderr = 1024 * 1024;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = maximumStdout - stdoutBytes;
      if (remaining <= 0) return;
      const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      stdout.push(retained);
      stdoutBytes += retained.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maximumStderr) {
        fail(new Error("Process stderr exceeded its limit."));
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => fail(error));
    const timer = setTimeout(() => fail(new Error(`Process timed out after ${timeoutMs} ms.`)), timeoutMs);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? -1
      };
      if (result.exitCode !== 0) reject(new Error(`${executable} failed (${result.exitCode}): ${result.stderr.trim()}`));
      else resolvePromise(result);
    });
  });
}

async function runProcessBufferPrefix(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maximumStdout: number
): Promise<BufferProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maximumStderr = 1024 * 1024;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = maximumStdout - stdoutBytes;
      if (remaining <= 0) return;
      const retained = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      stdout.push(retained);
      stdoutBytes += retained.byteLength;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maximumStderr) {
        fail(new Error("Process stderr exceeded its limit."));
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", fail);
    const timer = setTimeout(() => fail(new Error(`Process timed out after ${timeoutMs} ms.`)), timeoutMs);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? -1
      };
      if (result.exitCode !== 0) reject(new Error(`${executable} failed (${result.exitCode}).`));
      else resolvePromise(result);
    });
  });
}

export function isSafeGitRevision(value: string, allowHead = true): boolean {
  if (value === "" || value.length > 300 || value.startsWith("-") || value === "@") return false;
  if (value === "HEAD") return allowHead;
  if (/^[0-9a-f]{40,64}$/iu.test(value)) return true;
  if (/[\0-\x20\x7f]/u.test(value)) return false;
  if (value.includes("\\") || value.includes("..") || value.includes("@{")) return false;
  if (/[~^:?*\[]/u.test(value) || value.includes("//") || value.endsWith("/") || value.endsWith(".")) return false;
  return true;
}

function isImmutableGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/iu.test(value);
}

function canonicalGitRelativePath(value: string): string {
  if (
    value === "" ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    isAbsolute(value) ||
    /^[a-z]:[\\/]/iu.test(value) ||
    value.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(value) ||
    (process.platform === "win32" && /[:*?"<>|]/u.test(value))
  ) {
    throw new WorkspaceGitReviewError("Review paths must be canonical workspace-relative paths.", "invalid");
  }
  const parts = value.split("/");
  if (
    parts.some((part) => part === "" || part === "." || part === "..") ||
    (process.platform === "win32" && parts.some((part) => part.endsWith(".") || part.endsWith(" ")))
  ) {
    throw new WorkspaceGitReviewError("Review paths must be canonical workspace-relative paths.", "invalid");
  }
  return value;
}

function literalGitPathspec(value: string): string {
  return `:(top,literal)${canonicalGitRelativePath(value)}`;
}

function quotedGitPatchPath(prefix: "a" | "b", path: string): string {
  const value = `${prefix}/${path}`;
  return /^[!-~]+$/u.test(value) && !/["\\]/u.test(value) ? value : JSON.stringify(value);
}

function syntheticUntrackedBinaryPatch(path: string, oid: string): string {
  const oldPath = quotedGitPatchPath("a", path);
  const newPath = quotedGitPatchPath("b", path);
  return [
    `diff --git ${oldPath} ${newPath}`,
    "new file mode 100644",
    `index ${"0".repeat(Math.min(oid.length, 40))}..${oid}`,
    `Binary files /dev/null and ${newPath} differ`,
    ""
  ].join("\n");
}

function normalizeMutableGitSource(source: WorkspaceGitHunkMutation["source"]): WorkspaceGitMutableSource {
  if (source === "index" || source === "staged") return "staged";
  if (source === "workingTree" || source === "unstaged") return "unstaged";
  throw new WorkspaceGitReviewError("Only staged or unstaged diffs can be changed.", "invalid");
}

function validateGitCommitMessage(value: string): string {
  if (
    value.trim() === "" ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value) ||
    Buffer.byteLength(value, "utf8") > WORKSPACE_GIT_COMMIT_MESSAGE_MAXIMUM_BYTES
  ) {
    throw new WorkspaceGitReviewError("Commit message must be non-empty, bounded UTF-8 text without NUL bytes.", "invalid");
  }
  return value;
}

function validateGitRemoteName(value: string): string {
  if (
    value === "." ||
    value === ".." ||
    value.length > 200 ||
    !/^[a-z0-9][a-z0-9._-]*$/iu.test(value)
  ) {
    throw new WorkspaceGitReviewError("A configured remote name is required.", "invalid");
  }
  return value;
}

function gitRemoteUrlContainsCredentials(value: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    try {
      const parsed = new URL(value);
      if (parsed.password !== "") return true;
      if ((scheme === "http" || scheme === "https" || scheme === "ftp") && parsed.username !== "") return true;
    } catch {
      // An unparseable configured URL is never accepted by the safe Review
      // path; Git can still be used directly from a terminal for it.
      return true;
    }
  }
  // Reject scp-like forms that embed a password/token before `@`, while
  // retaining ordinary SSH `git@host:path` destinations.
  return /^[^@/\\:]+:[^@/\\]+@/u.test(value);
}

function isNonFastForwardRejection(result: ProcessResult): boolean {
  return /non-fast-forward|fetch first|rejected.*\(fetch first\)|rejected.*\(non-fast-forward\)/iu
    .test(`${result.stdout}\n${result.stderr}`);
}

function isForceLeaseRejection(result: ProcessResult): boolean {
  return /stale info|rejected.*\(stale info\)/iu.test(`${result.stdout}\n${result.stderr}`);
}

function isRegularGitMode(value: string): boolean {
  return /^100[0-7]{3}$/u.test(value);
}

function isMissingFilesystemError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

export function isUnmergedGitStatus(status: string): boolean {
  return status === "U" || status === "DD" || status === "AU" || status === "UD" || status === "UA" || status === "DU" || status === "AA" || status === "UU";
}

function normalizeBranchCandidateRef(value: string): string | undefined {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("refs/remotes/")
    ? trimmed.slice("refs/remotes/".length)
    : trimmed.startsWith("remotes/") ? trimmed.slice("remotes/".length) : trimmed;
  return normalized === "" || !isSafeGitRevision(normalized, false) ? undefined : normalized;
}

function imageMediaType(path: string): string | undefined {
  return reviewImageRasterMimeByExtension.get(extname(path).toLowerCase());
}

function missingImageSide(path: string, mediaType = imageMediaType(path)): WorkspaceGitImageSide {
  return {
    present: false,
    tooLarge: false,
    path,
    ...(mediaType === undefined ? {} : { mediaType })
  };
}

function safeUtf8Prefix(bytes: Buffer, maximumBytes: number): Buffer {
  let end = Math.min(bytes.byteLength, maximumBytes);
  for (let attempts = 0; attempts < 4 && end >= 0; attempts += 1, end -= 1) {
    const candidate = bytes.subarray(0, end);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      return candidate;
    } catch {
      // A UTF-8 code point occupies at most four bytes.
    }
  }
  throw new WorkspaceGitReviewError("The selected diff is not valid UTF-8 text.", "unsupported");
}

function uniquePaths(oldPath: string | undefined, path: string): readonly string[] {
  return [...new Set([oldPath, path].filter((value): value is string => value !== undefined && value !== ""))];
}

export function selectDiffFilePatch(raw: string): string {
  const normalized = raw.replace(/\r\n/gu, "\n");
  const fileCount = normalized.split("\n").filter((line) => line.startsWith("diff --git ")).length;
  if (fileCount !== 1) {
    throw new WorkspaceGitReviewError("The selected file diff is stale or ambiguous.", "stale");
  }
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export function selectDiffHunkPatch(raw: string, hunkIndex: number): string {
  const normalized = raw.replace(/\r\n/gu, "\n");
  const fileStarts: number[] = [];
  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("diff --git ") === true) fileStarts.push(index);
  }
  if (fileStarts.length !== 1) {
    throw new WorkspaceGitReviewError("The selected file diff is stale or ambiguous.", "stale");
  }
  const hunkStarts: number[] = [];
  for (let index = fileStarts[0]!; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("@@ ") === true) hunkStarts.push(index);
  }
  const selectedStart = hunkStarts[hunkIndex];
  if (selectedStart === undefined) throw new WorkspaceGitReviewError("The selected hunk is stale.", "stale");
  const selectedEnd = hunkStarts[hunkIndex + 1] ?? lines.length;
  const header = lines.slice(fileStarts[0], hunkStarts[0]);
  const selected = lines.slice(selectedStart, selectedEnd);
  while (selected.at(-1) === "") selected.pop();
  return `${[...header, ...selected].join("\n")}\n`;
}

/**
 * Exact audited FileBodyView inline-image set. Git Review intentionally accepts
 * additional raster extensions, so its broader shared map must not be reused.
 */
const WORKSPACE_RASTER_MEDIA_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"]
]);

const WORKSPACE_BINARY_MEDIA_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".opus", "audio/ogg"],
  [".mp4", "video/mp4"],
  [".m4v", "video/x-m4v"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".avi", "video/x-msvideo"],
  [".mkv", "video/x-matroska"]
]);

/** The code/Markdown filename surface must remain text even when a
 * preview window is shorter than the file. Unknown extensions still use the
 * bounded UTF-8 probe below and therefore remain fail-closed when oversized. */
const WORKSPACE_KNOWN_TEXT_EXTENSIONS = new Set([
  ".txt", ".log", ".csv", ".tsv",
  ".json", ".jsonc", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".cs", ".scala", ".sc",
  ".groovy", ".gradle", ".pl", ".pm", ".r", ".hs", ".proto", ".php",
  ".dart", ".lua", ".sh", ".bash", ".zsh", ".ps1",
  ".yaml", ".yml", ".toml", ".ini",
  ".html", ".htm", ".vue", ".svelte",
  ".css", ".scss", ".sass", ".less", ".sql", ".graphql", ".gql",
  ".diff", ".patch", ".dockerfile", ".makefile", ".mk"
]);
const WORKSPACE_MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);

function workspaceMediaPreviewLimit(path: string): number | undefined {
  const extension = extname(path).toLowerCase();
  if (WORKSPACE_RASTER_MEDIA_BY_EXTENSION.has(extension)) return WORKSPACE_RASTER_PREVIEW_MAXIMUM_BYTES;
  if (extension === ".pdf") return WORKSPACE_PDF_PREVIEW_MAXIMUM_BYTES;
  return undefined;
}

function inferMediaType(path: string): string {
  const extension = extname(path).toLowerCase();
  const fileName = basename(path).toLowerCase();
  if (fileName === "dockerfile" || fileName === "makefile") return "text/plain";
  if (WORKSPACE_MARKDOWN_EXTENSIONS.has(extension)) return "text/markdown";
  if (extension === ".json" || extension === ".jsonc") return "application/json";
  if (WORKSPACE_KNOWN_TEXT_EXTENSIONS.has(extension)) return "text/plain";
  if (extension === ".xml" || extension === ".drawio") return "application/xml";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".glb") return "model/gltf-binary";
  if (extension === ".gltf") return "model/gltf+json";
  if (extension === ".ktx2") return "image/ktx2";
  const rasterMediaType = WORKSPACE_RASTER_MEDIA_BY_EXTENSION.get(extension);
  if (rasterMediaType !== undefined) return rasterMediaType;
  if (extension === ".pdf") return "application/pdf";
  const binaryMediaType = WORKSPACE_BINARY_MEDIA_BY_EXTENSION.get(extension);
  if (binaryMediaType !== undefined) return binaryMediaType;
  return "application/octet-stream";
}

function isTextMediaType(value: string): boolean {
  return value.startsWith("text/") || value === "application/json" || value === "application/xml" || value === "image/svg+xml";
}

function isGeneratedPath(path: string): boolean {
  return /(^|\/)(dist|build|coverage|generated|\.next|\.vite)(\/|$)/i.test(toSlash(path));
}

function toSlash(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeRelativePath(value: string): string {
  const slash = toSlash(value);
  return slash.replace(/^(?:\.\/)+/u, "");
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function fileHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function newWorkspaceId(): string {
  return randomUUID();
}
