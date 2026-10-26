// @vitest-environment jsdom
import { create, toBinary } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { ExtensionAuthorizationPhase, ExtensionOAuthServiceGetFlowResponseSchema } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "jokoDesktop"); });
async function fixture() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const transport = { unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
    calls.push({ method: method.localName, input });
    const value = method.localName === "getSnapshot" ? { snapshot: {} } : method.localName === "beginClient" ? { ticket: { ticketId: "protected-client", relativeEndpoint: "/v1/credentials/upload/protected-client", maximumBytes: 2_048n } }
      : method.localName === "start" ? { flow: { flowId: "original-flow", extensionId: "extension", slotKey: "account", phase: ExtensionAuthorizationPhase.PREPARING } }
        : method.localName === "dispatch" ? { accepted: true, authorizationFlowId: "host-card-flow" }
        : method.localName === "commitClient" || method.localName === "get" ? { state: { extensionId: "extension", revision: { value: 2n } } } : {};
    return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: create(method.output, value) };
  }), stream: vi.fn() } as unknown as Transport;
  const profile = { id: "original-profile", deviceId: "device", name: "Desktop", serverId: "original-server", origin: "http://127.0.0.1:4318" };
  const gateway = createOrchestratorGateway(profile, "original-auth-fixture", {}, () => transport); await gateway.connect({ snapshotOnly: true });
  return { gateway, calls, profile };
}
it("sends client secrets only through the original protected upload channel", async () => {
  const f = await fixture(), upload = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })); vi.stubGlobal("fetch", upload);
  const result = await f.gateway.extensionOAuthApi()!.saveClient({ extensionId: "extension", slotKey: "account", expectedRevision: { value: 1n } }, "application-client", "private-client-secret-fixture", new AbortController().signal);
  expect(result.revision!.value).toBe(2n);
  expect(JSON.stringify(f.calls, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)).not.toContain("private-client-secret-fixture");
  const [url, init] = upload.mock.calls[0]!; expect(String(url)).toBe("http://127.0.0.1:4318/v1/credentials/upload/protected-client");
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer original-auth-fixture"); expect(ArrayBuffer.isView(init?.body)).toBe(true);
  expect(new Uint8Array(init!.body as Uint8Array).every(value => value === 0)).toBe(true); f.gateway.disconnect();
});
it("cancels the original controller and rejects its late success after the node connection closes", async () => {
  const f = await fixture(); let release!: (value: Uint8Array) => void;
  const authorize = vi.fn(async (_owner: { profileId: string; serverId: string; origin: string }, _bytes: Uint8Array) => await new Promise<Uint8Array>(resolve => { release = resolve; })),
    cancel = vi.fn(async (_owner: { profileId: string; serverId: string; origin: string }, _flowId: string) => {});
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { extensionOAuth: { authorize, cancel } } });
  const pending = f.gateway.extensionOAuthApi()!.authorize({ extensionId: "extension", slotKey: "account", expectedRevision: { value: 1n } }, new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce()); f.gateway.disconnect();
  expect(cancel.mock.calls[0]![0]).toEqual({ profileId: f.profile.id, serverId: f.profile.serverId, origin: f.profile.origin });
  release(toBinary(ExtensionOAuthServiceGetFlowResponseSchema, create(ExtensionOAuthServiceGetFlowResponseSchema, { flow: { flowId: "original-flow", phase: ExtensionAuthorizationPhase.COMPLETE } })));
  await rejected; expect(f.calls.filter(call => call.method === "cancelFlow")).toHaveLength(1); expect(f.calls.filter(call => call.method === "get")).toHaveLength(0);
});
it("completes only the host card's bound flow through the original native controller without starting an unbound flow", async () => {
  const f = await fixture(), authorize = vi.fn(async (_owner: { profileId: string; serverId: string; origin: string }, _bytes: Uint8Array) => toBinary(ExtensionOAuthServiceGetFlowResponseSchema,
    create(ExtensionOAuthServiceGetFlowResponseSchema, { flow: { flowId: "host-card-flow", phase: ExtensionAuthorizationPhase.COMPLETE } }))), cancel = vi.fn(async () => {});
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { extensionOAuth: { authorize, cancel } } });
  const result = await f.gateway.extensionCardApi()!.dispatch({ sessionId: "task", cardId: "host-card", actionId: "host:connect-account" });
  expect(result).toMatchObject({ accepted: true, authorizationFlowId: "host-card-flow" });
  expect(authorize.mock.calls[0]![0]).toEqual({ profileId: f.profile.id, serverId: f.profile.serverId, origin: f.profile.origin });
  expect(f.calls.map(call => call.method)).not.toContain("start"); expect(cancel).not.toHaveBeenCalled(); f.gateway.disconnect();
});
it("cancels the exact host-card flow on view cancellation and discards late native success", async () => {
  const f = await fixture(), abort = new AbortController(); let release!: (bytes: Uint8Array) => void;
  const authorize = vi.fn(async () => await new Promise<Uint8Array>(resolve => { release = resolve; })), cancel = vi.fn(async () => {});
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: { extensionOAuth: { authorize, cancel } } });
  const pending = f.gateway.extensionCardApi()!.dispatch({ sessionId: "task", cardId: "host-card", actionId: "host:connect-account" }, { signal: abort.signal });
  const refused = expect(pending).rejects.toThrow(); await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce()); abort.abort();
  release(toBinary(ExtensionOAuthServiceGetFlowResponseSchema, create(ExtensionOAuthServiceGetFlowResponseSchema, { flow: { flowId: "host-card-flow", phase: ExtensionAuthorizationPhase.COMPLETE } })));
  await refused; expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ profileId: f.profile.id }), "host-card-flow");
  expect(f.calls.filter(call => call.method === "cancelFlow")).toMatchObject([{ input: { flowId: "host-card-flow" } }]); f.gateway.disconnect();
});
