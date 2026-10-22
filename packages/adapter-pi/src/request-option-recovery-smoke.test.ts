import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AdapterContext, EventPayload, NativeSessionBinding, PromptInput, TargetDescriptor } from "@joko/core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createPiAdapter } from "./adapter.js";
import { PiCacheCompatibilityStore, piCacheRouteKey } from "./request-option-compatibility.js";
import { mkdtemp } from "./test-paths.js";

const rejection = { error: { type: "invalid_request_error", param: "prompt_cache_key",
  message: "Validation: Unsupported parameter(s): `prompt_cache_key`" } };

describe("real Pi optional cache parameter recovery", () => {
  it("replays the exact HTTP body once, keeps one native user turn, and applies learning after a cold reopen", { timeout: 45_000 }, async () => {
    const f = await fixture((body, response) => {
      if (Object.hasOwn(body, "prompt_cache_key") || Object.hasOwn(body, "prompt_cache_retention")) reject(response);
      else complete(response);
    });
    let checks = 0;
    let adapter = createPiAdapter(f.options);
    try {
      const context = f.context({ assertCurrent: () => { checks++; } });
      const binding = await adapter.createSession(f.creation, context);
      const attached = { ...context, binding };
      await adapter.send(prompt("Recover this exact user request."), attached);
      await f.done(1);
      expect(f.events.filter(event => event.type === "done"), JSON.stringify({ errors: f.events.filter(event => event.type === "error"),
        requestFields: f.requests.map(request => Object.keys(request.body)) })).toEqual([{ type: "done", outcome: "completed" }]);
      expect(f.requests).toHaveLength(2);
      const { prompt_cache_key, prompt_cache_retention, ...original } = f.requests[0]!.body;
      expect(prompt_cache_key).toBeTypeOf("string");
      expect(prompt_cache_retention).toBe("24h");
      expect(f.requests[1]!.body).toEqual(original);
      expect(f.requests.every(request => request.headers.authorization === "Bearer private-provider-credential")).toBe(true);
      expect(f.requests.every(request => !Object.keys(request.headers).some(name => name.startsWith("x-joko-")))).toBe(true);
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(f.events.filter(event => event.type === "message_complete" && event.role === "user")).toHaveLength(1);
      expect(nativeUsers(binding)).toHaveLength(1);
      const learned = await readFile(join(f.home, "request-option-compatibility.json"), "utf8");
      expect(learned).not.toContain(f.endpoint);
      expect(learned).not.toContain("private-provider-credential");
      expect(JSON.stringify(f.events)).not.toContain("cache-compatibility/v1/");
      expect(JSON.stringify(f.events)).not.toContain("routeKey");
      await adapter.dispose();
      adapter = createPiAdapter(f.options);
      await adapter.resumeSession(binding, attached);
      await adapter.send(prompt("A second user turn after reopening."), attached);
      await f.done(2);
      expect(f.requests).toHaveLength(3);
      expect(f.requests[2]!.body).not.toHaveProperty("prompt_cache_key");
      expect(f.requests[2]!.body).not.toHaveProperty("prompt_cache_retention");
      expect(nativeUsers(binding)).toHaveLength(2);
      expect(f.events.filter(event => event.type === "error")).toEqual([]);
    } finally { await adapter.dispose(); await f.close(); }
  });

  it("learns for an externally owned turn but leaves retry to its caller", { timeout: 45_000 }, async () => {
    const f = await fixture((body, response) => Object.hasOwn(body, "prompt_cache_key") ? reject(response) : complete(response));
    const adapter = createPiAdapter(f.options);
    try {
      const context = f.context();
      const binding = await adapter.createSession(f.creation, context);
      await adapter.send(prompt("Caller owns recovery."), { ...context, binding });
      await f.done(1);
      expect(f.requests).toHaveLength(1);
      expect(f.events.some(event => event.type === "done" && event.outcome === "failed")).toBe(true);
      expect(await new PiCacheCompatibilityStore(join(f.home, "request-option-compatibility.json")).has(f.route)).toBe(true);
      await adapter.send(prompt("Explicit later input."), { ...context, binding });
      await f.done(2);
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]!.body).not.toHaveProperty("prompt_cache_key");
    } finally { await adapter.dispose(); await f.close(); }
  });

  it.each(["unreadable-store", "unrelated-400", "second-rejection", "authority-lost"] as const)(
    "does not loop or conceal failure after %s", { timeout: 45_000 }, async scenario => {
      let current = true;
      const f = await fixture((_body, response) => {
        if (scenario === "authority-lost") current = false;
        reject(response, scenario === "unrelated-400"
          ? { error: { type: "invalid_request_error", param: "temperature", message: "Unsupported parameter: temperature; prompt_cache_key was accepted" } }
          : rejection);
      });
      const storePath = join(f.home, "request-option-compatibility.json");
      if (scenario === "unreadable-store") await writeFile(storePath, "preserve this unreadable file");
      const adapter = createPiAdapter(f.options);
      try {
        const context = f.context({ assertCurrent: () => { if (!current) throw new Error("Owner changed"); } });
        const binding = await adapter.createSession(f.creation, context);
        await adapter.send(prompt("Do not conceal the final error."), { ...context, binding });
        await f.done(1);
        expect(f.requests).toHaveLength(scenario === "second-rejection" ? 2 : 1);
        expect(f.events.filter(event => event.type === "done")).toEqual([{ type: "done", outcome: "failed" }]);
        expect(f.events.some(event => event.type === "error")).toBe(true);
        expect(nativeUsers(binding)).toHaveLength(1);
        if (scenario === "unreadable-store") expect(await readFile(storePath, "utf8")).toBe("preserve this unreadable file");
        if (scenario === "unrelated-400") expect(await new PiCacheCompatibilityStore(storePath).has(f.route)).toBe(false);
      } finally { await adapter.dispose(); await f.close(); }
    }
  );

  it("does not replay a cancelled request while its first response is pending", { timeout: 45_000 }, async () => {
    let received!: () => void;
    const first = new Promise<void>(resolve => { received = resolve; });
    let reply: ServerResponse | undefined;
    const f = await fixture((_body, response) => { reply = response; received(); });
    const adapter = createPiAdapter(f.options);
    try {
      const context = f.context({ assertCurrent: () => {} });
      const binding = await adapter.createSession(f.creation, context);
      const attached = { ...context, binding };
      await adapter.send(prompt("Cancel before the rejected response."), attached);
      await first;
      await adapter.abort(attached);
      if (reply && !reply.destroyed) reject(reply);
      await f.done(1);
      expect(f.requests).toHaveLength(1);
      expect(f.events.some(event => event.type === "done" && event.outcome === "aborted")).toBe(true);
      expect(await new PiCacheCompatibilityStore(join(f.home, "request-option-compatibility.json")).has(f.route)).toBe(false);
    } finally { await adapter.dispose(); await f.close(); }
  });

  it("learns without replay after assistant output and actual tool execution", { timeout: 45_000 }, async () => {
    let requestCount = 0, authorityChecks = 0;
    const f = await fixture((_body, response) => {
      if (++requestCount === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "read-request", object: "chat.completion.chunk", created: 1, model: "cache-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "Reading now.", tool_calls: [{ index: 0, id: "read-owned", type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "owned.txt" }) } }] }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "read-request", object: "chat.completion.chunk", created: 1, model: "cache-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      } else reject(response);
    });
    await writeFile(join(f.creation.target.workspaceRoot, "owned.txt"), "Actual local read completed.");
    const adapter = createPiAdapter(f.options);
    try {
      const context: AdapterContext = { ...f.context({ assertCurrent: () => { authorityChecks++; } }),
        requestInteraction: async () => ({ kind: "confirmed", confirmed: true }) };
      const binding = await adapter.createSession(f.creation, context);
      await adapter.send(prompt("Read owned.txt first."), { ...context, binding });
      await f.done(1);
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests[1]!.body.messages)).toContain("Actual local read completed.");
      expect(f.events.some(event => event.type === "text_delta" && event.delta === "Reading now.")).toBe(true);
      expect(f.events.some(event => event.type === "tool_start" && event.name === "read")).toBe(true);
      expect(f.events.some(event => event.type === "done" && event.outcome === "failed")).toBe(true);
      expect(authorityChecks).toBe(0);
      expect(await new PiCacheCompatibilityStore(join(f.home, "request-option-compatibility.json")).has(f.route)).toBe(true);
    } finally { await adapter.dispose(); await f.close(); }
  });
});

async function fixture(respond: (body: Record<string, unknown>, response: ServerResponse) => void) {
  const requests: Array<{ body: Record<string, unknown>; headers: IncomingMessage["headers"] }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({ body, headers: request.headers });
      respond(body, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api.openai.com/v1`;
  const home = await mkdtemp(join(tmpdir(), "joko-cache-recovery-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "joko-cache-recovery-workspace-"));
  const target: TargetDescriptor = { id: "cache-recovery-target", backendId: "pi", displayName: "Local recovery",
    workspaceRoot: workspace, managed: true, trusted: true };
  const events: EventPayload[] = [];
  let doneCount = 0;
  const waiters: Array<() => void> = [];
  const options = { agentHome: home, sessionRoot: home, includeManagedSubagentTools: () => false,
    providers: [{ id: "local", api: "openai-completions" as const, baseUrl: endpoint, apiKeyEnv: "JOKO_FIXTURE_API_KEY",
      models: [{ id: "cache-model", contextWindow: 32_768, maxTokens: 1_024, compat: { supportsLongCacheRetention: true } }] }],
    environment: { JOKO_FIXTURE_API_KEY: "private-provider-credential" },
    settings: { compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } } };
  return { home, endpoint, requests, options, events,
    route: { providerId: "local", wireModelId: "cache-model", routeKey: piCacheRouteKey(endpoint, "openai-completions")! },
    creation: { target, providerId: "local", modelId: "cache-model", permissionMode: "ask" as const, fastMode: false },
    context: (recovery?: AdapterContext["rejectedRequestRecovery"]): AdapterContext => ({
      sessionId: "cache-recovery-session", generation: 1, target, signal: new AbortController().signal,
      ...(recovery ? { rejectedRequestRecovery: recovery } : {}),
      emit: async event => {
        events.push(event);
        if (event.type === "done") { doneCount++; for (const waiter of waiters.splice(0)) waiter(); }
      },
      requestInteraction: async () => { throw new Error("Private cache control must not reach a user interaction."); },
      artifactCapacityBytes: 256 * 1024 * 1024,
      storeArtifact: async path => {
        const bytes = await readFile(path);
        return { id: "fixture-artifact", sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, mimeType: "application/octet-stream" };
      }
    }),
    done: async (count: number) => {
      if (doneCount >= count) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Pi did not settle turn ${count}`)), 15_000);
        const wake = () => {
          if (doneCount < count) { waiters.push(wake); return; }
          clearTimeout(timer); resolve();
        };
        waiters.push(wake);
      });
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  };
}

function prompt(text: string): PromptInput { return { text, images: [], files: [], mentions: [], disposition: "prompt" }; }
function reject(response: ServerResponse, body: unknown = rejection): void {
  response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(body));
}
function complete(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "cache-recovery-answer", object: "chat.completion.chunk", created: 1,
    model: "cache-model", choices: [{ index: 0, delta: { role: "assistant", content: "Recovered once." }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "cache-recovery-answer", object: "chat.completion.chunk", created: 1,
    model: "cache-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}
function nativeUsers(binding: NativeSessionBinding) {
  return SessionManager.open(binding.opaqueRef).buildSessionContext().messages.filter(message => message.role === "user");
}
