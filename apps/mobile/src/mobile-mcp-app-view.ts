import { getRandomBytes } from "expo-crypto";
import { McpAppNativeOperation, McpAppOperation, type McpAppNativeDocument } from "@joko/contracts";
import type { MobileMcpAppApi } from "./mobile-mcp-app-api";
import { prepareMcpAppNativeDocument, type PreparedMcpAppNativeDocument } from "./mobile-mcp-app-document";

export type AppRpc = { jsonrpc: "2.0"; method?: string; id?: number | string; params?: Record<string, unknown>; [key: string]: unknown };
export interface MobileMcpAppState { readonly loading: boolean; readonly height: number; readonly failed: boolean }
const token = () => [...getRandomBytes(24)].map(byte => byte.toString(16).padStart(2, "0")).join("");
const UI_OWNER = token();

/** The root host owns the actual WebView until bounded teardown, including after route/card removal. */
export class MobileMcpAppView {
  readonly id = token();
  readonly bridgeKey = token();
  readonly openId = token();
  readonly #api: MobileMcpAppApi;
  readonly #sessionId: string;
  readonly #cardId: string;
  readonly #changed: () => void;
  readonly #removed: () => void;
  readonly #openLink: (url: string) => Promise<void>;
  readonly #listeners = new Set<(state: MobileMcpAppState) => void>();
  #after = 0;
  #ready = false;
  #outbound: AppRpc[] = [];
  #timer?: ReturnType<typeof setTimeout>;
  #close?: Promise<void>;
  #initializedId?: string | number;
  document?: McpAppNativeDocument;
  nativeDocument?: PreparedMcpAppNativeDocument;
  inject?: (script: string) => void;
  width = 1;
  state: MobileMcpAppState = { loading: true, height: 320, failed: false };
  closing = false;
  disposed = false;

  constructor(api: MobileMcpAppApi, sessionId: string, cardId: string, changed: () => void, removed: () => void,
    openLink: (url: string) => Promise<void>) {
    this.#api = api; this.#sessionId = sessionId; this.#cardId = cardId;
    this.#changed = changed; this.#removed = removed; this.#openLink = openLink;
  }
  #view() { return { sessionId: this.#sessionId, cardId: this.#cardId, uiOwnerId: UI_OWNER, openId: this.openId,
    ...(this.document ? { viewId: this.document.viewId } : {}) }; }
  subscribe(listener: (state: MobileMcpAppState) => void): () => void {
    this.#listeners.add(listener); listener(this.state); return () => { this.#listeners.delete(listener); };
  }
  #update(value: Partial<MobileMcpAppState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...value }; for (const listener of this.#listeners) listener(this.state); this.#changed();
  }
  setWidth(width: number): void { if (!this.disposed && Number.isFinite(width) && width > 0 && width !== this.width) { this.width = width; this.#changed(); } }
  #post(message: AppRpc): void {
    if (this.disposed) return;
    const serialized = JSON.stringify(JSON.stringify(message)).replace(/</gu, "\\u003c");
    this.inject?.(`window.dispatchEvent(new MessageEvent('message',{data:JSON.parse(${serialized}),source:window}));true;`);
  }
  async open(context: Record<string, unknown>): Promise<void> {
    try {
      const response = await this.#api.native({ view: { ...this.#view(), contextJson: JSON.stringify(context) }, operation: McpAppNativeOperation.OPEN });
      const document = response.document; if (!document?.viewId) throw new Error("MCP_APP_INVALID_DOCUMENT");
      this.document = document;
      if (this.closing) { await this.#api.metadata({ ...this.#view(), operation: McpAppOperation.TEARDOWN }); return; }
      const native = await prepareMcpAppNativeDocument(document, this.bridgeKey);
      if (this.closing) { await native.close(); return; }
      this.nativeDocument = native;
      this.#timer = setTimeout(() => this.fail(), 45_000);
      this.#changed(); void this.#poll();
    } catch { if (!this.closing) this.fail(); }
  }
  receive(data: string): void {
    if (this.disposed) return;
    try {
      const envelope = JSON.parse(data) as { key?: string; message?: AppRpc };
      if (envelope.key !== this.bridgeKey || envelope.message?.jsonrpc !== "2.0") return;
      const message = envelope.message;
      if (message.method === "ui/notifications/sandbox-proxy-ready") {
        if (this.#ready || this.closing || !this.nativeDocument) return;
        this.#ready = true;
        this.#post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { resourceUrl: this.nativeDocument.resourceUrl } });
        for (const pending of this.#outbound.splice(0)) this.#post(pending);
        return;
      }
      if (message.method?.startsWith("ui/notifications/sandbox-") || this.closing && message.method) return;
      if (message.method === "ui/initialize") this.#initializedId = message.id;
      if (message.method === "ui/notifications/initialized") { clearTimeout(this.#timer); this.#update({ loading: false }); }
      if (message.method === "ui/notifications/size-changed" && typeof message.params?.height === "number" && Number.isFinite(message.params.height))
        this.#update({ height: Math.max(80, Math.min(1200, Math.ceil(message.params.height))) });
      void this.#api.native({ view: this.#view(), operation: McpAppNativeOperation.MESSAGE, messageJson: JSON.stringify(message) }).catch(() => this.fail());
    } catch { this.fail(); }
  }
  async context(context: Record<string, unknown>): Promise<void> {
    if (this.document && !this.closing) await this.#api.metadata({ ...this.#view(), operation: McpAppOperation.CONTEXT, contextJson: JSON.stringify(context) });
  }
  async #poll(): Promise<void> {
    try {
      while (!this.disposed && this.document) {
        const response = await this.#api.native({ view: this.#view(), operation: McpAppNativeOperation.POLL, after: BigInt(this.#after) });
        const events = JSON.parse(response.eventsJson) as Array<{ seq: number; message?: AppRpc; openLink?: { id: string; url: string } }>;
        if (!Array.isArray(events)) throw new Error("MCP_APP_INVALID_POLL");
        for (const event of events) {
          if (this.disposed || !Number.isSafeInteger(event.seq) || event.seq <= this.#after) continue;
          this.#after = event.seq;
          if (event.openLink) { void this.#link(event.openLink); continue; }
          if (!event.message) continue;
          if (event.message.id === this.#initializedId && event.message.error) throw new Error("MCP_APP_INITIALIZATION_FAILED");
          if (this.#ready) this.#post(event.message); else this.#outbound.push(event.message);
        }
        if (!events.length && !this.disposed) await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch { if (!this.closing) this.fail(); }
  }
  async #link(link: { id: string; url: string }): Promise<void> {
    let success = false;
    try {
      const started = performance.now();
      const grant = await this.#api.native({ view: this.#view(), operation: McpAppNativeOperation.AUTHORIZE_LINK, linkId: link.id, url: link.url });
      if (this.closing || this.disposed || grant.linkValidForMs <= 0 || grant.linkValidForMs > 30_000
        || performance.now() - started >= grant.linkValidForMs) throw new Error("MCP_APP_LINK_EXPIRED");
      await this.#openLink(link.url); success = true;
    } catch { /* The Host receives the failed action and completes its standard RPC. */ }
    if (!this.disposed) await this.#api.native({ view: this.#view(), operation: McpAppNativeOperation.LINK_RESULT, linkId: link.id, success }).catch(() => this.fail());
  }
  fail(): void { if (!this.closing) { this.#update({ loading: false, failed: true }); void this.close(); } }
  close(): Promise<void> { return this.#close ??= this.#closeView(); }
  async #closeView(): Promise<void> {
    this.closing = true; clearTimeout(this.#timer); this.#changed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.#api.metadata({ ...this.#view(), operation: this.document ? McpAppOperation.TEARDOWN : McpAppOperation.CANCEL_OPEN }).catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    } finally {
      clearTimeout(timer); this.disposed = true; this.inject = undefined; this.#outbound = []; this.#listeners.clear(); this.#removed();
      await this.nativeDocument?.close().catch(() => undefined);
    }
  }
}
