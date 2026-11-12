import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OperationalStore } from "@joko/store";
import { createCodexAdapter } from "@joko/adapter-codex";
import type { AdapterContext, EventPayload, NativeSessionBinding, TargetDescriptor } from "@joko/core";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { ManagedProviderProxy } from "./managed-provider-proxy.js";
import { mkdtemp } from "./test-paths.js";

async function fixture(
  nativeResponses = false,
  protocol: "openai-responses" | "openai-completions" | "anthropic-messages" = "openai-responses",
  providerId = "provider"
) {
  const directory = await mkdtemp(join(tmpdir(), "joko-provider-proxy-"));
  const store = new OperationalStore(join(directory, "store.db"));
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(directory, "vault.key")), storagePath: join(directory, "credentials.json") });
  await credentials.initialize();
  const disabledModels = new Set<string>();
  const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "native-owner", modelEnabled: (_backendId, _providerId, modelId) => !disabledModels.has(modelId) });
  providers.initialize();
  const received: { path: string; model: string; authorization: string | undefined }[] = [];
  const receivedBodies: Record<string, unknown>[] = [];
  const forwardedProxyTokens: Array<string | undefined> = [];
  const forwardedFedrampHeaders: Array<string | undefined> = [];
  const nativeReceived: {
    path: string;
    model: string;
    authorization: string | undefined;
    accountId: string | undefined;
    fedramp: string | undefined;
  }[] = [];
  let hold = false; let reject = false; let pending: ServerResponse | undefined; let closed = false;
  let fixtureResponseBody = "data: fixture\n\n";
  let fixtureResponseContentType = "text/event-stream";
  let nativeResponseBody = "data: native fixture\n\n";
  let toolOutcome: "absent" | "present" | "denied" | undefined;
  const upstream = createServer(async (request, response) => {
    const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(bytes).toString());
    receivedBodies.push(body);
    received.push({ path: request.url!, model: body.model, authorization: request.headers.authorization });
    forwardedProxyTokens.push(request.headers["x-joko-provider-proxy-token"] as string | undefined);
    forwardedFedrampHeaders.push(request.headers["x-openai-fedramp"] as string | undefined);
    if (reject) { response.writeHead(302, { location: "https://external.invalid/", "content-type": "text/plain" }); response.end("upstream-private-detail"); return; }
    response.writeHead(200, { "content-type": fixtureResponseContentType });
    if (nativeResponses) {
      const index = received.length;
      const toolOutput = protocol === "openai-completions" && Array.isArray(body.messages)
        ? body.messages.find((item: Record<string, unknown>) => item.role === "tool" && item.tool_call_id === "check-tool-environment")?.content
        : Array.isArray(body.input) ? body.input.find((item: Record<string, unknown>) => item.type === "function_call_output"
          && item.call_id === "check-tool-environment")?.output : undefined;
      if (typeof toolOutput === "string") {
        if (toolOutput.includes("blocked by policy")) toolOutcome = "denied";
        else if (toolOutput.includes("TOKEN_PRESENT")) toolOutcome = "present";
        else if (toolOutput.includes("TOKEN_ABSENT")) toolOutcome = "absent";
      }
      const item = index === 1
        ? { id: `item-${index}`, type: "function_call", status: "completed", call_id: "check-tool-environment", name: "exec_command", arguments: JSON.stringify({
            cmd: process.platform === "win32"
              ? "if (Test-Path Env:JOKO_PROVIDER_PROXY_TOKEN) { Write-Output 'TOKEN_PRESENT' } else { Write-Output 'TOKEN_ABSENT' }"
              : "if printenv JOKO_PROVIDER_PROXY_TOKEN >/dev/null; then printf TOKEN_PRESENT; else printf TOKEN_ABSENT; fi",
            ...(process.platform === "win32" ? { shell: "powershell.exe", login: false } : {})
          }) }
        : { id: `item-${index}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Local managed response", annotations: [] }] };
      const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      if (protocol === "openai-completions") {
        const name: string | undefined = body.tools?.find((tool: { function: { name: string } }) =>
          tool.function.name === "exec_command" || tool.function.name.endsWith("__exec_command"))?.function.name;
        if (item.type === "function_call" && name === undefined) {
          response.end('data: {"error":{"message":"Missing the advertised native fixture tool."}}\n\n');
          return;
        }
        const delta = item.type === "function_call"
          ? { tool_calls: [{ index: 0, id: item.call_id, type: "function", function: { name, arguments: item.arguments } }] }
          : { content: "Local managed response" };
        emit({ id: `response-${index}`, choices: [{ index: 0, delta, finish_reason: null }] });
        emit({ id: `response-${index}`, choices: [{ index: 0, delta: {}, finish_reason: item.type === "function_call" ? "tool_calls" : "stop" }] });
        emit({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
        response.end("data: [DONE]\n\n");
        return;
      }
      emit({ type: "response.created", response: { id: `response-${index}`, status: "in_progress", output: [] } });
      emit({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      if (item.type === "message") emit({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Local managed response" });
      emit({ type: "response.output_item.done", output_index: 0, item });
      emit({ type: "response.completed", response: { id: `response-${index}`, status: "completed", model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
      response.end(); return;
    }
    response.write(fixtureResponseBody);
    if (hold) { pending = response; response.once("close", () => { closed = true; }); }
    else response.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let ownerCurrent = true; let sessionPresent = true;
  const routedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === endpoint) return await fetch(input, init);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : Buffer.from(init?.body as Uint8Array).toString("utf8"));
    nativeReceived.push({
      path: url.pathname,
      model: body.model,
      authorization: headers.get("authorization") ?? undefined,
      accountId: headers.get("chatgpt-account-id") ?? undefined,
      fedramp: headers.get("x-openai-fedramp") ?? undefined
    });
    return new Response(nativeResponseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const proxy = new ManagedProviderProxy({
    providers,
    fetch: routedFetch,
    assertOwner: () => { if (!ownerCurrent || !sessionPresent) throw new Error("Owner changed"); }
  });
  await proxy.start();
  const port = proxy.createRuntime({ backendId: "runtime", generation: 3, support: { protocols: [protocol], fields: [] }, assertCurrent: () => { if (!ownerCurrent) throw new Error("Runtime changed"); } });
  const owner = { backendId: "runtime", backendInstanceGeneration: 3, targetId: "target", sessionId: "session", sessionGeneration: 4, providerId, modelId: "model" };
  const requestPath = protocol === "anthropic-messages" ? "/custom/messages"
    : protocol === "openai-completions" ? "/custom/chat/completions" : "/custom/responses";
  const catalogModels = [
    { id: "model", input: ["text"] as const, contextWindow: 64_000, maxTokens: 4_000 },
    { id: "child-model", input: ["text"] as const, contextWindow: 128_000, maxTokens: 8_000 }
  ];
  const write = async (revision: bigint, secret: string) => {
    const reference = `credential-${revision}`;
    const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, secret);
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: reference, displayName: "Provider credential", kind: "api_key" });
    await providers.upsertConfiguration({ providerId, displayName: "Provider", kind: "custom_endpoint", enabled: true, expectedVersion: revision,
      runtimes: [{ backendId: "runtime", provider: { id: providerId, api: protocol, baseUrl: endpoint, apiKeyEnv: "PROVIDER_KEY",
        headers: { "X-Joko-Provider-Proxy-Token": { env: "PROVIDER_KEY" } },
        models: catalogModels },
        credentialBindings: { PROVIDER_KEY: reference }, credentialOrigin: endpoint, requestPath }] });
  };
  await write(0n, "first-private-provider-credential");
  const markProviderUnavailable = async () => {
    await providers.upsert({
      backendId: "runtime",
      credentialOrigin: endpoint,
      provider: {
        id: providerId,
        api: protocol,
        baseUrl: endpoint,
        apiKeyEnv: "PROVIDER_KEY",
        headers: { "X-Joko-Provider-Proxy-Token": { env: "PROVIDER_KEY" } },
        models: catalogModels
      },
      requestPath,
      displayName: "Provider",
      kind: "custom_endpoint",
      credentialBindings: { PROVIDER_KEY: "credential-0" },
      enabled: true,
      supportsLogin: false,
      supportsLogout: true,
      supportsRefresh: false,
      error: "Provider catalog is unavailable.",
      expectedVersion: 1n
    });
  };
  return { directory, store, credentials, providers, proxy, port, owner, received, receivedBodies, nativeReceived, forwardedProxyTokens, forwardedFedrampHeaders,
    disableModel: (modelId: string) => disabledModels.add(modelId),
    write, markProviderUnavailable, requestPath,
    token: port.environment[port.secretEnvironmentNames[0]!]!, toolOutcome: () => toolOutcome,
    hold: () => { hold = true; }, reject: () => { reject = true; },
    respondWith: (body: string, contentType = "text/event-stream") => {
      fixtureResponseBody = body;
      fixtureResponseContentType = contentType;
    },
    respondNativeWith: (body: string) => { nativeResponseBody = body; },
    retire: () => { ownerCurrent = false; }, closed: () => closed, sessionPresent: (present: boolean) => { sessionPresent = present; },
    finish: () => pending?.end(),
    dispose: async () => { port.dispose(); await proxy.close(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); store.close(); }
  };
}

function chatEvent(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function responsesEvents(body: string): Record<string, unknown>[] {
  return body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
}

describe("Managed Provider native proxy", () => {
  it("translates tool calls, usage, and tool history over the configured Codex Chat path", async () => {
    const f = await fixture(false, "openai-completions");
    try {
      const binding = await f.port.prepare(f.owner);
      const lease = await binding.activate({ operationId: "chat-turn", signal: new AbortController().signal, assertCurrent: () => undefined });
      const request = (body: Record<string, unknown>, suffix = "") => fetch(`${binding.baseUrl}/responses${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-joko-provider-proxy-token": f.token, "x-openai-fedramp": "true" },
        body: JSON.stringify({ model: "model", ...body })
      });
      const tools = [
        { type: "namespace", name: "notes", tools: [{ type: "function", name: "read_note", parameters: { type: "object", properties: {} } }] },
        { type: "custom", name: "render", description: "Render the supplied text." }
      ];
      const chunks = [
        { id: "chat-tool-turn", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "note-1", type: "function",
          function: { name: "notes__", arguments: "" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, function: { name: "read_note", arguments: "{}" } },
          { index: 1, id: "render-1", type: "function", function: { name: "render", arguments: '{"input":"über"}' } }
        ] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21, prompt_tokens_details: { cached_tokens: 4 } } }
      ];
      f.respondWith(chunks.map(chatEvent).join("") + "data: [DONE]\n\n");
      const response = await request({
        instructions: "General instruction", input: [{ role: "developer", content: "Keep the order." }, { role: "user", content: "Read and render." }],
        tools, stream: true, parallel_tool_calls: true, max_output_tokens: 80, store: false
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const events = responsesEvents(await response.text());
      expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
      expect(events.filter(event => event.type === "response.output_item.done").map(event => event.item)).toMatchObject([
        { type: "function_call", call_id: "note-1", name: "read_note", namespace: "notes", arguments: "{}" },
        { type: "custom_tool_call", call_id: "render-1", name: "render", input: "über" }
      ]);
      expect(events.at(-1)).toMatchObject({ type: "response.completed", response: {
        id: "chat-tool-turn", model: "model", status: "completed",
        usage: { input_tokens: 15, output_tokens: 6, total_tokens: 21, input_tokens_details: { cached_tokens: 4 } }
      } });
      expect(f.receivedBodies[0]).toMatchObject({
        model: "model", messages: [
          { role: "system", content: "General instruction\n\nKeep the order." },
          { role: "user", content: "Read and render." }
        ],
        tools: [{ function: { name: "notes__read_note" } }, { function: { name: "render" } }],
        parallel_tool_calls: true, max_tokens: 80, stream_options: { include_usage: true }
      });
      expect(f.receivedBodies[0]).not.toHaveProperty("store");

      f.respondWith(JSON.stringify({ id: "chat-followup", model: "upstream-alias", choices: [
        { index: 0, message: { role: "assistant", content: "Rendered." }, finish_reason: "stop" }
      ] }), "application/json");
      const followUp = await request({ stream: false, tools, input: [
        { role: "user", content: "Read and render." },
        { type: "function_call", call_id: "note-1", namespace: "notes", name: "read_note", arguments: "{}" },
        { type: "custom_tool_call", call_id: "render-1", name: "render", input: "über" },
        { type: "function_call_output", call_id: "note-1", output: "Original note" },
        { type: "custom_tool_call_output", call_id: "render-1", output: "Original rendering" }
      ] });
      expect(followUp.headers.get("content-type")).toBe("application/json");
      expect(await followUp.json()).toMatchObject({ id: "chat-followup", model: "model", status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Rendered." }] }] });
      expect(f.receivedBodies[1]).toMatchObject({
        stream: false, messages: [
          { role: "user", content: "Read and render." },
          { role: "assistant", tool_calls: [
            { id: "note-1", function: { name: "notes__read_note", arguments: "{}" } },
            { id: "render-1", function: { name: "render", arguments: '{"input":"über"}' } }
          ] },
          { role: "tool", tool_call_id: "note-1", content: "Original note" },
          { role: "tool", tool_call_id: "render-1", content: "Original rendering" }
        ]
      });
      expect((await request({ input: "fixture", previous_response_id: "chat-tool-turn" })).status).toBe(400);
      expect((await request({ input: "fixture" }, "/compact")).status).toBe(404);
      expect(f.received).toEqual(Array.from({ length: 2 }, () => ({
        path: f.requestPath, model: "model", authorization: "Bearer first-private-provider-credential"
      })));
      expect(f.forwardedProxyTokens).toEqual([undefined, undefined]);
      expect(f.forwardedFedrampHeaders).toEqual([undefined, undefined]);
      lease.release(); binding.dispose();
    } finally { await f.dispose(); }
  });

  it.each([
    { name: "read_note", finish: undefined, toolChoice: "auto" },
    { name: "read_note", finish: "tool_calls", toolChoice: "none" },
    { name: "retired_tool", finish: "tool_calls", toolChoice: "auto" }
  ])("never completes an unfinished or unauthorized Chat tool call ($name, $finish, $toolChoice)", async ({ name, finish, toolChoice }) => {
    const f = await fixture(false, "openai-completions");
    try {
      const binding = await f.port.prepare(f.owner);
      const lease = await binding.activate({ operationId: "chat-turn", signal: new AbortController().signal, assertCurrent: () => undefined });
      f.respondWith(chatEvent({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "pending", type: "function", function: { name, arguments: "{}" } }
      ] }, finish_reason: null }] }) + (finish === undefined ? "" : chatEvent({ choices: [{ delta: {}, finish_reason: finish }] }) + "data: [DONE]\n\n"));
      const response = await fetch(`${binding.baseUrl}/responses`, { method: "POST", headers: {
        "content-type": "application/json", "x-joko-provider-proxy-token": f.token
      }, body: JSON.stringify({ model: "model", stream: true, tool_choice: toolChoice, tools: [
        { type: "function", name: "read_note" }
      ], input: [
        { type: "custom_tool_call", call_id: "old", name: "retired_tool", input: "previous input" },
        { type: "custom_tool_call_output", call_id: "old", output: "previous output" },
        { role: "user", content: "Continue." }
      ] }) });
      const events = responsesEvents(await response.text());
      expect(events.some(event => event.type === "response.output_item.done")).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "response.failed", response: { status: "failed", output: [] } });
      expect(f.receivedBodies[0]?.tools).toMatchObject([{ function: { name: "read_note" } }]);
      lease.release(); binding.dispose();
    } finally { await f.dispose(); }
  });

  it.each(["child-model", "model"])("retains the active smart response after %s is disabled and fences only new route admission", async modelId => {
    const f = await fixture();
    try {
      const child = f.port.listSmartRoutingCandidates!().find(candidate => candidate.model.modelId === "child-model")!;
      const binding = await f.port.prepareSmartRouting!({ ...f.owner, nativeProviderId: "openai", rootProviderId: "provider", rootModelId: "model", revision: "catalog",
        routes: [{ providerId: child.providerId, modelId: child.model.modelId, revision: child.revision, native: false }] });
      binding.bindRoot({ threadId: "root", providerId: "provider", modelId: "model" });
      const lease = await binding.activate({ operationId: "accepted", signal: new AbortController().signal, assertCurrent: () => undefined });
      f.hold();
      const request = (threadId: string, requestedModel: string, parentThreadId?: string, subagent = "collab_spawn") => fetch(`${binding.baseUrl}/responses`, { method: "POST", headers: {
        "content-type": "application/json", "x-joko-provider-proxy-token": f.token, "thread-id": threadId,
        ...(parentThreadId ? { "x-codex-parent-thread-id": parentThreadId, "x-openai-subagent": subagent } : {})
      }, body: JSON.stringify({ model: requestedModel }) });
      const response = await request("root", "model"), reading = response.text();
      f.disableModel(modelId); f.finish();
      expect(await reading).toBe("data: fixture\n\n");
      if (modelId === "child-model") {
        expect(() => binding.assertCurrent()).not.toThrow();
        expect((await request("new-child", "child-model", "root")).status).toBe(502);
      } else {
        expect(() => binding.assertCurrent()).toThrow("unavailable");
        const guardian = await request("existing-turn-guardian", "model", "root", "guardian"); f.finish();
        expect(await guardian.text()).toBe("data: fixture\n\n");
        expect((await request("new-root-child", "model", "root")).status).toBe(502);
      }
      lease.release(); binding.dispose();
    } finally { await f.dispose(); }
  });

  it.each(["openai-responses", "openai-completions"] as const)("rejects a %s smart stream when its original credential is revoked", async protocol => {
    const f = await fixture(false, protocol);
    try {
      const child = f.port.listSmartRoutingCandidates!()[0]!;
      const binding = await f.port.prepareSmartRouting!({ ...f.owner, nativeProviderId: "openai", rootProviderId: "provider", rootModelId: "model", revision: "catalog",
        routes: [{ providerId: child.providerId, modelId: child.model.modelId, revision: child.revision, native: false }] });
      binding.bindRoot({ threadId: "root", providerId: "provider", modelId: "model" });
      const lease = await binding.activate({ operationId: "accepted", signal: new AbortController().signal, assertCurrent: () => undefined });
      f.hold();
      if (protocol === "openai-completions") {
        f.respondWith(chatEvent({ choices: [{ index: 0, delta: { content: "First fragment" }, finish_reason: null }] }));
      }
      const response = await fetch(`${binding.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json", "x-joko-provider-proxy-token": f.token, "thread-id": "root" }, body: JSON.stringify({ model: "model", input: "fixture" }) });
      const reading = response.text().catch(() => "revoked");
      await f.credentials.delete("credential-0"); f.finish();
      expect(await reading).toBe("revoked"); lease.release(); binding.dispose();
    } finally { await f.dispose(); }
  });

  it("translates a selected Chat descendant only while its exact parent, operation, and model are authorized", async () => {
    const f = await fixture(false, "openai-completions");
    try {
      const child = f.port.listSmartRoutingCandidates!().find(candidate => candidate.model.modelId === "child-model")!;
      expect(child.protocol).toBe("openai-completions");
      const binding = await f.port.prepareSmartRouting!({ ...f.owner, nativeProviderId: "openai", rootProviderId: "provider", rootModelId: "model", revision: "catalog",
        routes: [{ providerId: child.providerId, modelId: child.model.modelId, revision: child.revision, native: false }] });
      binding.bindRoot({ threadId: "root", providerId: "provider", modelId: "model" });
      const lease = await binding.activate({ operationId: "chat-smart-turn", signal: new AbortController().signal, assertCurrent: () => undefined });
      f.respondWith(chatEvent({ choices: [{ index: 0, delta: { content: "Child response" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
      const request = (parentThreadId: string, model: string) => fetch(`${binding.baseUrl}/responses`, { method: "POST", headers: {
        "content-type": "application/json", "x-joko-provider-proxy-token": f.token,
        "thread-id": "child", "x-codex-parent-thread-id": parentThreadId, "x-openai-subagent": "collab_spawn",
        authorization: "Bearer native-fixture-credential", "x-openai-fedramp": "true"
      }, body: JSON.stringify({ model, input: "child prompt" }) });
      expect((await request("unknown-parent", "child-model")).status).toBe(502);
      const events = responsesEvents(await (await request("root", "child-model")).text());
      expect(events.at(-1)).toMatchObject({ type: "response.completed", response: {
        model: "child-model", output: [{ type: "message", content: [{ type: "output_text", text: "Child response" }] }]
      } });
      expect((await request("root", "model")).status).toBe(502);
      lease.release();
      expect((await request("root", "child-model")).status).toBe(409);
      expect(f.received).toEqual([{ path: f.requestPath, model: "child-model", authorization: "Bearer first-private-provider-credential" }]);
      expect(f.receivedBodies[0]).toMatchObject({ messages: [{ role: "user", content: "child prompt" }] });
      expect(f.forwardedProxyTokens).toEqual([undefined]);
      expect(f.forwardedFedrampHeaders).toEqual([undefined]);
      binding.dispose();
    } finally { await f.dispose(); }
  });
  it("advertises smart candidates only while their Provider is currently available", async () => {
    const f = await fixture();
    try {
      expect(f.port.listSmartRoutingCandidates!().map((candidate) => candidate.model.modelId)).toEqual(["model", "child-model"]);
      await f.markProviderUnavailable();
      expect(f.providers.describeInferenceRoute("runtime", "provider", "child-model")).toBeDefined();
      expect(f.port.listSmartRoutingCandidates!()).toEqual([]);
    } finally { await f.dispose(); }
  });

  it("repairs required Responses arrays on the ordinary managed stream without changing other protocols", async () => {
    const messageAdded = JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "message-one",
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: null
      }
    });
    const delta = JSON.stringify({
      type: "response.output_text.delta",
      item_id: "message-one",
      output_index: 0,
      content_index: 0,
      delta: "usable continuation"
    });
    const stream = `data: ${messageAdded}\r\n\r\ndata: ${delta}\n\ndata: [DONE]\n\n`;
    const f = await fixture();
    try {
      f.respondWith(stream);
      const binding = await f.port.prepare(f.owner);
      const lease = await binding.activate({
        operationId: "repair-ordinary",
        signal: new AbortController().signal,
        assertCurrent: () => undefined
      });
      try {
        const response = await fetch(`${binding.baseUrl}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "model", input: "fixture" })
        });
        const output = await response.text();
        const events = output.split(/\r?\n\r?\n/u).filter(Boolean);
        expect((JSON.parse(events[0]!.split("data: ")[1]!) as {
          item: { content: unknown };
        }).item.content).toEqual([]);
        expect(events[1]).toBe(`data: ${delta}`);
        expect(events[2]).toBe("data: [DONE]");

        const validStream = stream.replace('"content":null', '"content":[]');
        f.respondWith(validStream);
        const validResponse = await fetch(`${binding.baseUrl}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "model", input: "fixture" })
        });
        expect(await validResponse.text()).toBe(validStream);
      } finally {
        lease.release();
        binding.dispose();
      }
    } finally {
      await f.dispose();
    }

    const anthropic = await fixture(false, "anthropic-messages");
    try {
      anthropic.respondWith(stream);
      const binding = await anthropic.port.prepare(anthropic.owner);
      const lease = await binding.activate({
        operationId: "repair-protocol-gate",
        signal: new AbortController().signal,
        assertCurrent: () => undefined
      });
      try {
        const response = await fetch(`${binding.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${anthropic.token}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "model", max_tokens: 100, messages: [] })
        });
        expect(await response.text()).toBe(stream);
      } finally {
        lease.release();
        binding.dispose();
      }
    } finally {
      await anthropic.dispose();
    }
  });

  it("repairs smart managed Responses while leaving the native route byte-identical", async () => {
    const f = await fixture();
    const reasoningAdded = JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "reasoning-one", type: "reasoning", status: "in_progress", summary: null }
    });
    const stream = `data: ${reasoningAdded}\n\ndata: [DONE]\n\n`;
    try {
      f.respondWith(stream);
      f.respondNativeWith(stream);
      const child = f.port.listSmartRoutingCandidates!().find((candidate) => candidate.model.modelId === "child-model")!;
      const binding = await f.port.prepareSmartRouting!({
        backendId: "runtime",
        backendInstanceGeneration: 3,
        targetId: "target",
        sessionId: "session",
        sessionGeneration: 4,
        nativeProviderId: "openai",
        rootProviderId: "provider",
        rootModelId: "model",
        routes: [
          { providerId: child.providerId, modelId: child.model.modelId, revision: child.revision, native: false },
          { providerId: "openai", modelId: "native-worker", revision: "native-catalog-a", native: true }
        ],
        revision: "catalog-a"
      });
      binding.bindRoot({ threadId: "root-thread", providerId: "provider", modelId: "model" });
      const lease = await binding.activate({
        operationId: "repair-smart",
        signal: new AbortController().signal,
        assertCurrent: () => undefined
      });
      const request = (input: {
        readonly threadId: string;
        readonly modelId: string;
        readonly parentThreadId?: string;
        readonly native?: boolean;
      }) => fetch(`${binding.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-joko-provider-proxy-token": f.token,
          "thread-id": input.threadId,
          ...(input.parentThreadId === undefined ? {} : {
            "x-codex-parent-thread-id": input.parentThreadId,
            "x-openai-subagent": "collab_spawn"
          }),
          ...(input.native === true ? { authorization: "Bearer native-private-credential" } : {})
        },
        body: JSON.stringify({ model: input.modelId, input: "fixture" })
      });
      try {
        const managed = await (await request({ threadId: "root-thread", modelId: "model" })).text();
        expect((JSON.parse(managed.split("\n\n")[0]!.slice("data: ".length)) as {
          item: { summary: unknown };
        }).item.summary).toEqual([]);

        const managedChild = await (await request({
          threadId: "managed-child",
          parentThreadId: "root-thread",
          modelId: "child-model"
        })).text();
        expect((JSON.parse(managedChild.split("\n\n")[0]!.slice("data: ".length)) as {
          item: { summary: unknown };
        }).item.summary).toEqual([]);

        const native = await (await request({
          threadId: "native-child",
          parentThreadId: "root-thread",
          modelId: "native-worker",
          native: true
        })).text();
        expect(native).toBe(stream);
      } finally {
        lease.release();
        binding.dispose();
      }
    } finally {
      await f.dispose();
    }
  });

  const nativeFixtureCommand = process.env.JOKO_CODEX_MANAGED_FIXTURE_COMMAND ?? process.env.JOKO_CODEX_HOSTED_TEST_BINARY;
  it.skipIf(nativeFixtureCommand === undefined).each(["openai-responses", "openai-completions"] as const)(
    "runs the installed native app-server over %s on the original thread with an isolated profile", async protocol => {
    const providerId = protocol === "openai-completions" ? "ollama" : "provider";
    const f = await fixture(true, protocol, providerId);
    const profile = join(f.directory, "profile"); const workspaceRoot = join(f.directory, "workspace");
    await mkdir(profile); await mkdir(workspaceRoot);
    const adapter = createCodexAdapter({ id: "runtime", instanceGeneration: 3, managedProviders: f.port,
      appServer: { transport: { command: nativeFixtureCommand!, args: ["app-server", "--listen", "stdio://"], cwd: workspaceRoot,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: f.directory, TMP: f.directory, USERPROFILE: profile, HOME: profile, CODEX_HOME: profile, OTEL_SDK_DISABLED: "true" } } } });
    const target: TargetDescriptor = { id: "target", backendId: "runtime", displayName: "Isolated target", workspaceRoot, managed: true, trusted: true };
    const events: EventPayload[] = [];
    let binding: NativeSessionBinding | undefined;
    const context = (operationId: string): AdapterContext => ({ sessionId: "session", generation: 4, backendInstanceGeneration: 3, target,
      ...(binding === undefined ? {} : { binding }), modelSelection: { providerId, modelId: "model" }, operationId, signal: new AbortController().signal,
      emit: async (event) => { events.push(event); }, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1_024,
      storeArtifact: async () => { throw new Error("No artifacts in this fixture."); } });
    try {
      binding = await adapter.createSession({ target, providerId, modelId: "model", permissionMode: "auto", fastMode: false }, context("create"));
      const originalId = binding.nativeSessionId;
      const run = async (id: string) => {
        const initial = events.filter((event) => event.type === "done").length;
        await adapter.send({ disposition: "prompt", text: "Return the local response.", images: [], files: [], mentions: [] }, context(id));
        await vi.waitFor(() => expect(events.filter((event) => event.type === "done")).toHaveLength(initial + 1), { timeout: 20_000 });
        expect(events.at(-1)).toEqual({ type: "done", outcome: "completed" });
      };
      await run("one");
      await f.write(1n, "second-private-provider-credential");
      await run("two");
      expect(await adapter.inspectSession(binding, context("inspect"))).toMatchObject({ binding: { nativeSessionId: originalId }, providerId });
      expect(f.received).toEqual([
        { path: f.requestPath, model: "model", authorization: "Bearer first-private-provider-credential" },
        { path: f.requestPath, model: "model", authorization: "Bearer first-private-provider-credential" },
        { path: f.requestPath, model: "model", authorization: "Bearer second-private-provider-credential" }
      ]);
      // Native policy may deny the controlled environment probe. A denial is
      // recorded separately and does not prove that a tool process was launched.
      expect(["absent", "denied"]).toContain(f.toolOutcome());
      if (protocol === "openai-completions") {
        await expect(adapter.compact(undefined, context("compact"))).resolves.toBe("compacted");
        expect(f.received.at(-1)).toEqual({ path: f.requestPath, model: "model", authorization: "Bearer second-private-provider-credential" });
        expect(f.received).toHaveLength(4);
        await vi.waitFor(async () => expect((await adapter.inspectSession(binding!, context("compact-inspect"))).streaming).toBe(false), { timeout: 5_000 });
      }
      const completed = events.filter((event) => event.type === "done").length;
      const requests = f.received.length;
      f.reject();
      await adapter.send({ disposition: "prompt", text: "Return the local failure.", images: [], files: [], mentions: [] }, context("three"));
      await vi.waitFor(() => expect(events.filter((event) => event.type === "done")).toHaveLength(completed + 1), { timeout: 20_000 });
      expect(events.at(-1)).toEqual({ type: "done", outcome: "failed" });
      expect(f.received).toHaveLength(requests + 1);
      const nativeFiles = await readdir(profile, { recursive: true });
      for (const path of nativeFiles.filter((path) => path.endsWith(".jsonl") || path.endsWith(".toml"))) {
        expect(await readFile(join(profile, path), "utf8")).not.toContain(f.token);
      }
      expect(JSON.stringify(events)).not.toContain(f.token);
    } finally { await adapter.dispose(); await f.dispose(); }
  }, 60_000);

  it("requires both exact operation authority and authentication, pins the active route and never follows redirects", async () => {
    const f = await fixture();
    try {
      f.sessionPresent(false);
      const binding = await f.port.prepare(f.owner);
      expect(() => binding.assertCurrent()).not.toThrow();
      const request = (token = f.token, model = "model") => fetch(`${binding.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model, input: "fixture" }) });
      expect((await request()).status).toBe(409);
      await expect(binding.activate({ operationId: "not-yet-persisted", signal: new AbortController().signal, assertCurrent: () => undefined })).rejects.toThrow("Owner changed");
      f.sessionPresent(true);
      const lease = await binding.activate({ operationId: "operation-one", signal: new AbortController().signal, assertCurrent: () => undefined });
      expect((await request("wrong-token")).status).toBe(403);
      expect((await request(f.token, "other-model")).status).toBe(400);
      expect(f.received).toHaveLength(0);
      expect(await (await request()).text()).toBe("data: fixture\n\n");
      await f.write(1n, "second-private-provider-credential");
      expect(await (await request()).text()).toBe("data: fixture\n\n");
      expect(f.received).toEqual([
        { path: "/custom/responses", model: "model", authorization: "Bearer first-private-provider-credential" },
        { path: "/custom/responses", model: "model", authorization: "Bearer first-private-provider-credential" }
      ]);
      lease.release();
      expect((await request()).status).toBe(409);
      await expect(binding.activate({ operationId: "operation-two", signal: new AbortController().signal, assertCurrent: () => undefined })).rejects.toThrow("unavailable");
      binding.dispose();
      const next = await f.port.prepare(f.owner);
      const nextLease = await next.activate({ operationId: "operation-two", signal: new AbortController().signal, assertCurrent: () => undefined });
      f.reject();
      const failure = await fetch(`${next.baseUrl}/responses`, { method: "POST", headers: { "x-api-key": f.token }, body: JSON.stringify({ model: "model" }) });
      expect(failure.status).toBe(502);
      expect(await failure.text()).not.toContain("upstream-private-detail");
      expect(f.received.at(-1)?.authorization).toBe("Bearer second-private-provider-credential");
      nextLease.release(); next.dispose();
      const stored = JSON.stringify(f.store.findSetting("service", "orchestrator", "provider_catalog")?.value);
      expect(stored).toContain('"runtimes"');
      expect(stored).not.toContain(f.token);
      expect(stored).not.toContain("private-provider-credential");
    } finally { await f.dispose(); }
  });

  it("routes only an explicitly leased delegated model and revokes it independently", async () => {
    const f = await fixture();
    try {
      const binding = await f.port.prepare(f.owner);
      const parent = new AbortController();
      const parentLease = await binding.activate({
        operationId: "operation-with-subtask",
        signal: parent.signal,
        assertCurrent: () => undefined
      });
      const request = (model: string) => fetch(`${binding.baseUrl}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: "fixture" })
      });
      expect((await request("child-model")).status).toBe(400);
      const delegated = await binding.authorizeSubtask!({
        operationId: "operation-with-subtask",
        requestId: "agent-tool-one",
        modelId: "child-model",
        signal: parent.signal,
        assertCurrent: () => undefined
      });
      expect(await (await request("child-model")).text()).toBe("data: fixture\n\n");
      expect(f.received.at(-1)).toEqual({
        path: "/custom/responses",
        model: "child-model",
        authorization: "Bearer first-private-provider-credential"
      });
      delegated.release();
      expect((await request("child-model")).status).toBe(400);
      expect(await (await request("model")).text()).toBe("data: fixture\n\n");

      await expect(binding.authorizeSubtask!({
        operationId: "another-operation",
        requestId: "agent-tool-two",
        modelId: "child-model",
        signal: parent.signal,
        assertCurrent: () => undefined
      })).rejects.toThrow("unavailable");

      const inFlight = await binding.authorizeSubtask!({
        operationId: "operation-with-subtask",
        requestId: "agent-tool-three",
        modelId: "child-model",
        signal: parent.signal,
        assertCurrent: () => undefined
      });
      f.hold();
      const childResponse = await request("child-model");
      const childReading = childResponse.text().catch(() => "aborted");
      await vi.waitFor(() => expect(f.received.at(-1)?.model).toBe("child-model"));
      inFlight.release();
      expect(await childReading).toBe("aborted");
      await vi.waitFor(() => expect(f.closed()).toBe(true));
      parentLease.release();
      expect((await request("model")).status).toBe(409);
      binding.dispose();
    } finally { await f.dispose(); }
  });

  it("bounds Anthropic Messages max_tokens by each exact active parent or delegated route", async () => {
    const f = await fixture(false, "anthropic-messages");
    try {
      const binding = await f.port.prepare(f.owner);
      const parent = new AbortController();
      const parentLease = await binding.activate({
        operationId: "anthropic-limits",
        signal: parent.signal,
        assertCurrent: () => undefined
      });
      const request = (path: "/v1/messages" | "/v1/messages/count_tokens", model: string) => fetch(
        `${binding.baseUrl}${path}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 99_999, messages: [], vendor_field: { retain: true } })
        }
      );

      expect((await request("/v1/messages", "child-model")).status).toBe(400);
      expect(await (await request("/v1/messages", "model")).text()).toBe("data: fixture\n\n");
      expect(f.received.at(-1)?.path).toBe("/custom/messages");
      expect(f.receivedBodies.at(-1)).toMatchObject({
        model: "model",
        max_tokens: 4_000,
        vendor_field: { retain: true }
      });
      const smaller = await fetch(`${binding.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "model", max_tokens: 1_000, messages: [] })
      });
      expect(await smaller.text()).toBe("data: fixture\n\n");
      expect(f.receivedBodies.at(-1)).toMatchObject({ model: "model", max_tokens: 1_000 });
      const receivedBeforeInvalid = f.receivedBodies.length;
      const invalid = await fetch(`${binding.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "model", max_tokens: 0, messages: [] })
      });
      expect(invalid.status).toBe(400);
      expect(f.receivedBodies).toHaveLength(receivedBeforeInvalid);

      const child = await binding.authorizeSubtask!({
        operationId: "anthropic-limits",
        requestId: "large-child",
        modelId: "child-model",
        signal: parent.signal,
        assertCurrent: () => undefined
      });
      expect(await (await request("/v1/messages", "child-model")).text()).toBe("data: fixture\n\n");
      expect(f.received.at(-1)?.path).toBe("/custom/messages");
      expect(f.receivedBodies.at(-1)).toMatchObject({ model: "child-model", max_tokens: 8_000 });

      expect(await (await request("/v1/messages/count_tokens", "child-model")).text()).toBe("data: fixture\n\n");
      expect(f.received.at(-1)?.path).toBe("/custom/messages/count_tokens");
      expect(f.receivedBodies.at(-1)).toMatchObject({ model: "child-model", max_tokens: 99_999 });
      child.release();
      parentLease.release();
      binding.dispose();
    } finally { await f.dispose(); }
  });

  it("authorizes smart descendants by exact lineage and model while separating native and managed credentials", async () => {
    const f = await fixture();
    try {
      const child = f.port.listSmartRoutingCandidates!().find((candidate) => candidate.model.modelId === "child-model")!;
      const binding = await f.port.prepareSmartRouting!({
        backendId: "runtime",
        backendInstanceGeneration: 3,
        targetId: "target",
        sessionId: "session",
        sessionGeneration: 4,
        nativeProviderId: "openai",
        rootProviderId: "provider",
        rootModelId: "model",
        routes: [
          { providerId: child.providerId, modelId: child.model.modelId, revision: child.revision, native: false },
          { providerId: "openai", modelId: "native-worker", revision: "native-catalog-a", native: true }
        ],
        revision: "catalog-a"
      });
      binding.bindRoot({ threadId: "root-thread", providerId: "provider", modelId: "model" });
      const lease = await binding.activate({
        operationId: "smart-operation",
        signal: new AbortController().signal,
        assertCurrent: () => undefined
      });
      const request = (input: {
        readonly threadId: string;
        readonly modelId: string;
        readonly parentThreadId?: string;
        readonly subagent?: string;
        readonly token?: string;
        readonly authorization?: string;
        readonly accountId?: string;
        readonly fedramp?: string;
      }) => fetch(`${binding.baseUrl}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-joko-provider-proxy-token": input.token ?? f.token,
          "thread-id": input.threadId,
          ...(input.parentThreadId === undefined ? {} : { "x-codex-parent-thread-id": input.parentThreadId }),
          ...(input.subagent === undefined ? {} : { "x-openai-subagent": input.subagent }),
          ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
          ...(input.accountId === undefined ? {} : { "chatgpt-account-id": input.accountId }),
          ...(input.fedramp === undefined ? {} : { "x-openai-fedramp": input.fedramp })
        },
        body: JSON.stringify({ model: input.modelId, input: "fixture" })
      });

      expect((await request({ threadId: "root-thread", modelId: "model", token: "wrong" })).status).toBe(403);
      expect((await request({
        threadId: "root-thread",
        parentThreadId: "forged-parent",
        modelId: "model"
      })).status).toBe(502);
      expect(await (await request({
        threadId: "root-thread",
        modelId: "model",
        authorization: "Bearer must-not-reach-managed",
        fedramp: "true"
      })).text()).toBe("data: fixture\n\n");
      expect(await (await request({
        threadId: "inherited-root-child",
        parentThreadId: "root-thread",
        subagent: "collab_spawn",
        modelId: "model",
        authorization: "Bearer must-not-reach-managed"
      })).text()).toBe("data: fixture\n\n");
      expect(await (await request({
        threadId: "child-thread",
        parentThreadId: "root-thread",
        subagent: "collab_spawn",
        modelId: "child-model",
        authorization: "Bearer must-not-reach-managed"
      })).text()).toBe("data: fixture\n\n");
      expect(f.received.slice(-2)).toEqual([
        { path: "/custom/responses", model: "model", authorization: "Bearer first-private-provider-credential" },
        { path: "/custom/responses", model: "child-model", authorization: "Bearer first-private-provider-credential" }
      ]);
      expect(f.forwardedProxyTokens).toEqual([undefined, undefined, undefined]);
      expect(f.forwardedFedrampHeaders).toEqual([undefined, undefined, undefined]);
      expect((await request({
        threadId: "child-thread",
        parentThreadId: "root-thread",
        subagent: "collab_spawn",
        modelId: "native-worker",
        authorization: "Bearer native-private-credential"
      })).status).toBe(502);

      expect(await (await request({
        threadId: "guardian-child",
        parentThreadId: "child-thread",
        subagent: "guardian",
        modelId: "model"
      })).text()).toBe("data: fixture\n\n");
      expect((await request({
        threadId: "guardian-child",
        parentThreadId: "child-thread",
        subagent: "guardian",
        modelId: "child-model"
      })).status).toBe(502);
      expect(f.forwardedProxyTokens.every((token) => token === undefined)).toBe(true);

      expect(await (await request({
        threadId: "native-child",
        parentThreadId: "child-thread",
        subagent: "collab_spawn",
        modelId: "native-worker",
        authorization: "Bearer native-private-credential",
        accountId: "account-one",
        fedramp: "true"
      })).text()).toBe("data: native fixture\n\n");
      expect(f.nativeReceived).toEqual([{
        path: "/backend-api/codex/responses",
        model: "native-worker",
        authorization: "Bearer native-private-credential",
        accountId: "account-one",
        fedramp: "true"
      }]);

      expect((await request({
        threadId: "invalid-fedramp-child",
        parentThreadId: "child-thread",
        subagent: "collab_spawn",
        modelId: "native-worker",
        authorization: "Bearer native-private-credential",
        accountId: "account-one",
        fedramp: "false"
      })).status).toBe(502);

      expect(await (await request({
        threadId: "nested-child",
        parentThreadId: "child-thread",
        subagent: "collab_spawn",
        modelId: "child-model"
      })).text()).toBe("data: fixture\n\n");
      binding.completeDescendant("child-thread");
      expect(await (await request({
        threadId: "nested-child",
        parentThreadId: "child-thread",
        subagent: "collab_spawn",
        modelId: "child-model"
      })).text()).toBe("data: fixture\n\n");
      expect((await request({
        threadId: "late-nested-child",
        parentThreadId: "child-thread",
        subagent: "collab_spawn",
        modelId: "child-model"
      })).status).toBe(502);

      expect((await request({
        threadId: "unknown-child",
        parentThreadId: "unknown-parent",
        subagent: "collab_spawn",
        modelId: "child-model"
      })).status).toBe(502);
      expect((await request({ threadId: "child-thread", modelId: "child-model" })).status).toBe(502);
      expect((await request({
        threadId: "guardian-child",
        parentThreadId: "root-thread",
        subagent: "guardian",
        modelId: "child-model"
      })).status).toBe(502);
      expect((await request({
        threadId: "child-thread",
        parentThreadId: "root-thread",
        subagent: "collab_spawn",
        modelId: "child-model"
      })).status).toBe(502);
      binding.registerDescendant("unfinished-child", "root-thread");

      lease.release();
      expect((await request({ threadId: "root-thread", modelId: "model" })).status).toBe(409);
      const nextLease = await binding.activate({
        operationId: "next-smart-operation",
        signal: new AbortController().signal,
        assertCurrent: () => undefined
      });
      expect((await request({
        threadId: "child-thread",
        parentThreadId: "root-thread",
        subagent: "collab_spawn",
        modelId: "child-model"
      })).status).toBe(502);
      expect((await request({
        threadId: "nested-child",
        parentThreadId: "child-thread",
        subagent: "collab_spawn",
        modelId: "child-model"
      })).status).toBe(502);
      expect((await request({
        threadId: "unfinished-child",
        parentThreadId: "root-thread",
        subagent: "collab_spawn",
        modelId: "child-model"
      })).status).toBe(502);
      expect(await (await request({ threadId: "root-thread", modelId: "model" })).text()).toBe("data: fixture\n\n");

      await f.write(1n, "second-private-provider-credential");
      expect(() => binding.assertCurrent()).toThrow("unavailable");
      expect(await (await request({ threadId: "root-thread", modelId: "model" })).text()).toBe("data: fixture\n\n");
      expect(f.received.at(-1)?.authorization).toBe("Bearer first-private-provider-credential");
      nextLease.release();
      expect((await request({ threadId: "root-thread", modelId: "model" })).status).toBe(409);
      binding.dispose();
      const durableSettings = JSON.stringify(f.store.listSettings().map((setting) => setting.value));
      expect(durableSettings).not.toContain(f.token);
      expect(durableSettings).not.toContain("native-private-credential");
    } finally { await f.dispose(); }
  });

  it.each(["operation", "owner"] as const)("cancels in-flight native HTTP when the %s authority retires", async (boundary) => {
    const f = await fixture();
    try {
      f.hold();
      const binding = await f.port.prepare(f.owner);
      const operation = new AbortController();
      await binding.activate({ operationId: "active-operation", signal: operation.signal, assertCurrent: () => undefined });
      const response = await fetch(`${binding.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${f.token}` }, body: JSON.stringify({ model: "model" }) });
      const reading = response.text().catch(() => "aborted");
      await vi.waitFor(() => expect(f.received).toHaveLength(1));
      if (boundary === "operation") operation.abort();
      else { f.retire(); f.finish(); }
      expect(await reading).toBe("aborted");
      await vi.waitFor(() => expect(f.closed()).toBe(true));
      const next = binding.activate({ operationId: "next-operation", signal: new AbortController().signal, assertCurrent: () => undefined });
      if (boundary === "owner") await expect(next).rejects.toThrow();
      else (await next).release();
    } finally { await f.dispose(); }
  });
});
