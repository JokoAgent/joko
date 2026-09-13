import { createHash } from "node:crypto";
import { watch as watchFileSystem, type FSWatcher } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { isWithin } from "@joko/core/policy";

import type { WorkspaceRegistration } from "./workspace-service.js";

const WORKSPACE_WATCH_MAXIMUM_ENTRIES = 100_000;
const WORKSPACE_WATCH_RENAME_WINDOW_MS = 50;
const WORKSPACE_WATCH_SUBSCRIBER_CAPACITY = 1_024;
const WORKSPACE_WATCH_RETRY_MS = 500;

const EXCLUDED_DIRECTORY_NAMES = new Set([
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
const EXCLUDED_FILE_NAMES = new Set([".ds_store", "thumbs.db"]);

export type WorkspaceFileChangeKind =
  | "created"
  | "modified"
  | "deleted"
  | "renamed"
  | "overflow"
  | "resync";

export interface WorkspaceObservedRevision {
  readonly opaqueRevision: string;
  readonly byteSize: number;
  readonly modifiedAt: number;
}

export interface WorkspaceFileChangeDraft {
  readonly workspaceId: string;
  readonly kind: WorkspaceFileChangeKind;
  readonly path?: string;
  readonly previousPath?: string;
  readonly revision?: WorkspaceObservedRevision;
  readonly observedAt: number;
}

export interface WorkspaceFileChangeRecord extends WorkspaceFileChangeDraft {
  readonly sequence: bigint;
  readonly streamRevision: string;
}

export type WorkspaceFileChangeScope =
  | { readonly kind: "owner" }
  | { readonly kind: "workspace"; readonly workspaceId: string };

export interface WorkspaceWatcherObserver {
  readonly change: (change: Omit<WorkspaceFileChangeDraft, "workspaceId" | "observedAt">) => void | Promise<void>;
  readonly overflow: () => void | Promise<void>;
}

export interface WorkspaceWatcherSubscription {
  close(): void | Promise<void>;
}

/** Injectable seam used by conformance tests and non-Node deployments. */
export interface WorkspaceWatcherProvider {
  watch(workspace: WorkspaceRegistration, observer: WorkspaceWatcherObserver): Promise<WorkspaceWatcherSubscription>;
}

export interface WorkspaceChangeJournal {
  append(change: WorkspaceFileChangeDraft): Promise<WorkspaceFileChangeRecord>;
}

interface PersistedWorkspaceChangeCursor {
  readonly sequence: string;
  readonly streamRevision: string;
  readonly lastChange: {
    readonly workspaceId: string;
    readonly kind: WorkspaceFileChangeKind;
    readonly path?: string;
    readonly previousPath?: string;
    readonly opaqueRevision?: string;
    readonly observedAt: number;
  };
}

interface WorkspaceChangeSettingStore {
  findSetting<T>(scopeType: "service", scopeId: string, key: string): { readonly value: T } | undefined;
  setSetting<T>(scopeType: "service", scopeId: string, key: string, value: T): unknown;
}

/**
 * Production journal. Only the latest cursor/event must be retained because a
 * reconnect deliberately starts with RESYNC; persistence still happens before
 * any live subscriber can observe the corresponding event.
 */
export class OperationalWorkspaceChangeJournal implements WorkspaceChangeJournal {
  readonly #store: WorkspaceChangeSettingStore;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(store: WorkspaceChangeSettingStore) {
    this.#store = store;
  }

  append(change: WorkspaceFileChangeDraft): Promise<WorkspaceFileChangeRecord> {
    const result = this.#tail.then(() => {
      const previous = this.#store.findSetting<PersistedWorkspaceChangeCursor>(
        "service",
        "orchestrator",
        "workspace.change.cursor"
      )?.value;
      const priorSequence = parsePersistedSequence(previous?.sequence);
      const sequence = priorSequence + 1n;
      const streamRevision = workspaceStreamRevision(previous?.streamRevision ?? "workspace-stream:v1", sequence, change);
      const persisted: PersistedWorkspaceChangeCursor = {
        sequence: sequence.toString(10),
        streamRevision,
        lastChange: {
          workspaceId: change.workspaceId,
          kind: change.kind,
          ...(change.path === undefined ? {} : { path: change.path }),
          ...(change.previousPath === undefined ? {} : { previousPath: change.previousPath }),
          ...(change.revision === undefined ? {} : { opaqueRevision: change.revision.opaqueRevision }),
          observedAt: change.observedAt
        }
      };
      this.#store.setSetting("service", "orchestrator", "workspace.change.cursor", persisted);
      return { ...change, sequence, streamRevision } satisfies WorkspaceFileChangeRecord;
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

export class InMemoryWorkspaceChangeJournal implements WorkspaceChangeJournal {
  #sequence = 0n;
  #streamRevision = "workspace-stream:v1";

  async append(change: WorkspaceFileChangeDraft): Promise<WorkspaceFileChangeRecord> {
    const sequence = ++this.#sequence;
    this.#streamRevision = workspaceStreamRevision(this.#streamRevision, sequence, change);
    return { ...change, sequence, streamRevision: this.#streamRevision };
  }
}

interface ObservedEntry {
  readonly path: string;
  readonly directory: boolean;
  readonly identity: string;
  readonly revision: WorkspaceObservedRevision;
}

interface PendingDeletion {
  readonly entry: ObservedEntry;
  readonly timer: NodeJS.Timeout;
}

/** Node 22 recursive fs.watch provider with a canonical/symlink-safe snapshot. */
export class NodeWorkspaceWatcherProvider implements WorkspaceWatcherProvider {
  async watch(workspace: WorkspaceRegistration, observer: WorkspaceWatcherObserver): Promise<WorkspaceWatcherSubscription> {
    let closed = false;
    let failed = false;
    let tail: Promise<void> = Promise.resolve();
    let readyResolve: (() => void) | undefined;
    let readyReject: ((error: unknown) => void) | undefined;
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      readyResolve = resolvePromise;
      readyReject = rejectPromise;
    });
    const known = new Map<string, ObservedEntry>();
    const pendingDeletions = new Map<string, PendingDeletion>();

    const reportOverflow = (): void => {
      if (closed || failed) return;
      failed = true;
      void Promise.resolve(observer.overflow()).catch(() => undefined);
    };
    const consume = (eventType: string, filename: string | Buffer | null): void => {
      tail = tail.then(async () => {
        await ready;
        if (closed || failed) return;
        if (filename === null) {
          reportOverflow();
          return;
        }
        const path = canonicalWatcherPath(filename.toString());
        if (path === undefined) {
          reportOverflow();
          return;
        }
        const previous = known.get(path);
        const current = await observeWorkspaceEntry(workspace.root, path);
        if (closed || failed) return;
        if (workspaceWatchPathExcluded(path, current?.directory ?? previous?.directory ?? false)) return;
        if (current === undefined) {
          if (previous !== undefined) {
            known.delete(path);
            scheduleDeletion(previous);
          }
          return;
        }

        known.set(path, current);
        const pending = pendingDeletions.get(current.identity);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          pendingDeletions.delete(current.identity);
          if (pending.entry.path === path) {
            await observer.change({ kind: "modified", path, revision: current.revision });
          } else {
            rewriteKnownDirectoryPrefix(known, pending.entry, current);
            await observer.change({
              kind: "renamed",
              path,
              previousPath: pending.entry.path,
              revision: current.revision
            });
          }
          return;
        }
        if (previous === undefined) {
          await observer.change({ kind: "created", path, revision: current.revision });
          return;
        }
        if (eventType === "change" || previous.revision.opaqueRevision !== current.revision.opaqueRevision) {
          await observer.change({ kind: "modified", path, revision: current.revision });
        }
      }).catch(() => reportOverflow());
    };
    const scheduleDeletion = (entry: ObservedEntry): void => {
      const existing = pendingDeletions.get(entry.identity);
      if (existing !== undefined) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        pendingDeletions.delete(entry.identity);
        tail = tail.then(async () => {
          if (!closed && !failed) await observer.change({ kind: "deleted", path: entry.path });
        }).catch(() => reportOverflow());
      }, WORKSPACE_WATCH_RENAME_WINDOW_MS);
      timer.unref?.();
      pendingDeletions.set(entry.identity, { entry, timer });
    };

    let watcher: FSWatcher;
    try {
      watcher = watchFileSystem(workspace.root, { recursive: true }, consume);
      watcher.once("error", reportOverflow);
      const snapshot = await snapshotWorkspaceEntries(workspace.root);
      for (const entry of snapshot) known.set(entry.path, entry);
      readyResolve?.();
    } catch (error) {
      closed = true;
      readyReject?.(error);
      try { watcher!.close(); } catch { /* watcher did not start or is already closed */ }
      throw error;
    }

    return {
      close: async () => {
        if (closed) return;
        closed = true;
        for (const pending of pendingDeletions.values()) clearTimeout(pending.timer);
        pendingDeletions.clear();
        try { watcher.close(); } catch { /* already closed */ }
        await tail.catch(() => undefined);
      }
    };
  }
}

interface StreamSubscriber {
  readonly id: number;
  readonly scope: WorkspaceFileChangeScope;
  readonly queue: BoundedAsyncQueue<WorkspaceFileChangeRecord>;
}

interface ActiveWorkspaceWatcher {
  readonly subscription: WorkspaceWatcherSubscription;
}

/**
 * Ref-counted workspace stream. Native callbacks enter one serialization tail;
 * the journal assigns the owner-wide sequence before subscribers are notified.
 */
export class WorkspaceChangeStream {
  readonly #provider: WorkspaceWatcherProvider;
  readonly #journal: WorkspaceChangeJournal;
  readonly #registrations: () => readonly WorkspaceRegistration[];
  readonly #now: () => number;
  readonly #subscribers = new Map<number, StreamSubscriber>();
  readonly #watchers = new Map<string, ActiveWorkspaceWatcher>();
  readonly #watcherStarts = new Map<string, Promise<void>>();
  readonly #retryTimers = new Map<string, NodeJS.Timeout>();
  #nextSubscriberId = 1;
  #publishTail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: {
    readonly provider?: WorkspaceWatcherProvider;
    readonly journal?: WorkspaceChangeJournal;
    readonly registrations: () => readonly WorkspaceRegistration[];
    readonly now?: () => number;
  }) {
    this.#provider = options.provider ?? new NodeWorkspaceWatcherProvider();
    this.#journal = options.journal ?? new InMemoryWorkspaceChangeJournal();
    this.#registrations = options.registrations;
    this.#now = options.now ?? Date.now;
  }

  async *watch(scope: WorkspaceFileChangeScope, signal?: AbortSignal): AsyncGenerator<WorkspaceFileChangeRecord> {
    if (this.#closed) throw new Error("Workspace change stream is closed.");
    if (abortSignalRaised(signal)) return;
    const registrations = this.#matchingRegistrations(scope);
    if (scope.kind === "workspace" && registrations.length !== 1) {
      throw new Error(`Workspace ${scope.workspaceId} is not registered.`);
    }
    const subscriber: StreamSubscriber = {
      id: this.#nextSubscriberId++,
      scope,
      queue: new BoundedAsyncQueue(WORKSPACE_WATCH_SUBSCRIBER_CAPACITY, signal)
    };
    this.#subscribers.set(subscriber.id, subscriber);
    try {
      // Install the native watcher before the resync marker. Any event in the
      // startup window is ordered before a final RESYNC, so no mutation is lost.
      for (const registration of registrations) await this.#ensureWatcher(registration);
      if (abortSignalRaised(signal)) return;
      for (const registration of registrations) {
        await this.#publish({ workspaceId: registration.id, kind: "resync", observedAt: this.#now() });
      }
      while (true) {
        const next = await subscriber.queue.next();
        if (next === undefined) return;
        yield next;
      }
    } finally {
      this.#subscribers.delete(subscriber.id);
      subscriber.queue.close();
      await this.#closeUnusedWatchers();
    }
  }

  async workspaceRegistered(registration: WorkspaceRegistration): Promise<void> {
    if (this.#closed || !this.#hasOwnerSubscriber()) return;
    await this.#ensureWatcher(registration);
    await this.#publish({ workspaceId: registration.id, kind: "resync", observedAt: this.#now() });
  }

  async workspaceUnregistered(workspaceId: string): Promise<void> {
    if (this.#closed) return;
    this.#cancelRetry(workspaceId);
    const active = this.#watchers.get(workspaceId);
    this.#watchers.delete(workspaceId);
    await active?.subscription.close();
    await this.#watcherStarts.get(workspaceId)?.catch(() => undefined);
    const startedWhileClosing = this.#watchers.get(workspaceId);
    if (startedWhileClosing !== undefined) {
      this.#watchers.delete(workspaceId);
      await startedWhileClosing.subscription.close();
    }
    this.#cancelRetry(workspaceId);
    if (this.#subscribers.size > 0) {
      await this.#publish({ workspaceId, kind: "resync", observedAt: this.#now() });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    for (const subscriber of this.#subscribers.values()) subscriber.queue.close();
    this.#subscribers.clear();
    await Promise.all(watchers.map(async (watcher) => watcher.subscription.close()));
    await Promise.all([...this.#watcherStarts.values()].map(async (start) => start.catch(() => undefined)));
    await this.#publishTail.catch(() => undefined);
  }

  async #ensureWatcher(registration: WorkspaceRegistration): Promise<void> {
    if (this.#closed || !this.#workspaceHasSubscriber(registration.id) || this.#watchers.has(registration.id)) return;
    const pending = this.#watcherStarts.get(registration.id);
    if (pending !== undefined) {
      await pending;
      return;
    }
    this.#cancelRetry(registration.id);
    // Defer the provider call by one microtask so the in-flight marker is
    // installed before even a synchronous provider overflow callback can run.
    const start = Promise.resolve().then(async () => this.#startWatcher(registration));
    this.#watcherStarts.set(registration.id, start);
    try {
      await start;
    } finally {
      if (this.#watcherStarts.get(registration.id) === start) this.#watcherStarts.delete(registration.id);
    }
  }

  async #startWatcher(registration: WorkspaceRegistration): Promise<void> {
    let overflowed = false;
    try {
      const subscription = await this.#provider.watch(registration, {
        change: async (change) => {
          if (overflowed || this.#closed) return;
          await this.#publish({
            workspaceId: registration.id,
            ...change,
            observedAt: this.#now()
          });
        },
        overflow: async () => {
          if (overflowed || this.#closed) return;
          overflowed = true;
          await this.#watcherOverflow(registration.id);
        }
      });
      const current = this.#registrations().find((candidate) => candidate.id === registration.id);
      if (
        overflowed ||
        this.#closed ||
        !this.#workspaceHasSubscriber(registration.id) ||
        current?.root !== registration.root
      ) {
        await subscription.close();
        return;
      }
      this.#watchers.set(registration.id, { subscription });
    } catch {
      const current = this.#registrations().find((candidate) => candidate.id === registration.id);
      if (
        this.#closed ||
        overflowed ||
        !this.#workspaceHasSubscriber(registration.id) ||
        current?.root !== registration.root
      ) return;
      try {
        await this.#publish({ workspaceId: registration.id, kind: "overflow", observedAt: this.#now() });
        await this.#publish({ workspaceId: registration.id, kind: "resync", observedAt: this.#now() });
      } finally {
        this.#scheduleRetry(registration.id);
      }
    }
  }

  async #watcherOverflow(workspaceId: string): Promise<void> {
    const active = this.#watchers.get(workspaceId);
    this.#watchers.delete(workspaceId);
    await active?.subscription.close();
    if (this.#closed || !this.#workspaceHasSubscriber(workspaceId)) return;
    await this.#publish({ workspaceId, kind: "overflow", observedAt: this.#now() });
    await this.#publish({ workspaceId, kind: "resync", observedAt: this.#now() });
    this.#scheduleRetry(workspaceId);
  }

  #scheduleRetry(workspaceId: string): void {
    if (this.#closed || this.#retryTimers.has(workspaceId) || !this.#workspaceHasSubscriber(workspaceId)) return;
    const timer = setTimeout(() => {
      this.#retryTimers.delete(workspaceId);
      const registration = this.#registrations().find((candidate) => candidate.id === workspaceId);
      if (registration !== undefined) {
        void this.#ensureWatcher(registration).catch(() => undefined).finally(() => {
          if (!this.#closed && !this.#watchers.has(workspaceId) && this.#workspaceHasSubscriber(workspaceId)) {
            this.#scheduleRetry(workspaceId);
          }
        });
      }
    }, WORKSPACE_WATCH_RETRY_MS);
    timer.unref?.();
    this.#retryTimers.set(workspaceId, timer);
  }

  #cancelRetry(workspaceId: string): void {
    const timer = this.#retryTimers.get(workspaceId);
    if (timer !== undefined) clearTimeout(timer);
    this.#retryTimers.delete(workspaceId);
  }

  #publish(change: WorkspaceFileChangeDraft): Promise<WorkspaceFileChangeRecord> {
    if (this.#closed) return Promise.reject(new Error("Workspace change stream is closed."));
    assertWorkspaceFileChangeDraft(change);
    const result = this.#publishTail.then(async () => {
      const persisted = await this.#journal.append(change);
      for (const subscriber of this.#subscribers.values()) {
        if (!scopeMatches(subscriber.scope, persisted.workspaceId)) continue;
        if (!subscriber.queue.push(persisted)) subscriber.queue.close();
      }
      return persisted;
    });
    this.#publishTail = result.catch(() => undefined);
    return result.catch((error: unknown) => {
      // Persistence is the publication boundary. If it fails, terminate every
      // affected subscriber so clients reconnect through a fresh RESYNC rather
      // than waiting forever on a stream that can no longer advance safely.
      for (const subscriber of this.#subscribers.values()) {
        if (scopeMatches(subscriber.scope, change.workspaceId)) subscriber.queue.close();
      }
      throw error;
    });
  }

  #matchingRegistrations(scope: WorkspaceFileChangeScope): readonly WorkspaceRegistration[] {
    const registrations = this.#registrations();
    return scope.kind === "owner"
      ? registrations
      : registrations.filter((registration) => registration.id === scope.workspaceId);
  }

  #workspaceHasSubscriber(workspaceId: string): boolean {
    return [...this.#subscribers.values()].some((subscriber) => scopeMatches(subscriber.scope, workspaceId));
  }

  #hasOwnerSubscriber(): boolean {
    return [...this.#subscribers.values()].some((subscriber) => subscriber.scope.kind === "owner");
  }

  async #closeUnusedWatchers(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const workspaceId of this.#retryTimers.keys()) {
      if (!this.#workspaceHasSubscriber(workspaceId)) this.#cancelRetry(workspaceId);
    }
    for (const [workspaceId, active] of this.#watchers) {
      if (this.#workspaceHasSubscriber(workspaceId)) continue;
      this.#watchers.delete(workspaceId);
      this.#cancelRetry(workspaceId);
      closing.push(Promise.resolve(active.subscription.close()));
    }
    await Promise.all(closing);
  }
}

class BoundedAsyncQueue<T> {
  readonly #capacity: number;
  readonly #signal: AbortSignal | undefined;
  readonly #values: T[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  constructor(capacity: number, signal?: AbortSignal) {
    this.#capacity = capacity;
    this.#signal = signal;
    signal?.addEventListener("abort", this.#abort, { once: true });
  }

  push(value: T): boolean {
    if (this.#closed || this.#values.length >= this.#capacity) return false;
    this.#values.push(value);
    this.#wake?.();
    this.#wake = undefined;
    return true;
  }

  async next(): Promise<T | undefined> {
    while (!this.#closed && this.#signal?.aborted !== true) {
      const value = this.#values.shift();
      if (value !== undefined) return value;
      await new Promise<void>((resolvePromise) => { this.#wake = resolvePromise; });
    }
    return undefined;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values.length = 0;
    this.#signal?.removeEventListener("abort", this.#abort);
    this.#wake?.();
    this.#wake = undefined;
  }

  readonly #abort = (): void => this.close();
}

async function snapshotWorkspaceEntries(root: string): Promise<readonly ObservedEntry[]> {
  const output: ObservedEntry[] = [];
  const queue = [""];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const absoluteParent = parent === "" ? root : resolve(root, ...parent.split("/"));
    const children = await readdir(absoluteParent, { withFileTypes: true });
    for (const child of children) {
      const path = parent === "" ? child.name : `${parent}/${child.name}`;
      if (workspaceWatchPathExcluded(path, child.isDirectory())) continue;
      const observed = await observeWorkspaceEntry(root, path);
      if (observed === undefined) continue;
      output.push(observed);
      if (output.length > WORKSPACE_WATCH_MAXIMUM_ENTRIES) {
        throw new Error("Workspace watcher snapshot exceeded its safe entry limit.");
      }
      if (observed.directory) queue.push(path);
    }
  }
  return output;
}

async function observeWorkspaceEntry(root: string, path: string): Promise<ObservedEntry | undefined> {
  const absolute = resolve(root, ...path.split("/"));
  if (!isWithin(absolute, root) || slash(relative(root, absolute)) !== path) return undefined;
  let current = root;
  try {
    for (const part of path.split("/")) {
      current = resolve(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return undefined;
    }
    const info = await lstat(absolute);
    if (!info.isFile() && !info.isDirectory()) return undefined;
    const canonical = await realpath(absolute);
    if (canonical !== absolute || !isWithin(canonical, root)) return undefined;
    return {
      path,
      directory: info.isDirectory(),
      identity: `${info.dev}:${info.ino}:${info.isDirectory() ? "d" : "f"}`,
      revision: {
        opaqueRevision: `meta:${info.dev}:${info.ino}:${info.mode}:${info.nlink}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        byteSize: info.isDirectory() ? 0 : info.size,
        modifiedAt: info.mtimeMs
      }
    };
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function canonicalWatcherPath(raw: string): string | undefined {
  const value = raw.split(sep).join("/").replace(/\\/gu, "/");
  if (
    value === "" ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    isAbsolute(value) ||
    /^[a-z]:\//iu.test(value) ||
    /[\0-\x1f\x7f]/u.test(value) ||
    (process.platform === "win32" && /[:*?"<>|]/u.test(value))
  ) return undefined;
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return undefined;
  if (process.platform === "win32" && parts.some((part) => part.endsWith(".") || part.endsWith(" "))) return undefined;
  return value;
}

function workspaceWatchPathExcluded(path: string, directory: boolean): boolean {
  const parts = path.split("/");
  const leaf = parts.at(-1)?.toLocaleLowerCase("en-US") ?? "";
  if (leaf.endsWith(".meta") || EXCLUDED_FILE_NAMES.has(leaf) || /^\.joko-(?:write|entry-).+\.tmp$/u.test(leaf)) return true;
  return parts.some((part, index) => index < parts.length - 1 && EXCLUDED_DIRECTORY_NAMES.has(part.toLocaleLowerCase("en-US")))
    || (directory && EXCLUDED_DIRECTORY_NAMES.has(leaf));
}

function assertWorkspaceFileChangeDraft(change: WorkspaceFileChangeDraft): void {
  if (change.workspaceId.trim() === "" || !Number.isSafeInteger(change.observedAt) || change.observedAt < 0) {
    throw new Error("Workspace file change metadata is invalid.");
  }
  if (!(["created", "modified", "deleted", "renamed", "overflow", "resync"] as readonly string[]).includes(change.kind)) {
    throw new Error("Workspace file change kind is invalid.");
  }
  if (change.kind === "overflow" || change.kind === "resync") {
    if (change.path !== undefined || change.previousPath !== undefined || change.revision !== undefined) {
      throw new Error("Workspace resync/overflow events cannot expose a path or file revision.");
    }
    return;
  }
  if (change.path === undefined || canonicalWatcherPath(change.path) !== change.path || reservedWorkspaceControlPath(change.path)) {
    throw new Error("Workspace file change path must be a canonical safe relative path.");
  }
  if (change.kind === "renamed") {
    if (
      change.previousPath === undefined ||
      canonicalWatcherPath(change.previousPath) !== change.previousPath ||
      reservedWorkspaceControlPath(change.previousPath) ||
      change.previousPath === change.path
    ) throw new Error("Workspace rename events require two different canonical safe relative paths.");
  } else if (change.previousPath !== undefined) {
    throw new Error("Only workspace rename events can carry a previous path.");
  }
  if (change.revision !== undefined && (
    change.revision.opaqueRevision.trim() === "" ||
    !Number.isSafeInteger(change.revision.byteSize) ||
    change.revision.byteSize < 0 ||
    !Number.isFinite(change.revision.modifiedAt) ||
    change.revision.modifiedAt < 0
  )) throw new Error("Workspace file change revision is invalid.");
}

function reservedWorkspaceControlPath(path: string): boolean {
  const parts = path.split("/");
  const leaf = parts.at(-1)?.toLocaleLowerCase("en-US") ?? "";
  return parts.some((part) => part.toLocaleLowerCase("en-US") === ".git")
    || leaf.endsWith(".meta")
    || /(^|\/)\.joko-(?:write|entry-)[^/]*\.tmp$/iu.test(path);
}

function rewriteKnownDirectoryPrefix(
  known: Map<string, ObservedEntry>,
  previous: ObservedEntry,
  current: ObservedEntry
): void {
  if (!previous.directory || !current.directory) return;
  const prefix = `${previous.path}/`;
  for (const [path, entry] of [...known]) {
    if (!path.startsWith(prefix)) continue;
    const nextPath = `${current.path}/${path.slice(prefix.length)}`;
    known.delete(path);
    known.set(nextPath, { ...entry, path: nextPath });
  }
}

function workspaceStreamRevision(previous: string, sequence: bigint, change: WorkspaceFileChangeDraft): string {
  const canonical = JSON.stringify({
    previous,
    sequence: sequence.toString(10),
    workspaceId: change.workspaceId,
    kind: change.kind,
    path: change.path ?? "",
    previousPath: change.previousPath ?? "",
    opaqueRevision: change.revision?.opaqueRevision ?? "",
    byteSize: change.revision?.byteSize ?? 0,
    modifiedAt: change.revision?.modifiedAt ?? 0,
    observedAt: change.observedAt
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function parsePersistedSequence(value: string | undefined): bigint {
  if (value === undefined || !/^(?:0|[1-9]\d*)$/u.test(value)) return 0n;
  return BigInt(value);
}

function scopeMatches(scope: WorkspaceFileChangeScope, workspaceId: string): boolean {
  return scope.kind === "owner" || scope.workspaceId === workspaceId;
}

function abortSignalRaised(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function slash(value: string): string {
  return value.split(sep).join("/");
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
