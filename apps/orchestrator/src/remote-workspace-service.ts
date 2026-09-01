import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { posix as remotePath } from "node:path";

import { workspaceEntryAbsentRevision } from "@joko/contracts";
import type {
  RemoteDirectoryEntry,
  RemoteFileStat,
  RemoteFileTransportPort,
  RemoteProcessHandle,
  RemoteProcessTransportPort
} from "@joko/remote-ssh";

import type { RemoteHostRegistry } from "./remote-host-registry.js";
import {
  WORKSPACE_GIT_COMMIT_MESSAGE_MAXIMUM_BYTES,
  WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES,
  WORKSPACE_TEXT_FILE_MAXIMUM_BYTES,
  WorkspaceEntryMutationError,
  WorkspaceFilePreviewError,
  WorkspaceGitReviewError,
  WorkspaceScanError,
  WorkspaceSearchError,
  WorkspaceTextFileWriteError,
  fileHash,
  selectDiffFilePatch,
  selectDiffHunkPatch,
  type GitState,
  type RemoteWorkspaceDelegate,
  type WorkspaceEntryListingOptions,
  type WorkspaceEntryMutationResult,
  type WorkspaceEntryRecord,
  type WorkspaceFileIndex,
  type WorkspaceFilePreview,
  type WorkspaceGitCommitResult,
  type WorkspaceGitDiff,
  type WorkspaceGitHunkMutation,
  type WorkspaceGitImagePreview,
  type WorkspaceGitImageSide,
  type WorkspaceGitMutation,
  type WorkspaceGitPushResult,
  type WorkspaceGitReviewDiffInput,
  type WorkspaceRegistration,
  type WorkspaceSearchOptions,
  type WorkspaceSearchPage,
  type WorkspaceSearchResult,
  type WorkspaceSearchStreamEvent,
  type WorkspaceTextFileWriteInput,
  type WorkspaceTextFileWriteResult
} from "./workspace-service.js";
import type { WorkspaceFileChangeRecord, WorkspaceFileChangeScope } from "./workspace-change-stream.js";

const MAXIMUM_PROCESS_OUTPUT = 16 * 1024 * 1024;
const MAXIMUM_TREE_ENTRIES = 100_000;
const MAXIMUM_COPY_BYTES = 256 * 1024 * 1024;

export class RemoteWorkspaceService implements RemoteWorkspaceDelegate {
  readonly #registry: RemoteHostRegistry;
  readonly #registrations = new Map<string, WorkspaceRegistration>();
  #closed = false;

  constructor(registry: RemoteHostRegistry) {
    this.#registry = registry;
  }

  async register(input: WorkspaceRegistration): Promise<WorkspaceRegistration> {
    this.#assertOpen();
    const remote = input.remote;
    if (remote === undefined || remote.workspaceRoot !== input.root) {
      throw new Error("Remote workspace registration is incomplete.");
    }
    const transports = await this.#transports(input);
    const canonical = await transports.files.realpath(remote.workspaceRoot);
    if (canonical !== remote.workspaceRoot || (await transports.files.stat(canonical)).kind !== "directory") {
      throw new Error("Remote workspace root must be a canonical directory.");
    }
    const registration = Object.freeze({ ...input, root: canonical });
    this.#registrations.set(input.id, registration);
    return registration;
  }

  unregister(id: string): void {
    this.#registrations.delete(id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#registrations.clear();
  }

  async invoke<Result>(workspaceId: string, method: string, args: readonly unknown[]): Promise<Result> {
    this.#assertOpen();
    const registration = this.#require(workspaceId);
    const transports = await this.#transports(registration);
    let result: unknown;
    switch (method) {
      case "list": result = await this.#list(registration, transports.files, args[0] as string, args[1] as WorkspaceEntryListingOptions | undefined); break;
      case "preview": result = await this.#preview(registration, transports.files, args[0] as string, args[1] as number); break;
      case "materializeFile": result = await this.#materialize(registration, transports.files, args); break;
      case "listFiles": result = await this.#listFiles(registration, transports.files); break;
      case "writeTextFile": result = await this.#writeTextFile(registration, transports.files, args[0] as WorkspaceTextFileWriteInput); break;
      case "createEntry": result = await this.#createEntry(registration, transports.files, args[0] as { path: string; kind: "file" | "directory"; expectedRevision: string }); break;
      case "moveEntry": result = await this.#moveEntry(registration, transports.files, args[0] as { sourcePath: string; destinationPath: string; expectedRevision: string }); break;
      case "deleteEntry": result = await this.#deleteEntry(registration, transports.files, args[0] as { path: string; expectedRevision: string; confirmRecursive: boolean }); break;
      case "copyEntry": result = await this.#copyEntry(registration, transports.files, args[0] as { sourcePath: string; destinationPath: string; expectedRevision: string }); break;
      case "search": result = (await this.#searchPage(registration, transports, args[0] as string, args[1] as WorkspaceSearchOptions | undefined)).matches; break;
      case "searchPage": result = await this.#searchPage(registration, transports, args[0] as string, args[1] as WorkspaceSearchOptions | undefined); break;
      case "gitState": result = await this.#gitState(registration, transports.processes); break;
      case "gitDiff": result = await this.#gitDiff(registration, transports.processes, args[0] as readonly string[], args[1] as Record<string, unknown>); break;
      case "gitReviewDiff": result = await this.#gitReviewDiff(registration, transports.processes, args[0] as WorkspaceGitReviewDiffInput); break;
      case "readGitDiffFile": result = await this.#readGitDiffFile(registration, transports, args[0] as RemoteGitDiffFileInput); break;
      case "readGitReviewFile": result = await this.#readGitReviewFile(registration, transports, args[0] as RemoteGitReviewFileInput); break;
      case "readGitDiffImage": result = await this.#readGitDiffImage(registration, transports, args[0] as RemoteGitImageInput); break;
      case "applyGitDiffHunk": result = await this.#applyGitDiffHunk(registration, transports.processes, args[0] as WorkspaceGitHunkMutation); break;
      case "applyGitDiff": result = await this.#applyGitDiff(registration, transports.processes, args[0] as WorkspaceGitMutation); break;
      case "commitGitReview": result = await this.#commit(registration, transports.processes, args[0] as { message: string; expectedRepositoryRevision: string; includeUnstaged?: boolean }); break;
      case "pushGitReview": result = await this.#push(registration, transports.processes, args[0] as RemoteGitPushInput); break;
      default: throw new Error("Remote workspace operation is unavailable.");
    }
    return result as Result;
  }

  async *stream<Result>(workspaceId: string, method: string, args: readonly unknown[]): AsyncGenerator<Result> {
    if (method !== "searchStream") throw new Error("Remote workspace stream is unavailable.");
    const options: WorkspaceSearchOptions = { caseSensitive: args[1] as boolean };
    const page = await this.invoke<WorkspaceSearchPage>(workspaceId, "searchPage", [args[0], options]);
    for (const match of page.matches) yield { kind: "match", match } as Result;
    yield {
      kind: "end",
      truncated: page.truncated,
      totalResults: page.totalResults,
      totalFiles: page.totalFiles,
      revision: page.revision
    } as Result;
  }

  async *watchChanges(scope: WorkspaceFileChangeScope, signal?: AbortSignal): AsyncGenerator<WorkspaceFileChangeRecord> {
    if (scope.kind !== "workspace") throw new Error("Remote workspace owner-wide watch is unavailable.");
    let sequence = 0n;
    let previous = await this.invoke<WorkspaceFileIndex>(scope.workspaceId, "listFiles", [signal]);
    while (signal?.aborted !== true && !this.#closed) {
      await abortableDelay(2_000, signal);
      if (isAborted(signal)) return;
      const current = await this.invoke<WorkspaceFileIndex>(scope.workspaceId, "listFiles", [signal]);
      if (current.revision === previous.revision) continue;
      sequence += 1n;
      yield {
        workspaceId: scope.workspaceId,
        kind: "resync",
        observedAt: Date.now(),
        sequence,
        streamRevision: current.revision
      };
      previous = current;
    }
  }

  async #list(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    directory = "",
    options?: WorkspaceEntryListingOptions
  ): Promise<readonly WorkspaceEntryRecord[]> {
    const start = remoteWorkspacePath(registration.root, directory, true);
    const maximum = Math.min(Math.max(options?.maximumEntries ?? 10_000, 1), MAXIMUM_TREE_ENTRIES);
    const output: WorkspaceEntryRecord[] = [];
    const visit = async (absolute: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 128) throw new WorkspaceScanError("Remote workspace tree is too deep.", "limit");
      const entries = [...await files.list(absolute)].sort(compareRemoteEntries);
      for (const entry of entries) {
        if (!safeEntryName(entry.name) || entry.kind === "symbolic_link" || entry.kind === "other") continue;
        if (entry.name === ".git") continue;
        const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const path = remotePath.join(absolute, entry.name);
        const info = await files.stat(path);
        if (info.kind !== "file" && info.kind !== "directory") continue;
        if (output.length >= maximum) throw new WorkspaceScanError("Remote workspace listing exceeded its limit.", "limit");
        output.push(remoteEntry(relativePath, info));
        if (info.kind === "directory" && options?.recursive === true) await visit(path, relativePath, depth + 1);
      }
    };
    await visit(start, canonicalRelative(directory, true), 0);
    return output;
  }

  async #preview(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    relativePath: string,
    maximumBytes: number
  ): Promise<WorkspaceFilePreview> {
    const path = remoteWorkspacePath(registration.root, relativePath, false);
    const before = await files.stat(path);
    if (before.kind !== "file") throw new WorkspaceFilePreviewError("Remote preview requires a regular file.", "unsupported");
    const limit = Math.min(Math.max(maximumBytes, 1), 32 * 1024 * 1024);
    const mediaType = inferRemoteMediaType(relativePath);
    if (!isTextMediaType(mediaType) && before.size > limit) {
      const after = await files.stat(path);
      if (remoteRevision(before) !== remoteRevision(after)) {
        throw new WorkspaceFilePreviewError("Remote file changed while it was read.", "stale");
      }
      return {
        entry: remoteEntry(canonicalRelative(relativePath), after),
        mediaType,
        truncated: false
      };
    }
    const bytes = Buffer.from(await files.read({
      path,
      maximumBytes: Math.min(Math.max(before.size, 1), limit),
      allowTruncated: true
    }));
    const after = await files.stat(path);
    if (remoteRevision(before) !== remoteRevision(after)) {
      throw new WorkspaceFilePreviewError("Remote file changed while it was read.", "stale");
    }
    const entry = remoteEntry(canonicalRelative(relativePath), after, contentRevision(bytes));
    if (isTextMediaType(mediaType)) {
      if (bytes.includes(0)) throw new WorkspaceFilePreviewError("Remote file is not valid text.", "unsupported");
      return { entry, mediaType, text: bytes.toString("utf8"), truncated: before.size > bytes.byteLength };
    }
    return { entry, mediaType, bytes, truncated: before.size > bytes.byteLength };
  }

  async #materialize(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    args: readonly unknown[]
  ): Promise<unknown> {
    const [relativePath, expectedRevision, ingest, signal] = args as [
      string,
      string,
      (handle: Awaited<ReturnType<typeof open>>, options: {
        expectedSize: number;
        signal?: AbortSignal;
        beforeFinalize: (snapshot: { sha256: string; byteLength: number }) => Promise<void>;
      }) => Promise<unknown>,
      AbortSignal | undefined
    ];
    signal?.throwIfAborted();
    const path = remoteWorkspacePath(registration.root, relativePath, false);
    const before = await files.stat(path, signal);
    if (before.kind !== "file" || before.size > 64 * 1024 * 1024) {
      throw new WorkspaceFilePreviewError("Remote download requires a bounded regular file.", "unsupported");
    }
    const content = Buffer.from(await files.read({ path, maximumBytes: Math.max(before.size, 1), signal }));
    const revision = contentRevision(content);
    if (expectedRevision !== revision && expectedRevision !== remoteRevision(before)) {
      throw new WorkspaceFilePreviewError("Remote file changed before download.", "stale");
    }
    const directory = await mkdtemp(pathModuleJoin(tmpdir(), "joko-remote-workspace-"));
    const staged = pathModuleJoin(directory, "artifact");
    await writeFile(staged, content, { mode: 0o600 });
    const handle = await open(staged, "r");
    try {
      return await ingest(handle, {
        expectedSize: content.byteLength,
        ...(signal === undefined ? {} : { signal }),
        beforeFinalize: async (snapshot) => {
          signal?.throwIfAborted();
          const current = await files.stat(path, signal);
          if (remoteRevision(current) !== remoteRevision(before) || snapshot.sha256 !== fileHash(content)) {
            throw new WorkspaceFilePreviewError("Remote file changed while it was downloaded.", "stale");
          }
        }
      });
    } finally {
      await handle.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  async #listFiles(registration: WorkspaceRegistration, files: RemoteFileTransportPort): Promise<WorkspaceFileIndex> {
    const entries = await this.#list(registration, files, "", { recursive: true, maximumEntries: MAXIMUM_TREE_ENTRIES });
    const paths = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path).sort();
    return { paths, truncated: false, revision: hashText(paths.join("\0")) };
  }

  async #writeTextFile(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    input: WorkspaceTextFileWriteInput
  ): Promise<WorkspaceTextFileWriteResult> {
    const path = remoteWorkspacePath(registration.root, input.path, false);
    const beforeInfo = await files.stat(path);
    if (beforeInfo.kind !== "file") throw new WorkspaceTextFileWriteError("Remote text save requires a regular file.", "unsupported");
    const before = Buffer.from(await files.read({ path, maximumBytes: Math.max(beforeInfo.size, 1) }));
    const beforeRevision = contentRevision(before);
    if (input.expectedRevision !== beforeRevision && input.expectedRevision !== remoteRevision(beforeInfo)) {
      throw new WorkspaceTextFileWriteError("Remote file changed; read it again before saving.", "stale");
    }
    const content = Buffer.from(input.text, "utf8");
    if (content.byteLength > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES || input.text.includes("\0")) {
      throw new WorkspaceTextFileWriteError("Remote text exceeds the save limit.", "too_large");
    }
    const current = await files.stat(path);
    if (remoteRevision(current) !== remoteRevision(beforeInfo)) {
      throw new WorkspaceTextFileWriteError("Remote file changed; read it again before saving.", "stale");
    }
    await files.write({ path, content, mode: beforeInfo.mode & 0o777, atomic: true });
    const after = await files.stat(path);
    const revision = contentRevision(content);
    return {
      entry: remoteEntry(canonicalRelative(input.path), after, revision),
      mediaType: inferRemoteMediaType(input.path),
      previousRevision: beforeRevision,
      revision
    };
  }

  async #createEntry(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    input: { path: string; kind: "file" | "directory"; expectedRevision: string }
  ): Promise<WorkspaceEntryMutationResult> {
    if (input.expectedRevision !== workspaceEntryAbsentRevision) {
      throw new WorkspaceEntryMutationError("Remote creation requires an absent revision fence.", "invalid");
    }
    const path = remoteWorkspacePath(registration.root, input.path, false);
    await expectMissing(files, path);
    if (input.kind === "directory") await files.mkdir(path, { recursive: false, mode: 0o755 });
    else await files.write({ path, content: new Uint8Array(), mode: 0o644, atomic: true });
    return { entry: remoteEntry(canonicalRelative(input.path), await files.stat(path)) };
  }

  async #moveEntry(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    input: { sourcePath: string; destinationPath: string; expectedRevision: string }
  ): Promise<WorkspaceEntryMutationResult> {
    const source = remoteWorkspacePath(registration.root, input.sourcePath, false);
    const destination = remoteWorkspacePath(registration.root, input.destinationPath, false);
    const before = await files.stat(source);
    assertRemoteRevision(before, input.expectedRevision);
    await expectMissing(files, destination);
    await files.rename(source, destination);
    return { entry: remoteEntry(canonicalRelative(input.destinationPath), await files.stat(destination)) };
  }

  async #deleteEntry(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    input: { path: string; expectedRevision: string; confirmRecursive: boolean }
  ): Promise<void> {
    const path = remoteWorkspacePath(registration.root, input.path, false);
    const before = await files.stat(path);
    assertRemoteRevision(before, input.expectedRevision);
    if (before.kind === "directory" && !input.confirmRecursive) {
      throw new WorkspaceEntryMutationError("Recursive remote deletion requires confirmation.", "unsafe");
    }
    await files.remove(path, { recursive: before.kind === "directory" });
  }

  async #copyEntry(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    input: { sourcePath: string; destinationPath: string; expectedRevision: string }
  ): Promise<WorkspaceEntryMutationResult> {
    const source = remoteWorkspacePath(registration.root, input.sourcePath, false);
    const destination = remoteWorkspacePath(registration.root, input.destinationPath, false);
    const before = await files.stat(source);
    assertRemoteRevision(before, input.expectedRevision);
    await expectMissing(files, destination);
    const budget = { entries: 0, bytes: 0 };
    await copyRemoteTree(files, source, destination, budget);
    const current = await files.stat(source);
    if (remoteRevision(current) !== remoteRevision(before)) {
      await files.remove(destination, { recursive: true }).catch(() => undefined);
      throw new WorkspaceEntryMutationError("Remote source changed while it was copied.", "stale");
    }
    return { entry: remoteEntry(canonicalRelative(input.destinationPath), await files.stat(destination)) };
  }

  async #searchPage(
    registration: WorkspaceRegistration,
    transports: RemoteTransports,
    query: string,
    options?: WorkspaceSearchOptions
  ): Promise<WorkspaceSearchPage> {
    const value = query.trim();
    if (value === "") return { matches: [], totalResults: 0, totalFiles: 0, truncated: false, revision: hashText("") };
    const maximum = Math.min(Math.max(options?.maximumResults ?? 1_000, 1), 5_000);
    const args = ["--json", "--hidden", "--glob", "!.git/**", "--max-count", "200"];
    if (options?.caseSensitive !== true) args.push("--ignore-case");
    if (options?.regularExpression !== true) args.push("--fixed-strings");
    if (options?.glob !== undefined) args.push("--glob", options.glob);
    args.push("--", value, ".");
    let output: string;
    try {
      output = (await runRemote(transports.processes, "rg", args, registration.root, 60_000, MAXIMUM_PROCESS_OUTPUT, undefined, new Set([0, 1]))).stdout;
    } catch {
      throw new WorkspaceSearchError("Remote workspace search failed.", "search_failed");
    }
    const matches = parseRipgrepJson(output, maximum + (options?.offset ?? 0));
    const offset = Math.min(Math.max(options?.offset ?? 0, 0), matches.length);
    const selected = matches.slice(offset, offset + maximum);
    const files = new Set(matches.map((match) => match.path));
    const revision = hashText(JSON.stringify(matches));
    return {
      matches: selected,
      totalResults: matches.length,
      totalFiles: files.size,
      truncated: offset + selected.length < matches.length,
      ...(offset + selected.length < matches.length ? { nextOffset: offset + selected.length } : {}),
      revision
    };
  }

  async #gitState(registration: WorkspaceRegistration, processes: RemoteProcessTransportPort): Promise<GitState> {
    const result = await runRemote(processes, "git", ["status", "--porcelain=v1", "-z", "--branch"], registration.root, 20_000, 4 * 1024 * 1024);
    const records = result.stdout.split("\0").filter(Boolean);
    const branchLine = records.shift() ?? "";
    const changes = records.map(parseGitStatus).filter((value): value is NonNullable<typeof value> => value !== undefined);
    const branchMatch = /^## (.+?)(?:\.\.\.|$)/u.exec(branchLine)?.[1];
    const head = await gitOptional(processes, registration.root, ["rev-parse", "HEAD"]);
    const operationInProgress = await gitOperationInProgress(processes, registration.root);
    return {
      repository: true,
      ...(branchMatch === undefined || branchMatch === "HEAD (no branch)" ? {} : { branch: branchMatch }),
      ...(head === undefined ? {} : { head }),
      detachedHead: branchLine.startsWith("## HEAD (no branch)"),
      operationInProgress,
      unmerged: changes.some((change) => change.index === "U" || change.worktree === "U"),
      dirty: changes.length > 0,
      changes
    };
  }

  async #gitDiff(
    registration: WorkspaceRegistration,
    processes: RemoteProcessTransportPort,
    paths: readonly string[] = [],
    options: { baseRevision?: unknown; headRevision?: unknown; ignoreWhitespace?: unknown } = {}
  ): Promise<WorkspaceGitDiff> {
    const revision = await repositoryRevision(processes, registration.root);
    const pathArgs = paths.length === 0 ? [] : ["--", ...paths.map((value) => canonicalRelative(value))];
    const whitespace = options.ignoreWhitespace === true ? ["--ignore-all-space"] : [];
    const workingTree = (await runRemote(processes, "git", ["diff", "--no-ext-diff", ...whitespace, ...pathArgs], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    const index = (await runRemote(processes, "git", ["diff", "--cached", "--no-ext-diff", ...whitespace, ...pathArgs], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    const base = typeof options.baseRevision === "string" && options.baseRevision !== "" ? options.baseRevision : undefined;
    const head = typeof options.headRevision === "string" && options.headRevision !== "" ? options.headRevision : undefined;
    const comparison = base === undefined
      ? ""
      : (await runRemote(processes, "git", ["diff", "--no-ext-diff", ...whitespace, base, head ?? "HEAD", ...pathArgs], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    return {
      index,
      workingTree,
      comparison,
      repositoryRevision: revision,
      ...(base === undefined ? {} : { baseRevision: base }),
      ...(head === undefined ? {} : { headRevision: head })
    };
  }

  async #gitReviewDiff(
    registration: WorkspaceRegistration,
    processes: RemoteProcessTransportPort,
    input: WorkspaceGitReviewDiffInput
  ): Promise<WorkspaceGitDiff> {
    const current = await this.#gitDiff(registration, processes);
    if (input.expectedRepositoryRevision !== undefined && input.expectedRepositoryRevision !== current.repositoryRevision) {
      throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    }
    if (input.source === "unstaged") return { ...current, index: "", comparison: "" };
    if (input.source === "staged") return { ...current, workingTree: "", comparison: "" };
    const source = input.sourceRevision;
    if (source === undefined || !immutableRevision(source)) throw new WorkspaceGitReviewError("Remote Review source is invalid.", "invalid");
    if (input.source === "commit") {
      const base = await gitOptional(processes, registration.root, ["rev-parse", `${source}^`]);
      const comparison = (await runRemote(processes, "git", ["show", "--format=", "--no-ext-diff", source], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
      return { ...current, index: "", workingTree: "", comparison, headRevision: source, ...(base === undefined ? {} : { baseRevision: base }), source: "commit", sourceRevision: source };
    }
    const mergeBase = (await runRemote(processes, "git", ["merge-base", "HEAD", source], registration.root, 20_000, 1024 * 1024)).stdout.trim();
    const head = (await runRemote(processes, "git", ["rev-parse", "HEAD"], registration.root, 20_000, 1024 * 1024)).stdout.trim();
    const comparison = (await runRemote(processes, "git", ["diff", "--no-ext-diff", mergeBase, head], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    return { ...current, index: "", workingTree: "", comparison, baseRevision: mergeBase, headRevision: head, mergeBaseRevision: mergeBase, source: "branch", sourceRevision: source };
  }

  async #readGitDiffFile(
    registration: WorkspaceRegistration,
    transports: RemoteTransports,
    input: RemoteGitDiffFileInput
  ): Promise<{ text: string; truncated: boolean; repositoryRevision: string }> {
    const current = await repositoryRevision(transports.processes, registration.root);
    if (current !== input.expectedRepositoryRevision) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    const path = canonicalRelative(input.path);
    let bytes: Buffer;
    if (input.source === "workingTree") {
      const absolute = remoteWorkspacePath(registration.root, path, false);
      const info = await transports.files.stat(absolute);
      bytes = Buffer.from(await transports.files.read({
        path: absolute,
        maximumBytes: Math.min(Math.max(info.size, 1), (input.maximumBytes ?? WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) + 1),
        allowTruncated: true
      }));
    } else {
      const object = input.source === "index" ? `:${path}` : `${input.headRevision ?? "HEAD"}:${path}`;
      bytes = Buffer.from((await runRemote(transports.processes, "git", ["show", object], registration.root, 20_000, (input.maximumBytes ?? WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) + 1)).stdout, "utf8");
    }
    if (bytes.includes(0)) throw new WorkspaceGitReviewError("Remote Review file is binary.", "unsupported");
    const maximum = input.maximumBytes ?? WORKSPACE_TEXT_FILE_MAXIMUM_BYTES;
    return { text: bytes.subarray(0, maximum).toString("utf8"), truncated: bytes.byteLength > maximum, repositoryRevision: current };
  }

  async #readGitReviewFile(
    registration: WorkspaceRegistration,
    transports: RemoteTransports,
    input: RemoteGitReviewFileInput
  ): Promise<{ text: string; truncated: boolean; repositoryRevision: string; mergeBaseRevision?: string }> {
    const source = input.source === "unstaged" ? "workingTree" : input.source === "staged" ? "index" : "comparison";
    const file = await this.#readGitDiffFile(registration, transports, {
      path: input.path,
      source,
      expectedRepositoryRevision: input.expectedRepositoryRevision,
      ...(input.sourceRevision === undefined ? {} : { headRevision: input.sourceRevision }),
      ...(input.maximumBytes === undefined ? {} : { maximumBytes: input.maximumBytes })
    });
    return { ...file, ...(input.expectedMergeBaseRevision === undefined ? {} : { mergeBaseRevision: input.expectedMergeBaseRevision }) };
  }

  async #readGitDiffImage(
    registration: WorkspaceRegistration,
    transports: RemoteTransports,
    input: RemoteGitImageInput
  ): Promise<WorkspaceGitImagePreview> {
    const current = await repositoryRevision(transports.processes, registration.root);
    if (current !== input.expectedRepositoryRevision) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    const read = async (objectPath: string | undefined): Promise<WorkspaceGitImageSide> => {
      if (objectPath === undefined) return { present: false, tooLarge: false };
      const result = await runRemote(transports.processes, "git", ["show", objectPath], registration.root, 20_000, WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES + 1, undefined, new Set([0, 128]));
      if (result.exitCode !== 0) return { present: false, tooLarge: false };
      const bytes = result.stdoutBytes;
      return { present: true, tooLarge: bytes.byteLength > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES, path: input.path, mediaType: inferRemoteMediaType(input.path), ...(bytes.byteLength > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES ? {} : { bytes }) };
    };
    const tree = input.sourceRevision ?? "HEAD";
    const oldImage = await read(`${tree}:${input.oldPath ?? input.path}`);
    let newImage: WorkspaceGitImageSide;
    if (input.source === "unstaged") {
      const absolute = remoteWorkspacePath(registration.root, input.path, false);
      try {
        const info = await transports.files.stat(absolute);
        const bytes = Buffer.from(await transports.files.read({
          path: absolute,
          maximumBytes: Math.min(Math.max(info.size, 1), WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES + 1),
          allowTruncated: true
        }));
        newImage = { present: true, tooLarge: bytes.byteLength > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES, path: input.path, mediaType: inferRemoteMediaType(input.path), ...(bytes.byteLength > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES ? {} : { bytes }) };
      } catch { newImage = { present: false, tooLarge: false }; }
    } else newImage = await read(input.source === "staged" ? `:${input.path}` : `${tree}:${input.path}`);
    return { oldImage, newImage, repositoryRevision: current, ...(input.expectedMergeBaseRevision === undefined ? {} : { mergeBaseRevision: input.expectedMergeBaseRevision }) };
  }

  async #applyGitDiffHunk(registration: WorkspaceRegistration, processes: RemoteProcessTransportPort, input: WorkspaceGitHunkMutation): Promise<string> {
    return this.#applyGitDiff(registration, processes, {
      ...input,
      source: mutableGitSource(input.source),
      target: "hunk"
    });
  }

  async #applyGitDiff(registration: WorkspaceRegistration, processes: RemoteProcessTransportPort, input: WorkspaceGitMutation): Promise<string> {
    const current = await repositoryRevision(processes, registration.root);
    if (current !== input.expectedRepositoryRevision) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    const path = canonicalRelative(input.path);
    if (input.target === "file") {
      if (input.action === "stage") await runRemote(processes, "git", ["add", "--", path], registration.root, 20_000, 4 * 1024 * 1024);
      else if (input.action === "unstage") await runRemote(processes, "git", ["restore", "--staged", "--", path], registration.root, 20_000, 4 * 1024 * 1024);
      else {
        if (input.confirmRevert !== true) throw new WorkspaceGitReviewError("Remote revert requires confirmation.", "invalid");
        await runRemote(processes, "git", ["restore", "--", path], registration.root, 20_000, 4 * 1024 * 1024);
      }
      return repositoryRevision(processes, registration.root);
    }
    const raw = (await runRemote(processes, "git", input.source === "staged" ? ["diff", "--cached", "--", path] : ["diff", "--", path], registration.root, 20_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    const patch = selectDiffHunkPatch(selectDiffFilePatch(raw), input.hunkIndex ?? -1);
    const args = ["apply", "--whitespace=nowarn"];
    if (input.action !== "revert") args.push("--cached");
    if (input.action === "unstage" || input.action === "revert") args.push("--reverse");
    await runRemote(processes, "git", [...args, "-"], registration.root, 20_000, 4 * 1024 * 1024, patch);
    return repositoryRevision(processes, registration.root);
  }

  async #commit(registration: WorkspaceRegistration, processes: RemoteProcessTransportPort, input: { message: string; expectedRepositoryRevision: string; includeUnstaged?: boolean }): Promise<WorkspaceGitCommitResult> {
    if (input.message.trim() === "" || Buffer.byteLength(input.message) > WORKSPACE_GIT_COMMIT_MESSAGE_MAXIMUM_BYTES || input.message.includes("\0")) {
      throw new WorkspaceGitReviewError("Remote commit message is invalid.", "invalid");
    }
    const before = await repositoryRevision(processes, registration.root);
    if (before !== input.expectedRepositoryRevision) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    if (input.includeUnstaged === true) await runRemote(processes, "git", ["add", "-A", "--", ":/"], registration.root, 120_000, 4 * 1024 * 1024);
    await runRemote(processes, "git", ["commit", "-F", "-"], registration.root, 120_000, 4 * 1024 * 1024, input.message);
    const headRevision = (await runRemote(processes, "git", ["rev-parse", "HEAD"], registration.root, 20_000, 1024 * 1024)).stdout.trim();
    return { previousRepositoryRevision: before, repositoryRevision: await repositoryRevision(processes, registration.root), headRevision };
  }

  async #push(
    registration: WorkspaceRegistration,
    processes: RemoteProcessTransportPort,
    input: RemoteGitPushInput
  ): Promise<WorkspaceGitPushResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.remote)) throw new WorkspaceGitReviewError("Remote name is invalid.", "invalid");
    const before = await repositoryRevision(processes, registration.root);
    const head = (await runRemote(processes, "git", ["rev-parse", "HEAD"], registration.root, 20_000, 1024 * 1024)).stdout.trim();
    if (before !== input.expectedRepositoryRevision || head !== input.expectedHeadRevision) throw new WorkspaceGitReviewError("Remote branch is stale.", "stale");
    const url = (await runRemote(processes, "git", ["remote", "get-url", input.remote], registration.root, 20_000, 1024 * 1024)).stdout.trim();
    if (gitUrlContainsCredential(url)) throw new WorkspaceGitReviewError("Remote URL contains embedded credentials.", "unsupported");
    const args = ["push"];
    if (input.confirmForceWithLease === true) {
      if (!immutableRevision(input.expectedRemoteOid ?? "")) throw new WorkspaceGitReviewError("Remote lease is invalid.", "invalid");
      args.push(`--force-with-lease=${input.remoteRef}:${input.expectedRemoteOid}`);
    }
    args.push(input.remote, `HEAD:${input.remoteRef}`);
    await runRemote(processes, "git", args, registration.root, 120_000, 4 * 1024 * 1024);
    return { kind: "pushed", repositoryRevision: await repositoryRevision(processes, registration.root), headRevision: head, remote: input.remote, remoteRef: input.remoteRef };
  }

  #require(id: string): WorkspaceRegistration {
    const registration = this.#registrations.get(id);
    if (registration === undefined) throw new Error("Remote workspace is not registered.");
    return registration;
  }

  async #transports(registration: WorkspaceRegistration): Promise<RemoteTransports> {
    const remote = registration.remote!;
    const { lease } = await this.#registry.transports(remote.targetId, remote.hostId);
    if (lease.files === undefined || lease.processes === undefined || !lease.capabilities.fileTransfer || !lease.capabilities.processStreaming) {
      throw new Error("Remote workspace transports are unavailable.");
    }
    return { files: lease.files, processes: lease.processes };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Remote workspace service is closed.");
  }
}

interface RemoteTransports {
  readonly files: RemoteFileTransportPort;
  readonly processes: RemoteProcessTransportPort;
}

interface RemoteGitDiffFileInput {
  readonly path: string;
  readonly source: "index" | "workingTree" | "comparison";
  readonly expectedRepositoryRevision: string;
  readonly headRevision?: string;
  readonly maximumBytes?: number;
}

interface RemoteGitReviewFileInput {
  readonly path: string;
  readonly source: "unstaged" | "staged" | "commit" | "branch";
  readonly expectedRepositoryRevision: string;
  readonly sourceRevision?: string;
  readonly expectedMergeBaseRevision?: string;
  readonly maximumBytes?: number;
}

interface RemoteGitImageInput {
  readonly path: string;
  readonly oldPath?: string;
  readonly source: "unstaged" | "staged" | "commit" | "branch";
  readonly expectedRepositoryRevision: string;
  readonly sourceRevision?: string;
  readonly expectedMergeBaseRevision?: string;
}

interface RemoteGitPushInput {
  readonly remote: string;
  readonly remoteRef: string;
  readonly expectedRepositoryRevision: string;
  readonly expectedHeadRevision: string;
  readonly confirmForceWithLease?: boolean;
  readonly expectedRemoteOid?: string;
}

function canonicalRelative(value: string, allowEmpty = false): string {
  const normalized = value.replace(/^(?:\.\/)+/u, "");
  if ((normalized === "" && allowEmpty) || normalized === ".") return "";
  if (
    normalized === "" || normalized.startsWith("/") || normalized.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) throw new Error("Remote workspace path is invalid.");
  return normalized;
}

function remoteWorkspacePath(root: string, relativePath: string, allowRoot: boolean): string {
  const relative = canonicalRelative(relativePath, allowRoot);
  const value = relative === "" ? root : remotePath.join(root, relative);
  if (value !== root && !value.startsWith(`${root}/`)) throw new Error("Remote workspace path escapes its root.");
  return value;
}

function safeEntryName(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !/[\/\0-\x1f\x7f]/u.test(value);
}

function remoteRevision(info: RemoteFileStat): string {
  return `remote-meta:${info.kind}:${info.mode}:${info.size}:${info.modifiedAt}`;
}

function contentRevision(content: Uint8Array): string {
  return `sha256:${fileHash(content)}:${content.byteLength}`;
}

function remoteEntry(relativePath: string, info: RemoteFileStat, revision = remoteRevision(info)): WorkspaceEntryRecord {
  return {
    path: relativePath,
    name: relativePath.split("/").at(-1) ?? relativePath,
    kind: info.kind === "directory" ? "directory" : "file",
    size: info.kind === "directory" ? 0 : info.size,
    modifiedAt: info.modifiedAt,
    revision,
    generated: /(^|\/)(dist|build|coverage|generated|\.next|\.vite)(\/|$)/iu.test(relativePath)
  };
}

function compareRemoteEntries(left: RemoteDirectoryEntry, right: RemoteDirectoryEntry): number {
  return Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name);
}

async function expectMissing(files: RemoteFileTransportPort, path: string): Promise<void> {
  try {
    await files.stat(path);
  } catch {
    return;
  }
  throw new WorkspaceEntryMutationError("Remote destination already exists.", "conflict");
}

function assertRemoteRevision(info: RemoteFileStat, expected: string): void {
  if (remoteRevision(info) !== expected) throw new WorkspaceEntryMutationError("Remote entry changed; refresh and retry.", "stale");
}

async function copyRemoteTree(files: RemoteFileTransportPort, source: string, destination: string, budget: { entries: number; bytes: number }): Promise<void> {
  const info = await files.stat(source);
  if (++budget.entries > MAXIMUM_TREE_ENTRIES) throw new WorkspaceEntryMutationError("Remote copy is too large.", "too_large");
  if (info.kind === "symbolic_link" || info.kind === "other") throw new WorkspaceEntryMutationError("Remote symbolic links cannot be copied.", "unsupported");
  if (info.kind === "file") {
    budget.bytes += info.size;
    if (budget.bytes > MAXIMUM_COPY_BYTES) throw new WorkspaceEntryMutationError("Remote copy is too large.", "too_large");
    const content = await files.read({ path: source, maximumBytes: Math.max(info.size, 1) });
    await files.write({ path: destination, content, mode: info.mode & 0o777, createParents: true, atomic: true });
    return;
  }
  await files.mkdir(destination, { recursive: false, mode: info.mode & 0o777 });
  for (const entry of await files.list(source)) {
    if (!safeEntryName(entry.name)) throw new WorkspaceEntryMutationError("Remote entry name is unsafe.", "unsafe");
    await copyRemoteTree(files, remotePath.join(source, entry.name), remotePath.join(destination, entry.name), budget);
  }
}

interface RemoteProcessResult {
  readonly stdout: string;
  readonly stdoutBytes: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runRemote(
  processes: RemoteProcessTransportPort,
  executable: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  maximumBytes: number,
  input?: string,
  accepted = new Set([0])
): Promise<RemoteProcessResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const process = await processes.open({ executable, args, cwd, signal: controller.signal });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  return new Promise((resolve, reject) => {
    const fail = (error: unknown): void => {
      clearTimeout(timer);
      process.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        fail(new Error("Remote process output exceeded its limit."));
        return;
      }
      target.push(value);
    };
    process.stdout.on("data", collect(stdout));
    process.stderr.on("data", collect(stderr));
    process.once("error", fail);
    if (input === undefined) process.stdin.end();
    else process.stdin.end(input, "utf8");
    process.once("exit", (code) => {
      clearTimeout(timer);
      const stdoutBytes = Buffer.concat(stdout);
      const result = {
        stdout: stdoutBytes.toString("utf8"),
        stdoutBytes,
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? -1
      };
      if (!accepted.has(result.exitCode)) reject(new Error("Remote process failed safely."));
      else resolve(result);
    });
  });
}

function parseRipgrepJson(output: string, maximum: number): WorkspaceSearchResult[] {
  const matches: WorkspaceSearchResult[] = [];
  for (const line of output.split("\n")) {
    if (line === "") continue;
    let record: any;
    try { record = JSON.parse(line); } catch { throw new WorkspaceSearchError("Remote search returned malformed output.", "search_failed"); }
    if (record?.type !== "match") continue;
    const path = canonicalRelative(String(record.data?.path?.text ?? ""));
    const lineNumber = Number(record.data?.line_number ?? 0);
    const text = String(record.data?.lines?.text ?? "").replace(/[\r\n]+$/u, "");
    for (const submatch of record.data?.submatches ?? []) {
      const start = Number(submatch.start ?? 0);
      const end = Number(submatch.end ?? start);
      matches.push({
        path,
        line: lineNumber,
        column: start + 1,
        endColumn: end + 1,
        startByte: start,
        endByte: end,
        preview: text,
        submatches: [{ startByte: start, endByte: end }],
        revision: hashText(`${path}\0${lineNumber}\0${text}`)
      });
      if (matches.length >= maximum) return matches;
    }
  }
  return matches;
}

function parseGitStatus(value: string): GitState["changes"][number] | undefined {
  if (value.length < 4) return undefined;
  const index = value[0] ?? " ";
  const worktree = value[1] ?? " ";
  const path = value.slice(3);
  if (path === "" || path.includes("\0")) return undefined;
  return { path, index, worktree };
}

async function repositoryRevision(processes: RemoteProcessTransportPort, cwd: string): Promise<string> {
  const status = await runRemote(processes, "git", ["status", "--porcelain=v2", "-z", "--branch"], cwd, 20_000, 8 * 1024 * 1024);
  return hashText(status.stdout);
}

async function gitOptional(processes: RemoteProcessTransportPort, cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const value = (await runRemote(processes, "git", args, cwd, 20_000, 1024 * 1024)).stdout.trim();
    return value === "" ? undefined : value;
  } catch { return undefined; }
}

async function gitOperationInProgress(processes: RemoteProcessTransportPort, cwd: string): Promise<boolean> {
  const gitDir = await gitOptional(processes, cwd, ["rev-parse", "--git-dir"]);
  if (gitDir === undefined) return false;
  const result = await runRemote(processes, "sh", ["-c", "test -d \"$1/rebase-merge\" -o -d \"$1/rebase-apply\" -o -f \"$1/MERGE_HEAD\" -o -f \"$1/CHERRY_PICK_HEAD\"", "sh", gitDir], cwd, 10_000, 1024, undefined, new Set([0, 1]));
  return result.exitCode === 0;
}

function immutableRevision(value: string): boolean { return /^[0-9a-f]{40,64}$/iu.test(value); }
function hashText(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function pathModuleJoin(...values: string[]): string { return path.join(...values); }
function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }

function mutableGitSource(source: WorkspaceGitHunkMutation["source"]): "unstaged" | "staged" {
  if (source === "index" || source === "staged") return "staged";
  if (source === "workingTree" || source === "unstaged") return "unstaged";
  throw new WorkspaceGitReviewError("Only staged or unstaged remote diffs can be changed.", "invalid");
}

function inferRemoteMediaType(value: string): string {
  const extension = remotePath.extname(value).toLowerCase();
  if ([".md", ".markdown", ".mdx"].includes(extension)) return "text/markdown";
  if ([".json", ".jsonc"].includes(extension)) return "application/json";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".glb") return "model/gltf-binary";
  if (extension === ".gltf") return "model/gltf+json";
  if (extension === ".ktx2") return "image/ktx2";
  if (extension === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".pdf") return "application/pdf";
  if ([".mp3", ".wav", ".ogg", ".mp4", ".webm"].includes(extension)) return extension === ".mp4" || extension === ".webm" ? `video/${extension.slice(1)}` : `audio/${extension.slice(1)}`;
  if (/\.(?:txt|log|csv|tsv|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|proto|php|sh|bash|zsh|ps1|yaml|yml|toml|ini|html|vue|svelte|css|scss|sql|graphql|diff|patch)$/iu.test(value)) return "text/plain";
  return "application/octet-stream";
}

function isTextMediaType(value: string): boolean { return value.startsWith("text/") || value === "application/json" || value === "image/svg+xml"; }

function gitUrlContainsCredential(value: string): boolean {
  try {
    const url = new URL(value);
    return url.password !== "" || ((url.protocol === "http:" || url.protocol === "https:") && url.username !== "");
  } catch { return /^[^@/\\:]+:[^@/\\]+@/u.test(value); }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolvePromise(); }, { once: true });
  });
}
