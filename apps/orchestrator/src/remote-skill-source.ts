import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import { CODEX_PROJECT_SKILL_ROOTS } from "@joko/adapter-codex";
import type { RemoteFileStat } from "@joko/remote-ssh";
import type { OperationalStore } from "@joko/store";
import { isSensitiveSkillPath } from "./skill-content-policy.js";
import type { RemoteSkillSourceAuthority } from "./remote-workspace-service.js";

/** Source provenance is service-private; no remote path is a public acquisition. */
export interface StoredRemoteProjectSkillSource {
  readonly kind: "remote_project";
  readonly targetId: string;
  readonly workspaceId: string;
  readonly rootRegistrationId: string;
  readonly executionIdentity: string;
  readonly projectRoot: (typeof CODEX_PROJECT_SKILL_ROOTS)[number];
  readonly packageKey: string;
  readonly sourceIncarnation: string;
  readonly sourceRevision: string;
  readonly generationId: string;
}

export interface RemoteProjectSkillCandidate {
  readonly source: StoredRemoteProjectSkillSource;
  readonly localPath: string;
  readonly name: string;
  readonly assertCurrent: () => void;
  readonly discard: () => Promise<void>;
}

export interface RemoteSkillSourceOwnerOptions {
  readonly store: Pick<OperationalStore, "getTarget" | "getBackend">;
  readonly managedRoot: string;
  readonly captureSkillSourceAuthority: (workspaceId: string, signal?: AbortSignal) => Promise<RemoteSkillSourceAuthority>;
  readonly maximumEntries?: number;
  readonly maximumBytes?: number;
}

/** Downloads only Adapter-declared project roots of an exact registered SSH Target. */
export class RemoteSkillSourceOwner {
  readonly #store: RemoteSkillSourceOwnerOptions["store"];
  readonly #root: string;
  readonly #capture: RemoteSkillSourceOwnerOptions["captureSkillSourceAuthority"];
  readonly #maximumEntries: number;
  readonly #maximumBytes: number;

  constructor(options: RemoteSkillSourceOwnerOptions) {
    if (!isAbsolute(options.managedRoot) || resolve(options.managedRoot) !== options.managedRoot) throw unavailable();
    this.#store = options.store;
    this.#root = options.managedRoot;
    this.#capture = options.captureSkillSourceAuthority;
    this.#maximumEntries = options.maximumEntries ?? 10_000;
    this.#maximumBytes = options.maximumBytes ?? 500 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maximumEntries) || this.#maximumEntries < 1 || this.#maximumEntries > 10_000
      || !Number.isSafeInteger(this.#maximumBytes) || this.#maximumBytes < 1 || this.#maximumBytes > 500 * 1024 * 1024) throw unavailable();
  }

  localPath(source: StoredRemoteProjectSkillSource): string {
    validateRemoteProjectSkillSource(source);
    return join(this.#root, source.generationId, "payload");
  }

  assertTargetCurrent(source: StoredRemoteProjectSkillSource, backendId: string, workspaceRoot: string): void {
    validateRemoteProjectSkillSource(source);
    const target = this.#store.getTarget(source.targetId);
    const metadata = target.metadata as Record<string, unknown>;
    if (target.descriptor.backendId !== backendId || !target.descriptor.trusted || metadata?.["deletedAt"] !== undefined
      || metadata?.["workspaceId"] !== source.workspaceId || target.descriptor.remoteWorkspace?.kind !== "ssh"
      || target.descriptor.remoteWorkspace.workspaceRoot !== workspaceRoot
      || this.#store.getBackend(backendId).descriptor.adapterKind !== "codex") throw unavailable();
  }

  async discover(targetId: string, signal?: AbortSignal): Promise<readonly RemoteProjectSkillCandidate[]> {
    const captured = await this.#authority(targetId, signal);
    const candidates: RemoteProjectSkillCandidate[] = [];
    try {
      for (const projectRoot of CODEX_PROJECT_SKILL_ROOTS) {
        const root = posix.join(captured.authority.registration.root, projectRoot);
        if (!await optionalDirectory(captured.authority, root, signal)) continue;
        const entries = await captured.authority.files.list(root, signal);
        captured.assertCurrent(); signal?.throwIfAborted();
        if (entries.length > 500) throw unavailable();
        if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw unavailable();
        for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
          portableKey(entry.name);
          if (entry.kind === "file") continue;
          if (entry.kind !== "directory" || isSensitiveSkillPath(entry.name)) throw unavailable();
          const sourcePath = posix.join(root, entry.name);
          if (!await optionalSkillFile(captured.authority, posix.join(sourcePath, "SKILL.md"), signal)) continue;
          if (candidates.length >= 500) throw unavailable();
          const generationId = randomUUID();
          const localPath = await this.#generation(generationId);
          try {
            const observed = await this.#tree(captured.authority, sourcePath, localPath, signal);
            const confirmed = await this.#tree(captured.authority, sourcePath, undefined, signal);
            if (confirmed.incarnation !== observed.incarnation || confirmed.revision !== observed.revision) throw unavailable();
            captured.assertCurrent(); signal?.throwIfAborted();
            const source: StoredRemoteProjectSkillSource = Object.freeze({
              kind: "remote_project", targetId, workspaceId: captured.authority.registration.id,
              rootRegistrationId: captured.authority.rootRegistrationId, executionIdentity: captured.authority.executionIdentity,
              projectRoot, packageKey: entry.name, sourceIncarnation: observed.incarnation,
              sourceRevision: observed.revision, generationId
            });
            candidates.push(Object.freeze({ source, localPath, name: entry.name, assertCurrent: captured.assertCurrent,
              discard: () => this.discard(source) }));
          } catch (error) {
            await this.#removeGeneration(generationId);
            throw error;
          }
        }
      }
      captured.assertCurrent(); signal?.throwIfAborted();
      return Object.freeze(candidates);
    } catch (error) {
      await Promise.allSettled(candidates.map(candidate => candidate.discard()));
      signal?.throwIfAborted();
      throw unavailable();
    }
  }

  /** Reinspection is required at approval and new runtime snapshot creation. */
  async verify(source: StoredRemoteProjectSkillSource, signal?: AbortSignal): Promise<() => void> {
    return (await this.captureStored(source, signal)).assertCurrent;
  }

  async captureStored(source: StoredRemoteProjectSkillSource, signal?: AbortSignal): Promise<{
    readonly authority: RemoteSkillSourceAuthority; readonly localPath: string; readonly assertCurrent: () => void
  }> {
    validateRemoteProjectSkillSource(source);
    const captured = await this.#authority(source.targetId, signal);
    const authority = captured.authority;
    if (authority.registration.id !== source.workspaceId || authority.rootRegistrationId !== source.rootRegistrationId
      || authority.executionIdentity !== source.executionIdentity) throw unavailable();
    const projectRoot = posix.join(authority.registration.root, source.projectRoot);
    if (!await optionalDirectory(authority, projectRoot, signal)) throw unavailable();
    const observed = await this.#tree(authority, posix.join(projectRoot, source.packageKey), undefined, signal);
    captured.assertCurrent(); signal?.throwIfAborted();
    if (observed.incarnation !== source.sourceIncarnation || observed.revision !== source.sourceRevision) throw unavailable();
    await this.assertLocalGeneration(source);
    captured.assertCurrent(); signal?.throwIfAborted();
    return Object.freeze({ authority, localPath: this.localPath(source), assertCurrent: captured.assertCurrent });
  }

  async assertLocalGeneration(source: StoredRemoteProjectSkillSource): Promise<void> {
    const local = this.localPath(source);
    const root = await realpath(this.#root);
    if (root !== this.#root || await realpath(local) !== local || !(await lstat(local)).isDirectory()
      || (await lstat(local)).isSymbolicLink() || relative(root, local) !== join(source.generationId, "payload")) throw unavailable();
  }

  async discard(source: StoredRemoteProjectSkillSource): Promise<void> {
    validateRemoteProjectSkillSource(source);
    await this.#removeGeneration(source.generationId);
  }

  async #authority(targetId: string, signal?: AbortSignal): Promise<{ readonly authority: RemoteSkillSourceAuthority; readonly assertCurrent: () => void }> {
    signal?.throwIfAborted();
    const target = this.#store.getTarget(targetId);
    const metadata = target.metadata as Record<string, unknown>;
    const workspaceId = metadata?.["workspaceId"];
    const backend = this.#store.getBackend(target.descriptor.backendId);
    if (metadata?.["deletedAt"] !== undefined || !target.descriptor.trusted || target.descriptor.remoteWorkspace?.kind !== "ssh"
      || backend.descriptor.adapterKind !== "codex" || typeof workspaceId !== "string" || workspaceId.length === 0) throw unavailable();
    const capability = backend.descriptor.capabilities.get("runtime.resources");
    if (capability?.supported !== true || !capability.options?.includes("skill")) throw unavailable();
    const authority = await this.#capture(workspaceId, signal);
    signal?.throwIfAborted();
    if (authority.registration.remote?.targetId !== targetId || authority.registration.root !== target.descriptor.remoteWorkspace.workspaceRoot) throw unavailable();
    const assertCurrent = (): void => {
      authority.assertCurrent(); authority.assertFilesCurrent();
      const current = this.#store.getTarget(targetId);
      const currentBackend = this.#store.getBackend(target.descriptor.backendId);
      if (current.revision !== target.revision || !current.descriptor.trusted
        || currentBackend.descriptor.instanceGeneration !== backend.descriptor.instanceGeneration
        || JSON.stringify(current.descriptor.remoteWorkspace) !== JSON.stringify(target.descriptor.remoteWorkspace)
        || (current.metadata as Record<string, unknown>)?.["workspaceId"] !== workspaceId) throw unavailable();
      const cap = currentBackend.descriptor.capabilities.get("runtime.resources");
      if (cap?.supported !== true || !cap.options?.includes("skill")) throw unavailable();
    };
    assertCurrent();
    return { authority, assertCurrent };
  }

  async #generation(id: string): Promise<string> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    if (await realpath(this.#root) !== this.#root || (await lstat(this.#root)).isSymbolicLink()) throw unavailable();
    const container = join(this.#root, id), payload = join(container, "payload");
    await mkdir(container, { mode: 0o700 });
    await mkdir(payload, { mode: 0o700 });
    return payload;
  }

  async #removeGeneration(id: string): Promise<void> {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw unavailable();
    const container = join(this.#root, id);
    const info = await lstat(container).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info === undefined) return;
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(this.#root) !== this.#root || await realpath(container) !== container) throw unavailable();
    await rm(container, { recursive: true });
  }

  async #tree(authority: RemoteSkillSourceAuthority, source: string, destination: string | undefined, signal?: AbortSignal): Promise<{ readonly incarnation: string; readonly revision: string }> {
    let entries = 0, bytes = 0;
    const manifest: unknown[] = [];
    let skillFound = false;
    const rootBefore = await exactStat(authority, source, signal);
    if (rootBefore.kind !== "directory") throw unavailable();
    const visit = async (path: string, key: string): Promise<void> => {
      authority.assertFilesCurrent(); signal?.throwIfAborted();
      if (++entries > this.#maximumEntries) throw unavailable();
      const before = await exactStat(authority, path, signal);
      if (before.kind === "directory") {
        const listed = await authority.files.list(path, signal);
        authority.assertFilesCurrent(); signal?.throwIfAborted();
        if (listed.length > this.#maximumEntries) throw unavailable();
        const ordered = [...listed].sort((a, b) => a.name.localeCompare(b.name, "en"));
        if (new Set(ordered.map(entry => entry.name)).size !== ordered.length) throw unavailable();
        manifest.push(["directory", key, before.mode, before.modifiedAt]);
        for (const entry of ordered) {
          const childKey = key ? `${key}/${entry.name}` : entry.name;
          portableKey(childKey);
          if (isSensitiveSkillPath(childKey)) throw unavailable();
          if (entry.kind !== "file" && entry.kind !== "directory") throw unavailable();
          if (destination !== undefined && entry.kind === "directory") await mkdir(join(destination, ...childKey.split("/")), { mode: 0o700 });
          await visit(posix.join(path, entry.name), childKey);
        }
        const afterList = await authority.files.list(path, signal);
        authority.assertFilesCurrent(); signal?.throwIfAborted();
        if (JSON.stringify([...afterList].sort((a, b) => a.name.localeCompare(b.name, "en"))) !== JSON.stringify(ordered)) throw unavailable();
      } else if (before.kind === "file") {
        bytes += before.size;
        if (!Number.isSafeInteger(before.size) || before.size < 0 || bytes > this.#maximumBytes) throw unavailable();
        const content = await authority.files.read({ path, maximumBytes: before.size || 1, signal });
        authority.assertFilesCurrent(); signal?.throwIfAborted();
        if (content.byteLength !== before.size) throw unavailable();
        if (key === "SKILL.md") {
          if (content.byteLength > 2 * 1024 * 1024) throw unavailable();
          new TextDecoder("utf-8", { fatal: true }).decode(content);
          skillFound = true;
        }
        manifest.push(["file", key, before.size, before.mode, before.modifiedAt, createHash("sha256").update(content).digest("hex")]);
        if (destination !== undefined) {
          const handle = await open(join(destination, ...key.split("/")), "wx", before.mode & 0o111 ? 0o755 : 0o644);
          try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
        }
      } else throw unavailable();
      const after = await exactStat(authority, path, signal);
      if (!sameStat(before, after)) throw unavailable();
    };
    await visit(source, "");
    if (!skillFound) throw unavailable();
    authority.assertFilesCurrent(); signal?.throwIfAborted();
    return { incarnation: digest([authority.rootRegistrationId, authority.executionIdentity, source, rootBefore]), revision: digest(manifest) };
  }
}

export function remoteProjectSkillSourceIdentity(source: StoredRemoteProjectSkillSource): string {
  return digest([source.targetId, source.workspaceId, source.rootRegistrationId, source.executionIdentity, source.projectRoot, source.packageKey]);
}

export function validateRemoteProjectSkillSource(value: StoredRemoteProjectSkillSource): StoredRemoteProjectSkillSource {
  if (!value || typeof value !== "object" || Object.keys(value).length !== 10 || value.kind !== "remote_project"
    || !CODEX_PROJECT_SKILL_ROOTS.includes(value.projectRoot) || !/^[a-f0-9-]{36}$/u.test(value.generationId)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.rootRegistrationId) || !/^sha256:[a-f0-9]{64}$/u.test(value.sourceIncarnation)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.sourceRevision)
    || [value.targetId, value.workspaceId, value.executionIdentity].some(item => typeof item !== "string" || item.length === 0 || item.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(item))) throw unavailable();
  portableKey(value.packageKey);
  if (value.packageKey.includes("/") || isSensitiveSkillPath(value.packageKey)) throw unavailable();
  return { ...value };
}

async function exactStat(authority: RemoteSkillSourceAuthority, path: string, signal?: AbortSignal): Promise<RemoteFileStat> {
  authority.assertFilesCurrent(); signal?.throwIfAborted();
  const before = await authority.files.stat(path, signal);
  authority.assertFilesCurrent(); signal?.throwIfAborted();
  if (before.kind !== "file" && before.kind !== "directory" || await authority.files.realpath(path, signal) !== path) throw unavailable();
  authority.assertFilesCurrent(); signal?.throwIfAborted();
  return before;
}

async function optionalDirectory(authority: RemoteSkillSourceAuthority, path: string, signal?: AbortSignal): Promise<boolean> {
  try { return (await exactStat(authority, path, signal)).kind === "directory"; }
  catch (error) { authority.assertFilesCurrent(); signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as { code?: unknown })?.code === 2) return false; throw error; }
}
async function optionalSkillFile(authority: RemoteSkillSourceAuthority, path: string, signal?: AbortSignal): Promise<boolean> {
  try { return (await exactStat(authority, path, signal)).kind === "file"; }
  catch (error) { authority.assertFilesCurrent(); signal?.throwIfAborted(); if ((error as NodeJS.ErrnoException)?.code === "ENOENT" || (error as { code?: unknown })?.code === 2) return false; throw error; }
}
function portableKey(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.split("/").length > 32
    || value.split("/").some(part => part === "" || part === "." || part === ".." || /[<>:"|?*\\\u0000-\u001f\u007f]/u.test(part)
      || /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) throw unavailable();
}
function sameStat(a: RemoteFileStat, b: RemoteFileStat): boolean { return a.kind === b.kind && a.size === b.size && a.mode === b.mode && a.modifiedAt === b.modifiedAt; }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function unavailable(): Error { return new Error("The registered project Skill source is unavailable or changed."); }
