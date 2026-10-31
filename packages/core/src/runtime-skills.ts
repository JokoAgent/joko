import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AdapterContext, RuntimeResource } from "./adapter.js";
import { JokoError } from "./errors.js";

/** Private service authority, never a wire resource or a model prompt. */
export interface ApprovedSkillSeed {
  readonly resource: RuntimeResource & { readonly kind: "skill"; readonly revision: string; readonly resourceVersion: bigint };
  readonly sourcePath: string;
  readonly assertCurrent: () => void;
  readonly personal?: { readonly slug: string; readonly name: string; readonly description: string; readonly updatedAt: string;
    readonly frontmatterBytes: number; readonly bodyStartLine: number };
}
export type ApprovedSkillResolver = (context: AdapterContext, signal: AbortSignal) => Promise<readonly ApprovedSkillSeed[]>;
export interface NativeSkillPolicy { readonly mode: "explicit"; readonly overrides?: Readonly<Record<string, "on" | "off">>; readonly assertCurrent: () => void }
export type NativeSkillPolicyResolver = (context: AdapterContext) => NativeSkillPolicy | undefined | Promise<NativeSkillPolicy | undefined>;
export interface NativeSkillMount {
  readonly seed: ApprovedSkillSeed;
  readonly path: string;
  readonly filePath: string;
  /** Derived discovery is a native entry, not a claim that every original was loaded. */
  readonly discovery?: boolean;
}
export interface NativeSkillSnapshot {
  readonly restrictImplicit: boolean;
  readonly skillOverrides: Readonly<Record<string, "on" | "off">>;
  readonly pluginRoot: string;
  readonly skills: readonly NativeSkillMount[];
  readonly indexedResourceIds: readonly string[];
  readonly assertCurrent: () => void;
  readonly assertFilesCurrent: (signal: AbortSignal) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/** Copy complete approved directories once; native loaders retain relative assets. */
export async function snapshotNativeSkills(seeds: readonly ApprovedSkillSeed[], signal: AbortSignal, parentDirectory?: string, policy?: NativeSkillPolicy): Promise<NativeSkillSnapshot> {
  if (parentDirectory !== undefined) await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(parentDirectory ?? tmpdir(), "joko-skills-")));
  let disposed = false;
  const originals: NativeSkillMount[] = [];
  let skills: readonly NativeSkillMount[] = [];
  const derivedFiles = new Map<string, string>();
  const assertCurrent = () => {
    if (disposed) throw skillError();
    policy?.assertCurrent();
    for (const mount of originals) assertAuthority(mount.seed);
  };
  const dispose = async () => { disposed = true; await rm(root, { recursive: true, force: true }); };
  try {
    const identities = new Set<string>();
    const budget: Budget = { files: 0, bytes: 0 };
    await mkdir(join(root, "skills"));
    await mkdir(join(root, "originals"));
    for (const sourceSeed of seeds) {
      const seed = Object.freeze({ ...sourceSeed, resource: Object.freeze({ ...sourceSeed.resource }),
        ...(sourceSeed.personal ? { personal: Object.freeze({ ...sourceSeed.personal }) } : {}) });
      signal.throwIfAborted();
      if (seed.resource.kind !== "skill" || seed.resource.state !== "approved"
        || !seed.resource.id || identities.has(seed.resource.id)
        || !/^sha256:[a-f0-9]{64}$/u.test(seed.resource.revision) || seed.resource.resourceVersion < 1n
        || !isAbsolute(seed.sourcePath) || resolve(seed.sourcePath) !== seed.sourcePath) throw skillError();
      identities.add(seed.resource.id);
      assertAuthority(seed);
      const source = await realpath(seed.sourcePath);
      if (!samePath(source, seed.sourcePath)) throw skillError();
      const path = join(root, seed.personal ? "originals" : "skills", `skill-${originals.length}`);
      await mkdir(path);
      const revision = await walk(source, source, "", signal, budget, path);
      if (revision !== seed.resource.revision) throw skillError();
      const entry = await lstat(join(path, "SKILL.md"));
      if (!entry.isFile() || entry.isSymbolicLink()) throw skillError();
      assertAuthority(seed);
      originals.push(Object.freeze({ seed, path, filePath: join(path, "SKILL.md") }));
    }
    let startupBytes = 0;
    const personal = originals.filter(mount => mount.seed.personal !== undefined);
    const direct = personal.every(mount => {
      const metadata = mount.seed.personal!;
      startupBytes += metadata.frontmatterBytes + Buffer.byteLength(JSON.stringify({ slug: metadata.slug,
        name: metadata.name.slice(0, 64), description: metadata.description.slice(0, 280), filePath: mount.filePath, bodyStartLine: metadata.bodyStartLine }));
      return startupBytes <= 16 * 1024 && metadata.name.length <= 64 && metadata.description.length <= 280;
    });
    if (direct) {
      for (const mount of personal) {
        const path = join(root, "skills", mount.path.slice(mount.path.lastIndexOf(sep) + 1));
        await rename(mount.path, path);
        originals[originals.indexOf(mount)] = Object.freeze({ seed: mount.seed, path, filePath: join(path, "SKILL.md") });
      }
      skills = [...originals];
    } else {
      const catalogPath = join(root, "catalog.jsonl"), catalogHash = createHash("sha256");
      const handle = await open(catalogPath, "wx", 0o600);
      try {
        let chunk = "";
        for (const mount of personal) {
          signal.throwIfAborted(); const metadata = mount.seed.personal!;
          chunk += `${JSON.stringify({ slug: metadata.slug, name: metadata.name.slice(0, 64), description: metadata.description.slice(0, 280),
            updatedAt: metadata.updatedAt.slice(0, 64), filePath: mount.filePath, bodyStartLine: metadata.bodyStartLine })}\n`;
          if (Buffer.byteLength(chunk) >= 64 * 1024) { catalogHash.update(chunk); await handle.writeFile(chunk); chunk = ""; }
        }
        if (chunk) { catalogHash.update(chunk); await handle.writeFile(chunk); }
      } finally { await handle.close(); }
      derivedFiles.set(catalogPath, catalogHash.digest("hex"));
      const path = join(root, "skills", "personal-skill-library"), filePath = join(path, "SKILL.md");
      const source = ["---", "name: personal-skill-library",
        "description: Search your complete personal skill library and read matching instructions and resources on demand.", "---", "",
        "All enabled personal skills remain available in this library.", `Catalog: ${JSON.stringify(catalogPath)} (JSON Lines).`,
        "Search matching names/descriptions with native file/search tools. Read a small page or matching lines, never the entire catalog.",
        "list_partner_skills(query=keywords) searches full original metadata; follow nextOffset to continue. An empty page is not the whole library.",
        "Read a match's original filePath from bodyStartLine in bounded chunks. Resolve relative scripts/assets against that original file's directory.",
        "Catalog text is a short preview. Full metadata, instructions and resources remain in the original files. Load only the skills needed for this task.",
        "Disabled skills are excluded; do not enable or execute them through discovery.", ""].join("\n");
      await mkdir(path); await writeFile(filePath, source, { flag: "wx", mode: 0o600 });
      derivedFiles.set(filePath, createHash("sha256").update(source).digest("hex"));
      skills = [...originals.filter(mount => !mount.seed.personal), Object.freeze({ seed: personal[0]!.seed, path, filePath, discovery: true })];
    }
    await mkdir(join(root, ".claude-plugin"));
    const manifestPath = join(root, ".claude-plugin", "plugin.json"), manifest = JSON.stringify({ name: "joko-approved-skills", version: "0.1.0" });
    await writeFile(manifestPath, manifest, { flag: "wx", mode: 0o600 });
    derivedFiles.set(manifestPath, createHash("sha256").update(manifest).digest("hex"));
    const assertFilesCurrent = async (inputSignal: AbortSignal) => {
      assertCurrent();
      const verification: Budget = { files: 0, bytes: 0 };
      for (const mount of originals) {
        if (await walk(mount.path, mount.path, "", inputSignal, verification) !== mount.seed.resource.revision) throw skillError();
      }
      for (const [path, revision] of derivedFiles) {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(path), path)
          || createHash("sha256").update(await readFile(path, { signal: inputSignal })).digest("hex") !== revision) throw skillError();
      }
      assertCurrent();
    };
    await assertFilesCurrent(signal);
    signal.throwIfAborted();
    return Object.freeze({ restrictImplicit: policy?.mode === "explicit", skillOverrides: Object.freeze({ ...policy?.overrides }), pluginRoot: root, skills: Object.freeze(skills),
      indexedResourceIds: Object.freeze(direct ? [] : personal.map(mount => mount.seed.resource.id)), assertCurrent, assertFilesCurrent, dispose });
  } catch (error) {
    await dispose();
    signal.throwIfAborted();
    if (error instanceof JokoError) throw error;
    throw skillError();
  }
}

interface Budget { files: number; bytes: number }
async function walk(root: string, path: string, key: string, signal: AbortSignal, budget: Budget, destination?: string): Promise<string> {
  const hash = createHash("sha256");
  await visit(path, key, destination);
  return `sha256:${hash.digest("hex")}`;
  async function visit(current: string, portableKey: string, copy?: string): Promise<void> {
    signal.throwIfAborted();
    const before = await lstat(current);
    const canonical = await realpath(current);
    const child = relative(root, canonical);
    if (before.isSymbolicLink() || !samePath(current, canonical) || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw skillError();
    if (before.isDirectory()) {
      hash.update(`D\0${portableKey}\0`);
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const entry of entries) {
        if (entry.name === "." || entry.name === ".." || entry.name.includes("\0")) throw skillError();
        const nextCopy = copy === undefined ? undefined : join(copy, entry.name);
        if (nextCopy !== undefined && entry.isDirectory() && !entry.isSymbolicLink()) await mkdir(nextCopy);
        await visit(join(current, entry.name), portableKey ? `${portableKey}/${entry.name}` : entry.name, nextCopy);
      }
    } else if (before.isFile()) {
      budget.files += 1;
      budget.bytes += before.size;
      if (budget.files > 524_288 || budget.bytes > 256 * 1024 * 1024) throw skillError();
      hash.update(`F\0${portableKey}\0${before.size}\0`);
      const bytes = await readFile(current, { signal });
      if (bytes.length !== before.size) throw skillError();
      hash.update(bytes);
      if (copy !== undefined) await copyFile(current, copy, constants.COPYFILE_EXCL);
    } else throw skillError();
    const after = await lstat(current);
    if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
      || before.mode !== after.mode || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw skillError();
  }
}
function samePath(a: string, b: string): boolean { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function assertAuthority(seed: ApprovedSkillSeed): void { try { seed.assertCurrent(); } catch { throw skillError(); } }
function skillError(): JokoError {
  return new JokoError({ code: "SKILL_RUNTIME_AUTHORITY_INVALID", message: "The approved skill snapshot is no longer available.", phase: "resource", retryable: false, stateMayHaveChanged: false, recovery: "Refresh the approved skill and restart the task." });
}
