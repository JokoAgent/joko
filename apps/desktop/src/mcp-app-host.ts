import { randomUUID } from "node:crypto";
import { ipcMain, protocol, session, type IpcMainInvokeEvent, type WebContents, type WebFrameMain, type OnBeforeRequestListenerDetails } from "electron";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createClient, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ConnectionService, McpAppService, McpAppNativeService, McpAppOperation, McpAppNativeOperation,
  McpAppServiceOperateRequestSchema, McpAppServiceOperateResponseSchema, mcpAppDirectSandboxDocument, mcpAppFrameUrlAllowed,
  type McpAppServiceOperateRequest, type McpAppNativeDocument } from "@joko/contracts";
import { DesktopMainDocumentOccurrenceAuthority } from "./main-document-occurrence.js";
import { isAllowedRendererNetworkUrl } from "./security.js";

export const MCP_APP_SCHEME = "joko-mcp-app";
export const MCP_APP_CHANNEL = "joko:mcp-app:operate";
export const MCP_APP_CAPTURE = "joko:mcp-app:document";
const FRAME_HEADER = "X-Joko-Mcp-App-Frame";
const MAX_BYTES = 4 * 1024 * 1024;
interface Owner { readonly profileId: string; readonly serverId: string; readonly origin: string }
interface Route { readonly owner: Owner; readonly transport: Transport; readonly assertCurrent: () => void; readonly uiOwnerId: string }
interface Entry { readonly localId: string; readonly document: McpAppNativeDocument; readonly contents: WebContents;
  readonly route: Route; readonly request: McpAppServiceOperateRequest; readonly key: string; frame?: WebFrameMain }

/** Main owns private documents, source-frame identity and original authenticated transport. */
export class DesktopMcpAppHost {
  readonly #documents = new Map<string, Entry>();
  readonly #views = new Map<string, Entry>();
  readonly #documentsByContents = new Map<WebContents, DesktopMainDocumentOccurrenceAuthority<WebContents>>();
  readonly #owners = new Map<WebContents, Owner>();
  constructor(readonly deps: { readonly assertSource: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => void;
    readonly readAuthKey: (profileId: string) => Promise<string | undefined>; readonly quitting: () => boolean }) {}

  register(): void {
    ipcMain.on(MCP_APP_CAPTURE, (event, claim: unknown) => {
      try {
        this.deps.assertSource(event); if (typeof claim !== "string") throw new Error("Invalid document claim");
        let authority = this.#documentsByContents.get(event.sender);
        if (!authority) {
          authority = new DesktopMainDocumentOccurrenceAuthority(randomUUID); this.#documentsByContents.set(event.sender, authority);
          const retire = () => { authority!.retire(event.sender); this.#owners.delete(event.sender); this.#releaseContents(event.sender); };
          event.sender.on("render-process-gone", retire); event.sender.once("destroyed", () => { retire(); this.#documentsByContents.delete(event.sender); });
          this.#installNavigation(event.sender);
        }
        const capture = authority.capture(event.sender, claim);
        if (capture.retired) this.#releaseContents(event.sender);
        event.returnValue = capture.current.occurrence;
      } catch { event.returnValue = undefined; }
    });
    ipcMain.handle(MCP_APP_CHANNEL, async (event, occurrence: unknown, value: unknown, bytes: unknown) => {
      this.deps.assertSource(event);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 96 * 1024) throw new Error("Invalid application request");
      const owner = parseOwner(value), request = fromBinary(McpAppServiceOperateRequestSchema, bytes);
      if (request.operation === McpAppOperation.TEARDOWN) {
        const authority = this.#documentsByContents.get(event.sender), entry = this.#views.get(request.viewId);
        if (typeof occurrence !== "string" || !authority?.isCurrent(event.sender, occurrence)) throw new Error("Application Document retired");
        if (entry) {
          if (entry.contents !== event.sender || !sameOwner(entry.route.owner, owner) || entry.request.sessionId !== request.sessionId) throw new Error("Application View owner changed");
          // Cleanup uses its original route even after the saved credential disappears.
          try { await createClient(McpAppService, entry.route.transport).operate({ ...entry.request, operation: McpAppOperation.TEARDOWN }, { timeoutMs: 5000 }); }
          catch { /* Local private documents must still be reclaimed after remote revocation. */ }
          finally { this.#remove(entry); }
        }
        return toBinary(McpAppServiceOperateResponseSchema, create(McpAppServiceOperateResponseSchema));
      }
      const route = await this.#route(event, occurrence, owner, request.operation === McpAppOperation.OPEN);
      request.uiOwnerId = route.uiOwnerId;
      let response = create(McpAppServiceOperateResponseSchema);
      if (request.operation === McpAppOperation.OPEN) {
        const opened = await createClient(McpAppNativeService, route.transport).operate({ view: request, operation: McpAppNativeOperation.OPEN }, { timeoutMs: 120_000 });
        const document = opened.document;
        if (!document || !document.viewId || Buffer.byteLength(document.html) > MAX_BYTES) throw new Error("Invalid application document");
        try {
          route.assertCurrent();
          if ([...this.#documents.values()].filter(entry => entry.contents === event.sender).length >= 16) throw new Error("Application View limit");
          const entry: Entry = { localId: randomUUID(), document, contents: event.sender, route, request: { ...request, viewId: document.viewId }, key: randomUUID() };
          this.#documents.set(entry.localId, entry); this.#views.set(document.viewId, entry);
          response = create(McpAppServiceOperateResponseSchema, { viewId: document.viewId, proxyUrl: `${MCP_APP_SCHEME}://${entry.localId}/sandbox`, prefersBorder: document.prefersBorder });
        } catch (error) { await createClient(McpAppService, route.transport).operate({ ...request, viewId: document.viewId, operation: McpAppOperation.TEARDOWN }).catch(() => undefined); throw error; }
      } else {
        const entry = request.viewId ? this.#views.get(request.viewId) : undefined;
        if (entry && (entry.contents !== event.sender || !sameOwner(entry.route.owner, owner))) throw new Error("Application View owner changed");
        if (request.operation !== McpAppOperation.CANCEL_OPEN && !entry) throw new Error("Application View unavailable");
        response = await createClient(McpAppService, entry?.route.transport ?? route.transport).operate(request, { timeoutMs: 120_000 });
      }
      return toBinary(McpAppServiceOperateResponseSchema, response);
    });
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${MCP_APP_SCHEME}://*/*`] }, (details, callback) => {
      const url = new URL(details.url), entry = this.#documents.get(url.hostname);
      if (url.pathname !== "/bridge") { callback({ requestHeaders: details.requestHeaders }); return; }
      try {
        if (!entry || details.method !== "POST" || !details.frame || entry.contents.id !== details.webContentsId
          || details.frame.url !== `${MCP_APP_SCHEME}://${entry.localId}/sandbox` || entry.frame && entry.frame !== details.frame) throw new Error("Invalid frame");
        entry.route.assertCurrent(); entry.frame = details.frame;
        const headers = Object.fromEntries(Object.entries(details.requestHeaders).filter(([key]) => key.toLowerCase() !== FRAME_HEADER.toLowerCase()));
        callback({ requestHeaders: { ...headers, [FRAME_HEADER]: entry.key } });
      } catch { callback({ cancel: true }); }
    });
    protocol.handle(MCP_APP_SCHEME, request => this.#serve(request));
  }

  allowRequest(details: OnBeforeRequestListenerDetails): boolean {
    try {
      const url = new URL(details.url), id = url.hostname.replace(/-view$/u, ""), entry = this.#documents.get(id);
      if (!entry || entry.contents.id !== details.webContentsId) return false;
      entry.route.assertCurrent();
      return url.pathname === "/bridge" ? details.method === "POST" && details.frame?.url === `${MCP_APP_SCHEME}://${id}/sandbox`
        : details.method === "GET" && details.resourceType === "subFrame";
    } catch { return false; }
  }
  isAppFrame(frame: WebFrameMain | undefined): boolean {
    for (let current = frame; current; current = current.parent ?? undefined) {
      try { const url = new URL(current.url); if (url.protocol === `${MCP_APP_SCHEME}:` && this.#documents.has(url.hostname.replace(/-view$/u, ""))) return true; } catch { /* No committed frame URL yet. */ }
    }
    return false;
  }
  async #route(event: IpcMainInvokeEvent, occurrence: unknown, owner: Owner, bind: boolean): Promise<Route> {
    const authority = this.#documentsByContents.get(event.sender);
    if (typeof occurrence !== "string" || !authority?.isCurrent(event.sender, occurrence) || this.deps.quitting()) throw new Error("Application Document retired");
    const previous = this.#owners.get(event.sender);
    if (bind) { if (previous && !sameOwner(previous, owner)) this.#releaseContents(event.sender); this.#owners.set(event.sender, owner); }
    else if (previous && !sameOwner(previous, owner)) throw new Error("Application connection retired");
    const assertCurrent = () => {
      if (event.sender.isDestroyed() || !authority.isCurrent(event.sender, occurrence) || this.deps.quitting()
        || !sameOwner(this.#owners.get(event.sender), owner)) throw new Error("Application owner retired");
    };
    assertCurrent();
    const identity = await createClient(ConnectionService, createConnectTransport({ baseUrl: owner.origin, httpVersion: "1.1", defaultTimeoutMs: 5000 })).getServerInfo({});
    assertCurrent(); if (identity.server?.serverId !== owner.serverId) throw new Error("Application node identity changed");
    const key = await this.deps.readAuthKey(owner.profileId); assertCurrent();
    if (!key || !/^[A-Za-z0-9_-]{43}$/u.test(key)) throw new Error("Application authorization unavailable");
    const transport = createConnectTransport({ baseUrl: owner.origin, httpVersion: "1.1", defaultTimeoutMs: 120_000,
      interceptors: [next => request => { request.header.set("authorization", `Bearer ${key}`); return next(request); }] });
    return { owner, transport, assertCurrent, uiOwnerId: `desktop-${event.sender.id}-${occurrence}` };
  }
  async #native(entry: Entry, request: { readonly operation: McpAppNativeOperation; readonly messageJson?: string; readonly after?: bigint;
    readonly linkId?: string; readonly url?: string; readonly success?: boolean }) {
    entry.route.assertCurrent();
    const response = await createClient(McpAppNativeService, entry.route.transport).operate({ ...request, view: entry.request }, { timeoutMs: 120_000 });
    entry.route.assertCurrent(); return response;
  }
  async #serve(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url), id = url.hostname.replace(/-view$/u, ""), entry = this.#documents.get(id);
      if (!entry || url.search || url.hash) return new Response(null, { status: 404 });
      entry.route.assertCurrent();
      if (url.pathname === "/bridge" && url.hostname === id) {
        if (request.method !== "POST" || request.headers.get(FRAME_HEADER) !== entry.key || entry.frame?.url !== `${MCP_APP_SCHEME}://${id}/sandbox`) return new Response(null, { status: 403 });
        const reader = request.body?.getReader(); if (!reader) return new Response(null, { status: 400 });
        const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Application message too large"); } chunks.push(value); } }
        finally { reader.releaseLock(); }
        if (this.#documents.get(id) !== entry) throw new Error("Application View retired");
        const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        let result: unknown = {};
        switch (body?.op) {
          case "message": await this.#native(entry, { operation: McpAppNativeOperation.MESSAGE, messageJson: JSON.stringify(body.message) }); break;
          case "poll": result = JSON.parse((await this.#native(entry, { operation: McpAppNativeOperation.POLL, after: BigInt(body.after ?? 0) })).eventsJson); break;
          case "open-link": result = { url: body.url, validForMs: (await this.#native(entry, { operation: McpAppNativeOperation.AUTHORIZE_LINK, linkId: body.linkId, url: body.url })).linkValidForMs }; break;
          case "link-result": await this.#native(entry, { operation: McpAppNativeOperation.LINK_RESULT, linkId: body.linkId, success: body.success }); break;
          default: throw new Error("Invalid application bridge operation");
        }
        return Response.json(result, { headers: { "cache-control": "no-store" } });
      }
      const sandbox = url.hostname === id && url.pathname === "/sandbox", resource = url.hostname === `${id}-view` && url.pathname === "/resource";
      if (request.method !== "GET" || !sandbox && !resource) return new Response(null, { status: 404 });
      return new Response(sandbox ? mcpAppDirectSandboxDocument(`${MCP_APP_SCHEME}://${id}-view/resource`, `${MCP_APP_SCHEME}://${id}/bridge`, true) : entry.document.html, { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": sandbox ? `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${MCP_APP_SCHEME}://${id}-view; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'` : entry.document.csp,
        "permissions-policy": "camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()"
      } });
    } catch { return new Response(null, { status: 410 }); }
  }
  #remove(entry: Entry): void { this.#documents.delete(entry.localId); this.#views.delete(entry.document.viewId); }
  #releaseContents(contents: WebContents): void {
    for (const entry of this.#documents.values()) if (entry.contents === contents) {
      this.#remove(entry); void createClient(McpAppService, entry.route.transport).operate({ ...entry.request, operation: McpAppOperation.TEARDOWN }, { timeoutMs: 5000 }).catch(() => undefined);
    }
  }
  #installNavigation(contents: WebContents): void {
    contents.on("will-frame-navigate", event => {
      const source = event.frame?.url || event.initiator?.url || "";
      let domains: readonly string[] | undefined;
      for (let ancestor = event.frame?.parent; ancestor; ancestor = ancestor.parent) {
        try { const url = new URL(ancestor.url); if (url.protocol === `${MCP_APP_SCHEME}:` && url.hostname.endsWith("-view")) { domains = this.#documents.get(url.hostname.slice(0, -5))?.document.frameDomains ?? []; break; } } catch { /* Empty document. */ }
      }
      if (domains !== undefined) { if (!mcpAppFrameUrlAllowed(event.url, domains)) event.preventDefault(); return; }
      if (!source.startsWith(`${MCP_APP_SCHEME}:`)) return;
      try { const from = new URL(source), to = new URL(event.url);
        if (to.protocol !== `${MCP_APP_SCHEME}:` || to.hostname !== (from.hostname.endsWith("-view") ? from.hostname : `${from.hostname}-view`) || to.pathname !== "/resource") event.preventDefault();
      } catch { event.preventDefault(); }
    });
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape" || input.isAutoRepeat || input.isComposing || input.control || input.alt || input.meta || input.shift) return;
      for (let frame = contents.focusedFrame; frame; frame = frame.parent) {
        if (!frame.url.startsWith(`${MCP_APP_SCHEME}:`)) continue;
        const url = new URL(frame.url), entry = this.#documents.get(url.hostname);
        if (url.pathname === "/sandbox" && entry?.contents === contents) { void frame.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));").catch(() => undefined); event.preventDefault(); return; }
      }
    });
  }
}
function sameOwner(a: Owner | undefined, b: Owner): boolean { return a?.profileId === b.profileId && a.serverId === b.serverId && a.origin === b.origin; }
function parseOwner(value: unknown): Owner {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid application owner");
  const owner = value as Owner;
  if (Object.keys(owner).sort().join(",") !== "origin,profileId,serverId" || [owner.profileId, owner.serverId, owner.origin].some(item => typeof item !== "string" || !item || item.length > 2048)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(owner.profileId) || !isAllowedRendererNetworkUrl(owner.origin) || new URL(owner.origin).origin !== owner.origin) throw new Error("Invalid application owner");
  return Object.freeze({ ...owner });
}
