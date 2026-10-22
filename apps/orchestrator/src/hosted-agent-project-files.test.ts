import { existsSync, readFileSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext } from "@joko/core";
import { afterEach, expect, it } from "vitest";
import { materializeHostedProjectFiles, snapshotSourceProjectFiles, type HostedProjectFile } from "./hosted-agent-project-files.js";

const roots: string[] = [];
const MANIFEST = ".joko-project-snapshot.json";
const assertCurrent = () => {};
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup.");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(): Promise<{ base: string; source: string; host: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "joko-project-snapshots-"))); roots.push(base);
  const source = path.join(base, "source"), host = path.join(base, "run", "workspace");
  await Promise.all([mkdir(source), mkdir(host, { recursive: true })]);
  return { base, source, host };
}
async function put(root: string, relative: string, content: string | Buffer): Promise<void> {
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
}
function context(root: string, extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    sessionId: "source-session", generation: 1,
    target: { id: "source-target", backendId: "source-backend", displayName: "Project", workspaceRoot: root, managed: false, trusted: true },
    signal: new AbortController().signal, emit: async () => {}, requestInteraction: async () => { throw new Error("No interaction in this fixture."); },
    artifactCapacityBytes: 1024 * 1024, storeArtifact: async () => { throw new Error("No artifacts in this fixture."); }, ...extra
  } as AdapterContext;
}
function snapshot(root: string, files: readonly HostedProjectFile[], extra: { personalInstructions?: string; assertCurrent?: () => void } = {}) {
  return materializeHostedProjectFiles({ root, files, assertCurrent, ...extra });
}
function relative(files: readonly HostedProjectFile[]): string[] { return files.map(file => file.path).sort(); }

it("collects only the fixed project instruction set and sanitized permission arrays without ancestor or Host configuration", async () => {
  const { base, source, host } = await fixture();
  await put(base, "AGENTS.md", "Ancestor instructions must stay local.");
  const instructions = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", "AGENTS.override.md"];
  for (const name of instructions) await put(source, name, `Instructions for ${name}.`);
  const permissions = { allow: ["Read(src/**)", "Read(@~/explicit-rule)", "", 42], deny: ["Bash(rm *)"], ask: ["Write(src/**)"] };
  await put(source, ".claude/settings.json", JSON.stringify({ permissions, hooks: { pre: "execute" }, env: { API_KEY: "private-setting-value" }, mcpServers: { personal: {} }, memory: "private" }));
  await put(source, ".claude/settings.local.json", JSON.stringify({ hooks: {} }));
  await put(source, ".claude/rules/project.md", "Project rule.");
  for (const name of ["README.md", "src/main.ts", ".claude/hooks/run.md", ".claude/memory.md", ".codex/config.toml", ".pi/settings.json", ".claude/skills/draft/SKILL.md"]) await put(source, name, "Must not be included by default.");
  for (const name of [".claude/rules/auth.json", ".claude/rules/.env", ".claude/rules/id_rsa", ".claude/rules/key.pem"]) await put(source, name, "Sensitive file name.");
  await put(source, ".claude/rules/secret.md", "Authorization: Bearer private-token-123456789");
  await put(source, ".claude/rules/binary.bin", Buffer.from([0, 1, 2]));
  await put(source, ".claude/rules/invalid.txt", Buffer.from([0xc3, 0x28]));
  const files = await snapshotSourceProjectFiles(context(source));
  expect(relative(files)).toEqual([...instructions, ".claude/settings.json", ".claude/rules/project.md"].sort());
  const sanitized = JSON.stringify({ permissions: { allow: ["Read(src/**)", "Read(@~/explicit-rule)"], deny: ["Bash(rm *)"], ask: ["Write(src/**)"] } }, null, 2);
  expect(files.find(file => file.path === ".claude/settings.json")?.content).toBe(sanitized);
  expect(files.slice(0, 5).map(file => file.path)).toEqual(instructions);
  expect(JSON.stringify(files)).not.toContain("private-setting-value");
  await snapshot(host, files); expect(await readFile(path.join(host, ".claude/settings.json"), "utf8")).toBe(sanitized);
});

it("requires explicit current Source policy for every skill, agent, command and prompt file and keeps entry documents first", async () => {
  const { source } = await fixture();
  const allowed = [".claude/skills/allowed/SKILL.md", ".claude/skills/allowed/attachment.txt", ".claude/agents/allowed.md", ".claude/commands/allowed.md", ".agents/skills/allowed/SKILL.md", ".codex/skills/allowed/SKILL.md", ".pi/skills/allowed/SKILL.md", ".pi/prompts/allowed.md"];
  for (const name of [...allowed, ".claude/skills/disabled/SKILL.md", ".pi/prompts/disabled.md"]) await put(source, name, "Approved resource text.");
  expect(await snapshotSourceProjectFiles(context(source))).toEqual([]);
  const observed: string[] = [];
  const files = await snapshotSourceProjectFiles(context(source), { resourceAllowed: (file, actualContext) => {
    expect(actualContext.target.workspaceRoot).toBe(source); expect(path.isAbsolute(file.absolutePath)).toBe(true);
    expect(file.realPath.startsWith(source + path.sep)).toBe(true); observed.push(file.relativePath); return allowed.includes(file.relativePath);
  } });
  expect(relative(files)).toEqual([...allowed].sort());
  expect(observed).toContain(".claude/skills/disabled/SKILL.md");
  expect(files.at(-1)?.path).toBe(".claude/skills/allowed/attachment.txt");
});

it("bounds actual directory junctions to the trusted Source and does not scan the whole Source through a root cycle", async () => {
  const { base, source } = await fixture();
  const outside = path.join(base, "outside"); await mkdir(outside);
  await put(outside, "outside.md", "Outside the trusted workspace.");
  await put(source, "ordinary-source.md", "Source tree contents are not project instructions.");
  await put(source, ".claude/rules/real/guide.md", "Inside the approved rule collection.");
  await symlink(outside, path.join(source, ".claude", "rules", "escape"), "junction");
  await symlink(source, path.join(source, ".claude", "rules", "cycle"), "junction");
  await symlink(path.join(source, ".claude", "rules", "real"), path.join(source, ".claude", "rules", "alias"), "junction");
  await symlink(path.join(base, "missing"), path.join(source, ".claude", "rules", "broken"), "junction");
  const files = await snapshotSourceProjectFiles(context(source));
  expect(relative(files)).toEqual([".claude/rules/alias/guide.md", ".claude/rules/real/guide.md"]);
  expect(JSON.stringify(files)).not.toContain("Outside the trusted workspace");
  await expect(snapshotSourceProjectFiles(context(path.join(source, ".claude", "rules", "alias")))).rejects.toThrow(/canonical/u);
});

it("uses the v1 128-file ceiling and the fixed six-directory-level bound", async () => {
  const { source } = await fixture(); await put(source, "AGENTS.md", "Root instructions have priority.");
  await put(source, ".claude/rules/a/b/c/d/e/f/allowed.md", "Depth six.");
  await put(source, ".claude/rules/a/b/c/d/e/f/g/too-deep.md", "Beyond depth six.");
  const first = await snapshotSourceProjectFiles(context(source));
  expect(relative(first)).toEqual([".claude/rules/a/b/c/d/e/f/allowed.md", "AGENTS.md"]);
  for (let index = 0; index < 140; index++) await put(source, `.claude/rules/rule-${String(index).padStart(3, "0")}.md`, "Small rule.");
  const files = await snapshotSourceProjectFiles(context(source));
  expect(files).toHaveLength(128); expect(files[0]?.path).toBe("AGENTS.md");
  expect(files.some(file => file.path.endsWith("too-deep.md"))).toBe(false);
});

it("skips whole oversized files and keeps the fixed four MiB raw text budget", async () => {
  const { source } = await fixture();
  await put(source, "AGENTS.md", "X".repeat(512 * 1024 + 1));
  for (let index = 0; index < 9; index++) await put(source, `.claude/rules/${index}.md`, String(index).repeat(512 * 1024));
  const files = await snapshotSourceProjectFiles(context(source));
  expect(files).toHaveLength(8); expect(files.some(file => file.path === "AGENTS.md")).toBe(false);
  expect(files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0)).toBe(4 * 1024 * 1024);
  expect(files.every(file => file.content.length === 512 * 1024)).toBe(true);
});

it("accounts for JSON escaping and personal instructions before choosing complete Source files", async () => {
  const { source } = await fixture();
  for (const name of ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md"]) await put(source, name, "\\".repeat(512 * 1024));
  const personalInstructions = "\\".repeat(1024 * 1024);
  const files = await snapshotSourceProjectFiles(context(source, { appendSystemPrompt: personalInstructions }));
  expect(files).toHaveLength(3); expect(files.every(file => file.content.length === 512 * 1024)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify({ instructions: personalInstructions, files }))).toBeLessThan(6 * 1024 * 1024 - 128 * 1024);
  await expect(snapshotSourceProjectFiles(context(source, { appendSystemPrompt: "\u0001".repeat(1024 * 1024) }))).rejects.toThrow(/limit/u);
});

it("refuses untrusted, nonlocal, noncanonical and stale Source authorities", async () => {
  const { source } = await fixture(); await put(source, "AGENTS.md", "Project instructions.");
  const local = context(source);
  await expect(snapshotSourceProjectFiles({ ...local, target: { ...local.target, trusted: false } })).rejects.toThrow(/trusted/u);
  await expect(snapshotSourceProjectFiles({ ...local, target: { ...local.target, remoteWorkspace: { kind: "device_peer", controllerDeviceId: "controller", targetDeviceId: "device", workspaceRoot: source } } })).rejects.toThrow(/trusted/u);
  const aborted = new AbortController(); aborted.abort(new Error("Source generation retired."));
  await expect(snapshotSourceProjectFiles(context(source, { signal: aborted.signal }))).rejects.toThrow(/retired/u);
  let reads = 0;
  await expect(snapshotSourceProjectFiles(local, { assertCurrent: () => { if (++reads === 8) throw new Error("Source policy changed."); } })).rejects.toThrow(/policy changed/u);
});

it("materializes run virtual paths and leaves only approved relative imports active outside code examples", async () => {
  const { host } = await fixture();
  const body = "Read @.claude/rules/guide.md @./missing.md @C:\\private\\AGENTS.md @~/AGENTS.md\n`@~/example.md`\n```md\n@~/code-example.md\n```\n";
  const files = await snapshot(host, [{ path: "AGENTS.md", content: body }, { path: ".claude/rules/guide.md", content: "Approved rule." }]);
  expect(files.map(file => file.path)).toEqual([path.join(host, "AGENTS.md"), path.join(host, ".claude", "rules", "guide.md")]);
  const actual = await readFile(path.join(host, "AGENTS.md"), "utf8");
  expect(actual).toContain("Read @.claude/rules/guide.md `@./missing.md` `@C:\\private\\AGENTS.md` `@~/AGENTS.md`");
  expect(actual).toContain("`@~/example.md`\n```md\n@~/code-example.md\n```");
  expect(files[0]?.content).toBe(actual);
});

it("restores changed Source context and removes only unchanged previously owned snapshots, including disabled resources", async () => {
  const { base, host } = await fixture();
  await put(host, "README.md", "User-created file."); await put(host, ".claude/sdk-state.json", "SDK-owned state.");
  await put(base, "run/native-home/auth.json", "Native account data.");
  await snapshot(host, [{ path: "AGENTS.md", content: "Before." }, { path: ".claude/rules/old.md", content: "Old rule." }, { path: ".claude/skills/approved/SKILL.md", content: "Previously approved skill." }]);
  const next = [{ path: "AGENTS.md", content: "After." }, { path: ".claude/rules/new.md", content: "New rule." }];
  await snapshot(host, next);
  expect(await readFile(path.join(host, "AGENTS.md"), "utf8")).toBe("After.");
  expect(existsSync(path.join(host, ".claude/rules/old.md"))).toBe(false);
  expect(existsSync(path.join(host, ".claude/skills/approved/SKILL.md"))).toBe(false);
  await snapshot(host, []);
  expect(existsSync(path.join(host, "AGENTS.md"))).toBe(false);
  expect(existsSync(path.join(host, ".claude/rules/new.md"))).toBe(false);
  expect(await readFile(path.join(host, "README.md"), "utf8")).toBe("User-created file.");
  expect(await readFile(path.join(host, ".claude/sdk-state.json"), "utf8")).toBe("SDK-owned state.");
  expect(await readFile(path.join(base, "run/native-home/auth.json"), "utf8")).toBe("Native account data.");
  expect(JSON.parse(await readFile(path.join(host, MANIFEST), "utf8"))).toEqual({ format: 1, files: [] });
});

it.each(["unowned", "modified"] as const)("preserves %s workspace files and rejects the entire update before changing other snapshots", async mode => {
  const { host } = await fixture();
  if (mode === "modified") await snapshot(host, [{ path: "AGENTS.md", content: "Source-owned text." }]);
  await put(host, "AGENTS.md", "User/SDK change.");
  await expect(snapshot(host, [{ path: ".claude/rules/new.md", content: "New rule." }, { path: "AGENTS.md", content: "Replacement." }])).rejects.toThrow(/unowned|modified/u);
  expect(await readFile(path.join(host, "AGENTS.md"), "utf8")).toBe("User/SDK change.");
  expect(existsSync(path.join(host, ".claude/rules/new.md"))).toBe(false);
});

it.each(["../AGENTS.md", "/AGENTS.md", "C:/AGENTS.md", "AGENTS.md:stream", ".claude/../AGENTS.md", ".claude\\rules\\escape.md", ".claude/rules/CON.md", ".claude/rules/trailing. ", ".claude/rules/.git/config", ".claude/rules/auth.json", ".claude/rules/.env", ".claude/hooks/run.md", "README.md"])("rejects an unapproved materialization path %s before effects", async target => {
  const { host } = await fixture();
  await expect(snapshot(host, [{ path: "AGENTS.md", content: "Approved." }, { path: target, content: "Unapproved." }])).rejects.toThrow(/invalid/u);
  expect(existsSync(path.join(host, "AGENTS.md"))).toBe(false); expect(existsSync(path.join(host, MANIFEST))).toBe(false);
});

it("rejects credentials, unsanitized settings, duplicate paths and encoded aggregate overflow before writing", async () => {
  const { host } = await fixture();
  const invalid = [
    [{ path: "AGENTS.md", content: "Authorization: Bearer private-token-123456789" }],
    [{ path: ".claude/settings.json", content: JSON.stringify({ permissions: { allow: ["Read(src/**)"] }, hooks: {} }) }],
    [{ path: "AGENTS.md", content: "A" }, { path: "AGENTS.md", content: "B" }],
    [{ path: "AGENTS.md", content: "A".repeat(512 * 1024 + 1) }],
    [{ path: "AGENTS.md", content: "\0" }]
  ];
  for (const files of invalid) await expect(snapshot(host, files)).rejects.toThrow(/invalid|sanitized|limit/u);
  const escaped = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"].map(name => ({ path: name, content: "\\".repeat(512 * 1024) }));
  await expect(snapshot(host, escaped, { personalInstructions: "\u0001".repeat(1024 * 1024) })).rejects.toThrow(/limit/u);
  expect(existsSync(path.join(host, MANIFEST))).toBe(false);
});

it("rejects unsafe manifests, directory junctions, root aliases and hardlinks without touching their external targets", async () => {
  const { base, host } = await fixture(); const outside = path.join(base, "outside"); await mkdir(outside);
  await put(outside, "AGENTS.md", "Outside account/project data.");
  await put(host, MANIFEST, JSON.stringify({ format: 1, files: [{ path: "../native-home/AGENTS.md", sha256: "a".repeat(64) }] }));
  await expect(snapshot(host, [])).rejects.toThrow(/manifest/u); await rm(path.join(host, MANIFEST));
  await symlink(outside, path.join(host, "alias"), "junction");
  await expect(snapshot(path.join(host, "alias"), [])).rejects.toThrow(/canonical/u);
  await mkdir(path.join(host, ".claude")); await symlink(outside, path.join(host, ".claude/rules"), "junction");
  await expect(snapshot(host, [{ path: ".claude/rules/AGENTS.md", content: "Must stay inside." }])).rejects.toThrow(/escapes|unsafe/u);
  await rm(path.join(host, ".claude/rules")); await rm(path.join(host, MANIFEST), { force: true });
  await link(path.join(outside, "AGENTS.md"), path.join(host, "AGENTS.md"));
  expect((await lstat(path.join(host, "AGENTS.md"))).nlink).toBe(2);
  await expect(snapshot(host, [{ path: "AGENTS.md", content: "Do not overwrite a hardlink." }])).rejects.toThrow(/limit/u);
  expect(await readFile(path.join(outside, "AGENTS.md"), "utf8")).toBe("Outside account/project data.");
});

it("checks existing parents even when an old snapshot leaf is missing and never cleans through a substituted junction", async () => {
  const { base, host } = await fixture(), outside = path.join(base, "outside"); await mkdir(outside);
  await put(outside, "SDK.md", "External SDK data.");
  await snapshot(host, [{ path: ".claude/rules/old.md", content: "Previously owned." }]);
  await rm(path.join(host, ".claude/rules/old.md")); await rmdir(path.join(host, ".claude/rules"));
  await symlink(outside, path.join(host, ".claude/rules"), "junction");
  await expect(snapshot(host, [])).rejects.toThrow(/unsafe/u);
  await expect(snapshot(host, [{ path: ".claude/rules/new.md", content: "Must not write outside." }])).rejects.toThrow(/unsafe/u);
  expect(existsSync(path.join(outside, "new.md"))).toBe(false);
  expect(await readFile(path.join(outside, "SDK.md"), "utf8")).toBe("External SDK data.");
});

it.each(["journal", "file"] as const)("recovers an interrupted %s replacement using only its current ownership journal", async stage => {
  const { host } = await fixture();
  await snapshot(host, [{ path: "AGENTS.md", content: "Old Source instructions." }, { path: ".claude/rules/removed.md", content: "No longer approved." }]);
  const next = [{ path: "AGENTS.md", content: "New Source instructions." }, { path: ".claude/rules/added.md", content: "New rule." }];
  let interrupted = false;
  await expect(snapshot(host, next, { assertCurrent: () => {
    const manifest = JSON.parse(readFileSync(path.join(host, MANIFEST), "utf8")) as { files: { previousSha256?: string }[] };
    const journal = manifest.files.some(file => file.previousSha256);
    if (!interrupted && journal && (stage === "journal" || readFileSync(path.join(host, "AGENTS.md"), "utf8") === "New Source instructions.")) { interrupted = true; throw new Error("Original route retired."); }
  } })).rejects.toThrow(/retired/u);
  expect(interrupted).toBe(true);
  expect(await readFile(path.join(host, "AGENTS.md"), "utf8")).toBe(stage === "journal" ? "Old Source instructions." : "New Source instructions.");
  await snapshot(host, next);
  expect(await readFile(path.join(host, "AGENTS.md"), "utf8")).toBe("New Source instructions.");
  expect(await readFile(path.join(host, ".claude/rules/added.md"), "utf8")).toBe("New rule.");
  expect(existsSync(path.join(host, ".claude/rules/removed.md"))).toBe(false);
  const manifest = JSON.parse(await readFile(path.join(host, MANIFEST), "utf8")) as { files: { previousSha256?: string }[] };
  expect(manifest.files.every(file => file.previousSha256 === undefined)).toBe(true);
});
