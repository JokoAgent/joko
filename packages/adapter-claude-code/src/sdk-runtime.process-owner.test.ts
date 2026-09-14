import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableProcessOwner, type ProcessIdentitySupervisor } from "@joko/runtime-governance";
import { DefaultClaudeSdkRuntime, spawnOwnedClaudeCodeProcess, type ClaudeSdkQuery, type ClaudeSdkQueryParams } from "./sdk-runtime.js";

const sdk = vi.hoisted(() => ({ query: vi.fn(), startup: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => sdk);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude SDK owned custom spawn", () => {
  it("keeps filesystem settings enabled during discovery while forwarding the Host credential override", async () => {
    sdk.startup.mockRejectedValueOnce(new Error("bounded fixture stop"));
    const runtime = new DefaultClaudeSdkRuntime();

    await expect(runtime.probe({
      cwd: process.cwd(),
      env: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" },
      settings: { apiKeyHelper: "" },
      settingSources: ["user", "project", "local"],
      initializationTimeoutMs: 500
    })).resolves.toMatchObject({ installed: true });

    expect(sdk.startup).toHaveBeenCalledWith({
      initializeTimeoutMs: 500,
      options: expect.objectContaining({
        settings: { apiKeyHelper: "" },
        settingSources: ["user", "project", "local"]
      })
    });
  });

  it("confirms only the selected Query's exact process lease and does not retire a concurrent Query", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-query-owner-"));
    roots.push(root);
    const children: ReturnType<typeof spawnOwnedClaudeCodeProcess>[] = [];
    sdk.query.mockImplementation(({ options }: { options: { abortController: AbortController; spawnClaudeCodeProcess: (input: Parameters<typeof spawnOwnedClaudeCodeProcess>[0]) => ReturnType<typeof spawnOwnedClaudeCodeProcess> } }) => {
      const child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", "setInterval(() => undefined, 1000)"],
        cwd: process.cwd(), env: { ...process.env }, signal: options.abortController.signal });
      children.push(child);
      return { close: () => { child.kill("SIGKILL"); } } as ClaudeSdkQuery;
    });
    let unconfirmed = true;
    const terminate = vi.fn(async (pid: number) => {
      if (unconfirmed) return "unconfirmed" as const;
      try { process.kill(pid, "SIGKILL"); } catch { return "not_running" as const; }
      return "terminated" as const;
    });
    const runtime = new DefaultClaudeSdkRuntime({ processOwner: { rootDirectory: root, instanceId: "query-owner", generation: 1,
      recoverStale: false, supervisor: { capture: async (pid) => `fixture-${pid}`, captureSync: (pid) => `fixture-${pid}`, terminate } } });
    try {
      const first = await runtime.query(queryParams());
      const second = await runtime.query(queryParams());
      await expect(runtime.retireQuery(first, 100)).rejects.toThrow("hard retirement");
      expect(await readdir(join(root, "1"))).toHaveLength(2);
      unconfirmed = false;
      const firstExit = new Promise<void>((resolvePromise) => children[0]!.once("exit", () => resolvePromise()));
      await runtime.retireQuery(first, 1_000);
      await firstExit;
      expect(children[1]!.exitCode).toBeNull();
      expect(await readdir(join(root, "1"))).toHaveLength(1);
      await expect(runtime.retireQuery(first, 1_000)).rejects.toThrow("cannot be confirmed");
      const secondExit = new Promise<void>((resolvePromise) => children[1]!.once("exit", () => resolvePromise()));
      await runtime.retireQuery(second, 1_000);
      await secondExit;
      await expectOwnerRootEmpty(root);
    } finally {
      unconfirmed = false;
      await runtime.retireOwnedProcesses(1_000);
      await runtime.closeSessionOperations();
    }
  });

  it("publishes exact ownership before returning and retires through the forwarded signal", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-owner-"));
    roots.push(root);
    const terminate = vi.fn(async (
      pid: number,
      expectedIdentity: string
    ) => {
      if (expectedIdentity !== `identity-${pid}`) return "identity_mismatch" as const;
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        return "not_running" as const;
      }
      return "terminated" as const;
    });
    const supervisor: ProcessIdentitySupervisor = {
      capture: async (pid) => `identity-${pid}`,
      captureSync: (pid) => `identity-${pid}`,
      terminate
    };
    const owner = new DurableProcessOwner({
      rootDirectory: root,
      instanceId: "claude-instance",
      generation: 6,
      recoverStale: false,
      supervisor
    });
    await owner.prepare(1_000);
    const forwarded = new AbortController();
    const child = spawnOwnedClaudeCodeProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: forwarded.signal
    }, owner, 1_000);
    const exit = new Promise<void>((resolvePromise) => {
      child.once("exit", () => resolvePromise());
    });
    const files = await readdir(join(root, "6"));
    expect(files).toHaveLength(1);
    const manifest = JSON.parse(await readFile(join(root, "6", files[0]!), "utf8")) as {
      readonly pid: number;
      readonly processIdentity: string;
    };
    expect(manifest).toMatchObject({ processIdentity: `identity-${manifest.pid}` });

    forwarded.abort();
    await exit;
    await expectOwnerRootEmpty(root);
    expect(terminate).toHaveBeenCalledWith(manifest.pid, manifest.processIdentity, 1_000);
  });
});

function queryParams(): ClaudeSdkQueryParams {
  return { prompt: (async function* () {})(), options: {
    abortController: new AbortController(), additionalDirectories: [], allowDangerouslySkipPermissions: false,
    canUseTool: async () => ({ behavior: "deny", message: "No tool is admitted by this process fixture." }),
    cwd: process.cwd(), env: {}, includePartialMessages: true, permissionMode: "default", persistSession: false,
    settingSources: [], systemPrompt: { type: "preset", preset: "claude_code" }, tools: []
  } };
}

async function expectOwnerRootEmpty(root: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readdir(root)).length === 0) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  expect(await readdir(root)).toEqual([]);
}
