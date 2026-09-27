import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableProcessOwner, type ProcessIdentitySupervisor } from "@joko/runtime-governance";
import {
  CLAUDE_AGENT_SDK_CLI_VERSION,
  DefaultClaudeSdkRuntime,
  spawnOwnedClaudeCodeProcess,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryParams
} from "./sdk-runtime.js";
import {
  adoptClaudeSessionStoreChild,
  createClaudeDurableSessionStore,
  createClaudeSessionStoreAuthority,
  prepareClaudeSessionStoreImport,
  sealClaudeSessionStoreImport,
  type ClaudeSessionStoreSessionAccess
} from "./claude-session-store.js";

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  startup: vi.fn(),
  createSdkMcpServer: vi.fn((options: unknown) => ({ type: "sdk", name: "fixture", instance: options }))
}));
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

  it("uses the fixed package's bundled CLI binding when an empty startup probe emits no turn init", async () => {
    sdk.startup.mockResolvedValueOnce(probeWarmQuery());
    const runtime = new DefaultClaudeSdkRuntime();

    await expect(runtime.probe({
      cwd: process.cwd(),
      env: {},
      settings: { apiKeyHelper: "" },
      settingSources: [],
      initializationTimeoutMs: 500
    })).resolves.toMatchObject({
      installed: true,
      cliVersion: CLAUDE_AGENT_SDK_CLI_VERSION
    });
  });

  it("does not apply the bundled CLI binding to an executable override", async () => {
    sdk.startup.mockResolvedValueOnce(probeWarmQuery());
    const runtime = new DefaultClaudeSdkRuntime();

    const result = await runtime.probe({
      cwd: process.cwd(),
      env: {},
      pathToClaudeCodeExecutable: "D:\\custom\\claude.exe",
      settings: { apiKeyHelper: "" },
      settingSources: [],
      initializationTimeoutMs: 500
    });
    expect(result).toEqual(expect.objectContaining({ installed: true }));
    expect(result.cliVersion).toBeUndefined();
  });

  it("confirms only the selected Query's exact process lease and does not retire a concurrent Query", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-query-owner-"));
    const sessionStoreRoot = await mkdtemp(join(tmpdir(), "joko-claude-session-store-"));
    roots.push(root, sessionStoreRoot);
    const children: ReturnType<typeof spawnOwnedClaudeCodeProcess>[] = [];
    let observedSessionStore: {
      load(key: { readonly projectKey: string; readonly sessionId: string }): Promise<unknown[] | null>;
    } | undefined;
    sdk.query.mockImplementation(({ options }: { options: {
      abortController: AbortController;
      sessionStore?: typeof observedSessionStore;
      spawnClaudeCodeProcess: (input: Parameters<typeof spawnOwnedClaudeCodeProcess>[0]) => ReturnType<typeof spawnOwnedClaudeCodeProcess>;
    } }) => {
      observedSessionStore = options.sessionStore;
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
    expect(() => new DefaultClaudeSdkRuntime({
      processOwner: { rootDirectory: root, instanceId: "query-owner", generation: 1,
        recoverStale: false, supervisor: { capture: async () => "unused", captureSync: () => "unused", terminate } },
      sessionStoreRootDirectory: root
    })).toThrow("must be disjoint");
    const runtime = new DefaultClaudeSdkRuntime({
      processOwner: { rootDirectory: root, instanceId: "query-owner", generation: 1,
        recoverStale: false, supervisor: { capture: async (pid) => `fixture-${pid}`, captureSync: (pid) => `fixture-${pid}`, terminate } },
      sessionStoreRootDirectory: sessionStoreRoot
    });
    try {
      expect(runtime.supportsWorkspaceDerivation).toBe(true);
      const storedSessions = runtime.storedSessions;
      expect(storedSessions).toBeDefined();
      const importAccess = await storedSessions!.prepareImport({
        operationId: "22222222-2222-4222-8222-222222222222",
        sourceWorkspaceAuthority: "workspace-source",
        sourceSessionId: "11111111-1111-4111-8111-111111111111",
        targetWorkspaceAuthority: "workspace-target"
      });
      await expect(storedSessions!.readOperation(importAccess)).resolves.toMatchObject({
        operationId: "22222222-2222-4222-8222-222222222222",
        state: "importing"
      });
      const recovered = await storedSessions!.recoverOperation({
        operationId: importAccess.operationId,
        targetWorkspaceAuthority: importAccess.target.workspaceAuthority
      });
      expect(recovered).toEqual(importAccess);
      expect((await storedSessions!.cleanupOperation(recovered)).state).toBe("cleaned");
      expect((await storedSessions!.cleanupOperation(recovered)).state).toBe("cleaned");
      expect(storedSessions).toMatchObject({
        claim: expect.any(Function),
        recoverOperation: expect.any(Function),
        cleanupOperation: expect.any(Function)
      });
      expect(await readdir(root)).toEqual([]);

      const authority = createClaudeSessionStoreAuthority({
        rootDirectory: sessionStoreRoot,
        namespace: `backend-${createHash("sha256").update("query-owner", "utf8").digest("hex")}`,
        generation: 1
      });
      const storedOperation = prepareClaudeSessionStoreImport(authority, {
        operationId: randomUUID(),
        sourceWorkspaceAuthority: "workspace-query-source",
        sourceSessionId: randomUUID(),
        targetWorkspaceAuthority: "workspace-query-target"
      });
      const staging = createClaudeDurableSessionStore(authority, storedOperation, {
        onChildReserved: async () => undefined
      });
      const sourceProjectKey = "query-source-project";
      const targetProjectKey = "query-target-project";
      const childSessionId = randomUUID();
      await staging.append(
        { projectKey: sourceProjectKey, sessionId: storedOperation.source.sessionId },
        [{ type: "user", uuid: randomUUID() }]
      );
      sealClaudeSessionStoreImport(authority, storedOperation);
      await staging.load({ projectKey: targetProjectKey, sessionId: storedOperation.source.sessionId });
      await staging.append(
        { projectKey: targetProjectKey, sessionId: childSessionId },
        [{ type: "assistant", uuid: randomUUID(), value: "query-owned store" }]
      );
      const storedAccess = adoptClaudeSessionStoreChild(authority, storedOperation, childSessionId);
      staging.close();

      const first = await runtime.query(queryParams(storedAccess));
      const firstSessionStore = observedSessionStore!;
      expect(await firstSessionStore.load({ projectKey: targetProjectKey, sessionId: childSessionId })).toHaveLength(1);
      const second = await runtime.query(queryParams());
      await expect(runtime.retireQuery(first, 100)).rejects.toThrow("hard retirement");
      expect(await firstSessionStore.load({ projectKey: targetProjectKey, sessionId: childSessionId })).toHaveLength(1);
      expect(await readdir(join(root, "1"))).toHaveLength(2);
      unconfirmed = false;
      const firstExit = new Promise<void>((resolvePromise) => children[0]!.once("exit", () => resolvePromise()));
      await runtime.retireQuery(first, 1_000);
      await firstExit;
      await expect(firstSessionStore.load({ projectKey: targetProjectKey, sessionId: childSessionId }))
        .rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
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

  it("samples and terminates one Query only through its opaque durable lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-claude-query-inspection-"));
    roots.push(root);
    let child: ReturnType<typeof spawnOwnedClaudeCodeProcess> | undefined;
    sdk.query.mockImplementationOnce(({ options }: { options: {
      abortController: AbortController;
      spawnClaudeCodeProcess: (input: Parameters<typeof spawnOwnedClaudeCodeProcess>[0]) => ReturnType<typeof spawnOwnedClaudeCodeProcess>;
    } }) => {
      child = options.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        cwd: process.cwd(),
        env: { ...process.env },
        signal: options.abortController.signal
      });
      return { close: () => undefined } as ClaudeSdkQuery;
    });
    const inspect = vi.fn(async (roots: readonly { readonly pid: number }[]) => roots.map(({ pid }) => ({
      pid,
      cpuPercent: 8.5,
      memoryKb: 16_384,
      processCount: 2
    })));
    const terminate = vi.fn(async (pid: number, expectedIdentity: string) => {
      if (expectedIdentity !== `query-${pid}`) return "identity_mismatch" as const;
      try { process.kill(pid, "SIGKILL"); } catch { return "not_running" as const; }
      return "terminated" as const;
    });
    const runtime = new DefaultClaudeSdkRuntime({
      processOwner: {
        rootDirectory: root,
        instanceId: "query-inspection",
        generation: 1,
        recoverStale: false,
        supervisor: {
          capture: async (pid) => `query-${pid}`,
          captureSync: (pid) => `query-${pid}`,
          inspect,
          terminate
        }
      }
    });
    try {
      const query = await runtime.query(queryParams());
      const usage = await runtime.inspectQueryProcesses(query);
      expect(runtime.processInspectionSupported).toBe(true);
      expect(usage).toEqual([expect.objectContaining({
        ownerToken: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        pid: expect.any(Number),
        cpuPercent: 8.5,
        memoryKb: 16_384,
        processCount: 2
      })]);
      const exit = new Promise<void>((resolvePromise) => child!.once("exit", () => resolvePromise()));
      await runtime.terminateQueryProcess(query, {
        pid: usage[0]!.pid,
        processInstanceId: usage[0]!.ownerToken
      }, 1_000);
      await exit;
      await expect(runtime.terminateQueryProcess(query, {
        pid: usage[0]!.pid,
        processInstanceId: usage[0]!.ownerToken
      }, 1_000)).rejects.toThrow("no longer current");
      expect(terminate).toHaveBeenCalledWith(usage[0]!.pid, `query-${usage[0]!.pid}`, 1_000);
    } finally {
      await runtime.retireOwnedProcesses(1_000);
      await runtime.closeSessionOperations();
    }
  });
});

function queryParams(sessionStoreAccess?: ClaudeSessionStoreSessionAccess): ClaudeSdkQueryParams {
  return { prompt: (async function* () {})(), options: {
    abortController: new AbortController(), additionalDirectories: [], allowDangerouslySkipPermissions: false,
    canUseTool: async () => ({ behavior: "deny", message: "No tool is admitted by this process fixture." }),
    cwd: process.cwd(), env: {}, includePartialMessages: true, permissionMode: "default", persistSession: false,
    ...(sessionStoreAccess === undefined ? {} : { sessionStoreAccess }),
    settingSources: [], systemPrompt: { type: "preset", preset: "claude_code" }, tools: []
  } };
}

function probeWarmQuery() {
  const query = {
    initializationResult: async () => ({ models: [], account: {} }),
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {}
  };
  return { query: () => query, close: vi.fn() };
}

async function expectOwnerRootEmpty(root: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readdir(root)).length === 0) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  expect(await readdir(root)).toEqual([]);
}
