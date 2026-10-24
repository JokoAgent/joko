import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrderedPolicyRule, PolicySnapshot } from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";
import { reviewNativeToolPolicy } from "./native-tool-policy.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const rule = (input: Partial<OrderedPolicyRule> = {}): OrderedPolicyRule => ({ id: "deny-read", effect: "deny", subjectKind: "file_read", ceiling: "critical", priority: 0, order: 0, ...input });
function snapshot(rules: readonly OrderedPolicyRule[], workspaceRoot = "/project"): PolicySnapshot {
  return { generation: "1", backendId: "native-backend", targetId: "project", workspaceRoot, rules };
}
const signal = () => new AbortController().signal;

describe("ordinary native ordered tool policy", () => {
  it.each(["Read", "read", "read_file"])('denies automatic %s reads while leaving unrelated paths available', toolName => {
    const policy = snapshot([rule({ workspaceRelativePathPrefix: "private" })]);
    expect(reviewNativeToolPolicy(policy, { toolName, input: { file_path: "/project/private/key.txt" }, signal: signal() }, { remote: true, pathStyle: "posix" }).verdict).toBe("block");
    expect(reviewNativeToolPolicy(policy, { toolName, input: { path: "/project/public/readme.md" }, signal: signal() }, { remote: true, pathStyle: "posix" }).verdict).toBe("default");
  });
  it.each(["Bash", "bash", "command", "exec_command"])('matches command rules for %s and preserves explicit deny before allow', toolName => {
    const policy = snapshot([rule({ id: "allow", subjectKind: "command", effect: "allow", priority: 99 }), rule({ subjectKind: "command", toolName: "bash" })]);
    expect(reviewNativeToolPolicy(policy, { toolName, input: { command: "pwd" }, signal: signal() }).verdict).toBe("block");
    expect(reviewNativeToolPolicy(snapshot([rule({ subjectKind: "command", toolName })]), { toolName, input: { command: "pwd" }, signal: signal() }).verdict).toBe("block");
  });
  it("checks every file change destination and recursive read before any execution", () => {
    const policy = snapshot([rule({ subjectKind: "file_write", workspaceRelativePathPrefix: "private" })]);
    expect(reviewNativeToolPolicy(policy, { toolName: "file_change", input: { changes: [{ path: "/project/public/a", kind: { move_path: "/project/private/a" } }] }, signal: signal() }, { remote: true, pathStyle: "posix" }).verdict).toBe("block");
    expect(reviewNativeToolPolicy(policy, { toolName: "apply_patch", input: { input: "*** Begin Patch\n*** Update File: public/a\n*** Move to: private/a\n*** End Patch" }, signal: signal() }, { remote: true, pathStyle: "posix" }).verdict).toBe("block");
    const reads = snapshot([rule({ workspaceRelativePathPrefix: "private" })]);
    for (const toolName of ["Grep", "Glob", "read"]) expect(reviewNativeToolPolicy(reads, { toolName, input: { path: "/project", recursive: true }, signal: signal() }, { remote: true, pathStyle: "posix" }).verdict).toBe("block");
  });
  it("keeps backend/target scopes and MCP identities exact", () => {
    expect(reviewNativeToolPolicy(snapshot([rule({ backendId: "another" })]), { toolName: "Read", input: { path: "/project/a" }, signal: signal() }, { remote: true }).verdict).toBe("default");
    const policy = snapshot([rule({ subjectKind: "mcp", toolProviderId: "server", toolName: "read", effect: "ask" })]);
    expect(reviewNativeToolPolicy(policy, { toolName: "mcp__server__read", input: {}, signal: signal() }).verdict).toBe("ask");
    expect(reviewNativeToolPolicy(policy, { toolName: "mcp__other__read", input: {}, signal: signal() }).verdict).toBe("default");
  });
  it.skipIf(process.platform === "win32")("checks both the requested path and canonical symlink destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-native-policy-")); roots.push(root);
    await mkdir(join(root, "private")); await writeFile(join(root, "private", "secret"), "not read by this test");
    await symlink(join(root, "private"), join(root, "public-alias"));
    expect(reviewNativeToolPolicy(snapshot([rule({ workspaceRelativePathPrefix: "private" })], root), {
      toolName: "Read", input: { file_path: join(root, "public-alias", "secret") }, signal: signal()
    }).verdict).toBe("block");
  });
});
