import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import { createConnectionFetch } from "@joko/connection-transport";
import { createConnectTransport } from "@joko/connection-transport/node";
import { ConnectionService, ExtensionOAuthService, ExtensionAuthorizationPhase as Phase,
  ExtensionOAuthServiceGetFlowRequestSchema, ExtensionOAuthServiceGetFlowResponseSchema } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopExtensionOAuthHost } from "../src/extension-oauth-host.js";
import { listenForExtensionOAuth } from "../src/extension-oauth-loopback.js";

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, callback: (...args: unknown[]) => unknown) => { ipc.handlers.set(name, callback); } } }));
vi.mock("@joko/connection-transport", async original => ({ ...await original<typeof import("@joko/connection-transport")>(), createConnectionFetch: vi.fn() }));
vi.mock("@joko/connection-transport/node", async original => ({ ...await original<typeof import("@joko/connection-transport/node")>(), createConnectTransport: vi.fn() }));
vi.mock("../src/extension-oauth-loopback.js", async original => ({ ...await original<typeof import("../src/extension-oauth-loopback.js")>(), listenForExtensionOAuth: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); ipc.handlers.clear(); });

it.each(['https', 'iroh', 'tailcat'] as const)("uploads the private OAuth callback through the original pinned %s carrier while opening the Provider URL externally", async kind => {
  const endpointPublicKey = `ed25519:${"a".repeat(64)}`, key = "k".repeat(43), flowId = "24cf241c-fb12-4592-aac3-b23d64e1d214";
  const owner = { profileId: "owner", serverId: "node", origin: "https://node.example", endpointPublicKey, ...(kind === 'https' ? {} : { transportKind: kind }) };
  const endpointTransport = kind === 'https' ? undefined : kind === 'iroh'
    ? { kind, ticket: 'private-iroh-ticket', endpointId: 'b'.repeat(64) }
    : { kind, address: 'tcPrivate-tailcat-address', endpointId: `nodekey:${'b'.repeat(64)}`, port: 4318 };
  const trust = { endpointPublicKey, transportKind: kind, ...(endpointTransport === undefined ? {} : { endpointTransport }) };
  const state = "s".repeat(43), callbackUrl = "http://127.0.0.1:45678/callback";
  const authorize = new URL("https://provider.example/authorize");
  authorize.searchParams.set("response_type", "code"); authorize.searchParams.set("state", state); authorize.searchParams.set("redirect_uri", callbackUrl);
  const authorization = { authorizeUrl: authorize.href, callbackUrl, state, corsOrigins: [authorize.origin], corsHosts: [] };
  let completed = false;
  const complete = vi.fn(() => { completed = true; return {}; });
  const transport = createRouterTransport(router => {
    router.service(ConnectionService, { getServerInfo: () => ({ server: { serverId: owner.serverId, endpointPublicKey } }) });
    router.service(ExtensionOAuthService, { getFlow: () => ({ flow: { flowId, phase: completed ? Phase.COMPLETE : Phase.AUTHORIZING, authorization } }),
      beginCallback: () => ({ ticket: { ticketId: "callback", relativeEndpoint: "/v1/credentials/upload/callback", maximumBytes: 12_288n } }),
      completeCallback: complete, cancelFlow: () => ({}) });
  });
  vi.mocked(createConnectTransport).mockImplementation(options => { expect(options).toMatchObject(trust); return transport; });
  let uploadBody: Uint8Array | undefined, delivered = "";
  const upload = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(`${owner.origin}/v1/credentials/upload/callback`);
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${key}` });
    expect(init?.signal?.aborted).toBe(false);
    uploadBody = init?.body as Uint8Array; delivered = Buffer.from(uploadBody).toString("utf8");
    return new Response(null, { status: 204 });
  });
  vi.mocked(createConnectionFetch).mockImplementation(input => { expect(input).toEqual({ origin: owner.origin, ...trust }); return upload; });
  const close = vi.fn(async () => undefined);
  vi.mocked(listenForExtensionOAuth).mockImplementation(async (_offer, deliver, current) => { current(); await deliver({ state, code: "private-code" }); return { close }; });
  const plaintext = vi.fn(async () => { throw new Error("A Joko secret reached plaintext fetch."); }); vi.stubGlobal("fetch", plaintext);
  const openExternal = vi.fn(async () => undefined);
  const read = vi.fn(async (id: string) => id.startsWith('transport_') ? JSON.stringify({ owner: JSON.stringify([owner.profileId, owner.origin, owner.serverId, endpointPublicKey, kind]), transport: endpointTransport }) : key);
  new DesktopExtensionOAuthHost({ assertSource() {}, readAuthKey: read, isCurrentDocument: () => true, quitting: () => false, openExternal }).register();
  const bytes = toBinary(ExtensionOAuthServiceGetFlowRequestSchema, create(ExtensionOAuthServiceGetFlowRequestSchema, { flowId }));
  const result = await ipc.handlers.get("joko:extension-oauth:authorize")!({ sender: { isDestroyed: () => false } }, "document", owner, bytes) as Uint8Array;
  expect(fromBinary(ExtensionOAuthServiceGetFlowResponseSchema, result).flow?.phase).toBe(Phase.COMPLETE);
  expect(complete).toHaveBeenCalledOnce(); expect(upload).toHaveBeenCalledOnce(); expect(plaintext).not.toHaveBeenCalled();
  expect(delivered).toContain("private-code"); expect(uploadBody?.every(byte => byte === 0)).toBe(true);
  expect(openExternal).toHaveBeenCalledWith(authorize.href); expect(close).toHaveBeenCalledOnce();
  if (kind === 'https') expect(read).toHaveBeenCalledExactlyOnceWith(owner.profileId);
  else expect(read.mock.calls.map(call => call[0])).toEqual([expect.stringMatching(/^transport_[a-f0-9]{64}$/u), owner.profileId]);
});
