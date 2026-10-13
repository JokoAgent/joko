import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { JokoError, snapshotNativeSkills, type ApprovedSkillSeed, type NativeSkillPolicy, type NativeSkillSnapshot } from "@joko/core";
import type { RemoteFileStat } from "@joko/remote-ssh";
import type { RemoteSkillSourceAuthority } from "./remote-workspace-service.js";

interface TreeEntry {
  readonly key: string;
  readonly kind: "file" | "directory";
  readonly mode: number;
  readonly size: number;
  readonly sha256?: string;
}
interface MountRecord {
  readonly id: string;
  readonly authority: RemoteSkillSourceAuthority;
  readonly profileRoot: string;
  readonly remoteRoot: string;
  readonly local: NativeSkillSnapshot;
  readonly entries: readonly TreeEntry[];
  phase: "building" | "active" | "retained" | "retiring";
  disposed: boolean;
}
export interface RemoteNativeSkillOwnerOptions { readonly journalRoot: string }
export interface RemoteNativeSkillPrepareInput {
  readonly authority: RemoteSkillSourceAuthority;
  readonly profileRoot: string;
  readonly seeds: readonly ApprovedSkillSeed[];
  readonly signal: AbortSignal;
  readonly policy?: NativeSkillPolicy;
  readonly assertRuntimeCurrent: () => void;
}

/** Private full-package mounts, retained until the exact native thread release is confirmed. */
export class RemoteNativeSkillOwner {
  readonly #journalRoot: string;
  readonly #mounts = new Map<string, MountRecord>();
  #closed = false;

  constructor(options: RemoteNativeSkillOwnerOptions) {
    if (!isAbsolute(options.journalRoot) || resolve(options.journalRoot) !== options.journalRoot) throw unavailable();
    this.#journalRoot = options.journalRoot;
  }

  async prepare(input: RemoteNativeSkillPrepareInput): Promise<NativeSkillSnapshot> {
    const { authority, signal } = input;
    const assertLive = (): void => {
      if (this.#closed) throw unavailable();
      input.assertRuntimeCurrent(); authority.assertCurrent(); authority.assertFilesCurrent();
      input.policy?.assertCurrent();
      for (const seed of input.seeds) seed.assertCurrent();
    };
    signal.throwIfAborted(); assertLive();
    if (input.seeds.some(seed => seed.personal !== undefined) || !canonicalPath(input.profileRoot)) throw unavailable();
    const policy: NativeSkillPolicy = { mode: "explicit", overrides: input.policy?.overrides ?? {}, assertCurrent: assertLive };
    const local = await snapshotNativeSkills(input.seeds, signal, undefined, policy);
    let record: MountRecord | undefined;
    try {
      assertLive(); signal.throwIfAborted();
      const id = randomUUID();
      await writeFile(join(local.pluginRoot, ".joko-owner"), id, { flag: "wx", mode: 0o600 });
      const entries = await localTree(local.pluginRoot, signal);
      record = { id, authority, profileRoot: input.profileRoot,
        remoteRoot: posix.join(input.profileRoot, ".joko-approved-skills", id), local, entries, phase: "building", disposed: false };
      this.#mounts.set(id, record);
      await this.#journal(record);
      assertLive(); signal.throwIfAborted();
      await directory(authority, input.profileRoot, signal);
      const parent = posix.dirname(record.remoteRoot);
      try { await directory(authority, parent, signal); }
      catch (error) {
        if (!missing(error)) throw error;
        assertLive(); await authority.files.mkdir(parent, { mode: 0o700, signal });
        await directory(authority, parent, signal);
      }
      assertLive(); await authority.files.mkdir(record.remoteRoot, { mode: 0o700, signal });
      await directory(authority, record.remoteRoot, signal);
      assertLive(); await authority.files.write({ path: posix.join(record.remoteRoot, ".joko-owner"), content: Buffer.from(id), mode: 0o600, atomic: true, signal });
      for (const entry of entries) {
        if (entry.key === ".joko-owner") continue;
        signal.throwIfAborted(); assertLive();
        const path = posix.join(record.remoteRoot, entry.key);
        await directory(authority, posix.dirname(path), signal);
        if (entry.kind === "directory") await authority.files.mkdir(path, { mode: entry.mode, signal });
        else {
          const content = await readFile(join(local.pluginRoot, ...entry.key.split("/")));
          if (content.byteLength !== entry.size || hash(content) !== entry.sha256) throw unavailable();
          signal.throwIfAborted(); assertLive();
          await authority.files.write({ path, content, mode: entry.mode, atomic: true, signal });
        }
      }
      await verifyRemoteTree(record, signal);
      await local.assertFilesCurrent(signal);
      assertLive(); signal.throwIfAborted();
      record.phase = "active"; await this.#journal(record);
      const owned = record;
      const assertCurrent = (): void => { if (owned.disposed || owned.phase !== "active") throw unavailable(); assertLive(); };
      const mapPath = (path: string): string => {
        const key = relative(local.pluginRoot, path).split(sep).join("/");
        if (!portableKey(key)) throw unavailable();
        return posix.join(owned.remoteRoot, key);
      };
      return Object.freeze({ restrictImplicit: true, skillOverrides: local.skillOverrides,
        pluginRoot: owned.remoteRoot, skills: Object.freeze(local.skills.map(mount => Object.freeze({ ...mount,
          path: mapPath(mount.path), filePath: mapPath(mount.filePath) }))), indexedResourceIds: local.indexedResourceIds,
        assertCurrent,
        assertFilesCurrent: async (readSignal: AbortSignal) => {
          readSignal.throwIfAborted(); assertCurrent(); await local.assertFilesCurrent(readSignal);
          await verifyRemoteTree(owned, readSignal); readSignal.throwIfAborted(); assertCurrent();
        },
        dispose: () => this.#dispose(owned)
      });
    } catch (error) {
      if (record === undefined) await local.dispose();
      else await this.#dispose(record).catch(() => undefined);
      signal.throwIfAborted();
      throw error;
    }
  }

  /** Closing a connection is not evidence that a native thread stopped using its mount. */
  async shutdown(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#mounts.values()].map(async record => {
      if (record.disposed) return;
      record.phase = "retained"; await this.#journal(record);
    }));
  }

  async #dispose(record: MountRecord): Promise<void> {
    if (record.disposed) return;
    record.phase = "retiring";
    await this.#journal(record);
    try {
      record.authority.assertCurrent(); record.authority.assertFilesCurrent();
      await directory(record.authority, record.profileRoot);
      await directory(record.authority, posix.dirname(record.remoteRoot));
      let present = true;
      try { await directory(record.authority, record.remoteRoot); }
      catch (error) { if (!missing(error)) throw error; present = false; }
      if (present) {
        const marker = await record.authority.files.read({ path: posix.join(record.remoteRoot, ".joko-owner"), maximumBytes: 64 });
        if (Buffer.from(marker).toString("utf8") !== record.id) throw unavailable();
        record.authority.assertCurrent(); record.authority.assertFilesCurrent();
        await record.authority.files.remove(record.remoteRoot, { recursive: true });
      }
      await record.local.dispose();
      record.disposed = true; this.#mounts.delete(record.id);
      await rm(join(this.#journalRoot, `${record.id}.json`), { force: true });
    } catch (error) {
      record.phase = "retained"; await this.#journal(record);
      throw error;
    }
  }

  async #journal(record: MountRecord): Promise<void> {
    await mkdir(this.#journalRoot, { recursive: true, mode: 0o700 });
    if (await realpath(this.#journalRoot) !== this.#journalRoot || (await lstat(this.#journalRoot)).isSymbolicLink()) throw unavailable();
    const temporary = join(this.#journalRoot, `${record.id}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, id: record.id, phase: record.phase,
        remoteRoot: record.remoteRoot, profileRoot: record.profileRoot, localRoot: record.local.pluginRoot,
        executionIdentity: record.authority.executionIdentity, authorityIdentity: record.authority.authorityIdentity,
        rootRegistrationId: record.authority.rootRegistrationId, entries: record.entries }));
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temporary, join(this.#journalRoot, `${record.id}.json`)); }
    finally { await rm(temporary, { force: true }); }
  }
}

async function localTree(root: string, signal: AbortSignal): Promise<readonly TreeEntry[]> {
  const entries: TreeEntry[] = []; let bytes = 0;
  const walk = async (path: string, key: string): Promise<void> => {
    signal.throwIfAborted();
    const before = await lstat(path);
    if (before.isSymbolicLink() || await realpath(path) !== path) throw unavailable();
    if (key && (!portableKey(key) || entries.length >= 524_288)) throw unavailable();
    if (before.isDirectory()) {
      if (key) entries.push({ key, kind: "directory", mode: 0o700, size: 0 });
      const names = (await readdir(path)).sort((a, b) => a.localeCompare(b, "en"));
      for (const name of names) await walk(join(path, name), key ? `${key}/${name}` : name);
    } else if (before.isFile()) {
      bytes += before.size; if (bytes > 256 * 1024 * 1024) throw unavailable();
      const content = await readFile(path);
      if (content.byteLength !== before.size) throw unavailable();
      entries.push({ key, kind: "file", mode: 0o600 | (before.mode & 0o100), size: before.size, sha256: hash(content) });
    } else throw unavailable();
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) throw unavailable();
  };
  await walk(root, ""); return Object.freeze(entries);
}

async function verifyRemoteTree(record: MountRecord, signal?: AbortSignal): Promise<void> {
  const { authority } = record;
  const byKey = new Map(record.entries.map(entry => [entry.key, entry]));
  const childrenByParent = new Map<string, TreeEntry[]>();
  for (const entry of record.entries) {
    const parent = posix.dirname(entry.key);
    const children = childrenByParent.get(parent) ?? [];
    children.push(entry); childrenByParent.set(parent, children);
  }
  const walk = async (path: string, key: string): Promise<void> => {
    signal?.throwIfAborted(); authority.assertCurrent(); authority.assertFilesCurrent();
    const before = await authority.files.stat(path, signal);
    if (await authority.files.realpath(path, signal) !== path) throw unavailable();
    const expected = key ? byKey.get(key) : { kind: "directory", mode: 0o700 };
    if (expected === undefined || before.kind !== expected.kind || (before.mode & 0o777) !== expected.mode) throw unavailable();
    if (before.kind === "directory") {
      const entries = await authority.files.list(path, signal);
      const children = childrenByParent.get(key || ".") ?? [];
      if (entries.length !== children.length || new Set(entries.map(entry => entry.name)).size !== entries.length) throw unavailable();
      for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        const child = key ? `${key}/${entry.name}` : entry.name;
        if (!portableKey(child) || byKey.get(child)?.kind !== entry.kind) throw unavailable();
        await walk(posix.join(path, entry.name), child);
      }
    } else if (before.kind === "file") {
      const file = byKey.get(key)!;
      if (before.size !== file.size) throw unavailable();
      const content = await authority.files.read({ path, maximumBytes: Math.max(1, file.size), ...(signal === undefined ? {} : { signal }) });
      if (content.byteLength !== file.size || hash(content) !== file.sha256) throw unavailable();
    } else throw unavailable();
    const after = await authority.files.stat(path, signal);
    if (!sameStat(before, after)) throw unavailable();
    signal?.throwIfAborted(); authority.assertCurrent(); authority.assertFilesCurrent();
  };
  await directory(authority, record.profileRoot, signal);
  await directory(authority, posix.dirname(record.remoteRoot), signal);
  await walk(record.remoteRoot, "");
}
async function directory(authority: RemoteSkillSourceAuthority, path: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted(); authority.assertCurrent(); authority.assertFilesCurrent();
  if (!canonicalPath(path)) throw unavailable();
  const stat = await authority.files.stat(path, signal);
  if (stat.kind !== "directory" || await authority.files.realpath(path, signal) !== path) throw unavailable();
  signal?.throwIfAborted(); authority.assertCurrent(); authority.assertFilesCurrent();
}
function canonicalPath(path: string): boolean { return path.startsWith("/") && path !== "/" && posix.normalize(path) === path && !/[\u0000-\u001f\u007f]/u.test(path); }
function portableKey(key: string): boolean { return key.length > 0 && key.length <= 512 && key.split("/").length <= 32 && key.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".." && !/[\\:\u0000-\u001f\u007f]/u.test(segment)); }
function hash(content: Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
function sameStat(a: RemoteFileStat, b: RemoteFileStat): boolean { return a.kind === b.kind && a.size === b.size && a.mode === b.mode && a.modifiedAt === b.modifiedAt; }
function missing(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === 2); }
function unavailable(): JokoError { return new JokoError({ code: "remote_skill_mount_unavailable", phase: "prepare_input",
  message: "The approved remote Skill mount authority is unavailable.", recovery: "Refresh the approved project resources and reconnect the Target.",
  retryable: false, stateMayHaveChanged: false }); }
