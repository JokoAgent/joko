import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { posix, win32, type PlatformPath } from "node:path";

import { reviewImageMimeType, workspaceEntryAbsentRevision } from "@joko/contracts";
import { DEVICE_PEER_RUNTIME_EXECUTABLES } from "@joko/device-peer";
import type {
  RemoteDirectoryEntry,
  RemoteFileStat,
  RemoteFileTransportPort,
  RemoteProcessHandle,
  RemoteProcessTransportPort
} from "@joko/remote-ssh";

import type { RemoteExecutionRouter } from "./remote-execution-router.js";
import { RemoteFileVersionCache, type RemoteFileCacheIdentity } from "./remote-file-version-cache.js";
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
  isUnmergedGitStatus,
  selectDiffFilePatch,
  selectDiffHunkPatch,
  workspacePreviewRegistrationIdentity,
  type GitState,
  type RemoteWorkspaceDelegate,
  type WorkspaceEntryListingOptions,
  type WorkspaceEntryMutationResult,
  type WorkspaceEntryRecord,
  type WorkspaceFileIndex,
  type WorkspaceFilePreview,
  type WorkspacePreviewAuthority,
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
import {
  decodeWorkspaceTextPreview,
  isWorkspaceTextMediaType as isTextMediaType,
  workspaceMediaTypeForPath as inferRemoteMediaType
} from "./workspace-file-media.js";

const MAXIMUM_PROCESS_OUTPUT = 16 * 1024 * 1024;
const MAXIMUM_TREE_ENTRIES = 100_000;
const MAXIMUM_COPY_BYTES = 256 * 1024 * 1024;
const GIT_METHODS = new Set([
  "gitState", "gitDiff", "gitReviewDiff", "readGitDiffFile", "readGitReviewFile", "readGitDiffImage",
  "applyGitDiffHunk", "applyGitDiff", "commitGitReview", "pushGitReview"
]);
const REMOTE_WORKSPACE_WATCH = String.raw`
const fs = require('node:fs'), path = require('node:path');
if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1);
const root = process.argv[1];
if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) process.exit(1);
let timer;
const watcher = fs.watch(root, { recursive: true }, (_kind, name) => {
  const parts = name == null ? [] : String(name).split(path.sep);
  if (parts.includes('.git') || parts.includes('..')) return;
  if (!timer) timer = setTimeout(() => { timer = undefined; process.stdout.write('change\n'); }, 50);
});
const stop = () => { clearTimeout(timer); watcher.close(); };
watcher.on('error', () => { stop(); process.exitCode = 1; process.stdin.destroy(); });
process.stdin.resume(); process.stdin.once('end', stop);
process.stdout.write('ready\n');
`;

/** Private registered-workspace authority shared by Skill source and runtime owners. */
export interface RemoteSkillSourceAuthority {
  readonly registration: WorkspaceRegistration;
  readonly rootRegistrationId: string;
  readonly files: RemoteFileTransportPort;
  readonly processes: RemoteProcessTransportPort;
  readonly executionIdentity: string;
  readonly authorityIdentity: string;
  readonly forwarding?: import("@joko/remote-ssh").RemoteForwardingTransportPort;
  readonly assertCurrent: () => void;
  readonly assertFilesCurrent: () => void;
  readonly assertForwardingCurrent: () => void;
}

export class RemoteWorkspaceService implements RemoteWorkspaceDelegate {
  readonly #remoteExecution: RemoteExecutionRouter;
  readonly #cache: RemoteFileVersionCache | undefined;
  readonly #registrations = new Map<string, WorkspaceRegistration>();
  #closed = false;

  constructor(remoteExecution: RemoteExecutionRouter, options: { readonly cache?: RemoteFileVersionCache } = {}) {
    this.#remoteExecution = remoteExecution;
    this.#cache = options.cache;
  }

  async register(input: WorkspaceRegistration): Promise<WorkspaceRegistration> {
    this.#assertOpen();
    const remote = input.remote;
    if (remote === undefined || remote.binding.workspaceRoot !== input.root) {
      throw new Error("Remote workspace registration is incomplete.");
    }
    const registration = Object.freeze({ ...input });
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

  async captureSkillSourceAuthority(workspaceId: string, signal?: AbortSignal): Promise<RemoteSkillSourceAuthority> {
    signal?.throwIfAborted();
    this.#assertOpen();
    const registration = this.#require(workspaceId);
    const binding = registration.remote?.binding;
    if (!registration.trusted || binding?.kind !== "ssh" || binding.workspaceRoot !== registration.root) {
      throw new Error("Skill sources require a registered trusted SSH workspace.");
    }
    const authority = await this.#remoteExecution.workspace(binding, signal);
    signal?.throwIfAborted();
    if (authority.kind !== "ssh" || authority.pathStyle !== "posix") throw new Error("Skill source transport is unavailable.");
    await validateCapturedWorkspaceRoot(registration, authority.files, authority.assertFilesCurrent, signal);
    signal?.throwIfAborted();
    const assertRegistration = (): void => {
      this.#assertOpen();
      if (this.#registrations.get(workspaceId) !== registration) throw new Error("The registered Skill workspace changed.");
    };
    const assertCurrent = (): void => { assertRegistration(); authority.assertCurrent(); authority.assertFilesCurrent(); };
    const assertFilesCurrent = (): void => { assertRegistration(); authority.assertFilesCurrent(); };
    assertCurrent();
    return Object.freeze({
      registration,
      rootRegistrationId: `sha256:${createHash("sha256").update(JSON.stringify([
        registration.id, registration.remote!.targetId, registration.root, binding, authority.executionIdentity
      ])).digest("hex")}`,
      files: authority.files, processes: authority.processes,
      executionIdentity: authority.executionIdentity, authorityIdentity: authority.authorityIdentity,
      ...(authority.forwarding === undefined ? {} : { forwarding: authority.forwarding }),
      assertCurrent, assertFilesCurrent,
      assertForwardingCurrent: () => { assertRegistration(); authority.assertForwardingCurrent(); }
    });
  }

  async capturePreviewAuthority(workspaceId: string, signal?: AbortSignal): Promise<WorkspacePreviewAuthority> {
    signal?.throwIfAborted();
    this.#assertOpen();
    const registration = this.#require(workspaceId);
    const remote = registration.remote!;
    const authority = await this.#remoteExecution.files(remote.binding, signal);
    signal?.throwIfAborted();
    await validateCapturedWorkspaceRoot(registration, authority.files, authority.assertCurrent, signal);
    const assertCurrent = (): void => {
      signal?.throwIfAborted(); this.#assertOpen(); authority.assertCurrent();
      if (this.#registrations.get(workspaceId) !== registration) throw new WorkspaceFilePreviewError("The remote workspace read authority changed. Open the source again.", "stale");
    };
    assertCurrent();
    const files = authority.files;
    const identity = createHash("sha256").update(JSON.stringify([
      workspacePreviewRegistrationIdentity(registration), authority.authorityIdentity
    ])).digest("hex");
    return { identity, assertCurrent, preview: async (path, maximumBytes = WORKSPACE_TEXT_FILE_MAXIMUM_BYTES, maximumFileBytes, readSignal) => {
      const currentSignal = signal === undefined ? readSignal : readSignal === undefined ? signal : AbortSignal.any([signal, readSignal]);
      assertCurrent(); currentSignal?.throwIfAborted();
      const result = await this.#preview(registration, files, path, maximumBytes, maximumFileBytes, currentSignal, assertCurrent);
      assertCurrent(); currentSignal?.throwIfAborted();
      return result;
    } };
  }

  async invoke<Result>(workspaceId: string, method: string, args: readonly unknown[]): Promise<Result> {
    this.#assertOpen();
    const registration = this.#require(workspaceId);
    const transports = await this.#transports(registration);
    if (GIT_METHODS.has(method) && !await requireRemoteGitRoot(registration, transports, method === "gitState")) {
      if (method !== "gitState") throw new WorkspaceGitReviewError("Remote workspace is not a Git repository.", "unsupported");
      return { repository: false, detachedHead: false, operationInProgress: false, unmerged: false, dirty: false, changes: [] } as Result;
    }
    let result: unknown;
    switch (method) {
      case "list": result = await this.#list(registration, transports.files, args[0] as string, args[1] as WorkspaceEntryListingOptions | undefined); break;
      case "preview": result = await this.#preview(registration, transports.files, args[0] as string, args[1] as number, args[2] as number | undefined, undefined, transports.assertCurrent); break;
      case "materializeFile": result = await this.#materialize(registration, transports.files, args, transports.assertCurrent); break;
      case "listFiles": result = await this.#listFiles(registration, transports.files); break;
      case "writeTextFile": result = await this.#writeTextFile(registration, transports.files, args[0] as WorkspaceTextFileWriteInput); break;
      case "createEntry": result = await this.#createEntry(registration, transports.files, args[0] as { path: string; kind: "file" | "directory"; expectedRevision: string }); break;
      case "moveEntry": result = await this.#moveEntry(registration, transports.files, args[0] as { sourcePath: string; destinationPath: string; expectedRevision: string }); break;
      case "deleteEntry": result = await this.#deleteEntry(registration, transports.files, args[0] as { path: string; expectedRevision: string; confirmRecursive: boolean }); break;
      case "copyEntry": result = await this.#copyEntry(registration, transports.files, args[0] as { sourcePath: string; destinationPath: string; expectedRevision: string }); break;
      case "search": result = (await this.#searchPage(registration, transports, args[0] as string, args[1] as WorkspaceSearchOptions | undefined)).matches; break;
      case "searchPage": result = await this.#searchPage(registration, transports, args[0] as string, args[1] as WorkspaceSearchOptions | undefined); break;
      case "gitState": result = await this.#gitState(registration, transports); break;
      case "gitDiff": result = await this.#gitDiff(registration, transports, args[0] as readonly string[], args[1] as Record<string, unknown>); break;
      case "gitReviewDiff": result = await this.#gitReviewDiff(registration, transports, args[0] as WorkspaceGitReviewDiffInput); break;
      case "readGitDiffFile": result = await this.#readGitDiffFile(registration, transports, args[0] as RemoteGitDiffFileInput); break;
      case "readGitReviewFile": result = await this.#readGitReviewFile(registration, transports, args[0] as RemoteGitReviewFileInput); break;
      case "readGitDiffImage": result = await this.#readGitDiffImage(registration, transports, args[0] as RemoteGitImageInput); break;
      case "applyGitDiffHunk": result = await this.#applyGitDiffHunk(registration, transports, args[0] as WorkspaceGitHunkMutation); break;
      case "applyGitDiff": result = await this.#applyGitDiff(registration, transports, args[0] as WorkspaceGitMutation); break;
      case "commitGitReview": result = await this.#commit(registration, transports, args[0] as { message: string; expectedRepositoryRevision: string; includeUnstaged?: boolean }); break;
      case "pushGitReview": result = await this.#push(registration, transports, args[0] as RemoteGitPushInput); break;
      default: throw new Error("Remote workspace operation is unavailable.");
    }
    transports.assertCurrent();
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
    signal?.throwIfAborted();
    const registration = this.#require(scope.workspaceId), transports = await this.#transports(registration);
    const child = await transports.processes.open({
      executable: registration.remote!.binding.kind === "device_peer" ? DEVICE_PEER_RUNTIME_EXECUTABLES.node : "node",
      args: ["-e", REMOTE_WORKSPACE_WATCH, registration.root], cwd: registration.root,
      ...(signal === undefined ? {} : { signal })
    });
    let sequence = 0n; const streamId = randomUUID();
    let buffer = "", ready = false;
    const stop = () => { child.stdin.end(); child.kill(); child.stdout.destroy(); };
    const timer = setInterval(() => { try { transports.assertCurrent(); } catch (error) { child.stdout.destroy(error as Error); child.kill(); } }, 2_000);
    timer.unref?.(); signal?.addEventListener("abort", stop, { once: true });
    child.stdin.on("error", () => undefined);
    child.stderr.resume();
    const onError = (error: Error) => child.stdout.destroy(error);
    child.on("error", onError);
    try {
      if (isAborted(signal)) { stop(); return; }
      for await (const chunk of child.stdout) {
        signal?.throwIfAborted(); transports.assertCurrent();
        buffer += Buffer.from(chunk).toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (frame === "ready" && !ready) ready = true;
          else if (!ready || frame !== "change") throw new Error("Remote workspace watch returned an invalid frame.");
          sequence += 1n;
          yield { workspaceId: scope.workspaceId, kind: "resync", observedAt: Date.now(), sequence, streamRevision: hashText(`${streamId}:${sequence}`) };
        }
        if (buffer.length > 4_096) throw new WorkspaceScanError("Remote workspace watch returned an invalid frame.", "limit");
      }
      if (!isAborted(signal) && !this.#closed) throw new Error(ready ? "Remote workspace watch stopped. Reopen the file browser to reconnect."
        : "Remote workspace watch could not start. SSH file watching requires Node.js 22 or newer in the remote account PATH.");
    } catch (error) {
      if (!isAborted(signal) && !this.#closed) throw error;
    } finally {
      clearInterval(timer); signal?.removeEventListener("abort", stop); stop();
    }
  }

  async #list(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    directory = "",
    options?: WorkspaceEntryListingOptions
  ): Promise<readonly WorkspaceEntryRecord[]> {
    const start = remoteWorkspacePath(registration, directory, true);
    const maximum = Math.min(Math.max(options?.maximumEntries ?? 10_000, 1), MAXIMUM_TREE_ENTRIES);
    const output: WorkspaceEntryRecord[] = [];
    const visit = async (absolute: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 128) throw new WorkspaceScanError("Remote workspace tree is too deep.", "limit");
      if (await files.realpath(absolute) !== absolute || (await files.stat(absolute)).kind !== "directory") throw new WorkspaceScanError("Remote listing requires a canonical directory.", "scan_failed");
      const entries = [...await files.list(absolute)].sort(compareRemoteEntries);
      for (const entry of entries) {
        if (!safeEntryName(entry.name) || entry.kind === "symbolic_link" || entry.kind === "other") continue;
        if (entry.name === ".git") continue;
        const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const path = pathApi(registration).join(absolute, entry.name);
        const info = await files.stat(path);
        if (info.kind !== "file" && info.kind !== "directory") continue;
        if (await files.realpath(path) !== path) continue;
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
    maximumBytes: number,
    maximumFileBytes: number | undefined,
    signal: AbortSignal | undefined,
    sourceIsCurrent: () => void
  ): Promise<WorkspaceFilePreview> {
    const assertCurrent = this.#fileGuard(registration, sourceIsCurrent, signal);
    const path = remoteWorkspacePath(registration, relativePath, false);
    assertCurrent();
    if (await files.realpath(path, signal) !== path) throw new WorkspaceFilePreviewError("Remote preview path is not canonical.", "invalid");
    signal?.throwIfAborted();
    const before = await files.stat(path, signal);
    signal?.throwIfAborted();
    if (before.kind !== "file") throw new WorkspaceFilePreviewError("Remote preview requires a regular file.", "unsupported");
    if (maximumFileBytes !== undefined && (!Number.isSafeInteger(maximumFileBytes) || maximumFileBytes < 1 || before.size > maximumFileBytes)) {
      throw new WorkspaceFilePreviewError("The file exceeds the complete preview budget.", "unsupported");
    }
    const limit = Math.min(Math.max(maximumBytes, 1), 32 * 1024 * 1024);
    const mediaType = inferRemoteMediaType(relativePath);
    if (!isTextMediaType(mediaType) && before.size > limit) {
      const after = await files.stat(path, signal);
      signal?.throwIfAborted();
      if (remoteRevision(before) !== remoteRevision(after)) {
        throw new WorkspaceFilePreviewError("Remote file changed while it was read.", "stale");
      }
      assertCurrent();
      return {
        entry: remoteEntry(canonicalRelative(relativePath), after),
        observedRevision: remoteRevision(after),
        mediaType,
        truncated: false
      };
    }
    const { bytes, after } = await this.#readFileBytes(registration, files, path, before, limit, true, assertCurrent, signal);
    const entry = remoteEntry(canonicalRelative(relativePath), after, contentRevision(bytes));
    if (isTextMediaType(mediaType)) {
      if (bytes.includes(0)) throw new WorkspaceFilePreviewError("Remote file is not valid text.", "unsupported");
      let text: string;
      try { text = decodeWorkspaceTextPreview(bytes, before.size > bytes.byteLength); }
      catch { throw new WorkspaceFilePreviewError("Remote file is not valid UTF-8 text.", "unsupported"); }
      return { entry, observedRevision: remoteRevision(after), mediaType, text, truncated: before.size > bytes.byteLength };
    }
    return { entry, observedRevision: remoteRevision(after), mediaType, bytes, truncated: before.size > bytes.byteLength };
  }

  async #materialize(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    args: readonly unknown[],
    sourceIsCurrent: () => void
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
    const assertCurrent = this.#fileGuard(registration, sourceIsCurrent, signal);
    assertCurrent();
    const path = remoteWorkspacePath(registration, relativePath, false);
    if (await files.realpath(path, signal) !== path) throw new WorkspaceFilePreviewError("Remote download path is not canonical.", "invalid");
    const before = await files.stat(path, signal);
    if (before.kind !== "file" || before.size > 64 * 1024 * 1024) {
      throw new WorkspaceFilePreviewError("Remote download requires a bounded regular file.", "unsupported");
    }
    const { bytes: content } = await this.#readFileBytes(registration, files, path, before,
      Math.max(before.size, 1), false, assertCurrent, signal);
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
          assertCurrent();
          const current = await files.stat(path, signal);
          if (remoteRevision(current) !== remoteRevision(before) || snapshot.sha256 !== fileHash(content)
            || await files.realpath(path, signal) !== path) {
            throw new WorkspaceFilePreviewError("Remote file changed while it was downloaded.", "stale");
          }
          assertCurrent();
        }
      });
    } finally {
      await handle.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  #fileGuard(registration: WorkspaceRegistration, sourceIsCurrent: () => void, signal?: AbortSignal): () => void {
    return () => {
      signal?.throwIfAborted(); this.#assertOpen(); sourceIsCurrent();
      if (this.#registrations.get(registration.id) !== registration) {
        throw new WorkspaceFilePreviewError("The remote workspace read authority changed. Open the source again.", "stale");
      }
    };
  }

  async #readFileBytes(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    path: string,
    before: RemoteFileStat,
    maximumBytes: number,
    allowTruncated: boolean,
    assertCurrent: () => void,
    signal?: AbortSignal
  ): Promise<{ readonly bytes: Buffer; readonly after: RemoteFileStat }> {
    assertCurrent();
    const identity: RemoteFileCacheIdentity | undefined = typeof before.version === "string" && /^[a-f0-9]{64}$/.test(before.version)
      ? { source: createHash("sha256").update(JSON.stringify([
          "remote-workspace-file-v1", registration.id, registration.root, registration.remote?.targetId,
          registration.remote?.binding, path
        ])).digest("hex"), version: before.version, size: before.size } : undefined;
    let cached: Buffer | undefined;
    if (identity && this.#cache) {
      try { cached = await this.#cache.read(identity, maximumBytes, assertCurrent); }
      catch { assertCurrent(); }
    }
    assertCurrent();
    const bytes = cached ?? Buffer.from(await files.read({ path,
      maximumBytes: Math.min(Math.max(before.size, 1), maximumBytes), allowTruncated,
      ...(identity === undefined ? {} : { expectedVersion: identity.version }),
      ...(signal === undefined ? {} : { signal }) }));
    const after = await files.stat(path, signal);
    if (remoteRevision(before) !== remoteRevision(after) || await files.realpath(path, signal) !== path) {
      throw new WorkspaceFilePreviewError("Remote file changed while it was read.", "stale");
    }
    assertCurrent();
    if (cached === undefined && identity && this.#cache && bytes.byteLength === before.size) {
      try { await this.#cache.write(identity, bytes, assertCurrent); }
      catch { assertCurrent(); }
    }
    assertCurrent();
    return { bytes, after };
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
    const path = remoteWorkspacePath(registration, input.path, false);
    await assertRemoteMutationPath(registration, files, path, true);
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
    await assertRemoteMutationPath(registration, files, path, true);
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
    const path = remoteWorkspacePath(registration, input.path, false);
    await expectMissing(files, path);
    await assertRemoteMutationPath(registration, files, path, false);
    if (input.kind === "directory") await files.mkdir(path, { recursive: false, mode: 0o755 });
    else await files.write({ path, content: new Uint8Array(), mode: 0o644, createOnly: true });
    return { entry: remoteEntry(canonicalRelative(input.path), await files.stat(path)) };
  }

  async #moveEntry(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    input: { sourcePath: string; destinationPath: string; expectedRevision: string }
  ): Promise<WorkspaceEntryMutationResult> {
    const source = remoteWorkspacePath(registration, input.sourcePath, false);
    const destination = remoteWorkspacePath(registration, input.destinationPath, false);
    assertSeparateRemoteDestination(registration, source, destination);
    await assertRemoteMutationPath(registration, files, source, true);
    const before = await files.stat(source);
    assertRemoteRevision(before, input.expectedRevision);
    await expectMissing(files, destination);
    await assertRemoteMutationPath(registration, files, destination, false);
    await assertRemoteMutationPath(registration, files, source, true);
    assertRemoteRevision(await files.stat(source), input.expectedRevision);
    await files.rename(source, destination);
    return { entry: remoteEntry(canonicalRelative(input.destinationPath), await files.stat(destination)) };
  }

  async #deleteEntry(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    input: { path: string; expectedRevision: string; confirmRecursive: boolean }
  ): Promise<void> {
    const path = remoteWorkspacePath(registration, input.path, false);
    await assertRemoteMutationPath(registration, files, path, true);
    const before = await files.stat(path);
    assertRemoteRevision(before, input.expectedRevision);
    if (before.kind === "directory" && !input.confirmRecursive) {
      throw new WorkspaceEntryMutationError("Recursive remote deletion requires confirmation.", "unsafe");
    }
    await assertRemoteMutationPath(registration, files, path, true);
    assertRemoteRevision(await files.stat(path), input.expectedRevision);
    await files.remove(path, { recursive: before.kind === "directory" });
  }

  async #copyEntry(
    registration: WorkspaceRegistration,
    files: RemoteFileTransportPort,
    input: { sourcePath: string; destinationPath: string; expectedRevision: string }
  ): Promise<WorkspaceEntryMutationResult> {
    const source = remoteWorkspacePath(registration, input.sourcePath, false);
    const destination = remoteWorkspacePath(registration, input.destinationPath, false);
    assertSeparateRemoteDestination(registration, source, destination);
    await assertRemoteMutationPath(registration, files, source, true);
    const before = await files.stat(source);
    assertRemoteRevision(before, input.expectedRevision);
    await expectMissing(files, destination);
    const budget = { entries: 0, bytes: 0, effectStarted: false };
    try {
      await copyRemoteTree(registration, files, source, destination, budget);
      const current = await files.stat(source);
      if (remoteRevision(current) !== remoteRevision(before)) throw new WorkspaceEntryMutationError("Remote source changed while it was copied.", "stale");
      return { entry: remoteEntry(canonicalRelative(input.destinationPath), await files.stat(destination)) };
    } catch (error) {
      if (!budget.effectStarted) throw error;
      throw new WorkspaceEntryMutationError("Remote copy did not finish. Inspect its destination before retrying.", "effect_failed", { stateMayHaveChanged: true, cause: error });
    }
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

  async #gitState(registration: WorkspaceRegistration, transports: RemoteTransports): Promise<GitState> {
    const processes = transports.processes;
    const result = await runRemote(processes, "git", ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], registration.root, 20_000, 4 * 1024 * 1024);
    const records = result.stdout.split("\0").filter(Boolean);
    const branchLine = records.shift() ?? "";
    const changes: GitState["changes"][number][] = [];
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!, change = parseGitStatus(record);
      if (change === undefined) continue;
      if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") {
        const originalPath = records[++index];
        if (originalPath === undefined) throw new WorkspaceGitReviewError("Remote Git rename status is incomplete.", "stale");
        changes.push({ ...change, originalPath: canonicalRelative(originalPath) });
      } else changes.push(change);
    }
    const branchMatch = /^## (.+?)(?:\.\.\.|$)/u.exec(branchLine)?.[1];
    const head = await gitOptional(processes, registration.root, ["rev-parse", "HEAD"]);
    const operationInProgress = await gitOperationInProgress(
      processes,
      transports.files,
      pathApi(registration),
      registration.root
    );
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
    transports: RemoteTransports,
    paths: readonly string[] = [],
    options: { baseRevision?: unknown; headRevision?: unknown; ignoreWhitespace?: unknown } = {}
  ): Promise<WorkspaceGitDiff> {
    const processes = transports.processes;
    const revision = await repositoryRevision(processes, registration.root);
    const pathArgs = ["--", ...paths.map(literalGitPathspec)];
    const whitespace = options.ignoreWhitespace === true ? ["--ignore-all-space"] : [];
    const tracked = (await runRemote(processes, "git", ["diff", "--no-ext-diff", "--find-renames", ...whitespace, ...pathArgs], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    const workingTree = tracked + await this.#readUntrackedDiff(registration, transports, paths, options.ignoreWhitespace === true);
    if (Buffer.byteLength(workingTree) > MAXIMUM_PROCESS_OUTPUT) throw new WorkspaceGitReviewError("Remote Review exceeds its safe size limit.", "unsupported");
    const index = (await runRemote(processes, "git", ["diff", "--cached", "--no-ext-diff", "--find-renames", ...whitespace, ...pathArgs], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    const base = typeof options.baseRevision === "string" && options.baseRevision !== "" ? options.baseRevision : undefined;
    const head = typeof options.headRevision === "string" && options.headRevision !== "" ? options.headRevision : undefined;
    const comparison = base === undefined
      ? ""
      : (await runRemote(processes, "git", ["diff", "--no-ext-diff", ...whitespace, base, head ?? "HEAD", ...pathArgs], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    const headRevision = head ?? await gitOptional(processes, registration.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (await repositoryRevision(processes, registration.root) !== revision) throw new WorkspaceGitReviewError("Remote Review changed while it was read.", "stale");
    return {
      index,
      workingTree,
      comparison,
      repositoryRevision: revision,
      ...(base === undefined ? {} : { baseRevision: base }),
      ...(headRevision === undefined ? {} : { headRevision })
    };
  }

  async #gitReviewDiff(
    registration: WorkspaceRegistration,
    transports: RemoteTransports,
    input: WorkspaceGitReviewDiffInput
  ): Promise<WorkspaceGitDiff> {
    const processes = transports.processes;
    const current = await this.#gitDiff(registration, transports, input.paths, { ignoreWhitespace: input.ignoreWhitespace });
    if (input.expectedRepositoryRevision !== undefined && input.expectedRepositoryRevision !== current.repositoryRevision) {
      throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    }
    if (input.source === "unstaged") return { ...current, index: "", comparison: "" };
    if (input.source === "staged") return { ...current, workingTree: "", comparison: "" };
    const source = input.sourceRevision;
    if (source === undefined || !immutableRevision(source)) throw new WorkspaceGitReviewError("Remote Review source is invalid.", "invalid");
    if (input.source === "commit") {
      const base = await gitOptional(processes, registration.root, ["rev-parse", `${source}^`]);
      const comparison = (await runRemote(processes, "git", ["show", "--format=", "--no-ext-diff", ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []), source, "--", ...(input.paths ?? []).map(literalGitPathspec)], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
      return { ...current, index: "", workingTree: "", comparison, headRevision: source, ...(base === undefined ? {} : { baseRevision: base }), source: "commit", sourceRevision: source };
    }
    const mergeBase = (await runRemote(processes, "git", ["merge-base", "HEAD", source], registration.root, 20_000, 1024 * 1024)).stdout.trim();
    const head = (await runRemote(processes, "git", ["rev-parse", "HEAD"], registration.root, 20_000, 1024 * 1024)).stdout.trim();
    const comparison = (await runRemote(processes, "git", ["diff", "--no-ext-diff", ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []), mergeBase, head, "--", ...(input.paths ?? []).map(literalGitPathspec)], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    return { ...current, index: "", workingTree: "", comparison, baseRevision: mergeBase, headRevision: head, mergeBaseRevision: mergeBase, source: "branch", sourceRevision: source };
  }

  async #readUntrackedDiff(
    registration: WorkspaceRegistration,
    transports: RemoteTransports,
    paths: readonly string[],
    ignoreWhitespace: boolean
  ): Promise<string> {
    const listed = await runRemote(transports.processes, "git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths.map(literalGitPathspec)],
      registration.root, 20_000, MAXIMUM_PROCESS_OUTPUT);
    const patches: string[] = [];
    let bytes = 0;
    for (const entry of listed.stdout.split("\0").filter(Boolean)) {
      const relativePath = canonicalRelative(entry), absolute = remoteWorkspacePath(registration, relativePath, false);
      const info = await transports.files.stat(absolute);
      let patch: string;
      if (info.kind !== "file" || info.size > WORKSPACE_TEXT_FILE_MAXIMUM_BYTES) {
        // Keep bounded, non-renderable entries visible without reading links or
        // buffering a large new file into the Review response.
        const oldPath = JSON.stringify(`a/${relativePath}`), newPath = JSON.stringify(`b/${relativePath}`);
        patch = `diff --git ${oldPath} ${newPath}\nnew file mode ${info.kind === "symbolic_link" ? "120000" : "100644"}\nBinary files /dev/null and ${newPath} differ\n`;
      } else {
        await assertRemoteMutationPath(registration, transports.files, absolute, true);
        patch = (await runRemote(transports.processes, "git", ["diff", "--no-index", "--no-color", "--src-prefix=a/", "--dst-prefix=b/",
          ...(ignoreWhitespace ? ["--ignore-all-space"] : []), "--", "/dev/null", relativePath], registration.root, 30_000, MAXIMUM_PROCESS_OUTPUT, undefined, new Set([0, 1]))).stdout;
      }
      bytes += Buffer.byteLength(patch);
      if (bytes > MAXIMUM_PROCESS_OUTPUT) throw new WorkspaceGitReviewError("Remote Review exceeds its safe size limit.", "unsupported");
      patches.push(patch.endsWith("\n") ? patch : `${patch}\n`);
    }
    return patches.join("");
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
      const absolute = remoteWorkspacePath(registration, path, false);
      await assertRemoteMutationPath(registration, transports.files, absolute, true);
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
    const before = await this.#gitReviewDiff(registration, transports, input);
    if (before.repositoryRevision !== input.expectedRepositoryRevision || before.mergeBaseRevision !== input.expectedMergeBaseRevision) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    const source = input.source === "unstaged" ? "workingTree" : input.source === "staged" ? "index" : "comparison";
    const file = await this.#readGitDiffFile(registration, transports, {
      path: input.path,
      source,
      expectedRepositoryRevision: input.expectedRepositoryRevision,
      ...(before.headRevision === undefined ? {} : { headRevision: before.headRevision }),
      ...(input.maximumBytes === undefined ? {} : { maximumBytes: input.maximumBytes })
    });
    const after = await this.#gitReviewDiff(registration, transports, input);
    if (after.repositoryRevision !== before.repositoryRevision || after.headRevision !== before.headRevision || after.mergeBaseRevision !== before.mergeBaseRevision) throw new WorkspaceGitReviewError("Remote Review changed while it was read.", "stale");
    return { ...file, ...(after.mergeBaseRevision === undefined ? {} : { mergeBaseRevision: after.mergeBaseRevision }) };
  }

  async #readGitDiffImage(
    registration: WorkspaceRegistration,
    transports: RemoteTransports,
    input: RemoteGitImageInput
  ): Promise<WorkspaceGitImagePreview> {
    const path = canonicalRelative(input.path), oldPath = input.oldPath ? canonicalRelative(input.oldPath) : path;
    if (!reviewImageMimeType(path) && !reviewImageMimeType(oldPath)) throw new WorkspaceGitReviewError("Only approved raster image formats can be previewed.", "unsupported");
    const before = await this.#gitReviewDiff(registration, transports, input);
    if (before.repositoryRevision !== input.expectedRepositoryRevision || before.mergeBaseRevision !== input.expectedMergeBaseRevision) {
      throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    }
    const missing = (path: string): WorkspaceGitImageSide => ({ present: false, tooLarge: false, path });
    const side = (path: string, size: number, bytes?: Buffer): WorkspaceGitImageSide => ({ present: true,
      tooLarge: size > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES, path, mediaType: reviewImageMimeType(path), ...(bytes === undefined ? {} : { bytes }) });
    const read = async (tree: string | undefined, path: string): Promise<WorkspaceGitImageSide> => {
      if (tree === undefined) return missing(path);
      const objectPath = `${tree}:${path}`;
      const sizeResult = await runRemote(transports.processes, "git", ["cat-file", "-s", objectPath], registration.root, 20_000, 1024, undefined, new Set([0, 128]));
      if (sizeResult.exitCode !== 0) return missing(path);
      const size = Number(sizeResult.stdout.trim());
      if (!Number.isSafeInteger(size) || size < 0) throw new WorkspaceGitReviewError("Remote image size is invalid.", "invalid");
      if (size > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES) return side(path, size);
      const result = await runRemote(transports.processes, "git", ["show", objectPath], registration.root, 20_000, WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES);
      return side(path, size, result.stdoutBytes);
    };
    let oldImage: WorkspaceGitImageSide;
    let newImage: WorkspaceGitImageSide;
    if (input.source === "unstaged") {
      oldImage = await read("", oldPath);
      const absolute = remoteWorkspacePath(registration, path, false);
      let info: RemoteFileStat | undefined;
      try { info = await transports.files.stat(absolute); } catch { transports.assertCurrent(); }
      if (info === undefined) newImage = missing(path);
      else {
        await assertRemoteMutationPath(registration, transports.files, absolute, true);
        if (info.kind !== "file") throw new WorkspaceGitReviewError("Remote image must be a regular file.", "unsupported");
        const bytes = info.size > WORKSPACE_GIT_IMAGE_MAXIMUM_BYTES ? undefined : Buffer.from(await transports.files.read({ path: absolute, maximumBytes: Math.max(info.size, 1) }));
        newImage = side(path, info.size, bytes);
      }
    } else if (input.source === "staged") {
      oldImage = await read(before.headRevision, oldPath); newImage = await read("", path);
    } else {
      oldImage = await read(input.source === "commit" ? before.baseRevision : before.mergeBaseRevision, oldPath);
      newImage = await read(before.headRevision, path);
    }
    const after = await this.#gitReviewDiff(registration, transports, input);
    if (after.repositoryRevision !== before.repositoryRevision || after.headRevision !== before.headRevision || after.baseRevision !== before.baseRevision || after.mergeBaseRevision !== before.mergeBaseRevision) {
      throw new WorkspaceGitReviewError("Remote Review changed while the images were read.", "stale");
    }
    return { oldImage, newImage, repositoryRevision: after.repositoryRevision, ...(after.mergeBaseRevision === undefined ? {} : { mergeBaseRevision: after.mergeBaseRevision }) };
  }

  async #applyGitDiffHunk(registration: WorkspaceRegistration, transports: RemoteTransports, input: WorkspaceGitHunkMutation): Promise<string> {
    return this.#applyGitDiff(registration, transports, {
      ...input,
      source: mutableGitSource(input.source),
      target: "hunk"
    });
  }

  async #applyGitDiff(registration: WorkspaceRegistration, transports: RemoteTransports, input: WorkspaceGitMutation): Promise<string> {
    const processes = transports.processes;
    if (input.action === "revert" && input.confirmRevert !== true) throw new WorkspaceGitReviewError("Remote revert requires confirmation.", "invalid");
    if (input.source !== (input.action === "unstage" ? "staged" : "unstaged")) {
      throw new WorkspaceGitReviewError("The remote Git action does not match its Review source.", "invalid");
    }
    if (input.target === "hunk" && (!Number.isSafeInteger(input.hunkIndex) || (input.hunkIndex ?? -1) < 0)) {
      throw new WorkspaceGitReviewError("A non-negative remote hunk index is required.", "invalid");
    }
    const current = await repositoryRevision(processes, registration.root);
    if (current !== input.expectedRepositoryRevision) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    const path = canonicalRelative(input.path);
    const paths = [...new Set([input.oldPath, path].filter((value): value is string => value !== undefined && value !== "").map(value => canonicalRelative(value)))];
    let raw = (await runRemote(processes, "git", ["diff", "--binary", "--no-color", "--find-renames", ...(input.source === "staged" ? ["--cached"] : []),
      ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []), "--", ...paths.map(literalGitPathspec)], registration.root, 20_000, MAXIMUM_PROCESS_OUTPUT)).stdout;
    if (raw === "" && input.target === "file") {
      await this.#applyUntrackedFileMutation(registration, transports, input, path, current);
    } else {
      if (raw === "" && input.source === "unstaged") {
        raw = await this.#readUntrackedDiff(registration, transports, [path], input.ignoreWhitespace === true);
      }
      const filePatch = selectDiffFilePatch(raw);
      const patch = input.target === "file" ? filePatch : selectDiffHunkPatch(filePatch, input.hunkIndex ?? -1);
      const args = ["apply", "--whitespace=nowarn"];
      if (input.action !== "revert") args.push("--cached");
      if (input.action === "unstage" || input.action === "revert") args.push("--reverse");
      if (input.ignoreWhitespace) args.push("--ignore-space-change");
      if (await repositoryRevision(processes, registration.root) !== current) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
      await requireRemoteGitRoot(registration, transports);
      await runRemote(processes, "git", [...args, "-"], registration.root, 20_000, 4 * 1024 * 1024, patch);
    }
    return repositoryRevision(processes, registration.root);
  }

  async #applyUntrackedFileMutation(registration: WorkspaceRegistration, transports: RemoteTransports,
    input: WorkspaceGitMutation, path: string, revision: string): Promise<void> {
    if (input.action === "unstage") throw new WorkspaceGitReviewError("The selected remote staged diff is stale.", "stale");
    const status = await runRemote(transports.processes, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", literalGitPathspec(path)],
      registration.root, 20_000, MAXIMUM_PROCESS_OUTPUT);
    if (status.stdout !== `?? ${path}\0`) throw new WorkspaceGitReviewError("The selected remote file is no longer untracked.", "stale");
    const absolute = remoteWorkspacePath(registration, path, false);
    await assertRemoteMutationPath(registration, transports.files, absolute, true);
    const before = await transports.files.stat(absolute);
    if (before.kind !== "file") throw new WorkspaceGitReviewError("Remote Review file actions require a regular file.", "unsupported");
    if (await repositoryRevision(transports.processes, registration.root) !== revision) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    await requireRemoteGitRoot(registration, transports);
    await assertRemoteMutationPath(registration, transports.files, absolute, true);
    if (remoteRevision(await transports.files.stat(absolute)) !== remoteRevision(before)) throw new WorkspaceGitReviewError("The selected remote file changed.", "stale");
    if (input.action === "stage") await runRemote(transports.processes, "git", ["add", "--", literalGitPathspec(path)], registration.root, 20_000, 4 * 1024 * 1024);
    else await transports.files.remove(absolute, { recursive: false });
  }

  async #commit(registration: WorkspaceRegistration, transports: RemoteTransports, input: { message: string; expectedRepositoryRevision: string; includeUnstaged?: boolean }): Promise<WorkspaceGitCommitResult> {
    const processes = transports.processes;
    if (input.message.trim() === "" || Buffer.byteLength(input.message) > WORKSPACE_GIT_COMMIT_MESSAGE_MAXIMUM_BYTES || input.message.includes("\0")) {
      throw new WorkspaceGitReviewError("Remote commit message is invalid.", "invalid");
    }
    const before = await repositoryRevision(processes, registration.root);
    if (before !== input.expectedRepositoryRevision) throw new WorkspaceGitReviewError("Remote Review is stale.", "stale");
    await requireRemoteGitRoot(registration, transports);
    if (input.includeUnstaged === true) await runRemote(processes, "git", ["add", "-A", "--", ":/"], registration.root, 120_000, 4 * 1024 * 1024);
    await requireRemoteGitRoot(registration, transports);
    await runRemote(processes, "git", ["commit", "-F", "-"], registration.root, 120_000, 4 * 1024 * 1024, input.message);
    const headRevision = (await runRemote(processes, "git", ["rev-parse", "HEAD"], registration.root, 20_000, 1024 * 1024)).stdout.trim();
    return { previousRepositoryRevision: before, repositoryRevision: await repositoryRevision(processes, registration.root), headRevision };
  }

  async #push(
    registration: WorkspaceRegistration,
    transports: RemoteTransports,
    input: RemoteGitPushInput
  ): Promise<WorkspaceGitPushResult> {
    const processes = transports.processes;
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
    await requireRemoteGitRoot(registration, transports);
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
    const authority = await this.#remoteExecution.workspace(remote.binding);
    await validateCapturedWorkspaceRoot(registration, authority.files, authority.assertCurrent);
    const assertCurrent = () => {
      this.#assertOpen(); authority.assertCurrent();
      if (this.#registrations.get(registration.id) !== registration) throw new WorkspaceEntryMutationError("The registered remote workspace changed.", "stale");
    };
    const guarded = async <T>(operation: () => Promise<T>): Promise<T> => { assertCurrent(); const value = await operation(); assertCurrent(); return value; };
    assertCurrent();
    return {
      files: {
        realpath: (...args) => guarded(() => authority.files.realpath(...args)),
        stat: (...args) => guarded(() => authority.files.stat(...args)),
        list: (...args) => guarded(() => authority.files.list(...args)),
        read: (...args) => guarded(() => authority.files.read(...args)),
        write: (...args) => guarded(() => authority.files.write(...args)),
        mkdir: (...args) => guarded(() => authority.files.mkdir(...args)),
        rename: (...args) => guarded(() => authority.files.rename(...args)),
        remove: (...args) => guarded(() => authority.files.remove(...args))
      },
      processes: { open: async request => {
        assertCurrent(); const child = await authority.processes.open(request);
        try { assertCurrent(); } catch (error) { child.kill(); throw error; } return child;
      } },
      assertCurrent,
      pathStyle: authority.pathStyle
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Remote workspace service is closed.");
  }
}

interface RemoteTransports {
  readonly files: RemoteFileTransportPort;
  readonly processes: RemoteProcessTransportPort;
  readonly pathStyle: "posix" | "win32";
  readonly assertCurrent: () => void;
}

async function validateCapturedWorkspaceRoot(
  registration: WorkspaceRegistration,
  files: RemoteFileTransportPort,
  assertCurrent: () => void,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  assertCurrent();
  const canonical = await files.realpath(registration.root, signal);
  signal?.throwIfAborted();
  if (canonical !== registration.root || (await files.stat(canonical, signal)).kind !== "directory") {
    throw new Error("Remote workspace root must be a canonical directory.");
  }
  signal?.throwIfAborted();
  assertCurrent();
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

function literalGitPathspec(value: string): string {
  const relativePath = canonicalRelative(value);
  if (relativePath === "") throw new WorkspaceGitReviewError("Remote Git file paths must be non-empty.", "invalid");
  return `:(top,literal)${relativePath}`;
}

async function requireRemoteGitRoot(registration: WorkspaceRegistration, transports: RemoteTransports, allowMissing = false): Promise<boolean> {
  const probe = await runRemote(transports.processes, "git", ["rev-parse", "--show-toplevel"], registration.root, 20_000, 1024 * 1024, undefined, new Set([0, 128]));
  transports.assertCurrent();
  if (probe.exitCode !== 0) {
    if (allowMissing) return false;
    throw new WorkspaceGitReviewError("Remote workspace is not a Git repository.", "unsupported");
  }
  const paths = pathApi(registration), reported = paths.normalize(probe.stdout.trim());
  if (!paths.isAbsolute(reported) || await transports.files.realpath(reported) !== registration.root) {
    throw new WorkspaceGitReviewError("Detected remote Git repository extends outside the workspace boundary.", "unsupported");
  }
  transports.assertCurrent();
  return true;
}

function remoteWorkspacePath(registration: WorkspaceRegistration, relativePath: string, allowRoot: boolean): string {
  const root = registration.root;
  const paths = pathApi(registration);
  const relative = canonicalRelative(relativePath, allowRoot);
  if (!allowRoot && relative === "") throw new WorkspaceEntryMutationError("The remote workspace root cannot be mutated as an entry.", "unsafe");
  const value = relative === "" ? root : paths.join(root, ...relative.split("/"));
  const fromRoot = paths.relative(root, value);
  if (fromRoot === ".." || fromRoot.startsWith(`..${paths.sep}`) || paths.isAbsolute(fromRoot)) {
    throw new Error("Remote workspace path escapes its root.");
  }
  return value;
}

function pathApi(registration: WorkspaceRegistration): PlatformPath {
  const root = registration.remote?.binding.workspaceRoot ?? registration.root;
  return /^[A-Za-z]:[\\/]/u.test(root) || root.startsWith("\\\\") ? win32 : posix;
}

function safeEntryName(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !/[\/\0-\x1f\x7f]/u.test(value);
}

function remoteRevision(info: RemoteFileStat): string {
  return info.version === undefined ? `remote-meta:${info.kind}:${info.mode}:${info.size}:${info.modifiedAt}`
    : `remote-version:${info.version}:${info.kind}:${info.mode}:${info.size}:${info.modifiedAt}`;
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

async function assertRemoteMutationPath(registration: WorkspaceRegistration, files: RemoteFileTransportPort, path: string, existing: boolean): Promise<void> {
  const parent = pathApi(registration).dirname(path);
  if (await files.realpath(registration.root) !== registration.root || await files.realpath(parent) !== parent
    || (await files.stat(parent)).kind !== "directory") {
    throw new WorkspaceEntryMutationError("Remote paths must stay inside the canonical workspace without symbolic links.", "unsafe");
  }
  if (existing) {
    const info = await files.stat(path);
    if (await files.realpath(path) !== path || (info.kind !== "file" && info.kind !== "directory")) {
      throw new WorkspaceEntryMutationError("Remote mutations require a regular file or directory without symbolic links.", "unsafe");
    }
  }
}

function assertSeparateRemoteDestination(registration: WorkspaceRegistration, source: string, destination: string): void {
  const paths = pathApi(registration), relative = paths.relative(source, destination);
  if (relative === "" || relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)) {
    throw new WorkspaceEntryMutationError("A remote entry cannot be moved or copied into itself.", "unsafe");
  }
}

function assertRemoteRevision(info: RemoteFileStat, expected: string): void {
  if (remoteRevision(info) !== expected) throw new WorkspaceEntryMutationError("Remote entry changed; refresh and retry.", "stale");
}

async function copyRemoteTree(
  registration: WorkspaceRegistration,
  files: RemoteFileTransportPort,
  source: string,
  destination: string,
  budget: { entries: number; bytes: number; effectStarted: boolean }
): Promise<void> {
  const paths = pathApi(registration);
  await assertRemoteMutationPath(registration, files, source, true);
  await assertRemoteMutationPath(registration, files, destination, false);
  const info = await files.stat(source);
  if (++budget.entries > MAXIMUM_TREE_ENTRIES) throw new WorkspaceEntryMutationError("Remote copy is too large.", "too_large");
  if (info.kind === "symbolic_link" || info.kind === "other") throw new WorkspaceEntryMutationError("Remote symbolic links cannot be copied.", "unsupported");
  if (info.kind === "file") {
    budget.bytes += info.size;
    if (budget.bytes > MAXIMUM_COPY_BYTES) throw new WorkspaceEntryMutationError("Remote copy is too large.", "too_large");
    const content = await files.read({ path: source, maximumBytes: Math.max(info.size, 1) });
    await assertRemoteMutationPath(registration, files, source, true);
    if (remoteRevision(await files.stat(source)) !== remoteRevision(info)) throw new WorkspaceEntryMutationError("Remote source changed while it was copied.", "stale");
    await assertRemoteMutationPath(registration, files, destination, false);
    budget.effectStarted = true;
    await files.write({ path: destination, content, mode: info.mode & 0o777, createOnly: true });
    return;
  }
  budget.effectStarted = true;
  await files.mkdir(destination, { recursive: false, mode: info.mode & 0o777 });
  for (const entry of await files.list(source)) {
    if (!safeEntryName(entry.name)) throw new WorkspaceEntryMutationError("Remote entry name is unsafe.", "unsafe");
    await copyRemoteTree(registration, files, paths.join(source, entry.name), paths.join(destination, entry.name), budget);
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
  const gitArgs = executable !== "git" ? args : args[0] === "status" ? ["-c", "core.fsmonitor=false", ...args]
    : ["diff", "show", "log"].includes(args[0] ?? "") ? [args[0]!, "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
  const process = await processes.open({ executable, args: gitArgs, cwd, signal: controller.signal,
    ...(executable !== "git" ? {} : { env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_EXTERNAL_DIFF: "", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } }) });
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
  const unmerged = isUnmergedGitStatus(value.slice(0, 2));
  return { path: canonicalRelative(path), index: unmerged ? "U" : index, worktree: unmerged ? "U" : worktree };
}

async function repositoryRevision(processes: RemoteProcessTransportPort, cwd: string): Promise<string> {
  const [status, index, workingTree, untracked] = await Promise.all([
    runRemote(processes, "git", ["-c", "core.fsmonitor=false", "status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], cwd, 20_000, MAXIMUM_PROCESS_OUTPUT),
    runRemote(processes, "git", ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-color"], cwd, 30_000, MAXIMUM_PROCESS_OUTPUT),
    runRemote(processes, "git", ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-color"], cwd, 30_000, MAXIMUM_PROCESS_OUTPUT),
    runRemote(processes, "git", ["ls-files", "--others", "--exclude-standard", "-z"], cwd, 20_000, MAXIMUM_PROCESS_OUTPUT)
  ]);
  const identity = createHash("sha256");
  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    const diff = await runRemote(processes, "git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-color", "--", "/dev/null", path],
      cwd, 30_000, MAXIMUM_PROCESS_OUTPUT, undefined, new Set([0, 1]));
    identity.update(path).update("\0").update(diff.stdoutBytes).update("\0");
  }
  return hashText(JSON.stringify([status.stdout, index.stdout, workingTree.stdout, untracked.stdout, identity.digest("hex")]));
}

async function gitOptional(processes: RemoteProcessTransportPort, cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const value = (await runRemote(processes, "git", args, cwd, 20_000, 1024 * 1024)).stdout.trim();
    return value === "" ? undefined : value;
  } catch { return undefined; }
}

async function gitOperationInProgress(
  processes: RemoteProcessTransportPort,
  files: RemoteFileTransportPort,
  paths: PlatformPath,
  cwd: string
): Promise<boolean> {
  const gitDirValue = await gitOptional(processes, cwd, ["rev-parse", "--absolute-git-dir"]);
  const gitDir = gitDirValue === undefined
    ? undefined
    : paths.isAbsolute(gitDirValue) ? paths.normalize(gitDirValue) : paths.resolve(cwd, gitDirValue);
  if (gitDir === undefined) return false;
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"] as const) {
    try {
      await files.stat(paths.join(gitDir, marker));
      return true;
    } catch {
      // Missing markers are the ordinary idle state. The enclosing Git probe
      // remains authoritative and avoids host-shell quoting entirely.
    }
  }
  return false;
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



function gitUrlContainsCredential(value: string): boolean {
  try {
    const url = new URL(value);
    return url.password !== "" || ((url.protocol === "http:" || url.protocol === "https:") && url.username !== "");
  } catch { return /^[^@/\\:]+:[^@/\\]+@/u.test(value); }
}
