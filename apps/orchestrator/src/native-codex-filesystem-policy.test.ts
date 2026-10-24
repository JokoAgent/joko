import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { OrderedPolicyRule, PolicySnapshot } from "@joko/core";
import { describe, expect, it, vi } from "vitest";
import type { HostedAgentCodexAction } from "./hosted-agent-codex-mapping.js";
import {
  NativeCodexFileSystemPolicyError, tightenNativeCodexFileSystemPolicy,
  type NativeCodexFileSystemPolicyInput
} from "./native-codex-filesystem-policy.js";

const deny = (patch: Partial<OrderedPolicyRule> = {}): OrderedPolicyRule => ({
  id: "private-read", effect: "deny", subjectKind: "file_read", ceiling: "critical", priority: 0, order: 0,
  workspaceRelativePathPrefix: "private", ...patch
});
const uri = (path: string, windows = false) => pathToFileURL(path, { windows }).href;
const rootRead = { path: { type: "special", value: { kind: "root" } }, access: "read" };
const deniedPath = (path: string, windows = false) => ({ path: { type: "path", path: uri(path, windows) }, access: "deny" });
function fixture(patch: Partial<NativeCodexFileSystemPolicyInput> = {}) {
  const snapshot: PolicySnapshot = { generation: "policy-1", backendId: "codex", targetId: "project", workspaceRoot: "/project", rules: [deny()] };
  const selected = {
    snapshot, actions: [{ kind: "read", path: "/project/public", scope: "tree" }] as readonly HostedAgentCodexAction[],
    method: "fs/walk", params: { path: uri("/project/public"), options: { followDirectorySymlinks: true, maxDepth: 10 } },
    pathStyle: "posix", enforcement: "native-os-sandbox", canonicalize: vi.fn(async (path: string) => path), assertCurrent: vi.fn(),
    ...patch
  } satisfies NativeCodexFileSystemPolicyInput;
  // Each fixture owns its editable policy; production snapshots remain readonly.
  return { ...selected, snapshot: { ...selected.snapshot }, params: selected.params as Record<string, unknown> };
}

describe("native recursive filesystem policy", () => {
  it("keeps an unprotected search available even when the execution machine has no filesystem sandbox", async () => {
    const f = fixture({ enforcement: "unavailable" });
    f.snapshot = { ...f.snapshot, rules: [] };
    expect(await tightenNativeCodexFileSystemPolicy(f)).toBe(f.params);
    expect(f.canonicalize).not.toHaveBeenCalled();
  });

  it("protects a private sibling reached through a nested public symlink without disabling legitimate traversal", async () => {
    const f = fixture({ canonicalize: vi.fn(async path => path === "/project/private" ? "/vault/private" : path) });
    const result = await tightenNativeCodexFileSystemPolicy(f) as { path: string; options: unknown; sandbox: { permissions: { file_system: { entries: unknown[] } } } };
    // public/alias may resolve to /vault/private inside the native walk. The
    // root remains public; both lexical and real denied targets reach the OS.
    expect(result.path).toBe(uri("/project/public"));
    expect(result.options).toEqual({ followDirectorySymlinks: true, maxDepth: 10 });
    expect(result.sandbox.permissions.file_system.entries).toEqual([
      rootRead, deniedPath("/project/private"), deniedPath("/vault/private")
    ]);
    expect(f.canonicalize).toHaveBeenCalledWith("/project/private");
    expect(f.params).not.toHaveProperty("sandbox");
  });

  it("preserves a managed restricted profile and every original permission/context field", async () => {
    const original = {
      cwd: uri("/project"), workspaceRoots: [uri("/project")], userHomeDir: uri("/home/owner"), temporaryDirectories: [uri("/tmp")],
      windowsSandboxLevel: "disabled", useLegacyLandlock: false, futureContext: { value: "retained" },
      permissions: { type: "managed", network: "enabled", file_system: { type: "restricted", glob_scan_max_depth: 9,
        entries: [
          { path: { type: "path", path: uri("/project/public") }, access: "write" },
          { path: { type: "glob_pattern", pattern: "**/existing-secret/**" }, access: "deny", missing_path_behavior: "skip" }
        ] } }
    };
    const before = structuredClone(original), f = fixture({ params: { path: uri("/project/public"), sandbox: original } });
    const result = await tightenNativeCodexFileSystemPolicy(f) as { sandbox: typeof original };
    expect(result.sandbox).toEqual({ ...before, permissions: { ...before.permissions,
      file_system: { ...before.permissions.file_system, entries: [...before.permissions.file_system.entries, deniedPath("/project/private")] } } });
    expect(original).toEqual(before);
    expect(result.sandbox.permissions.file_system.entries).not.toContainEqual(rootRead);
  });

  it.each([
    { type: "disabled" }, { type: "external", network: "enabled" },
    { type: "managed", file_system: { type: "unrestricted" }, network: "enabled" }
  ])("narrows the existing $type read baseline without creating any writable root", async permissions => {
    const f = fixture({ params: { path: uri("/project/public"), sandbox: { permissions, windowsSandboxLevel: "disabled" } } });
    const result = await tightenNativeCodexFileSystemPolicy(f) as { sandbox: { permissions: { type: string; network: string; file_system: { type: string; entries: { access: string }[] } } } };
    expect(result.sandbox.permissions).toEqual({ type: "managed", network: "restricted", file_system: { type: "restricted",
      entries: [rootRead, deniedPath("/project/private")] } });
    expect(result.sandbox.permissions.file_system.entries.some(entry => entry.access === "write")).toBe(false);
  });

  it("narrows every discover root independently, preserving its own native restrictions", async () => {
    const restricted = { cwd: uri("/project/public"), windowsSandboxLevel: "disabled", permissions: { type: "managed", network: "restricted",
      file_system: { type: "restricted", entries: [{ path: { type: "path", path: uri("/project/public") }, access: "read" }] } } };
    const f = fixture({ method: "capabilityRoots/discoverV1", params: { roots: [
      { id: "plugin", path: uri("/project/public"), sandbox: restricted },
      { id: "skills", path: uri("/project/skills"), sandbox: { permissions: { type: "disabled" } } }
    ] } });
    const result = await tightenNativeCodexFileSystemPolicy(f) as { roots: { id: string; path: string; sandbox: { permissions: { file_system: { entries: unknown[] } } } }[] };
    expect(result.roots.map(root => [root.id, root.path])).toEqual([["plugin", uri("/project/public")], ["skills", uri("/project/skills")]]);
    expect(result.roots[0]!.sandbox.permissions.file_system.entries).toEqual([...restricted.permissions.file_system.entries, deniedPath("/project/private")]);
    expect(result.roots[1]!.sandbox.permissions.file_system.entries).toEqual([rootRead, deniedPath("/project/private")]);
    expect(restricted.permissions.file_system.entries).toHaveLength(1);
  });

  it.each([
    { toolName: "write" }, { toolName: "Read" }, { toolProviderId: "mcp-owner" }, { backendId: "other" }, { targetId: "other" },
    { subjectKind: "file_write" as const }, { effect: "allow" as const }, { effect: "ask" as const }
  ])("leaves walks with an unmatched native policy mask unchanged: %j", async mask => {
    const f = fixture(); f.snapshot = { ...f.snapshot, rules: [deny(mask)] };
    expect(await tightenNativeCodexFileSystemPolicy(f)).toBe(f.params);
    expect(f.canonicalize).not.toHaveBeenCalled();
  });

  it("uses the core explicit-deny precedence rather than a higher-priority allow exception", async () => {
    const f = fixture(); f.snapshot = { ...f.snapshot, rules: [deny({ id: "earlier-allow", effect: "allow", priority: 1000 }), deny({ toolName: "read" })] };
    expect(await tightenNativeCodexFileSystemPolicy(f)).toMatchObject({ sandbox: { permissions: { file_system: {
      entries: [rootRead, deniedPath("/project/private")]
    } } } });
  });

  it("does not invent a deny when the risk ceiling cannot match the entire credential prefix", async () => {
    const f = fixture(); f.snapshot = { ...f.snapshot, rules: [deny({ workspaceRelativePathPrefix: ".env", ceiling: "read_only" })] };
    expect(await tightenNativeCodexFileSystemPolicy(f)).toBe(f.params);
    expect(f.canonicalize).not.toHaveBeenCalled();
  });

  it("fails explicitly when a partially matching risk ceiling cannot be represented as a native path deny", async () => {
    const f = fixture(); f.snapshot = { ...f.snapshot, rules: [deny({ ceiling: "read_only" })] };
    await expect(tightenNativeCodexFileSystemPolicy(f)).rejects.toMatchObject({ code: "NATIVE_CODEX_FILESYSTEM_POLICY_UNAVAILABLE", reason: expect.stringContaining("Risk-selective") });
  });

  it("does not turn a global tool denial into an executable sandbox profile", async () => {
    const f = fixture(); f.snapshot = { ...f.snapshot, rules: [deny({ workspaceRelativePathPrefix: undefined })] };
    await expect(tightenNativeCodexFileSystemPolicy(f)).rejects.toMatchObject({ reason: expect.stringContaining("current policy denies") });
    expect(f.canonicalize).not.toHaveBeenCalled();
  });

  it.each(["fs/copy", "fs/remove"])("refuses a protected %s tree instead of changing its independent read/write semantics", async method => {
    const f = fixture({ method, actions: [{ kind: "write", path: "/project/public", scope: "tree" }] });
    await expect(tightenNativeCodexFileSystemPolicy(f)).rejects.toMatchObject({ reason: expect.stringContaining("independent recursive read/write") });
    f.snapshot = { ...f.snapshot, rules: [deny({ subjectKind: "file_write" })] };
    await expect(tightenNativeCodexFileSystemPolicy(f)).rejects.toBeInstanceOf(NativeCodexFileSystemPolicyError);
    f.snapshot = { ...f.snapshot, rules: [] };
    expect(await tightenNativeCodexFileSystemPolicy(f)).toBe(f.params);
  });

  it("leaves ordinary single-file and non-following walks on their existing canonical authorization gate", async () => {
    const single = fixture({ method: "fs/readFile", actions: [{ kind: "read", path: "/project/public" }], enforcement: "unavailable" });
    expect(await tightenNativeCodexFileSystemPolicy(single)).toBe(single.params);
    const walk = fixture({ params: { path: uri("/project/public"), options: { followDirectorySymlinks: false } }, enforcement: "unavailable" });
    expect(await tightenNativeCodexFileSystemPolicy(walk)).toBe(walk.params);
    expect(walk.canonicalize).not.toHaveBeenCalled();
  });

  it.each([
    { enforcement: "unavailable" as const },
    { params: { path: uri("/project/public"), sandbox: { useLegacyLandlock: true, permissions: { type: "disabled" } } } }
  ])("has no unsandboxed or legacy read-deny fallback: %j", async patch => {
    const f = fixture(patch);
    await expect(tightenNativeCodexFileSystemPolicy(f)).rejects.toBeInstanceOf(NativeCodexFileSystemPolicyError);
    expect(f.canonicalize).not.toHaveBeenCalled();
  });

  it.each([undefined, "disabled", "restricted-token"])("does not elevate a Windows sandbox from %s", async level => {
    const f = fixture({ pathStyle: "win32", snapshot: { generation: "1", backendId: "codex", targetId: "project", workspaceRoot: "C:\\project", rules: [deny()] },
      params: { path: uri("C:\\project\\public", true), sandbox: { windowsSandboxLevel: level, permissions: { type: "disabled" } } } });
    await expect(tightenNativeCodexFileSystemPolicy(f)).rejects.toMatchObject({ reason: expect.stringContaining("already configured elevated") });
    expect(f.canonicalize).not.toHaveBeenCalled();
  });

  it("retains an existing elevated Windows backend and serializes canonical denied paths for that machine", async () => {
    const f = fixture({ pathStyle: "win32", snapshot: { generation: "1", backendId: "codex", targetId: "project", workspaceRoot: "C:\\project", rules: [deny()] },
      params: { path: uri("C:\\project\\public", true), sandbox: { windowsSandboxLevel: "elevated", permissions: { type: "disabled" } } },
      canonicalize: vi.fn(async () => "D:\\vault\\private") });
    expect(await tightenNativeCodexFileSystemPolicy(f)).toMatchObject({ path: uri("C:\\project\\public", true), sandbox: {
      windowsSandboxLevel: "elevated", permissions: { file_system: { entries: [rootRead, deniedPath("C:\\project\\private", true), deniedPath("D:\\vault\\private", true)] } }
    } });
  });

  it.each([
    { permissions: { type: "managed", file_system: { type: "restricted", entries: "invalid" } } },
    { permissions: { type: "unknown" } }, { permissions: {} }, { permissions: { type: "managed", file_system: { type: "unknown" } } }
  ])("never replaces an invalid native profile with broader readable roots: %j", async sandbox => {
    const f = fixture({ params: { path: uri("/project/public"), sandbox } });
    await expect(tightenNativeCodexFileSystemPolicy(f)).rejects.toBeInstanceOf(NativeCodexFileSystemPolicyError);
  });

  it("fences policy/owner retirement during remote canonicalization and rejects foreign resolution without modifying the request", async () => {
    let current = true;
    const f = fixture({ assertCurrent: () => { if (!current) throw new Error("Original authority retired"); },
      canonicalize: vi.fn(async path => { current = false; return path; }) });
    await expect(tightenNativeCodexFileSystemPolicy(f)).rejects.toThrow("Original authority retired");
    expect(f.params).not.toHaveProperty("sandbox");
    const invalid = fixture({ canonicalize: vi.fn(async () => "relative/private") });
    await expect(tightenNativeCodexFileSystemPolicy(invalid)).rejects.toMatchObject({ reason: expect.stringContaining("foreign or relative") });
  });
});

const binary = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];
describe.skipIf(!binary || process.platform === "win32")("fixed native recursive filesystem enforcement", () => {
  it("omits a denied symlink target while still walking and discovering an allowed external skill", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-fs-policy-")));
    const project = join(root, "project"), publicRoot = join(project, "public"), privateRoot = join(project, "private"), allowedRoot = join(root, "allowed");
    await Promise.all([publicRoot, privateRoot, allowedRoot].map(path => mkdir(path, { recursive: true })));
    await writeFile(join(privateRoot, "SKILL.md"), "---\nname: private\ndescription: Hidden.\n---\nPRIVATE_POLICY_SENTINEL\n");
    await writeFile(join(allowedRoot, "SKILL.md"), "---\nname: allowed\ndescription: Public.\n---\nPUBLIC_POLICY_SENTINEL\n");
    await symlink(privateRoot, join(publicRoot, "blocked"));
    await symlink(allowedRoot, join(publicRoot, "allowed"));
    const child = spawn(binary!, ["exec-server", "--listen", "stdio://"], { cwd: project, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env["PATH"], HOME: root, TMPDIR: root } });
    const reader = createInterface({ input: child.stdout }), pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
    let sequence = 0, diagnostics = "";
    child.stderr.on("data", (chunk: Buffer) => { if (diagnostics.length < 8192) diagnostics += chunk.toString("utf8").slice(0, 8192 - diagnostics.length); });
    const failed = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
    child.once("error", failed);
    child.stdin.on("error", failed);
    const exited = new Promise<void>(resolve => child.once("exit", () => { failed(new Error(`Native executor exited: ${diagnostics}`)); resolve(); }));
    reader.on("line", line => {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.id !== "number") return;
      const waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); waiter.resolve(value); }
    });
    const request = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native filesystem response timed out: ${diagnostics}`)); }, 15_000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
    });
    try {
      expect((await request("initialize", { clientName: "joko-filesystem-policy-test", clientVersion: "1" })).error).toBeUndefined();
      child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
      const snapshot: PolicySnapshot = { generation: "1", backendId: "codex", targetId: "project", workspaceRoot: project, rules: [deny()] };
      const options = { snapshot, actions: [{ kind: "read", path: publicRoot, scope: "tree" }] as const,
        pathStyle: "posix" as const, enforcement: "native-os-sandbox" as const, canonicalize: (path: string) => realpath(path), assertCurrent: () => undefined };
      const walk = await request("fs/walk", await tightenNativeCodexFileSystemPolicy({ ...options, method: "fs/walk",
        params: { path: uri(publicRoot), options: { maxDepth: 5, maxDirectories: 100, maxEntries: 100, followDirectorySymlinks: true } } }));
      expect(walk.error).toBeUndefined();
      expect(JSON.stringify(walk.result)).toContain("allowed/SKILL.md");
      expect(JSON.stringify(walk.result)).not.toContain("blocked/SKILL.md");
      const discovery = await request("capabilityRoots/discoverV1", await tightenNativeCodexFileSystemPolicy({ ...options,
        method: "capabilityRoots/discoverV1", params: { roots: [{ id: "public", path: uri(publicRoot) }] } }));
      expect(discovery.error).toBeUndefined();
      expect(JSON.stringify(discovery.result)).toContain("PUBLIC_POLICY_SENTINEL");
      expect(JSON.stringify(discovery.result)).not.toContain("PRIVATE_POLICY_SENTINEL");
    } finally {
      child.stdin.end(); child.kill();
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Native filesystem test cleanup is unconfirmed.")); }, 3_000); })]);
      } finally { if (timeout) clearTimeout(timeout); reader.close(); await rm(root, { recursive: true, force: true }); }
    }
  }, 45_000);
});
