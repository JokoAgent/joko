import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import type { ApprovedSkillSeed, NativeSkillSnapshot } from "@joko/core";
import type { RemoteFileStat, RemoteFileTransportPort } from "@joko/remote-ssh";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteNativeSkillOwner } from "./remote-native-skills.js";
import type { RemoteSkillSourceAuthority } from "./remote-workspace-service.js";

const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.state.approved = fixture.state.lease = fixture.state.files = fixture.state.runtime = fixture.state.policy = true;
    fixture.remote.afterRead = fixture.remote.afterWrite = undefined;
    fixture.remote.failRemove = false;
    await fixture.owner.shutdown();
    for (const journal of await journals(fixture.journalRoot)) {
      const localRoot = journal.localRoot;
      const canonicalTemporaryRoot = await realpath(tmpdir());
      if (!isAbsolute(localRoot) || resolve(localRoot) !== localRoot || dirname(localRoot) !== canonicalTemporaryRoot
        || !/^joko-skills-/u.test(basename(localRoot))) throw Error("Unexpected private fixture cleanup root.");
      await rm(localRoot, { recursive: true, force: true });
    }
    await rm(fixture.root, { recursive: true, force: true });
  }
});

describe("RemoteNativeSkillOwner", () => {
  it("uploads the complete approved package and freezes binary assets independently from the original service source", async () => {
    const fixture = await createFixture();
    const snapshot = await fixture.prepare();
    const mount = snapshot.skills[0]!;
    expect(snapshot.restrictImplicit).toBe(true);
    expect(snapshot.skillOverrides).toEqual({ ambient: "off" });
    expect(mount.seed.resource).toEqual(fixture.seed.resource);
    expect(mount.seed.sourcePath).toBe(fixture.seed.sourcePath);
    expect(mount.filePath).toBe(posix.join(snapshot.pluginRoot, "skills/skill-0/SKILL.md"));
    expect(fixture.remote.bytes(mount.filePath).toString()).toBe(fixture.body);
    expect(fixture.remote.bytes(posix.join(mount.path, "assets/template.bin"))).toEqual(fixture.asset);
    expect(fixture.remote.bytes(posix.join(mount.path, "scripts/render.sh")).toString()).toBe(fixture.script);
    const [journal] = await journals(fixture.journalRoot);
    expect(journal).toMatchObject({ version: 1, phase: "active", remoteRoot: snapshot.pluginRoot,
      executionIdentity: "ssh:registered-account", authorityIdentity: "ssh:revision-1:lease-7", rootRegistrationId: "registered-root" });
    expect(journal!.entries.map(entry => entry.key)).toEqual(expect.arrayContaining([
      ".joko-owner", ".claude-plugin/plugin.json", "skills/skill-0/SKILL.md", "skills/skill-0/assets/template.bin", "skills/skill-0/scripts/render.sh"
    ]));
    for (const entry of journal!.entries) expect(fixture.remote.entry(posix.join(snapshot.pluginRoot, entry.key)).mode)
      .toBe(entry.mode);
    await writeFile(join(fixture.seed.sourcePath, "assets/template.bin"), "later original source bytes");
    await snapshot.assertFilesCurrent(new AbortController().signal);
    expect(fixture.remote.bytes(posix.join(mount.path, "assets/template.bin"))).toEqual(fixture.asset);
    await snapshot.dispose();
    expect(fixture.remote.removed).toEqual([snapshot.pluginRoot]);
    expect(await journals(fixture.journalRoot)).toEqual([]);
    await expect(lstat(journal!.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => snapshot.assertCurrent()).toThrow();
  });

  it.each(["bytes", "added", "missing", "mode", "link"] as const)("rejects full remote copy %s drift before native consumption", async drift => {
    const fixture = await createFixture();
    const snapshot = await fixture.prepare();
    const assetPath = posix.join(snapshot.skills[0]!.path, "assets/template.bin");
    if (drift === "bytes") fixture.remote.entry(assetPath).content = Buffer.from([9, 9, 9, 9, 9]);
    if (drift === "added") fixture.remote.putFile(posix.join(snapshot.skills[0]!.path, "assets/late.bin"), Buffer.from([1]));
    if (drift === "missing") fixture.remote.entries.delete(assetPath);
    if (drift === "mode") fixture.remote.entry(assetPath).mode = 0o644;
    if (drift === "link") fixture.remote.entry(assetPath).kind = "symbolic_link";
    await expect(snapshot.assertFilesCurrent(new AbortController().signal)).rejects.toBeDefined();
    await snapshot.dispose();
    expect(fixture.remote.removed).toEqual([snapshot.pluginRoot]);
  });

  it.each(["approval", "lease", "files", "runtime", "policy", "cancel"] as const)("rechecks %s authority after an asynchronous remote file proof", async authority => {
    const fixture = await createFixture();
    const snapshot = await fixture.prepare();
    const proof = new AbortController();
    const reached = deferred(); const release = deferred();
    fixture.remote.afterRead = async path => {
      if (!path.endsWith("/template.bin")) return;
      reached.resolve(); await release.promise;
    };
    const pending = snapshot.assertFilesCurrent(proof.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    await reached.promise;
    if (authority === "approval") fixture.state.approved = false;
    else if (authority === "cancel") proof.abort();
    else fixture.state[authority] = false;
    release.resolve(); await rejected;
    fixture.state.approved = fixture.state.lease = fixture.state.files = fixture.state.runtime = fixture.state.policy = true;
    fixture.remote.afterRead = undefined;
    await snapshot.dispose();
  });

  it("does not publish a canceled upload and retains its exact cleanup journal when the original lease disappears", async () => {
    const fixture = await createFixture();
    const signal = new AbortController();
    const reached = deferred(); const release = deferred();
    fixture.remote.afterWrite = async path => {
      if (!path.endsWith("/template.bin")) return;
      reached.resolve(); await release.promise;
    };
    const pending = fixture.prepare(signal.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await reached.promise; signal.abort(); fixture.state.lease = false; release.resolve(); await rejected;
    const [journal] = await journals(fixture.journalRoot);
    expect(journal).toMatchObject({ phase: "retained", authorityIdentity: "ssh:revision-1:lease-7" });
    expect(fixture.remote.entries.has(journal!.remoteRoot)).toBe(true);
    expect(fixture.remote.removed).toEqual([]);
    expect(await lstat(journal!.localRoot)).toBeDefined();
  });

  it.each(["marker", "remove", "lease"] as const)("retains unconfirmed %s cleanup without deleting another owned mount", async failure => {
    const fixture = await createFixture();
    const first = await fixture.prepare(); const second = await fixture.prepare();
    const firstMarker = posix.join(first.pluginRoot, ".joko-owner");
    const originalMarker = fixture.remote.bytes(firstMarker);
    if (failure === "marker") fixture.remote.entry(firstMarker).content = fixture.remote.bytes(posix.join(second.pluginRoot, ".joko-owner"));
    if (failure === "remove") fixture.remote.failRemove = true;
    if (failure === "lease") fixture.state.lease = false;
    await expect(first.dispose()).rejects.toBeDefined();
    expect(() => first.assertCurrent()).toThrow();
    const retained = (await journals(fixture.journalRoot)).find(journal => journal.remoteRoot === first.pluginRoot)!;
    expect(retained.phase).toBe("retained");
    expect(retained.authorityIdentity).toBe("ssh:revision-1:lease-7");
    expect(await lstat(retained.localRoot)).toBeDefined();
    expect(fixture.remote.entries.has(first.pluginRoot)).toBe(true);
    expect(fixture.remote.entries.has(second.pluginRoot)).toBe(true);
    expect(fixture.remote.removed).toEqual([]);
    fixture.remote.entry(firstMarker).content = originalMarker; fixture.remote.failRemove = false; fixture.state.lease = true;
    await second.assertFilesCurrent(new AbortController().signal);
    await second.dispose();
    expect(fixture.remote.removed).toEqual([second.pluginRoot]);
    expect(fixture.remote.entries.has(first.pluginRoot)).toBe(true);
    await first.dispose();
    expect(fixture.remote.removed).toEqual([second.pluginRoot, first.pluginRoot]);
    expect(await journals(fixture.journalRoot)).toEqual([]);
  });

  it("fences shutdown while retaining native-exposed mounts and their original authority journals", async () => {
    const fixture = await createFixture();
    const snapshot = await fixture.prepare();
    await fixture.owner.shutdown();
    expect(() => snapshot.assertCurrent()).toThrow();
    await expect(snapshot.assertFilesCurrent(new AbortController().signal)).rejects.toBeDefined();
    await expect(fixture.prepare()).rejects.toBeDefined();
    expect(fixture.remote.removed).toEqual([]);
    const [journal] = await journals(fixture.journalRoot);
    expect(journal).toMatchObject({ phase: "retained", remoteRoot: snapshot.pluginRoot, authorityIdentity: "ssh:revision-1:lease-7" });
    expect(fixture.remote.entries.has(snapshot.pluginRoot)).toBe(true);
    await snapshot.dispose();
  });
});

interface Entry { kind: RemoteFileStat["kind"]; content: Buffer; mode: number; modifiedAt: number }
class MemoryRemoteFiles implements RemoteFileTransportPort {
  readonly entries = new Map<string, Entry>();
  readonly removed: string[] = [];
  afterRead: ((path: string) => Promise<void>) | undefined;
  afterWrite: ((path: string) => Promise<void>) | undefined;
  failRemove = false;
  constructor() { this.putDirectory("/srv"); this.putDirectory("/srv/profile"); }
  putDirectory(path: string): void { this.entries.set(path, { kind: "directory", content: Buffer.alloc(0), mode: 0o700, modifiedAt: 1 }); }
  putFile(path: string, content: Uint8Array, mode = 0o600): void { this.entries.set(path, { kind: "file", content: Buffer.from(content), mode, modifiedAt: 1 }); }
  entry(path: string): Entry { const entry = this.entries.get(path); if (!entry) throw Object.assign(Error("Remote path is absent."), { code: "ENOENT" }); return entry; }
  bytes(path: string): Buffer { return Buffer.from(this.entry(path).content); }
  async realpath(path: string, signal?: AbortSignal): Promise<string> { signal?.throwIfAborted(); this.entry(path); return path; }
  async stat(path: string, signal?: AbortSignal): Promise<RemoteFileStat> { signal?.throwIfAborted(); const entry = this.entry(path);
    return { kind: entry.kind, size: entry.kind === "file" ? entry.content.length : 0, mode: entry.mode, modifiedAt: entry.modifiedAt }; }
  async list(path: string, signal?: AbortSignal) { signal?.throwIfAborted(); this.entry(path); return [...this.entries]
    .filter(([key]) => posix.dirname(key) === path).map(([key, entry]) => ({ name: posix.basename(key), kind: entry.kind })); }
  async read(input: Parameters<RemoteFileTransportPort["read"]>[0]): Promise<Uint8Array> {
    input.signal?.throwIfAborted(); const content = this.bytes(input.path);
    if (content.length > input.maximumBytes) throw Error("Remote read exceeded its byte bound.");
    await this.afterRead?.(input.path); return content;
  }
  async write(input: Parameters<RemoteFileTransportPort["write"]>[0]): Promise<void> {
    input.signal?.throwIfAborted(); this.entry(posix.dirname(input.path)); this.putFile(input.path, input.content, input.mode);
    await this.afterWrite?.(input.path);
  }
  async mkdir(path: string, options?: Parameters<RemoteFileTransportPort["mkdir"]>[1]): Promise<void> {
    options?.signal?.throwIfAborted(); this.entry(posix.dirname(path));
    if (this.entries.has(path)) throw Object.assign(Error("Remote path exists."), { code: "EEXIST" });
    this.putDirectory(path); this.entry(path).mode = options?.mode ?? 0o700;
  }
  async rename(): Promise<void> { throw Error("Unused remote rename."); }
  async remove(path: string, options?: Parameters<RemoteFileTransportPort["remove"]>[1]): Promise<void> {
    options?.signal?.throwIfAborted(); if (this.failRemove) throw Error("Remote removal outcome is unknown.");
    this.entry(path); this.removed.push(path);
    for (const key of this.entries.keys()) if (key === path || (options?.recursive && key.startsWith(`${path}/`))) this.entries.delete(key);
  }
}
interface Journal { version: number; phase: string; remoteRoot: string; localRoot: string; authorityIdentity: string; entries: { key: string; mode: number }[] }
async function journals(root: string): Promise<Journal[]> {
  let names: string[]; try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return Promise.all(names.filter(name => name.endsWith(".json")).map(async name => JSON.parse(await readFile(join(root, name), "utf8")) as Journal));
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
interface Fixture {
  root: string; journalRoot: string; owner: RemoteNativeSkillOwner; remote: MemoryRemoteFiles; seed: ApprovedSkillSeed;
  body: string; asset: Buffer; script: string;
  state: { approved: boolean; lease: boolean; files: boolean; runtime: boolean; policy: boolean };
  prepare(signal?: AbortSignal): Promise<NativeSkillSnapshot>;
}
async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-remote-native-skill-test-")));
  const sourcePath = join(root, "approved-generation"); await mkdir(sourcePath);
  const body = "---\nname: report\ndescription: Prepare a report\n---\nUse scripts/render.sh and assets/template.bin.\n";
  const asset = Buffer.from([0, 255, 12, 10, 1]); const script = "#!/bin/sh\nprintf 'report'\n";
  await mkdir(join(sourcePath, "assets")); await mkdir(join(sourcePath, "scripts"));
  await writeFile(join(sourcePath, "SKILL.md"), body); await writeFile(join(sourcePath, "assets/template.bin"), asset);
  await writeFile(join(sourcePath, "scripts/render.sh"), script, { mode: 0o700 });
  const revision = `sha256:${createHash("sha256").update("D\0\0D\0assets\0F\0assets/template.bin\0" + asset.length + "\0").update(asset)
    .update("D\0scripts\0F\0scripts/render.sh\0" + Buffer.byteLength(script) + "\0").update(script)
    .update("F\0SKILL.md\0" + Buffer.byteLength(body) + "\0").update(body).digest("hex")}`;
  const state = { approved: true, lease: true, files: true, runtime: true, policy: true };
  const assert = (value: boolean): void => { if (!value) throw Error("Captured authority was retired."); };
  const seed: ApprovedSkillSeed = { sourcePath, resource: { id: "opaque-approved-report", name: "Report", kind: "skill", state: "approved",
    source: "project", revision, resourceVersion: 2n }, assertCurrent: () => assert(state.approved) };
  const remote = new MemoryRemoteFiles(); const journalRoot = join(root, "journal");
  const owner = new RemoteNativeSkillOwner({ journalRoot });
  const authority: RemoteSkillSourceAuthority = {
    registration: { id: "registered-workspace", root: "/srv/project", displayName: "Project", trusted: true,
      remote: { targetId: "target", binding: { kind: "ssh", hostTargetId: "target", hostId: "host", workspaceRoot: "/srv/project" } } },
    rootRegistrationId: "registered-root", files: remote, processes: { open: async () => { throw Error("No process I/O in mount owner tests."); } },
    executionIdentity: "ssh:registered-account", authorityIdentity: "ssh:revision-1:lease-7",
    assertCurrent: () => assert(state.lease), assertFilesCurrent: () => { assert(state.lease); assert(state.files); },
    assertForwardingCurrent: () => { throw Error("No forwarding I/O in mount owner tests."); }
  };
  const fixture: Fixture = { root, journalRoot, owner, remote, seed, body, asset, script, state,
    prepare: (signal = new AbortController().signal) => owner.prepare({ authority, profileRoot: "/srv/profile", seeds: [seed], signal,
      policy: { mode: "explicit", overrides: { ambient: "off" }, assertCurrent: () => assert(state.policy) }, assertRuntimeCurrent: () => assert(state.runtime) }) };
  fixtures.push(fixture); return fixture;
}
