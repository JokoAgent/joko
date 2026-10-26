import { setTimeout as delay } from "node:timers/promises";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@joko/connection-transport/node";
import { createConnectionFetch } from "@joko/connection-transport";
import { ConnectionService, ExtensionOAuthService, ExtensionOAuthServiceGetFlowRequestSchema, ExtensionOAuthServiceGetFlowResponseSchema,
  ExtensionAuthorizationPhase as Phase } from "@joko/contracts";
import { isAllowedRendererNetworkUrl } from "./security.js";
import { listenForExtensionOAuth, validateExtensionOAuthOffer } from "./extension-oauth-loopback.js";
import { desktopEndpointTrust } from './connection-transport.js';

interface Owner { readonly profileId: string; readonly serverId: string; readonly origin: string; readonly endpointPublicKey?: string; readonly transportKind?: 'https' | 'iroh' | 'tailcat' | 'webrtc' | 'http-connect' }
interface Entry { readonly contents: WebContents; readonly occurrence: string; readonly owner: Owner; readonly flowId: string; readonly abort: AbortController; readonly cancel: () => Promise<void> }
export class DesktopExtensionOAuthHost {
  readonly #entries = new Set<Entry>();
  constructor(private readonly deps: { readonly assertSource: (event: IpcMainInvokeEvent) => void; readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
    readonly isCurrentDocument: (contents: WebContents, occurrence: string) => boolean; readonly quitting: () => boolean; readonly openExternal: (url: string) => Promise<unknown> }) {}
  register() {
    ipcMain.handle("joko:extension-oauth:authorize", async (event, occurrence: unknown, ownerValue: unknown, bytes: unknown) => {
      this.deps.assertSource(event); const owner = parseOwner(ownerValue);
      if (typeof occurrence !== "string" || !(bytes instanceof Uint8Array) || bytes.byteLength > 2_048) throw new Error("Invalid plugin authorization request.");
      const { flowId } = fromBinary(ExtensionOAuthServiceGetFlowRequestSchema, bytes);
      if (!/^[a-f0-9-]{36}$/u.test(flowId)) throw new Error("Invalid plugin authorization flow.");
      const assertDocument = () => {
        if (this.deps.quitting() || event.sender.isDestroyed() || !this.deps.isCurrentDocument(event.sender, occurrence)) throw new Error("Plugin authorization owner changed.");
      };
      assertDocument();
      for (const entry of this.#entries) if (entry.contents === event.sender) { entry.abort.abort(); void entry.cancel(); }
      const abort = new AbortController();
      const assertCurrent = () => { abort.signal.throwIfAborted(); assertDocument(); };
      let cancelRemote = async () => {};
      const entry: Entry = { contents: event.sender, occurrence, owner, flowId, abort, cancel: () => cancelRemote() };
      this.#entries.add(entry); let listener: Awaited<ReturnType<typeof listenForExtensionOAuth>> | undefined, finished = false;
      try {
      const trust = await desktopEndpointTrust(owner, this.deps.readAuthKey); assertCurrent();
      const uploadCallback = createConnectionFetch({ origin: owner.origin, ...trust });
      const identity = await createClient(ConnectionService, createConnectTransport({ baseUrl: owner.origin, ...trust, httpVersion: "1.1", defaultTimeoutMs: 5_000 })).getServerInfo({});
      assertCurrent(); if (identity.server?.serverId !== owner.serverId) throw new Error("Plugin authorization node changed.");
      const key = await this.deps.readAuthKey(owner.profileId); assertCurrent();
      if (!key || !/^[A-Za-z0-9_-]{43}$/u.test(key)) throw new Error("Plugin authorization unavailable.");
      const client = createClient(ExtensionOAuthService, createConnectTransport({ baseUrl: owner.origin, ...trust, httpVersion: "1.1", defaultTimeoutMs: 10_000,
        interceptors: [next => request => { request.header.set("authorization", `Bearer ${key}`); return next(request); }] }));
      let cancelling: Promise<void> | undefined;
      cancelRemote = () => cancelling ??= client.cancelFlow({ flowId }, { timeoutMs: 5_000 }).then(() => undefined, () => undefined);
        const deadline = Date.now() + 300_000;
        while (true) {
          assertCurrent(); if (Date.now() >= deadline) throw new Error("Plugin authorization timed out.");
          const result = await client.getFlow({ flowId }, { signal: abort.signal }); assertCurrent();
          const flow = result.flow;
          if (!flow || flow.flowId !== flowId || flow.expiresAt && Number(flow.expiresAt.seconds) * 1000 <= Date.now()) throw new Error("Plugin authorization flow is unavailable.");
          if (flow.phase === Phase.COMPLETE || flow.phase === Phase.FAILED) { finished = true; return toBinary(ExtensionOAuthServiceGetFlowResponseSchema, result); }
          if (flow.phase === Phase.AUTHORIZING && !listener) {
            if (!flow.authorization) throw new Error("Plugin authorization offer is unavailable.");
            validateExtensionOAuthOffer(flow.authorization);
            listener = await listenForExtensionOAuth(flow.authorization, async callback => {
              assertCurrent(); const { ticket } = await client.beginCallback({ flowId }, { signal: abort.signal }); assertCurrent();
              if (!ticket || ticket.relativeEndpoint !== `/v1/credentials/upload/${encodeURIComponent(ticket.ticketId)}` || ticket.maximumBytes > 12_288n) throw new Error("Plugin callback input is unavailable.");
              const input = Buffer.from(JSON.stringify(callback), "utf8");
              try {
              if (BigInt(input.byteLength) > ticket.maximumBytes) throw new Error("Plugin callback input is too large.");
              const response = await uploadCallback(new URL(ticket.relativeEndpoint, owner.origin), { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/octet-stream" },
                body: input, redirect: "error", signal: abort.signal }); assertCurrent();
              await response.body?.cancel(); if (!response.ok) throw new Error("Plugin callback could not be delivered.");
              await client.completeCallback({ flowId, credentialUploadTicketId: ticket.ticketId }, { signal: abort.signal }); assertCurrent();
              } finally { input.fill(0); }
            }, assertCurrent);
            assertCurrent(); await this.deps.openExternal(flow.authorization.authorizeUrl); assertCurrent();
          }
          await delay(500, undefined, { signal: abort.signal });
        }
      } finally { abort.abort(); this.#entries.delete(entry); await listener?.close(); if (!finished) await entry.cancel(); }
    });
    ipcMain.handle("joko:extension-oauth:cancel", async (event, occurrence: unknown, ownerValue: unknown, flowId: unknown) => {
      this.deps.assertSource(event); const owner = parseOwner(ownerValue);
      if (typeof occurrence !== "string" || typeof flowId !== "string" || !this.deps.isCurrentDocument(event.sender, occurrence)) throw new Error("Plugin authorization owner changed.");
      for (const entry of this.#entries) if (entry.contents === event.sender && entry.occurrence === occurrence && entry.flowId === flowId && sameOwner(entry.owner, owner)) { entry.abort.abort(); await entry.cancel(); }
    });
  }
}
function sameOwner(a: Owner, b: Owner) { return a.profileId === b.profileId && a.serverId === b.serverId && a.origin === b.origin && a.endpointPublicKey === b.endpointPublicKey && (a.transportKind ?? 'https') === (b.transportKind ?? 'https'); }
function parseOwner(value: unknown): Owner {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin authorization owner.");
  const owner = value as Owner;
  if (Object.keys(owner).filter(key => key !== "endpointPublicKey" && key !== 'transportKind').sort().join(",") !== "origin,profileId,serverId" || [owner.profileId, owner.serverId, owner.origin].some(item => typeof item !== "string" || !item || item.length > 2048)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(owner.profileId) || !isAllowedRendererNetworkUrl(owner.origin) || new URL(owner.origin).origin !== owner.origin) throw new Error("Invalid plugin authorization owner.");
  if (owner.endpointPublicKey !== undefined && !/^ed25519:[a-f0-9]{64}$/u.test(owner.endpointPublicKey)) throw new Error("Invalid endpoint public key.");
  if (owner.transportKind !== undefined && !['https', 'iroh', 'tailcat', 'webrtc', 'http-connect'].includes(owner.transportKind)) throw new Error('Invalid connection transport.');
  return Object.freeze({ ...owner });
}
