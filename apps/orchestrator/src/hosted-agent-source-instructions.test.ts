import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AdapterContext } from "@joko/core";
import { snapshotSourceInstructions } from "./hosted-agent-source-instructions.js";
import { materializeHostedProjectFiles, snapshotSourceProjectFiles } from "./hosted-agent-project-files.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup."); await rm(root, { recursive: true, force: true });
} });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-instructions-"))), workspace = join(root, "project"), home = join(root, "home"), host = join(root, "host");
  roots.push(root); await Promise.all([mkdir(workspace), mkdir(join(home, ".claude"), { recursive: true }), mkdir(join(home, ".codex"), { recursive: true }), mkdir(host)]);
  const context: AdapterContext = { sessionId: "task", generation: 1, target: { id: "target", backendId: "source", displayName: "Task", workspaceRoot: workspace, trusted: true, managed: true },
    signal: new AbortController().signal, emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024,
    storeArtifact: async () => { throw new Error("No artifact."); } };
  return { root, workspace, home, host, context };
}
it("carries the original computer's ancestors, personal instructions and bounded nested imports into the private native context", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "AGENTS.md"), "SOURCE_ANCESTOR_GUIDANCE");
  await writeFile(join(f.workspace, "CLAUDE.md"), "Source project @policy.md\n`@not-an-import.md`\n```\n@not-code.md\n```");
  await writeFile(join(f.workspace, "policy.md"), "SOURCE_IMPORTED_POLICY @nested.md");
  await writeFile(join(f.workspace, "nested.md"), "SOURCE_NESTED_POLICY @policy.md");
  await writeFile(join(f.home, ".claude", "CLAUDE.md"), "SOURCE_PERSONAL_GUIDANCE @personal.md");
  await writeFile(join(f.home, ".claude", "personal.md"), "SOURCE_PERSONAL_IMPORT");
  const files = await snapshotSourceInstructions(f.context, { nativeKind: "claude-agent-sdk-stdio", home: f.home, environment: {},
    files: await snapshotSourceProjectFiles(f.context), assertCurrent: () => {} });
  const contents = JSON.stringify(files);
  expect(files[0]?.content).toContain("SOURCE_PERSONAL_GUIDANCE"); expect(files.at(-1)?.path).toBe("CLAUDE.md");
  for (const expected of ["SOURCE_ANCESTOR_GUIDANCE", "SOURCE_IMPORTED_POLICY", "SOURCE_NESTED_POLICY", "SOURCE_PERSONAL_GUIDANCE", "SOURCE_PERSONAL_IMPORT"]) expect(contents).toContain(expected);
  expect(files.filter(file => file.content.includes("SOURCE_IMPORTED_POLICY"))).toHaveLength(1);
  const project = files.find(file => file.path === "CLAUDE.md")!;
  expect(project.content).toMatch(/@\.claude\/rules\/source-context\/[a-f0-9]{64}\.md/u);
  expect(project.content).toContain("`@not-an-import.md`"); expect(project.content).toContain("```\n@not-code.md\n```");
  await materializeHostedProjectFiles({ root: f.host, files, assertCurrent: () => {} });
  expect(await readFile(join(f.host, "CLAUDE.md"), "utf8")).toBe(project.content);
});
it("uses Codex override priority and excludes credentials, executable settings and out-of-scope imports", async () => {
  const f = await fixture();
  await writeFile(join(f.home, ".codex", "AGENTS.override.md"), "SOURCE_OVERRIDE_GUIDANCE");
  await writeFile(join(f.home, ".codex", "AGENTS.md"), "WRONG_FALLBACK_GUIDANCE");
  await writeFile(join(f.home, ".codex", "auth.json"), '{"access_token":"never-transfer"}');
  await writeFile(join(f.home, ".claude", "settings.json"), '{"hooks":{"command":"never-execute"}}');
  const codex = await snapshotSourceInstructions(f.context, { nativeKind: "codex", home: f.home, environment: {}, files: [], assertCurrent: () => {} });
  expect(JSON.stringify(codex)).toContain("SOURCE_OVERRIDE_GUIDANCE"); expect(JSON.stringify(codex)).not.toContain("WRONG_FALLBACK_GUIDANCE");
  await writeFile(join(f.home, ".codex", "AGENTS.override.md"), " \n");
  const fallback = await snapshotSourceInstructions(f.context, { nativeKind: "codex", home: f.home, environment: {}, files: [], assertCurrent: () => {} });
  expect(JSON.stringify(fallback)).toContain("WRONG_FALLBACK_GUIDANCE");
  await writeFile(join(f.workspace, "CLAUDE.md"), "@.env @missing.md"); await writeFile(join(f.workspace, ".env"), "PRIVATE_SECRET=never-transfer");
  const claude = await snapshotSourceInstructions(f.context, { nativeKind: "claude-agent-sdk-stdio", home: f.home, environment: {},
    files: await snapshotSourceProjectFiles(f.context), assertCurrent: () => {} });
  expect(claude.find(file => file.path === "CLAUDE.md")?.content).toBe("`@.env` `@missing.md`");
  expect(JSON.stringify([...codex, ...claude])).not.toMatch(/never-transfer|never-execute/u);
});
it("rechecks the original Source authority throughout reads and refuses a retired task snapshot", async () => {
  const f = await fixture(); await writeFile(join(f.root, "AGENTS.md"), "Ancestor"); let reads = 0;
  await expect(snapshotSourceInstructions(f.context, { nativeKind: "pi", home: f.home, environment: {}, files: [],
    assertCurrent: () => { if (++reads > 5) throw new Error("Source retired."); } })).rejects.toThrow(/retired/u);
});

it("merges original personal native permissions and rule imports while preserving project precedence and excluding executable settings", async () => {
  const f = await fixture(), config = join(f.home, ".claude");
  await mkdir(join(config, "rules", "nested"), { recursive: true }); await mkdir(join(f.workspace, ".claude", "rules"), { recursive: true });
  await writeFile(join(config, "rules", "personal.md"), "PERSONAL_RULE @../rule-detail.txt");
  await writeFile(join(config, "rule-detail.txt"), "PERSONAL_RULE_IMPORT");
  await mkdir(join(config, "shared")); await writeFile(join(config, "shared", "rule.md"), "LINKED_PERSONAL_RULE");
  await symlink(join(config, "shared"), join(config, "rules", "linked"), process.platform === "win32" ? "junction" : "dir");
  await symlink(join(config, "rules"), join(config, "rules", "cycle"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(f.workspace, "outside.md"), "OUTSIDE_PERSONAL_CONFIG");
  await symlink(f.workspace, join(config, "rules", "outside"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(config, "rules", "nested", "same.md"), "SHADOWED_PERSONAL_RULE");
  await mkdir(join(f.workspace, ".claude", "rules", "nested"));
  await writeFile(join(f.workspace, ".claude", "rules", "nested", "same.md"), "PROJECT_RULE_WINS");
  await writeFile(join(config, "settings.json"), JSON.stringify({ permissions: { allow: ["Read(src/**)", "WebSearch"], deny: ["Agent"], ask: ["Write"] },
    hooks: { SessionStart: [{ command: "never-run-personal-hook" }] }, env: { ANTHROPIC_API_KEY: "never-transfer-setting-key" }, apiKeyHelper: "never-run-helper" }));
  await writeFile(join(f.workspace, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Read(src/**)"], deny: ["WebFetch"], ask: [] } }));
  const files = await snapshotSourceInstructions(f.context, { nativeKind: "claude-agent-sdk-stdio", home: f.home, environment: {},
    files: await snapshotSourceProjectFiles(f.context), assertCurrent: () => {} });
  const serialized = JSON.stringify(files);
  expect(serialized).toContain("PERSONAL_RULE_IMPORT"); expect(serialized).toContain("PROJECT_RULE_WINS"); expect(serialized).toContain("LINKED_PERSONAL_RULE");
  expect(serialized).not.toMatch(/SHADOWED_PERSONAL_RULE|OUTSIDE_PERSONAL_CONFIG|never-run|never-transfer/u);
  const settings = files.find(file => file.path === ".claude/settings.local.json")!;
  expect(JSON.parse(settings.content)).toEqual({ permissions: { allow: ["Read(src/**)", "WebSearch"], deny: ["WebFetch", "Agent"], ask: ["Write"] } });
  await materializeHostedProjectFiles({ root: f.host, files, assertCurrent: () => {} });
  expect(await readFile(join(f.host, ".claude", "settings.local.json"), "utf8")).toBe(settings.content);
  await writeFile(join(config, "settings.json"), JSON.stringify({ permissions: { deny: ["Write"] } }));
  expect(JSON.parse(settings.content).permissions.deny).toEqual(["WebFetch", "Agent"]);
  const next = await snapshotSourceInstructions(f.context, { nativeKind: "claude-agent-sdk-stdio", home: f.home, environment: {},
    files: await snapshotSourceProjectFiles(f.context), assertCurrent: () => {} });
  expect(JSON.parse(next.find(file => file.path === ".claude/settings.local.json")!.content).permissions.deny).toEqual(["WebFetch", "Write"]);
});

it("retains every project and personal denial when their individually bounded native lists are combined", async () => {
  const f = await fixture(), project = Array.from({ length: 512 }, (_, i) => `mcp__project__tool_${i}`), personal = Array.from({ length: 512 }, (_, i) => `mcp__personal__tool_${i}`);
  await mkdir(join(f.workspace, ".claude"));
  await writeFile(join(f.workspace, ".claude", "settings.local.json"), JSON.stringify({ permissions: { deny: project } }));
  await writeFile(join(f.home, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: personal } }));
  const files = await snapshotSourceInstructions(f.context, { nativeKind: "claude-agent-sdk-stdio", home: f.home, environment: {},
    files: await snapshotSourceProjectFiles(f.context), assertCurrent: () => {} });
  const content = files.find(file => file.path === ".claude/settings.local.json")!.content;
  expect(JSON.parse(content).permissions.deny).toEqual([...project, ...personal]);
  await materializeHostedProjectFiles({ root: f.host, files, assertCurrent: () => {} });
  expect(await readFile(join(f.host, ".claude", "settings.local.json"), "utf8")).toBe(content);
});
