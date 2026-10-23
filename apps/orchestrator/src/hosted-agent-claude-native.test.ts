import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import { OperationalStore } from "@joko/store";
import type { AdapterContext, EventPayload, HostedExecution, NativeSessionBinding } from "@joko/core";
import { createHostedAgentClaudeAdapter } from "./hosted-agent-claude-factory.js";
import { HostedAgentClaudeExecutor } from "./hosted-agent-claude-executor.js";
import { HostedAgentExecutor } from "./hosted-agent-executor.js";
import { createHostedAgentToolChannel } from "./hosted-agent-tool-channel.js";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";

describe("dedicated hosted Claude native factory", () => {
  it.each(["claude-sonnet-4-6", "sonnet"])("uses the actual SDK with %s, forwards its pinned subscription and resumes the same native task", async modelId => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "joko-hosted-claude-factory-"))), source = join(directory, "source"), workspace = join(directory, "workspace"), home = join(directory, "native");
    await Promise.all([mkdir(source), mkdir(workspace), mkdir(home)]); await writeFile(join(source, "proof.txt"), "PRIVATE SOURCE PROOF");
    const store = new OperationalStore(join(directory, "store.db")), vault = await CredentialVault.open(join(directory, "vault.key"));
    const credentials = new CredentialManager({ vault, storagePath: join(directory, "credentials.json") }); await credentials.initialize();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "native-owner" }); providers.initialize();
    const lifetime = new AbortController(), outputs: EventPayload[] = [], messages: Record<string, unknown>[] = [], headers: Headers[] = [];
    const incoming: unknown[] = [], channel = diagnosticsChannel("http.server.request.start");
    const observed = (event: unknown) => { const request = (event as { request?: { url?: string; headers?: Record<string, unknown> } }).request;
      if (request) incoming.push({ url: request.url, scope: !!request.headers?.["x-joko-hosted-native-scope"], authorization: !!request.headers?.authorization, key: !!request.headers?.["x-api-key"] }); };
    channel.subscribe(observed);
    const sourceContext: AdapterContext = { sessionId: "source-task", generation: 1, backendInstanceGeneration: 1, operationId: "source-input", signal: lifetime.signal,
      target: { id: "source-target", backendId: "source-backend", displayName: "Source", workspaceRoot: source, managed: false, trusted: true },
      emit: async () => {}, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No Artifact expected."); } };
    const executor = new HostedAgentExecutor({ context: sourceContext, virtualRoot: workspace, assertCurrent: () => lifetime.signal.throwIfAborted(),
      readPolicy: () => ({ revision: "1", permissionMode: "bypassPermissions", planMode: false, approvedRoots: [], confirmCredentials: false }) });
    const helper = new HostedAgentClaudeExecutor({ workspaceRoot: workspace, signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted() });
    const toolChannel = await createHostedAgentToolChannel({ assertCurrent: () => lifetime.signal.throwIfAborted(), execute: async (request, signal) => {
      const { origin, ...input } = request as Record<string, unknown>; if (origin !== "agent") throw new Error("Wrong native owner.");
      return await helper.execute(input, signal, executor) ?? executor.execute(input, signal);
    } });
    const execution: HostedExecution = { trust: "guest", guestHome: directory, providerId: "claude-code", modelIds: [modelId],
      workspace: { root: workspace, additionalRoots: [], platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false },
      source: { sessionId: sourceContext.sessionId, targetId: sourceContext.target.id, generation: 1 }, channel: toolChannel, assertCurrent: () => lifetime.signal.throwIfAborted() };
    const owner = { sessionId: "private-native-session", targetId: "private-native-target", generation: 1, backendInstanceGeneration: 1 };
    let permitted = true;
    const creation = { home, execution, nativeOwner: owner, trust: "guest" as const, providerId: "claude-code", providerIds: ["claude-code"],
      modelIds: execution.modelIds, signal: lifetime.signal, readBlob: async () => { throw new Error("No input Blob expected."); },
      assertModelAllowed(providerId: string, selected: string) { if (!permitted || providerId !== "claude-code" || selected !== modelId) throw new Error("The original model grant is unavailable."); } };
    const token = "sk-ant-oat01-controlled-native-hosted-account";
    const serialized = JSON.stringify({ format: 1, type: "oauth", accessToken: token, refreshToken: "controlled-native-refresh", expiresAt: Date.now() + 60 * 60_000,
      scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: "default_claude_max_5x" });
    const ports = { creation, backendId: "claude-code", providers, credentialPort: { readSerialized: async () => serialized,
      compareAndSet: async () => false, restoreExact: async () => false, deleteExact: async () => false },
      environment: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", ENABLE_TOOL_SEARCH: "false" },
      fetch: (async (url, init) => {
        expect(String(url).startsWith("https://api.anthropic.com/v1/messages")).toBe(true);
        if (String(url).includes("count_tokens")) return new Response('{"input_tokens":5}', { headers: { "content-type": "application/json" } });
        const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")) as Record<string, unknown>; messages.push(body); headers.push(new Headers(init?.headers));
        const tools = Array.isArray(body.tools) ? body.tools as { name: string }[] : [], name = tools.find(tool => tool.name.endsWith("__Read"))?.name;
        const read = JSON.stringify(body.messages).includes("PRIVATE SOURCE PROOF");
        const content: ({ type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "text"; text: string })[] = !read && name ? [{ type: "tool_use", id: "native-source-read", name, input: { file_path: join(workspace, "proof.txt") } }]
          : [{ type: "text", text: "NATIVE SOURCE COMPLETE" }];
        const message = { id: "native-message-" + messages.length, type: "message", role: "assistant", model: "claude-sonnet-4-6", content,
          stop_reason: read || !name ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
        if (body.stream === false) return new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } });
        const events: Record<string, unknown>[] = [{ type: "message_start", message: { ...message, content: [], stop_reason: null } }];
        content.forEach((block, index) => {
          if (block.type === "tool_use") events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
            { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
          else events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
          events.push({ type: "content_block_stop", index });
        });
        events.push({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
        return new Response(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch };
    let adapter = await createHostedAgentClaudeAdapter(ports), binding: NativeSessionBinding | undefined;
    const context = (operationId: string): AdapterContext => ({ sessionId: owner.sessionId, generation: owner.generation, backendInstanceGeneration: 1,
      target: { id: owner.targetId, backendId: "claude-code", displayName: "Private native workspace", workspaceRoot: workspace, managed: true, trusted: false },
      modelSelection: { providerId: "claude-code", modelId }, hostedExecution: execution, operationId, ...(binding ? { binding } : {}),
      signal: lifetime.signal, emit: async event => { outputs.push(event); }, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024,
      storeArtifact: async () => { throw new Error("No Artifact expected."); } });
    try {
      binding = await adapter.createSession({ target: context("create").target, providerId: "claude-code", modelId, permissionMode: "bypassPermissions", fastMode: false }, context("create"));
      await adapter.send({ text: "Read the Source proof.", disposition: "prompt", images: [], files: [], mentions: [] }, context("one"));
      await eventually(() => outputs.some(event => event.type === "done"));
      expect(messages, JSON.stringify({ errors: outputs.filter(event => event.type === "error"), incoming })).toHaveLength(2); expect(outputs.at(-1)).toEqual({ type: "done", outcome: "completed" });
      expect(headers.every(header => header.get("authorization") === "Bearer " + token)).toBe(true);
      expect(headers.every(header => !header.has("x-joko-hosted-native-scope"))).toBe(true);
      const nativeId = binding.nativeSessionId; await adapter.closeSession(binding, context("close")); await adapter.dispose();
      adapter = await createHostedAgentClaudeAdapter(ports); expect((await adapter.resumeSession(binding, context("resume"))).binding.nativeSessionId).toBe(nativeId);
      await adapter.send({ text: "Continue the Source task.", disposition: "prompt", images: [], files: [], mentions: [] }, context("two"));
      await eventually(() => outputs.filter(event => event.type === "done").length === 2);
      expect(outputs.at(-1)).toEqual({ type: "done", outcome: "completed" }); expect(messages).toHaveLength(3);
      permitted = false;
      await adapter.send({ text: "The grant has been revoked.", disposition: "prompt", images: [], files: [], mentions: [] }, context("three"));
      await eventually(() => outputs.filter(event => event.type === "done").length === 3);
      expect(outputs.at(-1)).toEqual({ type: "done", outcome: "failed" }); expect(messages).toHaveLength(3);
      expect(JSON.stringify(outputs)).not.toContain(token); expect(JSON.stringify(outputs)).not.toContain("controlled-native-refresh");
      await expect(readFile(join(workspace, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      lifetime.abort(); await adapter.dispose(); await toolChannel.close(); await helper.dispose(); executor.dispose(); store.close(); channel.unsubscribe(observed);
      const suffix = relative(resolve(tmpdir()), directory); if (!suffix || suffix === ".." || suffix.startsWith(".." + sep)) throw new Error("Unsafe native fixture cleanup.");
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
async function eventually(check: () => boolean): Promise<void> { const limit = Date.now() + 40_000; while (!check()) { if (Date.now() > limit) throw new Error("The hosted native turn did not finish."); await new Promise(resolve => setTimeout(resolve, 25)); } }
