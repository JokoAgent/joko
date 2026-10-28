import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { snapshotNativeSkills, type ApprovedSkillSeed } from "./runtime-skills.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("retains explicit isolation even for an empty shelf and freezes native overrides and policy authority", async () => {
  let current = true; const overrides: Record<string, "on" | "off"> = { shared: "off" };
  const snapshot = await snapshotNativeSkills([], new AbortController().signal, undefined, { mode: "explicit", overrides,
    assertCurrent: () => { if (!current) throw Error("private owner retired"); } });
  try { expect(snapshot.skills).toEqual([]); expect(snapshot.restrictImplicit).toBe(true); overrides["shared"] = "on";
    expect(snapshot.skillOverrides).toEqual({ shared: "off" }); current = false;
    expect(() => snapshot.assertCurrent()).toThrow("private owner retired");
    await expect(snapshot.assertFilesCurrent(new AbortController().signal)).rejects.toBeDefined();
  } finally { await snapshot.dispose(); }
});

test("copies complete skill assets and freezes approval independently from mutable source objects", async () => {
  const { seed, body, asset } = await fixture();
  let current = true;
  const source = { ...seed, assertCurrent: () => { if (!current) throw new Error("private source /private/skills failed"); } };
  const snapshot = await snapshotNativeSkills([source], new AbortController().signal);
  try {
    const mount = snapshot.skills[0]!;
    expect(await readFile(mount.filePath, "utf8")).toBe(body);
    expect(await readFile(join(mount.path, "assets", "template.bin"))).toEqual(asset);
    expect(JSON.parse(await readFile(join(snapshot.pluginRoot, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({ name: "joko-approved-skills", version: "0.1.0" });
    source.assertCurrent = () => undefined;
    current = false;
    expect(() => snapshot.assertCurrent()).toThrow("approved skill snapshot");
    current = true;
    await writeFile(join(seed.sourcePath, "assets", "template.bin"), "new source asset");
    await snapshot.assertFilesCurrent(new AbortController().signal);
    expect(await readFile(join(mount.path, "assets", "template.bin"))).toEqual(asset);
    await writeFile(mount.filePath, "unexpected native edit");
    await expect(snapshot.assertFilesCurrent(new AbortController().signal)).rejects.toMatchObject({ publicError: { code: "SKILL_RUNTIME_AUTHORITY_INVALID" } });
  } finally { await snapshot.dispose(); }
  await expect(lstat(snapshot.pluginRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(seed.sourcePath)).resolves.toBeDefined();
});

test("canonicalizes its private snapshot root while retaining approved source and file fences", async () => {
  const { seed, body } = await fixture();
  const parent = await realpath(await mkdtemp(join(tmpdir(), "joko-skill-parent-"))); roots.push(parent);
  const actual = join(parent, "actual"), alias = join(parent, "alias");
  await mkdir(actual); await symlink(actual, alias, "junction");
  const snapshot = await snapshotNativeSkills([seed], new AbortController().signal, join(alias, "snapshots"));
  try {
    expect(snapshot.pluginRoot).toBe(await realpath(snapshot.pluginRoot));
    expect(await readFile(snapshot.skills[0]!.filePath, "utf8")).toBe(body);
    await snapshot.assertFilesCurrent(new AbortController().signal);
    await writeFile(snapshot.skills[0]!.filePath, "changed private snapshot");
    await expect(snapshot.assertFilesCurrent(new AbortController().signal)).rejects.toMatchObject({ publicError: { code: "SKILL_RUNTIME_AUTHORITY_INVALID" } });
  } finally { await snapshot.dispose(); }
});

test("rejects changed approvals, duplicate identities, cancellation and links before mounting", async () => {
  const { seed } = await fixture();
  await writeFile(join(seed.sourcePath, "SKILL.md"), "different approved content");
  await expect(snapshotNativeSkills([seed], new AbortController().signal)).rejects.toMatchObject({ publicError: { code: "SKILL_RUNTIME_AUTHORITY_INVALID" } });
  const stable = await fixture();
  await expect(snapshotNativeSkills([stable.seed, stable.seed], new AbortController().signal)).rejects.toMatchObject({ publicError: { code: "SKILL_RUNTIME_AUTHORITY_INVALID" } });
  const cancelled = new AbortController(); cancelled.abort();
  await expect(snapshotNativeSkills([stable.seed], cancelled.signal)).rejects.toBeDefined();
  await symlink(stable.seed.sourcePath, join(seed.sourcePath, "linked"), "junction");
  await expect(snapshotNativeSkills([seed], new AbortController().signal)).rejects.toMatchObject({ publicError: { code: "SKILL_RUNTIME_AUTHORITY_INVALID" } });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-native-skill-test-"))); roots.push(root);
  const body = "---\nname: report\ndescription: Prepare a report\n---\nRead assets/template.bin.\n";
  const asset = Buffer.from([0, 255, 12, 10, 1]);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "SKILL.md"), body);
  await writeFile(join(root, "assets", "template.bin"), asset);
  const revision = `sha256:${createHash("sha256").update("D\0\0D\0assets\0F\0assets/template.bin\0" + asset.length + "\0").update(asset)
    .update("F\0SKILL.md\0" + Buffer.byteLength(body) + "\0").update(body).digest("hex")}`;
  const seed: ApprovedSkillSeed = { sourcePath: root, resource: { id: "report", name: "Report", kind: "skill", state: "approved", source: "managed", revision, resourceVersion: 2n }, assertCurrent: () => undefined };
  return { seed, body, asset };
}

test("projects a complete large personal catalog while preserving originals outside native plugin discovery", async () => {
  // Copy and revalidate every asset in the 120-entry catalog on real disk.
  const { seed, body, asset } = await fixture();
  const seeds = Array.from({ length: 120 }, (_, index): ApprovedSkillSeed => ({ ...seed,
    resource: { ...seed.resource, id: `personal-${index}` }, personal: { slug: `skill-${index}`, name: `Skill ${index}`,
      description: "Full personal metadata ".repeat(10), updatedAt: "2026-10-12", frontmatterBytes: 400, bodyStartLine: 5 } }));
  const native = await snapshotNativeSkills(seeds, new AbortController().signal);
  try {
    expect(native.skills).toHaveLength(1); expect(native.skills[0]!.discovery).toBe(true); expect(native.indexedResourceIds).toHaveLength(120);
    const catalog = (await readFile(join(native.pluginRoot, "catalog.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { slug: string; filePath: string });
    expect(catalog).toHaveLength(120); expect(catalog[119]!.slug).toBe("skill-119");
    expect(await readFile(catalog[119]!.filePath, "utf8")).toBe(body);
    expect(await readFile(join(catalog[119]!.filePath, "..", "assets", "template.bin"))).toEqual(asset);
    expect(catalog.every(row => !row.filePath.includes(`${join(native.pluginRoot, "skills")}`))).toBe(true);
    await native.assertFilesCurrent(new AbortController().signal);
    await writeFile(join(native.pluginRoot, "catalog.jsonl"), "altered native catalog");
    await expect(native.assertFilesCurrent(new AbortController().signal)).rejects.toMatchObject({ publicError: { code: "SKILL_RUNTIME_AUTHORITY_INVALID" } });
  } finally { await native.dispose(); }
  const small = await snapshotNativeSkills([seeds[0]!], new AbortController().signal);
  try { expect(small.skills[0]!.discovery).toBeUndefined(); expect(small.indexedResourceIds).toEqual([]);
    expect(await readFile(small.skills[0]!.filePath, "utf8")).toBe(body); }
  finally { await small.dispose(); }
}, 30_000);
