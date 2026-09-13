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

async function fixture(nativeResponses = false) {
  const directory = await mkdtemp(join(tmpdir(), "joko-provider-proxy-"));
  const store = new OperationalStore(join(directory, "store.db"));
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(directory, "vault.key")), storagePath: join(directory, "credentials.json") });
  await credentials.initialize();
  const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "native-owner" });
  providers.initialize();
  const received: { path: string; model: string; authorization: string | undefined }[] = [];
  let hold = false; let reject = false; let pending: ServerResponse | undefined; let closed = false;
  let toolOutcome: "absent" | "present" | "denied" | undefined;
  const upstream = createServer(async (request, response) => {
    const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(bytes).toString());
    received.push({ path: request.url!, model: body.model, authorization: request.headers.authorization });
    if (reject) { response.writeHead(302, { location: "https://external.invalid/", "content-type": "text/plain" }); response.end("upstream-private-detail"); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (nativeResponses) {
      const index = received.length;
      const toolOutput = Array.isArray(body.input) ? body.input.find((item: Record<string, unknown>) => item.type === "function_call_output"
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
      emit({ type: "response.created", response: { id: `response-${index}`, status: "in_progress", output: [] } });
      emit({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      if (item.type === "message") emit({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Local managed response" });
      emit({ type: "response.output_item.done", output_index: 0, item });
      emit({ type: "response.completed", response: { id: `response-${index}`, status: "completed", model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } });
      response.end(); return;
    }
    response.write("data: fixture\n\n");
    if (hold) { pending = response; response.once("close", () => { closed = true; }); }
    else response.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let ownerCurrent = true; let sessionPresent = true;
  const proxy = new ManagedProviderProxy({ providers, assertOwner: () => { if (!ownerCurrent || !sessionPresent) throw new Error("Owner changed"); } });
  await proxy.start();
  const port = proxy.createRuntime({ backendId: "runtime", generation: 3, support: { protocols: ["openai-responses"], fields: [] }, assertCurrent: () => { if (!ownerCurrent) throw new Error("Runtime changed"); } });
  const owner = { backendId: "runtime", backendInstanceGeneration: 3, targetId: "target", sessionId: "session", sessionGeneration: 4, providerId: "provider", modelId: "model" };
  const write = async (revision: bigint, secret: string) => {
    const reference = `credential-${revision}`;
    const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, secret);
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: reference, displayName: "Provider credential", kind: "api_key" });
    await providers.upsertConfiguration({ providerId: "provider", displayName: "Provider", kind: "custom_endpoint", enabled: true, expectedVersion: revision,
      runtimes: [{ backendId: "runtime", provider: { id: "provider", api: "openai-responses", baseUrl: endpoint, apiKeyEnv: "PROVIDER_KEY", models: [{ id: "model", input: ["text"] }] },
        credentialBindings: { PROVIDER_KEY: reference }, credentialOrigin: endpoint, requestPath: "/custom/responses" }] });
  };
  await write(0n, "first-private-provider-credential");
  return { directory, store, providers, proxy, port, owner, received, write,
    token: port.environment[port.secretEnvironmentNames[0]!]!, toolOutcome: () => toolOutcome,
    hold: () => { hold = true; }, reject: () => { reject = true; },
    retire: () => { ownerCurrent = false; }, closed: () => closed, sessionPresent: (present: boolean) => { sessionPresent = present; },
    finish: () => pending?.end(),
    dispose: async () => { port.dispose(); await proxy.close(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); store.close(); }
  };
}

describe("Managed Provider native proxy", () => {
  it.skipIf(process.env.JOKO_CODEX_MANAGED_FIXTURE_COMMAND === undefined)("runs the installed native app-server through the production route on the original thread with an isolated profile", async () => {
    const f = await fixture(true);
    const profile = join(f.directory, "profile"); const workspaceRoot = join(f.directory, "workspace");
    await mkdir(profile); await mkdir(workspaceRoot);
    const adapter = createCodexAdapter({ id: "runtime", instanceGeneration: 3, managedProviders: f.port,
      appServer: { transport: { command: process.env.JOKO_CODEX_MANAGED_FIXTURE_COMMAND!, args: ["app-server", "--listen", "stdio://"], cwd: workspaceRoot,
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: f.directory, TMP: f.directory, USERPROFILE: profile, HOME: profile, CODEX_HOME: profile, OTEL_SDK_DISABLED: "true" } } } });
    const target: TargetDescriptor = { id: "target", backendId: "runtime", displayName: "Isolated target", workspaceRoot, managed: true, trusted: true };
    const events: EventPayload[] = [];
    let binding: NativeSessionBinding | undefined;
    const context = (operationId: string): AdapterContext => ({ sessionId: "session", generation: 4, backendInstanceGeneration: 3, target,
      ...(binding === undefined ? {} : { binding }), modelSelection: { providerId: "provider", modelId: "model" }, operationId, signal: new AbortController().signal,
      emit: async (event) => { events.push(event); }, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1_024,
      storeArtifact: async () => { throw new Error("No artifacts in this fixture."); } });
    try {
      binding = await adapter.createSession({ target, providerId: "provider", modelId: "model", permissionMode: "auto", fastMode: false }, context("create"));
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
      expect((await adapter.inspectSession(binding, context("inspect"))).binding.nativeSessionId).toBe(originalId);
      expect(f.received).toEqual([
        { path: "/custom/responses", model: "model", authorization: "Bearer first-private-provider-credential" },
        { path: "/custom/responses", model: "model", authorization: "Bearer first-private-provider-credential" },
        { path: "/custom/responses", model: "model", authorization: "Bearer second-private-provider-credential" }
      ]);
      // Native policy may deny the controlled environment probe. A denial is
      // recorded separately and does not prove that a tool process was launched.
      expect(["absent", "denied"]).toContain(f.toolOutcome());
      f.reject();
      await adapter.send({ disposition: "prompt", text: "Return the local failure.", images: [], files: [], mentions: [] }, context("three"));
      await vi.waitFor(() => expect(events.filter((event) => event.type === "done")).toHaveLength(3), { timeout: 20_000 });
      expect(events.at(-1)).toEqual({ type: "done", outcome: "failed" });
      expect(f.received).toHaveLength(4);
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
