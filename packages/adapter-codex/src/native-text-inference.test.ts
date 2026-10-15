import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeTextInferenceInput } from "@joko/core";
import { CodexBackendAdapter } from "./adapter.js";
import { AppServerHost } from "./host.js";
import { FakeCodexAppServer } from "./testing.js";
import type { JsonObject } from "./protocol.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const effect of cleanups.splice(0)) await effect(); });
function setup() {
  const fake = new FakeCodexAppServer(), host = new AppServerHost({ transportFactory: () => fake.createTransport() });
  const adapter = new CodexBackendAdapter({ id: "local-runtime", instanceGeneration: 3, host });
  cleanups.push(async () => { await adapter.dispose(); await host.shutdown(); });
  const input: NativeTextInferenceInput = { system: "Product facts only", user: "A private help question", timeoutMs: 20_000,
    signal: new AbortController().signal, backendInstanceGeneration: 3, assertCurrent: () => {}, assertModelAllowed: () => {} };
  return { fake, host, adapter, input };
}
async function runningThread(fake: FakeCodexAppServer): Promise<string> {
  await vi.waitFor(() => expect(fake.transport?.requests.some(request => request.method === "turn/start")).toBe(true));
  return [...fake.threads.keys()][0]!;
}

describe("native tool-free text inference", () => {
  it("uses an ephemeral isolated thread with tools, MCP and skills disabled, then interrupts and releases it", async () => {
    const { fake, adapter, input } = setup();
    fake.reviewSkills.push({ name: "local", path: "/private/SKILL.md", enabled: true });
    fake.reviewConfig = { mcp_servers: { external: { command: "external" } } };
    const pending = adapter.inferNativeText(input), threadId = await runningThread(fake);
    const start = fake.transport!.requests.find(request => request.method === "thread/start")!.params as JsonObject;
    expect(start).toMatchObject({ ephemeral: true, approvalPolicy: "never", modelProvider: "openai", dynamicTools: [], environments: [], selectedCapabilityRoots: [],
      config: { "features.shell_tool": false, "features.plugins": false, "features.memories": false, "mcp_servers.external.enabled": false,
        "skills.config": [{ path: "/private/SKILL.md", enabled: false }] } });
    await fake.completeTurn(threadId, "Use the General page.");
    await expect(pending).resolves.toBe("Use the General page.");
    expect(fake.transport!.requests.some(request => request.method === "turn/interrupt")).toBe(true);
    expect(fake.transport!.requests.some(request => request.method === "thread/unsubscribe")).toBe(true);
  });

  it("refuses stale instance, disabled model and signed-out dispatch, and cancels on auth revocation", async () => {
    const fixture = setup();
    await expect(fixture.adapter.inferNativeText({ ...fixture.input, backendInstanceGeneration: 2 })).rejects.toBeDefined();
    expect(fixture.fake.transport).toBeUndefined();
    await expect(fixture.adapter.inferNativeText({ ...fixture.input, assertModelAllowed: () => { throw new Error("disabled"); } })).rejects.toThrow("disabled");
    expect(fixture.fake.transport).toBeUndefined();
    fixture.fake.account = null;
    await expect(fixture.adapter.inferNativeText(fixture.input)).rejects.toBeDefined();
    expect(fixture.fake.transport!.requests.some(request => request.method === "thread/start")).toBe(false);
    fixture.fake.account = { type: "chatgpt", email: null, planType: "plus" };
    const pending = fixture.adapter.inferNativeText(fixture.input), assertion = expect(pending).rejects.toBeDefined();
    await runningThread(fixture.fake);
    await fixture.adapter.revokeProviderAuthentication("openai");
    await assertion;
    expect(fixture.fake.transport!.requests.some(request => request.method === "turn/interrupt")).toBe(true);
  });

  it("rechecks the exact caller before prompt dispatch and rejects external tool requests", async () => {
    const fixture = setup();
    let current = true;
    const pending = fixture.adapter.inferNativeText({ ...fixture.input, assertCurrent: () => { if (!current) throw new Error("retired"); } });
    const rejection = expect(pending).rejects.toBeDefined();
    const threadId = await runningThread(fixture.fake);
    current = false;
    await fixture.fake.completeTurn(threadId, "Late answer"); await rejection;
    const request = setup(), active = request.adapter.inferNativeText(request.input), failed = expect(active).rejects.toBeDefined();
    const activeThread = await runningThread(request.fake);
    await expect(request.fake.transport!.requestFromServer("item/commandExecution/requestApproval", { threadId: activeThread, turnId: "turn-1", itemId: "tool" })).resolves.toEqual({ decision: "cancel" });
    await failed;
  });

  it("releases a temporary thread when its owner retires between creation and prompt dispatch", async () => {
    const fixture = setup(); let current = true;
    const original = fixture.host.request.bind(fixture.host);
    vi.spyOn(fixture.host, "request").mockImplementation(async (method, params, options) => {
      const response = await original(method, params, options);
      if (method === "thread/start") current = false;
      return response;
    });
    await expect(fixture.adapter.inferNativeText({ ...fixture.input, assertCurrent: () => { if (!current) throw new Error("retired"); } })).rejects.toThrow("retired");
    expect(fixture.fake.transport!.requests.some(request => request.method === "turn/start")).toBe(false);
    expect(fixture.fake.transport!.requests.some(request => request.method === "thread/unsubscribe")).toBe(true);
  });
});
