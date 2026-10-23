import { describe, expect, it, vi } from "vitest";
import { createHostedAgentClaudeNativeTransport } from "./hosted-agent-claude-native-transport.js";
import type { HostedAgentBackendFactory } from "./hosted-agent-runtime.js";

describe("hosted native subscription transport", () => {
  it("retires an upstream stream that has stopped producing data", async () => {
    const cancelled = vi.fn(), transport = await createHostedAgentClaudeNativeTransport({ creation: fixture(() => {}), credentials: credentials(),
      fetch: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: started\n\n")); }, cancel: cancelled }),
        { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
    try {
      const response = await fetch(transport.environment["ANTHROPIC_BASE_URL"]! + "/v1/messages", { method: "POST",
        headers: { "content-type": "application/json", "x-joko-hosted-native-scope": transport.secret }, body: JSON.stringify({ model: "sonnet", messages: [] }) });
      const reader = response.body!.getReader(); await reader.read();
      await transport.close(); await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
      await reader.cancel().catch(() => {}); reader.releaseLock();
    } finally { await transport.close(); }
  });
  it("resolves only SDK-attested model aliases, retains native OAuth, and rejects foreign models before dispatch", async () => {
    let allowed = true;
    const creation = fixture((providerId, modelId) => { if (!allowed || providerId !== "claude-code" || modelId !== "sonnet") throw new Error("Not allowed."); });
    const forward = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("data: approved\n\n", { headers: { "content-type": "text/event-stream" } }));
    const transport = await createHostedAgentClaudeNativeTransport({ creation, credentials: credentials(), fetch: forward });
    transport.registerModels([{ value: "sonnet", resolvedModel: "canonical-model" }, { value: "host-only-alias", resolvedModel: "host-only-model" }]);
    const request = (model: string, scope = transport.secret, path = "/v1/messages?beta=true") => fetch(transport.environment["ANTHROPIC_BASE_URL"]! + path, {
      method: "POST", headers: { "content-type": "application/json", "x-joko-hosted-native-scope": scope, authorization: "Bearer private-relay-token",
        cookie: "host-cookie=must-not-leave" }, body: JSON.stringify({ model, stream: true, messages: [] }) });
    try {
      const accepted = await request("canonical-model"); expect(accepted.status).toBe(200); expect(await accepted.text()).toContain("approved");
      expect(forward).toHaveBeenCalledOnce();
      const [, init] = forward.mock.calls[0]!, headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer controlled-subscription-token"); expect(headers.has("cookie")).toBe(false); expect(headers.has("x-joko-hosted-native-scope")).toBe(false);
      expect(JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")).model).toBe("canonical-model");
      const foreign = await request("host-only-model"); expect(foreign.status).toBe(403); await foreign.text(); expect(forward).toHaveBeenCalledOnce();
      const forged = await request("canonical-model", "forged-scope"); expect(forged.status).toBe(403); await forged.text(); expect(forward).toHaveBeenCalledOnce();
      const account = await request("canonical-model", transport.secret, "/api/oauth/profile"); expect(account.status).toBe(404); await account.text(); expect(forward).toHaveBeenCalledOnce();
      allowed = false;
      const revoked = await request("canonical-model"); expect(revoked.status).toBe(403); await revoked.text(); expect(forward).toHaveBeenCalledOnce();
    } finally { await transport.close(); }
  });
});

function fixture(assertModelAllowed: Parameters<HostedAgentBackendFactory["create"]>[0]["assertModelAllowed"]): Parameters<HostedAgentBackendFactory["create"]>[0] {
  return { home: process.cwd(), nativeOwner: { sessionId: "native-session", targetId: "native-target", generation: 1, backendInstanceGeneration: 1 },
    trust: "guest", providerId: "claude-code", providerIds: ["claude-code"], modelIds: ["sonnet"], signal: new AbortController().signal, assertModelAllowed,
    readBlob: async () => { throw new Error("No Blob expected."); },
    execution: { trust: "guest", guestHome: process.cwd(), providerId: "claude-code", modelIds: ["sonnet"],
      workspace: { root: process.cwd(), additionalRoots: [], platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false },
      source: { sessionId: "source-task", targetId: "source-target", generation: 1 }, channel: { endpoint: "http://127.0.0.1:1/private", bearer: "private_test_bearer_0123456789abcdef" }, assertCurrent: () => {} } };
}
function credentials() {
  const value = JSON.stringify({ format: 1, type: "oauth", accessToken: "controlled-subscription-token", refreshToken: "controlled-refresh-token",
    expiresAt: Date.now() + 60 * 60_000, scopes: ["user:inference"], subscriptionType: "max", rateLimitTier: null });
  return { readSerialized: async () => value, compareAndSet: async () => false, restoreExact: async () => false, deleteExact: async () => false };
}
