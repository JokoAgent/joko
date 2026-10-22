import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostedExecution } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { CredentialManager, ProviderCatalogManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { createHostedAgentManagedProviderRuntime } from "./hosted-agent-managed-provider-runtime.js";

describe("hosted native Provider scope", () => {
  it("uses only the selected Provider and rechecks delegated model scope at every actual HTTP request", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "joko-hosted-provider-scope-")));
    const store = new OperationalStore(join(directory, "store.db"));
    const credentials = new CredentialManager({ vault: await CredentialVault.open(join(directory, "vault.key")), storagePath: join(directory, "credentials.json") }); await credentials.initialize();
    const providers = new ProviderCatalogManager({ store, credentials, nativeBackendId: "native-owner" }); providers.initialize();
    const received: string[] = [];
    const server = createServer((req, res) => { void (async () => { const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).model); res.setHeader("content-type", "application/json"); res.end('{"type":"message","content":[{"type":"text","text":"approved"}]}'); })().catch(() => res.writeHead(500).end()); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, "hosted-native-test-private-provider-key");
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "scope-provider-key", displayName: "Test Provider", kind: "api_key" });
    for (const providerId of ["shared-provider", "host-other-provider"]) await providers.upsertConfiguration({ providerId, displayName: providerId, kind: "custom_endpoint", enabled: true, expectedVersion: 0n,
      runtimes: [{ backendId: "native-test", provider: { id: providerId, api: "anthropic-messages", baseUrl: endpoint, apiKeyEnv: "NATIVE_TEST_KEY",
        models: ["selected", "allowed-child", "host-other-model"].map(id => ({ id, input: ["text"], contextWindow: 100_000, maxTokens: 4096 })) },
        credentialBindings: { NATIVE_TEST_KEY: "scope-provider-key" }, credentialOrigin: endpoint }] });
    const home = join(directory, "native"), workspace = join(directory, "workspace"); await Promise.all([mkdir(home), mkdir(workspace)]);
    const lifetime = new AbortController(), active = new Set(["selected", "allowed-child"]);
    const execution: HostedExecution = { trust: "guest", guestHome: directory, providerId: "shared-provider", modelIds: ["selected", "allowed-child"],
      workspace: { root: workspace, additionalRoots: [], platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false },
      source: { sessionId: "source-task", targetId: "source-target", generation: 7 }, channel: { endpoint: "http://127.0.0.1:1/private", bearer: "private_test_bearer_0123456789abcdef" }, assertCurrent: () => lifetime.signal.throwIfAborted() };
    const nativeOwner = { sessionId: "native-task", targetId: "native-target", generation: 1, backendInstanceGeneration: 1 };
    const scoped = await createHostedAgentManagedProviderRuntime({ backendId: "native-test", providers, support: { protocols: ["anthropic-messages"], fields: [] }, creation: {
      home, execution, nativeOwner, trust: "guest", providerId: "shared-provider", providerIds: ["shared-provider"], modelIds: execution.modelIds, signal: lifetime.signal,
      readBlob: async () => { throw new Error("No source Blob expected."); },
      assertModelAllowed(providerId, modelId) { if (providerId !== "shared-provider" || !active.has(modelId)) throw new Error("The current grant does not allow the model."); }
    } });
    const owner = { backendId: "native-test", backendInstanceGeneration: 1, sessionId: nativeOwner.sessionId, targetId: nativeOwner.targetId, sessionGeneration: nativeOwner.generation };
    try {
      expect(scoped.runtime.listProviders().map(provider => provider.providerId)).toEqual(["shared-provider"]);
      expect(scoped.runtime.listModels().map(model => model.modelId)).toEqual(["selected", "allowed-child"]);
      await expect(scoped.runtime.prepare({ ...owner, providerId: "host-other-provider", modelId: "selected" })).rejects.toThrow();
      await expect(scoped.runtime.prepare({ ...owner, providerId: "shared-provider", modelId: "host-other-model" })).rejects.toThrow();
      const binding = await scoped.runtime.prepare({ ...owner, providerId: "shared-provider", modelId: "selected" });
      const parent = await binding.activate({ operationId: "original-input", signal: lifetime.signal, assertCurrent: () => {} });
      const child = await binding.authorizeSubtask!({ operationId: "original-input", requestId: "child-one", modelId: "allowed-child", signal: lifetime.signal, assertCurrent: () => {} });
      const request = (model: string) => fetch(binding.baseUrl + "/v1/messages", { method: "POST", headers: { "content-type": "application/json",
        authorization: `Bearer ${scoped.runtime.environment[binding.apiKeyEnvironment]}` }, body: JSON.stringify({ model, max_tokens: 40, messages: [{ role: "user", content: "Hello" }] }) });
      try {
        const accepted = await request("allowed-child"); expect(accepted.status).toBe(200); await accepted.text(); expect(received).toEqual(["allowed-child"]);
        active.delete("allowed-child");
        const revoked = await request("allowed-child"); expect(revoked.status).not.toBe(200); await revoked.text(); expect(received).toEqual(["allowed-child"]);
        const foreign = await request("host-other-model"); expect(foreign.status).not.toBe(200); await foreign.text(); expect(received).toEqual(["allowed-child"]);
      } finally { child.release(); parent.release(); binding.dispose(); }
      await expect(scoped.runtime.prepare({ ...owner, sessionId: "other-native-task", providerId: "shared-provider", modelId: "selected" })).rejects.toThrow("owner changed");
    } finally {
      lifetime.abort(); scoped.runtime.dispose(); await scoped.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close();
      const suffix = relative(resolve(tmpdir()), directory); if (!suffix || suffix === ".." || suffix.startsWith(".." + sep)) throw new Error("Unsafe test cleanup.");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
