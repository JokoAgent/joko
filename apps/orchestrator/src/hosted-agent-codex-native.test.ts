import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { CodexBackendAdapter, StdioJsonRpcTransport, CODEX_MANAGED_PROVIDER_SUPPORT } from "@joko/adapter-codex";
import type { AdapterContext, EventPayload, HostedExecution, ManagedProviderRuntimePort, ProviderModel, TargetDescriptor } from "@joko/core";
import { createHostedAgentToolChannel } from "./hosted-agent-tool-channel.js";
import { ExecutorWorkspace } from "./hosted-agent-workspace.js";
import { HostedAgentCodexExecServerRelay } from "./hosted-agent-codex-relay.js";
import { createHostedAgentCodexTunnel } from "./hosted-agent-codex-tunnel.js";

const binary = process.env["JOKO_CODEX_HOSTED_TEST_BINARY"];
describe.skipIf(!binary)("Hosted actual Codex environment", () => {
  it.each(["owner", "guest"] as const)("runs a dedicated %s native thread and controlled model tool call through the Source exec-server", async trust => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joko-codex-hosted-native-"))), shadow = join(root, "model-host", "workspace"), source = join(root, "source", "project"),
      nativeHome = join(root, "model-host", "native"), privateHome = join(root, "private-native-user");
    await Promise.all([mkdir(shadow, { recursive: true }), mkdir(source, { recursive: true }), mkdir(nativeHome, { recursive: true }), mkdir(privateHome, { recursive: true })]);
    await writeFile(join(privateHome, "AGENTS.md"), "PRIVATE HOST USER INSTRUCTIONS MUST STAY PRIVATE");
    await writeFile(join(source, "AGENTS.md"), "SOURCE PROJECT INSTRUCTIONS");
    const workspace = new ExecutorWorkspace({ workingDir: source, aliases: [{ from: shadow, to: source }] }); workspace.setVirtualRoot(shadow);
    const methods: string[] = [], calls: { method: string; params: unknown }[] = [];
    const inputs: Record<string, unknown>[] = []; let modelAuthorization = "";
    const modelServer = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; inputs.push(input);
      modelAuthorization = request.headers.authorization ?? "";
      const tool = inputs.length === 1;
      const command = process.platform === "win32"
        ? `& '${process.execPath.replaceAll("'", "''")}' -e "require('node:fs').writeFileSync('executed.txt','SOURCE NATIVE OK')"`
        : `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('executed.txt','SOURCE NATIVE OK')"`;
      const item = tool
        ? { type: "function_call", id: "native-tool-item", call_id: "native-tool-call", name: "exec_command",
            arguments: JSON.stringify({ cmd: command, login: false, yield_time_ms: 1000, max_output_tokens: 1000 }), status: "completed" }
        : { type: "message", id: "native-answer", role: "assistant", status: "completed", content: [{ type: "output_text", text: "SOURCE DONE", annotations: [] }] };
      const events = [{ type: "response.created", response: { id: "native-response-" + inputs.length, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "native-response-" + inputs.length, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
    await new Promise<void>(ready => modelServer.listen(0, "127.0.0.1", ready));
    const modelAddress = modelServer.address(); if (!modelAddress || typeof modelAddress === "string") throw new Error("Missing controlled model listener.");
    const relay = new HostedAgentCodexExecServerRelay({ codexExecutable: binary!, cwd: source, workspace, sessionId: "source-session",
      assertCurrent: () => undefined, authorize: async () => () => undefined,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], TEMP: root, TMP: root } });
    const channel = await createHostedAgentToolChannel({ assertCurrent: () => undefined, execute: async (value, signal) => {
      const { origin, ...request } = value as Record<string, unknown>;
      expect(origin).toBe("agent"); const payload = request.payload as { data?: string };
      if (payload.data) methods.push(String((JSON.parse(payload.data) as { method?: string }).method));
      return relay.execute(request, signal);
    } });
    const executionHome = trust === "guest" ? root : nativeHome;
    const execution: HostedExecution = { workspace: { root: shadow, additionalRoots: [], platform: process.platform as "win32" | "darwin" | "linux", shell: "native",
      isGitRepository: false, personalInstructions: "SOURCE PERSONAL INSTRUCTIONS" }, channel,
      source: { sessionId: "source-session", targetId: "source-target", generation: 1 }, assertCurrent: () => undefined,
      ...(trust === "guest" ? { trust, guestHome: executionHome, providerId: "fixture", modelIds: ["fixture-model"] } : { trust }) };
    const env = { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], HOME: executionHome, USERPROFILE: executionHome,
      LOCALAPPDATA: executionHome, APPDATA: executionHome, CODEX_HOME: executionHome, TEMP: root, TMP: root };
    const model: ProviderModel = { providerId: "fixture", modelId: "fixture-model", displayName: "Fixture model", api: "openai-responses",
      contextWindow: 32000, maxOutputTokens: 4096, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const managedProviders: ManagedProviderRuntimePort = { support: CODEX_MANAGED_PROVIDER_SUPPORT, environment: { JOKO_FIXTURE_PROVIDER_TOKEN: "private-native-test-token" },
      secretEnvironmentNames: ["JOKO_FIXTURE_PROVIDER_TOKEN"], dispose: () => undefined, hasProvider: id => id === "fixture", listModels: () => [model],
      getThinkingLevelMap: () => ({}), listProviders: () => [{ providerId: "fixture", displayName: "Fixture", api: "openai-responses", authenticationState: "authenticated",
        loginMethods: ["api_key"], supportsLogin: false, supportsLogout: false, supportsRefresh: false, supportsModelRefresh: false }],
      prepare: async () => ({ providerId: "fixture", model, thinkingLevelMap: {}, protocol: "openai-responses", revision: "fixture-v1", baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
        apiKeyEnvironment: "JOKO_FIXTURE_PROVIDER_TOKEN", assertCurrent: () => undefined, activate: async () => ({ release: () => undefined }), dispose: () => undefined }) };
    const adapter = new CodexBackendAdapter({ instanceGeneration: 1, profileDirectory: executionHome, managedProviders,
      hostedExecution: { execution, openExecServer: createHostedAgentCodexTunnel },
      appServer: { transport: { command: binary!, env }, transportFactory: () => {
        const transport = new StdioJsonRpcTransport({ command: binary!, env, managedEnvironment: managedProviders.environment, requestTimeoutMs: 30_000 });
        const request = transport.request.bind(transport);
        transport.request = async (method, params, options) => { calls.push({ method, params }); return request(method, params, options); };
        return transport;
      } } });
    const target: TargetDescriptor = { id: "hosted-target", backendId: adapter.id, displayName: "Hosted native task", workspaceRoot: shadow, managed: true, trusted: true };
    const events: EventPayload[] = [];
    const context: AdapterContext = { sessionId: "hosted-session", generation: 1, backendInstanceGeneration: 1, target, hostedExecution: execution,
      modelSelection: { providerId: "fixture", modelId: "fixture-model" }, signal: new AbortController().signal,
      emit: async event => { events.push(event); }, requestInteraction: async () => ({ kind: "selected", value: "allow_once" }), artifactCapacityBytes: 1024,
      storeArtifact: async () => { throw new Error("No artifacts are generated by this test."); } };
    try {
      const models = await adapter.listModels(); expect(models.length).toBeGreaterThan(0);
      const binding = await adapter.createSession({ target, providerId: "fixture", modelId: "fixture-model", fastMode: false, permissionMode: "bypassPermissions" }, context);
      expect(binding.nativeSessionId).toBeTruthy();
      const registered = calls.find(call => call.method === "environment/add"); expect(registered).toBeDefined();
      const start = calls.find(call => call.method === "thread/start")!.params as Record<string, unknown>;
      expect(start.environments).toEqual([{ environmentId: expect.any(String), cwd: shadow, runtimeWorkspaceRoots: [shadow] }]);
      expect(start.developerInstructions).toContain("SOURCE PERSONAL INSTRUCTIONS");
      expect(start.developerInstructions).not.toContain("PRIVATE HOST USER");
      expect(methods).toContain("initialize"); expect(methods.some(method => method.startsWith("fs/"))).toBe(true);
      if (trust === "guest") {
        const configuration = start.config as Record<string, unknown>;
        expect(configuration).toMatchObject({ "features.hooks": false, "features.apps": false, "features.plugins": false,
          "features.js_repl": false, "features.browser_use": false, "features.computer_use": false,
          "memories.generate_memories": false, "memories.use_memories": false });
        expect(calls.some(call => call.method === "experimentalFeature/list")).toBe(true);
        await expect(adapter.setModel("another-provider", "fixture-model", { ...context, binding })).rejects.toThrow("not shared");
      }
      await expect(adapter.inspectSession(binding, { ...context, binding })).resolves.toMatchObject({ binding });
      expect(calls.some(call => call.method === "turn/start")).toBe(false);
      await adapter.send({ text: "Run the supplied file command and report SOURCE DONE.", images: [], files: [], mentions: [], disposition: "prompt" },
        { ...context, binding, operationId: "controlled-native-turn" });
      await expect.poll(() => events.filter(event => event.type === "done"), { timeout: 30_000 }).toHaveLength(1);
      expect(events.filter(event => event.type === "done")).toEqual([{ type: "done", outcome: "completed" }]);
      expect(inputs).toHaveLength(2); expect(modelAuthorization).toBe("Bearer private-native-test-token");
      expect((inputs[0]!.tools as { name?: string }[]).map(tool => tool.name)).toContain("exec_command");
      const toolResults = (inputs[1]!.input as { type?: string; output?: string }[]).filter(item => item.type === "function_call_output");
      expect(toolResults.map(item => item.output).join("\n")).toContain("Process exited with code 0");
      expect(JSON.stringify(inputs)).toContain("SOURCE PERSONAL INSTRUCTIONS"); expect(JSON.stringify(inputs)).not.toContain("PRIVATE HOST USER");
      expect(await readFile(join(source, "executed.txt"), "utf8")).toBe("SOURCE NATIVE OK");
      await expect(readFile(join(shadow, "executed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(privateHome, "AGENTS.md"), "utf8")).toContain("PRIVATE HOST USER");
    } finally {
      await adapter.dispose(); await channel.close(); await relay.close();
      modelServer.closeAllConnections(); await new Promise<void>(closed => modelServer.close(() => closed()));
      if (!relative(resolve(tmpdir()), resolve(root)).startsWith("joko-codex-hosted-native-")) throw new Error("Native test cleanup escaped its temporary root.");
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }, 90_000);
});
