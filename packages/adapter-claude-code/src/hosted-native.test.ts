import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterContext, EventPayload, HostedExecution } from "@joko/core";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "./adapter.js";
import { CLAUDE_HOSTED_GUEST_TOOLS } from "./hosted-tools.js";

describe("Claude hosted execution with the published native SDK", () => {
  it("advertises only guest built-ins and Source MCP, reads Source, and never loads model-computer resources", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-claude-hosted-native-")));
    const home = join(root, "native"), workspace = join(root, "workspace"), source = join(root, "source");
    await Promise.all([mkdir(home), mkdir(workspace), mkdir(source)]); await writeFile(join(source, "proof.txt"), "FROM THE SOURCE COMPUTER");
    const inputs: Record<string, unknown>[] = [], tools: string[][] = [], outputs: EventPayload[] = [];
    const bearer = "test_native_source_bearer_0123456789abcdef";
    let sourceRead = 0, modelCalls = 0;
    const executor = createServer((req, res) => { void (async () => {
      if (req.headers.authorization !== `Bearer ${bearer}` || req.url !== "/execute") { res.writeHead(403).end(); return; }
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; inputs.push(request);
      if (request.operation === "claude.call") { sourceRead++;
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ format: 1, ok: true, value: {
          content: [{ type: "text", text: await readFile(join(source, "proof.txt"), "utf8") }], isError: false } }));
      } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ format: 1, ok: true, value: {} })); }
    })().catch(() => res.writeHead(500).end()); }); await listen(executor);
    const model = createServer((req, res) => { void (async () => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      if (!req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.setHeader("content-type", "application/json"); res.end('{"input_tokens":1}'); return; }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: { name: string }[]; stream?: boolean; messages?: unknown[] };
      const names = input.tools?.map(tool => tool.name) ?? []; tools.push(names); modelCalls++;
      const name = names.find(name => name.endsWith("__Read"));
      const history = JSON.stringify(input.messages), used = history.includes("FROM THE SOURCE COMPUTER");
      const denied = history.includes("without isolation") || history.includes("checkout belongs to the task computer");
      const agent = names.find(name => name === "Agent" || name === "Task");
      const content: ({ type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "text"; text: string })[] = !used && name ? [{ type: "tool_use", id: "source-read-one", name, input: { file_path: join(workspace, "proof.txt") } }]
        : !denied && agent ? [{ type: "tool_use", id: "denied-cloud-isolation", name: agent,
          input: { description: "Do not open a cloud checkout", prompt: "Read nothing", subagent_type: "general-purpose", isolation: "remote" } }]
        : [{ type: "text", text: "SOURCE NATIVE COMPLETE" }];
      const stopReason = content[0]?.type === "tool_use" ? "tool_use" : "end_turn";
      const message = { id: "msg_source_" + modelCalls, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
      if (input.stream === false) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ...message, content, stop_reason: stopReason })); return; }
      const events: Record<string, unknown>[] = [{ type: "message_start", message }];
      content.forEach((block, index) => {
        if (block.type === "tool_use") {
          events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
            { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        } else events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        events.push({ type: "content_block_stop", index });
      });
      events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: "message_stop" });
      res.setHeader("content-type", "text/event-stream"); res.end(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    })().catch(() => res.writeHead(500).end()); }); await listen(model);
    const resources = vi.fn(async () => []), skills = vi.fn(async () => []), subagent = vi.fn(() => "host-only-model");
    const adapterOptions: ClaudeCodeAdapterOptions = { instanceGeneration: 1, probeCwd: workspace, settingSources: ["user", "project", "local"],
      environment: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, "claude"), ANTHROPIC_API_KEY: "sk-ant-native-controlled-fixture",
        ANTHROPIC_BASE_URL: origin(model), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", ENABLE_TOOL_SEARCH: "false" },
      resolveTextResources: resources, resolveNativeSkills: skills, resolveSubagentModel: subagent, initializationTimeoutMs: 30_000, admissionTimeoutMs: 30_000 };
    let adapter = new ClaudeCodeAdapter(adapterOptions);
    const lifetime = new AbortController();
    const hosted: HostedExecution = { trust: "guest", guestHome: root, providerId: "claude-code", modelIds: ["claude-sonnet-4-6"],
      workspace: { root: workspace, additionalRoots: [], platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false, personalInstructions: "SOURCE PERSONAL INSTRUCTIONS" },
      source: { sessionId: "source-session", targetId: "source-target", generation: 1 }, channel: { endpoint: origin(executor), bearer },
      assertCurrent: () => lifetime.signal.throwIfAborted() };
    const context: AdapterContext = { sessionId: "hosted-session", generation: 1, backendInstanceGeneration: 1, operationId: "original-input", hostedExecution: hosted,
      target: { id: "hosted-target", backendId: adapter.id, workspaceRoot: workspace, displayName: "Native model workspace", managed: true, trusted: false },
      modelSelection: { providerId: "claude-code", modelId: "claude-sonnet-4-6" }, signal: lifetime.signal, emit: async event => { outputs.push(event); },
      requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024, storeArtifact: async () => { throw new Error("No Artifact expected."); } };
    try {
      const binding = await adapter.createSession({ target: context.target, permissionMode: "bypassPermissions", fastMode: false, nativeStart: { kind: "new" },
        providerId: "claude-code", modelId: "claude-sonnet-4-6" }, context);
      await adapter.send({ text: "Read proof.txt from the Source and finish.", images: [], files: [], mentions: [], disposition: "prompt" }, { ...context, binding });
      await eventually(() => outputs.some(event => event.type === "done"), 40_000);
      expect(outputs.filter(event => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
      expect(modelCalls).toBe(3); expect(sourceRead).toBe(1);
      expect(inputs).toEqual([expect.objectContaining({ operation: "tool.begin", origin: "agent", payload: { name: "claude", input: { name: "Read", arguments: { file_path: join(workspace, "proof.txt") } } } }),
        expect.objectContaining({ operation: "claude.call", origin: "agent" }), expect.objectContaining({ operation: "tool.end", origin: "agent" })]);
      const allowed = new Set<string>([...CLAUDE_HOSTED_GUEST_TOOLS, "Task"]);
      expect(tools.flat().filter(name => !name.startsWith("mcp__") && !allowed.has(name))).toEqual([]);
      expect(tools.flat()).not.toContain("Read"); expect(tools.flat()).not.toContain("Bash"); expect(tools.flat()).not.toContain("WebFetch");
      expect(resources).not.toHaveBeenCalled(); expect(skills).not.toHaveBeenCalled(); expect(subagent).not.toHaveBeenCalled();
      await expect(adapter.setModel("claude-code", "host-only-model", { ...context, binding })).rejects.toThrow("shared Provider");
      await expect(readFile(join(workspace, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(outputs)).not.toContain(bearer);
      await adapter.closeSession(binding, { ...context, binding }); await adapter.dispose();
      adapter = new ClaudeCodeAdapter(adapterOptions);
      expect((await adapter.resumeSession(binding, { ...context, binding })).binding.nativeSessionId).toBe(binding.nativeSessionId);
      await adapter.send({ text: "Continue the same Source task.", images: [], files: [], mentions: [], disposition: "prompt" }, { ...context, binding, operationId: "resumed-input" });
      await eventually(() => outputs.filter(event => event.type === "done").length === 2, 40_000);
      expect(outputs.filter(event => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }, { type: "done", outcome: "completed" }]);
      expect(modelCalls).toBe(4); expect(sourceRead).toBe(1);
    } finally {
      lifetime.abort(); await adapter.dispose(); await Promise.all([close(executor), close(model)]);
      const suffix = relative(resolve(tmpdir()), root); if (!suffix || suffix === ".." || suffix.startsWith(".." + sep)) throw new Error("Unsafe test cleanup.");
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
async function listen(server: Server): Promise<void> { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); }
function origin(server: Server): string { const address = server.address(); if (!address || typeof address === "string") throw new Error("No native fixture address."); return `http://127.0.0.1:${address.port}`; }
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function eventually(check: () => boolean, timeout: number): Promise<void> { const limit = Date.now() + timeout; while (!check()) { if (Date.now() > limit) throw new Error("The native Source turn did not finish."); await new Promise(resolve => setTimeout(resolve, 25)); } }
