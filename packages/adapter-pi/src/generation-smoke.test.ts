import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AdapterContext, BlobRef, EventPayload, SessionTreeNode, TargetDescriptor } from "@joko/core";
import { describe, expect, it } from "vitest";
import { createPiAdapter } from "./adapter.js";
import { mkdtemp } from "./test-paths.js";

describe("real Pi managed generation smoke", () => {
  it("exercises the latest native Pi workflow without crossing product bindings", { timeout: 60_000 }, async () => {
    const server = await startOpenAiCompatibleServer();
    const address = server.address() as AddressInfo;
    const agentHome = await mkdtemp(join(tmpdir(), "joko-real-pi-workflow-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-real-pi-workflow-workspace-"));
    const bashSuccessScript = join(workspace, "bash-success.mjs");
    const bashAbortScript = join(workspace, "bash-abort.mjs");
    const bashStarted = join(workspace, "bash-started.txt");
    await Promise.all([
      writeFile(bashSuccessScript, "process.stdout.write('native-user-bash');\n"),
      writeFile(
        bashAbortScript,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(bashStarted)}, "started");\nsetTimeout(() => undefined, 30_000);\n`
      )
    ]);
    const provider = {
      id: "smoke",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions" as const,
      keyless: true,
      models: [{ id: "smoke-model", name: "Smoke Model", contextWindow: 16_384, maxTokens: 1_024 }]
    };
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [provider],
      settings: {
        compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }
      }
    });
    const target: TargetDescriptor = {
      id: "real-pi-workflow-target",
      backendId: "pi",
      displayName: "Real Pi workflow",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const firstSink = new EventSink();
    const secondSink = new EventSink();
    const artifacts: StoredArtifact[] = [];
    const firstBase = { ...smokeContext(target, 1, firstSink, artifacts), sessionId: "real-pi-workflow-first" };
    const secondBase = { ...smokeContext(target, 1, secondSink), sessionId: "real-pi-workflow-second" };
    try {
      const firstBinding = await adapter.createSession({
        target,
        name: "Workflow first",
        providerId: "smoke",
        modelId: "smoke-model",
        effort: "off",
        fastMode: false,
        permissionMode: "ask"
      }, firstBase);
      const secondBinding = await adapter.createSession({
        target,
        name: "Workflow second",
        providerId: "smoke",
        modelId: "smoke-model",
        effort: "off",
        fastMode: false,
        permissionMode: "ask"
      }, secondBase);
      const first = { ...firstBase, binding: firstBinding };
      const second = { ...secondBase, binding: secondBinding };

      expect(firstBinding.opaqueRef).not.toBe(secondBinding.opaqueRef);
      await expect(adapter.inspectSession(firstBinding, first)).resolves.toMatchObject({
        name: "Workflow first",
        binding: firstBinding,
        streaming: false,
        compacting: false,
        pi: { autoCompaction: true, autoRetry: true }
      });
      await expect(adapter.getState(first)).resolves.toMatchObject({
        sessionId: firstBinding.nativeSessionId,
        sessionName: "Workflow first",
        autoCompactionEnabled: true,
        isStreaming: false
      });
      const initialTree = await adapter.getTree(first);
      const initialNodes = flattenTree(initialTree.roots);
      expect(initialNodes.map((node) => node.kind)).toEqual(["model_change", "thinking_level_change", "session_info"]);
      expect(initialTree.leafId).toBe(initialNodes.at(-1)?.entryId);

      await adapter.setName("Workflow first renamed", first);
      await adapter.setAutoCompaction(false, first);
      await adapter.setAutoRetry(false, first);
      await expect(adapter.inspectSession(firstBinding, first)).resolves.toMatchObject({
        name: "Workflow first renamed",
        pi: { autoCompaction: false, autoRetry: false }
      });
      await expect(adapter.inspectSession(secondBinding, second)).resolves.toMatchObject({
        name: "Workflow second",
        pi: { autoCompaction: true, autoRetry: true }
      });
      await expect(adapter.setName("cross-binding write", { ...first, binding: secondBinding })).rejects.toMatchObject({
        publicError: { code: "PI_SESSION_BINDING_MISMATCH" }
      });
      await expect(adapter.setName("stale-generation write", { ...first, generation: 2 })).rejects.toMatchObject({
        publicError: { code: "PI_STALE_GENERATION" }
      });
      await expect(adapter.inspectSession(secondBinding, second)).resolves.toMatchObject({ name: "Workflow second" });
      await adapter.setAutoCompaction(true, first);
      await adapter.setAutoRetry(true, first);

      await expect(adapter.compact(undefined, first)).resolves.toBe("noop");
      await adapter.send({ text: "workflow turn one", images: [], files: [], mentions: [], disposition: "prompt" }, first);
      await firstSink.waitForDone(1);
      await adapter.send({ text: "workflow turn two", images: [], files: [], mentions: [], disposition: "prompt" }, first);
      await firstSink.waitForDone(2);

      const linearTree = await adapter.getTree(first);
      const linearNodes = flattenTree(linearTree.roots);
      expect(linearTree.leafId).toBeDefined();
      expect(linearNodes.filter((node) => node.kind === "message")).toHaveLength(4);
      const forkMessagesBeforeBranch = await adapter.getForkMessages(first);
      expect(forkMessagesBeforeBranch.map((message) => message.text)).toEqual(["workflow turn one", "workflow turn two"]);
      const navigationTarget = forkMessagesBeforeBranch[0]?.entryId;
      if (navigationTarget === undefined) throw new Error("Pi did not expose the first user entry for branch navigation");
      const navigationNode = findTreeNode(linearTree.roots, navigationTarget);
      if (navigationNode === undefined) throw new Error("Pi fork candidate was missing from the native tree");
      await adapter.navigateTree(navigationTarget, false, first);
      await expect(adapter.getTree(first)).resolves.toMatchObject({ leafId: navigationNode.parentId });
      await adapter.send({ text: "workflow branch turn", images: [], files: [], mentions: [], disposition: "prompt" }, first);
      await firstSink.waitForDone(3);
      const branchedTree = await adapter.getTree(first);
      expect(branchedTree.leafId).not.toBe(linearTree.leafId);
      expect(flattenTree(branchedTree.roots).filter((node) => node.kind === "message")).toHaveLength(6);

      await expect(adapter.compact("Preserve the workflow branch name.", first)).resolves.toBe("compacted");
      const compactedTree = await adapter.getTree(first);
      expect(flattenTree(compactedTree.roots).some((node) => node.kind === "compaction")).toBe(true);
      await expect(adapter.compact(undefined, first)).resolves.toBe("noop");
      expect(firstSink.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "compaction", state: "started", reason: "manual" }),
        expect.objectContaining({ type: "compaction", state: "completed", reason: "manual" })
      ]));

      const artifact = await adapter.exportSession(first);
      expect(artifact).toMatchObject({ mimeType: "text/html", fileName: `pi-${first.sessionId}.html` });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.mimeType).toBe("text/html");
      expect(Buffer.from(artifacts[0]?.bytes ?? []).toString("utf8")).toContain("<!DOCTYPE html>");

      await expect(adapter.runBash(`node "${bashSuccessScript}"`, false, first)).resolves.toMatchObject({
        output: "native-user-bash",
        exitCode: 0,
        cancelled: false,
        truncated: false
      });
      const pendingBash = adapter.runBash(`node "${bashAbortScript}"`, true, first);
      await waitForPath(bashStarted);
      await adapter.abortBash(first);
      await expect(pendingBash).resolves.toMatchObject({ cancelled: true, truncated: false });

      const branchMessage = (await adapter.getForkMessages(first)).find((message) => message.text === "workflow branch turn");
      if (branchMessage === undefined) throw new Error("Pi did not expose the branched user entry for forking");
      const forkResult = await adapter.fork(branchMessage.entryId, first);
      const forkBinding = forkResult.binding;
      expect(forkBinding).toMatchObject({ generation: 1 });
      expect(forkBinding.opaqueRef).not.toBe(firstBinding.opaqueRef);
      await expect(adapter.setName("source remains attached", first)).resolves.toBeUndefined();
      const forkSink = new EventSink();
      const forkBase = { ...smokeContext(target, 1, forkSink), sessionId: "real-pi-workflow-fork" };
      const forkContext = { ...forkBase, binding: forkBinding };
      await adapter.resumeSession(forkBinding, forkContext);
      // Pi materializes a fork JSONL on its first completed turn; cloning an
      // untouched fork is intentionally rejected by the native runtime.
      await adapter.send({ text: "workflow fork continuation", images: [], files: [], mentions: [], disposition: "prompt" }, forkContext);
      await forkSink.waitForDone(1);
      const cloneBinding = await adapter.clone(forkContext);
      expect(cloneBinding).toMatchObject({ generation: 1 });
      expect(cloneBinding.opaqueRef).not.toBe(forkBinding.opaqueRef);
      await expect(adapter.setName("fork binding write", forkContext)).resolves.toBeUndefined();
      const cloneSink = new EventSink();
      const cloneBase = { ...smokeContext(target, 1, cloneSink), sessionId: "real-pi-workflow-clone" };
      const cloneContext = { ...cloneBase, binding: cloneBinding };
      await adapter.resumeSession(cloneBinding, cloneContext);
      await adapter.setName("Workflow first clone", cloneContext);
      await expect(adapter.inspectSession(cloneBinding, cloneContext)).resolves.toMatchObject({
        name: "Workflow first clone",
        binding: cloneBinding
      });
      await expect(adapter.inspectSession(secondBinding, second)).resolves.toMatchObject({ name: "Workflow second" });
    } finally {
      await adapter.dispose().catch(() => undefined);
      await closeServer(server);
    }
  });

  it("routes one real Pi prompt lifecycle across steer and follow-up without orphaning product runs", { timeout: 30_000 }, async () => {
    const provider = await startGatedContinuationServer();
    const address = provider.server.address() as AddressInfo;
    const agentHome = await mkdtemp(join(tmpdir(), "joko-real-pi-continuation-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-real-pi-continuation-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [{
        id: "continuation-provider",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        keyless: true,
        models: [{ id: "continuation-model", contextWindow: 16_384, maxTokens: 1_024 }]
      }]
    });
    const target: TargetDescriptor = {
      id: "real-pi-continuation-target",
      backendId: "pi",
      displayName: "Real Pi continuation",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const promptSink = new EventSink();
    const steerSink = new EventSink();
    const followUpSink = new EventSink();
    const creationContext = { ...smokeContext(target, 1, promptSink), sessionId: "real-pi-continuation-session" };
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "continuation-provider",
        modelId: "continuation-model",
        effort: "off",
        fastMode: false,
        permissionMode: "ask"
      }, creationContext);
      const promptContext = { ...creationContext, binding };
      const steerContext = { ...smokeContext(target, 1, steerSink), sessionId: creationContext.sessionId, binding };
      const followUpContext = { ...smokeContext(target, 1, followUpSink), sessionId: creationContext.sessionId, binding };

      await adapter.send({ text: "initial prompt", images: [], files: [], mentions: [], disposition: "prompt" }, promptContext);
      await provider.firstRequestReceived;
      await adapter.send({ text: "steering input", images: [], files: [], mentions: [], disposition: "steer" }, steerContext);
      await adapter.send({ text: "follow-up input", images: [], files: [], mentions: [], disposition: "follow_up" }, followUpContext);
      provider.releaseFirstResponse();

      await Promise.all([
        promptSink.waitForDone(1),
        steerSink.waitForDone(1),
        followUpSink.waitForDone(1)
      ]);
      expect(promptSink.doneCount).toBe(1);
      expect(steerSink.doneCount).toBe(1);
      expect(followUpSink.doneCount).toBe(1);
      expect(promptSink.text).toContain("native-response-1");
      expect(promptSink.text).toContain("native-response-2");
      expect(followUpSink.text).toContain("native-response-3");
      expect(steerSink.text).toBe("");
      expect(provider.requests).toHaveLength(3);
    } finally {
      provider.releaseFirstResponse();
      await adapter.dispose().catch(() => undefined);
      await closeServer(provider.server);
    }
  });

  it("clears real Pi continuation queues before aborting the active lifecycle", { timeout: 30_000 }, async () => {
    const provider = await startGatedContinuationServer();
    const address = provider.server.address() as AddressInfo;
    const agentHome = await mkdtemp(join(tmpdir(), "joko-real-pi-abort-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-real-pi-abort-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [{
        id: "abort-provider",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        keyless: true,
        models: [{ id: "abort-model", contextWindow: 16_384, maxTokens: 1_024 }]
      }]
    });
    const target: TargetDescriptor = {
      id: "real-pi-abort-target",
      backendId: "pi",
      displayName: "Real Pi abort",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const promptSink = new EventSink();
    const steerSink = new EventSink();
    const followUpSink = new EventSink();
    const creationContext = { ...smokeContext(target, 1, promptSink), sessionId: "real-pi-abort-session" };
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "abort-provider",
        modelId: "abort-model",
        effort: "off",
        fastMode: false,
        permissionMode: "ask"
      }, creationContext);
      const promptContext = { ...creationContext, binding };
      const steerContext = { ...smokeContext(target, 1, steerSink), sessionId: creationContext.sessionId, binding };
      const followUpContext = { ...smokeContext(target, 1, followUpSink), sessionId: creationContext.sessionId, binding };

      await adapter.send({ text: "initial prompt", images: [], files: [], mentions: [], disposition: "prompt" }, promptContext);
      await provider.firstRequestReceived;
      await adapter.send({ text: "queued steering", images: [], files: [], mentions: [], disposition: "steer" }, steerContext);
      await adapter.send({ text: "queued follow-up", images: [], files: [], mentions: [], disposition: "follow_up" }, followUpContext);
      await adapter.abort(promptContext);

      await Promise.all([
        promptSink.waitForDone(1),
        steerSink.waitForDone(1),
        followUpSink.waitForDone(1)
      ]);
      for (const sink of [promptSink, steerSink, followUpSink]) {
        expect(sink.events.filter((event) => event.type === "done"))
          .toEqual([{ type: "done", outcome: "aborted" }]);
      }
      expect(provider.requests).toHaveLength(1);
    } finally {
      provider.releaseFirstResponse();
      await adapter.dispose().catch(() => undefined);
      await closeServer(provider.server);
    }
  });

  it("resumes one stable JSONL after rotating Agent Home and loads explicit resources", { timeout: 30_000 }, async () => {
    const server = await startOpenAiCompatibleServer();
    const address = server.address() as AddressInfo;
    const firstAgentHome = await mkdtemp(join(tmpdir(), "joko-real-pi-generation-one-"));
    const secondAgentHome = await mkdtemp(join(tmpdir(), "joko-real-pi-generation-two-"));
    const sessionRoot = await mkdtemp(join(tmpdir(), "joko-real-pi-sessions-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-real-pi-workspace-"));
    const resourceRoot = await mkdtemp(join(tmpdir(), "joko-real-pi-resources-"));
    const extension = join(resourceRoot, "managed-smoke.js");
    const toolOnlyExtension = join(resourceRoot, "tool-only-managed-smoke.js");
    const skill = join(resourceRoot, "managed-smoke-skill");
    const prompt = join(resourceRoot, "managed-smoke-prompt.md");
    await mkdir(skill, { recursive: true });
    await Promise.all([
      writeFile(
        extension,
        [
          "export default function managedSmoke(pi) {",
          "  pi.registerCommand('managed-smoke', {",
          "    description: 'Managed generation smoke command',",
          "    handler: async () => undefined",
          "  });",
          "}",
          ""
        ].join("\n")
      ),
      writeFile(
        toolOnlyExtension,
        [
          "import { Type } from 'typebox';",
          "export default function toolOnly(pi) {",
          "  pi.registerTool({",
          "    name: 'managed_lookup',",
          "    label: 'Managed lookup',",
          "    description: 'Tool-only managed extension used by the runtime catalog smoke test.',",
          "    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }, { additionalProperties: false }),",
          "    execute: async (_id, params) => ({ content: [{ type: 'text', text: params.query }] })",
          "  });",
          "}",
          ""
        ].join("\n")
      ),
      writeFile(
        join(skill, "SKILL.md"),
        "---\nname: managed-smoke-skill\ndescription: Managed generation smoke skill\n---\nUse only for the generation smoke test.\n"
      ),
      writeFile(prompt, "---\ndescription: Managed generation smoke prompt\n---\nReply with the managed smoke response.\n")
    ]);

    const provider = {
      id: "smoke",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions" as const,
      keyless: true,
      models: [{ id: "smoke-model", name: "Smoke Model", contextWindow: 16_384, maxTokens: 1_024 }]
    };
    const adapter = createPiAdapter({ agentHome: firstAgentHome, sessionRoot, providers: [provider] });
    const target: TargetDescriptor = {
      id: "real-pi-target",
      backendId: "pi",
      displayName: "Real Pi",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const eventSink = new EventSink();
    const firstContext = smokeContext(target, 1, eventSink);
    try {
      const binding = await adapter.createSession(
        { target, providerId: "smoke", modelId: "smoke-model", effort: "off", fastMode: false, permissionMode: "ask" },
        firstContext
      );
      await adapter.send({ text: "first", images: [], files: [], mentions: [], disposition: "prompt" }, { ...firstContext, binding });
      await eventSink.waitForDone(1);

      await adapter.updateManagedGeneration({
        agentHome: secondAgentHome,
        providers: [provider],
        managedResources: {
          extensions: [extension, toolOnlyExtension],
          skills: [skill],
          prompts: [prompt],
          packages: [],
          resources: [
            { id: "smoke-extension", kind: "extension", name: "managed-smoke", source: "approved smoke", state: "approved", revision: "sha256:extension-v1", resourceVersion: 11n, runtimePath: extension },
            { id: "smoke-tool-only-extension", kind: "extension", name: "tool-only-managed-smoke", source: "approved smoke", state: "approved", revision: "sha256:tool-only-v1", resourceVersion: 12n, runtimePath: toolOnlyExtension },
            { id: "smoke-skill", kind: "skill", name: "managed-smoke-skill", source: "approved smoke", state: "approved", revision: "sha256:skill-v1", resourceVersion: 13n, runtimePath: skill },
            { id: "smoke-prompt", kind: "prompt", name: "managed-smoke-prompt", source: "approved smoke", state: "approved", revision: "sha256:prompt-v1", resourceVersion: 14n, runtimePath: prompt }
          ]
        }
      });
      // Publication must not interrupt the active Pi run/runtime. It remains
      // usable with its original immutable generation until explicitly closed.
      await adapter.send({ text: "still-first", images: [], files: [], mentions: [], disposition: "prompt" }, { ...firstContext, binding });
      await eventSink.waitForDone(2);
      await adapter.closeSession(binding, { ...firstContext, binding });
      const secondContext: AdapterContext = { ...firstContext, generation: 2, binding };
      const resumed = await adapter.resumeSession(binding, secondContext);
      expect(resumed.binding.opaqueRef).toBe(binding.opaqueRef);
      await expect(adapter.getCommands(secondContext)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "managed-smoke", source: "extension", loaded: true })])
      );
      await expect(adapter.getRuntimeTools(secondContext)).resolves.toMatchObject({
        runtimeGeneration: 2,
        observedAt: expect.any(Number),
        tools: expect.arrayContaining([expect.objectContaining({
          name: "managed_lookup",
          active: true,
          description: "Tool-only managed extension used by the runtime catalog smoke test.",
          sourceInfo: expect.objectContaining({ scope: "temporary", origin: "top-level" }),
          inputSchema: expect.objectContaining({
            allowsAdditionalFields: false,
            fields: expect.arrayContaining([expect.objectContaining({ fieldPath: "query", required: true })])
          })
        })])
      });
      await expect(adapter.getResources(secondContext)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "smoke-extension", state: "loaded", revision: "sha256:extension-v1", runtimeGeneration: 2 }),
        expect.objectContaining({ id: "smoke-skill", state: "loaded", revision: "sha256:skill-v1", runtimeGeneration: 2 }),
        expect.objectContaining({ id: "smoke-prompt", state: "loaded", revision: "sha256:prompt-v1", runtimeGeneration: 2 }),
        expect.objectContaining({ id: "smoke-tool-only-extension", state: "loaded", revision: "sha256:tool-only-v1", runtimeGeneration: 2 })
      ]));
      await adapter.send({ text: "/managed-smoke", images: [], files: [], mentions: [], disposition: "prompt" }, secondContext);
      await eventSink.waitForDone(3);
      await adapter.send({ text: "second", images: [], files: [], mentions: [], disposition: "prompt" }, secondContext);
      await eventSink.waitForDone(4);
      expect(eventSink.text).toContain("real-pi-smoke");
    } finally {
      await adapter.dispose().catch(() => undefined);
      await closeServer(server);
    }
  });

  it("sends priority and default payloads through the real latest Pi provider pipeline", { timeout: 30_000 }, async () => {
    const requests: Record<string, unknown>[] = [];
    const server = await startOpenAiResponsesServer(requests);
    const address = server.address() as AddressInfo;
    const agentHome = await mkdtemp(join(tmpdir(), "joko-real-pi-fast-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "joko-real-pi-fast-workspace-"));
    const adapter = createPiAdapter({
      agentHome,
      sessionRoot: agentHome,
      providers: [{
        id: "priority-provider",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-responses",
        keyless: true,
        models: [{
          id: "priority-model",
          name: "Priority Model",
          supportsFastMode: true,
          contextWindow: 16_384,
          maxTokens: 1_024
        }]
      }]
    });
    const target: TargetDescriptor = {
      id: "real-pi-fast-target",
      backendId: "pi",
      displayName: "Real Pi Fast",
      workspaceRoot: workspace,
      managed: true,
      trusted: false
    };
    const sink = new EventSink();
    const context = { ...smokeContext(target, 1, sink), sessionId: "real-pi-fast-session" };
    try {
      const binding = await adapter.createSession({
        target,
        providerId: "priority-provider",
        modelId: "priority-model",
        effort: "off",
        fastMode: true,
        permissionMode: "ask"
      }, context);
      const boundContext = { ...context, binding };
      await adapter.send({ text: "priority", images: [], files: [], mentions: [], disposition: "prompt" }, boundContext);
      await sink.waitForDone(1);
      await adapter.setFastMode(false, boundContext);
      await adapter.send({ text: "default", images: [], files: [], mentions: [], disposition: "prompt" }, boundContext);
      await sink.waitForDone(2);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.["service_tier"]).toBe("priority");
      expect(requests[1]).not.toHaveProperty("service_tier");
    } finally {
      await adapter.dispose().catch(() => undefined);
      await closeServer(server);
    }
  });
});

class EventSink {
  readonly events: EventPayload[] = [];
  #done = 0;
  #waiters: Array<() => void> = [];

  get text(): string {
    return this.events.filter((event): event is Extract<EventPayload, { type: "text_delta" }> => event.type === "text_delta").map((event) => event.delta).join("");
  }

  get doneCount(): number {
    return this.#done;
  }

  async emit(payload: EventPayload): Promise<void> {
    this.events.push(payload);
    if (payload.type !== "done") return;
    this.#done += 1;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async waitForDone(count: number): Promise<void> {
    if (this.#done >= count) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for settled turn ${count}`)), 10_000);
      this.#waiters.push(() => {
        clearTimeout(timer);
        if (this.#done >= count) resolve();
        else void this.waitForDone(count).then(resolve, reject);
      });
    });
  }
}

async function startGatedContinuationServer(): Promise<{
  readonly server: Server;
  readonly requests: readonly Record<string, unknown>[];
  readonly firstRequestReceived: Promise<void>;
  readonly releaseFirstResponse: () => void;
}> {
  const requests: Record<string, unknown>[] = [];
  let markFirstRequestReceived!: () => void;
  const firstRequestReceived = new Promise<void>((resolve) => {
    markFirstRequestReceived = resolve;
  });
  let releaseFirstResponse!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => {
    releaseFirstResponse = resolve;
  });
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const ordinal = requests.length;
      if (ordinal === 1) markFirstRequestReceived();
      void (ordinal === 1 ? firstResponseGate : Promise.resolve()).then(() => {
        if (response.destroyed) return;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        response.write(
          `data: ${JSON.stringify({
            id: `joko-continuation-${ordinal}`,
            object: "chat.completion.chunk",
            created: ordinal,
            model: "continuation-model",
            choices: [{ index: 0, delta: { role: "assistant", content: `native-response-${ordinal}` }, finish_reason: null }]
          })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({
            id: `joko-continuation-${ordinal}`,
            object: "chat.completion.chunk",
            created: ordinal,
            model: "continuation-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: ordinal, completion_tokens: 1, total_tokens: ordinal + 1 }
          })}\n\n`
        );
        response.end("data: [DONE]\n\n");
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, requests, firstRequestReceived, releaseFirstResponse };
}

interface StoredArtifact {
  readonly sourcePath: string;
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
  readonly fileName?: string;
}

function smokeContext(target: TargetDescriptor, generation: number, sink: EventSink, artifacts?: StoredArtifact[]): AdapterContext {
  return {
    sessionId: "real-pi-generation-session",
    generation,
    target,
    signal: new AbortController().signal,
    emit: (payload) => sink.emit(payload),
    requestInteraction: async () => ({ kind: "confirmed", confirmed: true }),
    artifactCapacityBytes: 256 * 1024 * 1024,
    storeArtifact: async (sourcePath, options) => {
      const bytes = await readFile(sourcePath);
      artifacts?.push({
        sourcePath,
        bytes,
        ...(options?.mimeType === undefined ? {} : { mimeType: options.mimeType }),
        ...(options?.fileName === undefined ? {} : { fileName: options.fileName })
      });
      return blob(bytes, options?.mimeType, options?.fileName);
    }
  };
}

function flattenTree(nodes: readonly SessionTreeNode[]): readonly Pick<SessionTreeNode, "entryId" | "kind">[] {
  return nodes.flatMap((node) => [
    { entryId: node.entryId, kind: node.kind },
    ...flattenTree(node.children)
  ]);
}

function findTreeNode(nodes: readonly SessionTreeNode[], entryId: string): SessionTreeNode | undefined {
  for (const node of nodes) {
    if (node.entryId === entryId) return node;
    const nested = findTreeNode(node.children, entryId);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await access(path).then(() => true, () => false)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for native bash marker: ${path}`);
}

function blob(bytes: Uint8Array, mimeType = "application/octet-stream", fileName?: string): BlobRef {
  return {
    id: `smoke-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
    mimeType,
    fileName
  };
}

async function startOpenAiCompatibleServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.once("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      response.write(
        `data: ${JSON.stringify({
          id: "joko-smoke",
          object: "chat.completion.chunk",
          created: 1,
          model: "smoke-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "real-pi-smoke" }, finish_reason: null }]
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          id: "joko-smoke",
          object: "chat.completion.chunk",
          created: 1,
          model: "smoke-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })}\n\n`
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function startOpenAiResponsesServer(requests: Record<string, unknown>[]): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      const item = {
        id: `message-${requests.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "real-pi-fast", annotations: [] }]
      };
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "real-pi-fast" },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: `response-${requests.length}`,
            object: "response",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
          }
        }
      ];
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
