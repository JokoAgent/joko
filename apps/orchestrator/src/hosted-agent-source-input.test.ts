import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AdapterContext, MentionInput, PromptInput } from "@joko/core";
import { afterEach, expect, it } from "vitest";
import { mkdtemp } from "./test-paths.js";
import { HostedAgentSourceResources } from "./hosted-agent-source-resources.js";
import { prepareSourceWorkspaceInput } from "./hosted-agent-source-input.js";
import { HostedAgentExecutor } from "./hosted-agent-executor.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-input-"))), workspace = join(root, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true }); await writeFile(join(workspace, "src", "proof.txt"), "ORIGINAL_WORKSPACE_INPUT");
  let current = true;
  const context: AdapterContext = { sessionId: "original", generation: 4, backendInstanceGeneration: 2,
    target: { id: "target", backendId: "paired-source", displayName: "Original workspace", workspaceRoot: workspace, trusted: true, managed: true },
    signal: new AbortController().signal, emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024,
    storeArtifact: async () => { throw new Error("No input Artifacts written."); } };
  const resources = new HostedAgentSourceResources(), assertCurrent = () => { if (!current) throw new Error("Original Source retired."); };
  resources.capture(context, [{ id: "guide", kind: "prompt", name: "Guide", content: "ORIGINAL_RESOURCE_GUIDANCE", revision: "sha256:guide", resourceVersion: 1n, assertCurrent }]);
  cleanup.push(async () => { await resources.release(context); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup."); await rm(root, { recursive: true, force: true }); });
  const options = { shadow: "/native/virtual/workspace", workspaceId: "project-workspace", resources, assertCurrent };
  const prompt = (mentions: readonly MentionInput[]): PromptInput => ({ text: "Inspect these references.", images: [], files: [], mentions, disposition: "prompt" });
  return { root, workspace, context, options, prompt, retire: () => { current = false; } };
}

it("projects mixed file, line, resource and directory occurrences to the actual native workspace and reads on the original node", async () => {
  const f = await fixture(), input: PromptInput = { ...f.prompt([
    { kind: "workspace_file", workspaceId: "project-workspace", reference: "src/proof.txt", label: "@file", lineRange: { startLine: 1, endLine: 2 } },
    { kind: "resource", reference: "guide", label: "@guide", discoveredRevision: "sha256:guide", resourceVersion: "1", runtimeGeneration: 4 },
    { kind: "workspace_directory", workspaceId: "project-workspace", reference: "src", label: "@dir" }
  ]), text: "😀 @file @guide @dir", mentionRanges: [{ start: 3, end: 8, mentionIndex: 0 }, { start: 9, end: 15, mentionIndex: 1 }, { start: 16, end: 20, mentionIndex: 2 }] };
  const prepared = await prepareSourceWorkspaceInput(input, f.context, f.options);
  expect(prepared.input.text).toContain("😀 "); expect(prepared.input.text).toContain('"lineRange":{"startLine":1,"endLine":2}');
  expect(prepared.input.text).toContain("Path: /native/virtual/workspace/src/proof.txt"); expect(prepared.input.text).toContain("Path: /native/virtual/workspace/src");
  expect(prepared.input.text).toContain("ORIGINAL_RESOURCE_GUIDANCE"); expect(prepared.input.text).not.toContain(f.workspace);
  expect(prepared.input.mentions).toEqual([]); expect(prepared.input.mentionRanges).toBeUndefined();
  const executor = new HostedAgentExecutor({ context: f.context, virtualRoot: f.options.shadow, assertCurrent: f.options.assertCurrent,
    readPolicy: () => ({ revision: "original", permissionMode: "ask", planMode: false, approvedRoots: [], confirmCredentials: true }) });
  cleanup.push(async () => executor.dispose());
  const path = "/native/virtual/workspace/src/proof.txt";
  await executor.execute({ format: 1, callId: "read", requestId: "read:1", operation: "tool.begin", payload: { name: "read", input: { path } } });
  const result = await executor.execute({ format: 1, callId: "read", requestId: "read:2", operation: "fs.read", payload: { path } });
  expect(Buffer.from(String(result.data), "base64").toString()).toBe("ORIGINAL_WORKSPACE_INPUT");
  expect(await readFile(join(f.workspace, "src", "proof.txt"), "utf8")).toBe("ORIGINAL_WORKSPACE_INPUT");
  f.retire(); expect(prepared.assertCurrent).toThrow(/retired/u);
});

it("rejects wrong workspace identities, escaped paths and invalid line ranges before native dispatch", async () => {
  const f = await fixture(), mention = { kind: "workspace_file" as const, workspaceId: "project-workspace", reference: "src/proof.txt", label: "File" };
  for (const value of [{ ...mention, workspaceId: "other-workspace" }, { ...mention, reference: "../outside.txt" }, { ...mention, reference: "C:\\foreign\\data.txt" },
    { ...mention, reference: "/outside.txt" }, { ...mention, lineRange: { startLine: 4, endLine: 2 } }]) {
    await expect(prepareSourceWorkspaceInput(f.prompt([value]), f.context, f.options)).rejects.toThrow();
  }
  await expect(prepareSourceWorkspaceInput(f.prompt([{ kind: "workspace_directory", workspaceId: "project-workspace", reference: "src/proof.txt", label: "Wrong kind" }]), f.context, f.options)).rejects.toThrow();
  await expect(prepareSourceWorkspaceInput(f.prompt([mention]), f.context, { ...f.options, shadow: "/native\nwrong-root" })).rejects.toThrow(/native workspace/u);
});

it("fences link escapes and path replacement, and preserves a valid Windows native path spelling", async () => {
  const f = await fixture(), outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "secret.txt"), "OUTSIDE_WORKSPACE");
  await symlink(outside, join(f.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  const mention = { kind: "workspace_file" as const, workspaceId: "project-workspace", reference: "escape/secret.txt", label: "Escaped" };
  await expect(prepareSourceWorkspaceInput(f.prompt([mention]), f.context, f.options)).rejects.toThrow(/allowed file/u);
  const prepared = await prepareSourceWorkspaceInput(f.prompt([{ ...mention, reference: "src/proof.txt" }]), f.context, { ...f.options, shadow: "Z:\\native\\workspace" });
  expect(prepared.input.text).toContain("Path: Z:\\native\\workspace\\src\\proof.txt");
  await rename(join(f.workspace, "src", "proof.txt"), join(f.workspace, "src", "retired.txt"));
  await writeFile(join(f.workspace, "src", "proof.txt"), "REPLACED_IDENTITY");
  expect(prepared.assertCurrent).toThrow(/changed/u);
});
