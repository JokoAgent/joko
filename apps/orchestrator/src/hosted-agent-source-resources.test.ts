import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AdapterContext, PromptInput } from "@joko/core";
import { HostedAgentSourceResources } from "./hosted-agent-source-resources.js";
import { HostedAgentExecutor } from "./hosted-agent-executor.js";
import { inspectPiSkillPackage } from "./resource-manager.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-source-resources-"))), workspace = join(root, "workspace");
  await mkdir(workspace);
  const context: AdapterContext = { sessionId: "source-task", generation: 4, backendInstanceGeneration: 2, operationId: "source-input",
    target: { id: "source-target", backendId: "source", displayName: "Original task", workspaceRoot: workspace, trusted: true, managed: true },
    signal: new AbortController().signal, emit: async () => {}, requestInteraction: async () => ({ kind: "confirmed", confirmed: false }),
    artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No artifact."); } };
  const resources = new HostedAgentSourceResources();
  cleanups.push(async () => { await resources.release(context); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup."); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, context, resources };
}
it("resolves only the exact Source resource occurrence, preserves Unicode surroundings, and revokes delayed dispatch", async () => {
  const f = await fixture(); let current = true;
  const files = f.resources.capture(f.context, [{ id: "approved", kind: "prompt", name: "Review", revision: "sha256:original", resourceVersion: 3n,
    content: "Inspect the selected change.", assertCurrent: () => { if (!current) throw new Error("Resource revoked."); } }]);
  expect(files[0]?.path).toMatch(/^\.pi\/prompts\/approved-[a-f0-9]{64}\.md$/u);
  expect(f.resources.resources(f.context)[0]).toMatchObject({ id: "approved", state: "loaded", runtimeGeneration: 4 });
  expect(f.resources.commands(f.context)[0]).toMatchObject({ name: "Review", inputMode: "resource_mention", resourceId: "approved", loaded: true });
  const mention = { kind: "resource" as const, label: "@Review", reference: "approved", discoveredRevision: "sha256:original", resourceVersion: "3", runtimeGeneration: 4 };
  const input: PromptInput = { text: "😀 @Review 结束", images: [], files: [], mentions: [mention], disposition: "prompt", mentionRanges: [{ start: 3, end: 10, mentionIndex: 0 }] };
  const prepared = f.resources.prepare(input, f.context);
  expect(prepared.input.text).toContain("😀 "); expect(prepared.input.text).toContain("Inspect the selected change."); expect(prepared.input.text).toContain("结束");
  expect(prepared.input.mentions).toEqual([]); expect(prepared.input.mentionRanges).toBeUndefined();
  expect(() => f.resources.prepare({ ...input, mentions: [{ ...mention, runtimeGeneration: 3 }] }, f.context)).toThrow(/no longer loaded/u);
  current = false; expect(() => prepared.assertCurrent()).toThrow(/revoked/u); expect(f.resources.resources(f.context)).toEqual([]);
});
it("keeps a complete approved skill tree on the Source and routes relative scripts and binary resources to its immutable snapshot", async () => {
  const f = await fixture(), skill = join(f.root, "approved-skill");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: checked-skill\ndescription: Checked Source skill.\n---\nRead scripts/check.txt and image.bin.");
  await writeFile(join(skill, "scripts", "check.txt"), "ORIGINAL_APPROVED_SCRIPT"); const binary = Buffer.from([0, 255, 4, 6]); await writeFile(join(skill, "image.bin"), binary);
  const inspection = await inspectPiSkillPackage(skill, 256, 1024 * 1024); let current = true;
  const seeds = await f.resources.captureSkills(f.context, [{ resource: { id: "skill", kind: "skill", name: "Checked", state: "approved", source: "managed",
    revision: inspection.revision, resourceVersion: 1n }, sourcePath: skill, assertCurrent: () => { if (!current) throw new Error("Resource revoked."); } }]);
  const files = f.resources.capture(f.context, seeds), shadow = join(f.root, "provider", "workspace");
  const authority = f.resources.authority(f.context, shadow);
  const executor = new HostedAgentExecutor({ context: f.context, virtualRoot: shadow, aliases: authority.aliases,
    readPolicy: () => ({ revision: f.resources.authority(f.context, shadow).revision, permissionMode: "ask", planMode: false,
      approvedRoots: authority.approvedRoots, confirmCredentials: false }), assertCurrent: () => { f.resources.authority(f.context, shadow); } });
  cleanups.push(async () => executor.dispose());
  const virtual = join(shadow, dirname(files[0]!.path)), actual = authority.approvedRoots[0]!.path;
  await writeFile(join(skill, "scripts", "check.txt"), "MUTATED_AFTER_CAPTURE");
  for (const [index, name] of ["scripts/check.txt", "image.bin"].entries()) {
    const callId = `read-${index}`, path = join(virtual, name);
    await executor.execute({ format: 1, callId, requestId: `${callId}:1`, operation: "tool.begin", payload: { name: "read", input: { path } } });
    const value = await executor.execute({ format: 1, callId, requestId: `${callId}:2`, operation: "fs.read", payload: { path } });
    expect(Buffer.from(String(value.data), "base64")).toEqual(index ? binary : Buffer.from("ORIGINAL_APPROVED_SCRIPT"));
  }
  expect(await readFile(join(actual, "scripts", "check.txt"), "utf8")).toBe("ORIGINAL_APPROVED_SCRIPT");
  current = false; expect(() => f.resources.authority(f.context, shadow)).toThrow();
  await expect(executor.authorizeNativeActions([{ kind: "read", path: join(virtual, "image.bin") }], f.context.signal)).rejects.toMatchObject({ code: "STALE_AUTHORITY" });
  await f.resources.release(f.context); await expect(readFile(join(actual, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
});
