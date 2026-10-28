import type { ExtensionOAuthAuthorization } from "./gen/joko/v1/extension_oauth_pb.js";

export interface ExtensionSettingsHost {
  readonly locale?: string;
  confirm(title: string, body: string, signal: AbortSignal): Promise<boolean>;
  authorize(authorization: ExtensionOAuthAuthorization, expiresAt: number, signal: AbortSignal): Promise<{
    readonly state: string; readonly code?: string; readonly error?: string;
  }>;
  openLibrary(signal: AbortSignal): Promise<void>;
}

export type ExtensionSettingsCall =
  | { readonly kind: "context.get" | "routing.get" | "setup.get" | "setup.begin" | "setup.complete" | "oauth.get" | "connections.get" | "library.open" }
  | { readonly kind: "routing.set"; readonly revision: string; readonly dataJson: string }
  | { readonly kind: "setup.field"; readonly fieldId: string; readonly value: string | boolean }
  | { readonly kind: "secret.set"; readonly fieldId: string; readonly value: string }
  | { readonly kind: "secret.clear"; readonly fieldId: string }
  | { readonly kind: "secret.check"; readonly key: string; readonly value: string }
  | { readonly kind: "oauth.connect"; readonly key: string; readonly scopes?: readonly string[] }
  | { readonly kind: "oauth.change"; readonly key: string; readonly action: "remove" | "default" | "clearClient"; readonly accountId?: string }
  | { readonly kind: "connections.set"; readonly key: string; readonly host: string; readonly label?: string; readonly value: string }
  | { readonly kind: "connections.change"; readonly key: string; readonly action: "remove" | "default"; readonly connectionId: string };

export interface ExtensionSettingsBridgeRequest {
  readonly type: "joko:extension-settings-request";
  readonly version: 1;
  readonly id: string;
  readonly command: ExtensionSettingsCall;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const field = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9._:-]{0,127}$/u.test(value);
const secret = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 65_536 && !value.includes("\0");
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));

export function parseExtensionSettingsBridgeRequest(value: unknown): ExtensionSettingsBridgeRequest | undefined {
  if (!object(value) || !keys(value, ["type", "version", "id", "command"]) || value.type !== "joko:extension-settings-request"
    || value.version !== 1 || typeof value.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.id) || !object(value.command)) return undefined;
  const call = value.command;
  let valid = false;
  switch (call.kind) {
    case "context.get": case "routing.get": case "setup.get": case "setup.begin": case "setup.complete": case "oauth.get": case "connections.get": case "library.open":
      valid = keys(call, ["kind"]); break;
    case "routing.set": valid = keys(call, ["kind", "revision", "dataJson"]) && typeof call.revision === "string" && /^(?:0|[1-9][0-9]{0,19})$/u.test(call.revision)
      && typeof call.dataJson === "string" && call.dataJson.length <= 65_536; break;
    case "setup.field": valid = keys(call, ["kind", "fieldId", "value"]) && field(call.fieldId)
      && (typeof call.value === "boolean" || typeof call.value === "string" && call.value.length <= 8_192); break;
    case "secret.set": valid = keys(call, ["kind", "fieldId", "value"]) && field(call.fieldId) && secret(call.value); break;
    case "secret.clear": valid = keys(call, ["kind", "fieldId"]) && field(call.fieldId); break;
    case "secret.check": valid = keys(call, ["kind", "key", "value"]) && field(call.key) && secret(call.value); break;
    case "oauth.connect": valid = keys(call, ["kind", "key", "scopes"]) && field(call.key) && (call.scopes === undefined
      || Array.isArray(call.scopes) && call.scopes.length <= 32 && call.scopes.every(scope => typeof scope === "string" && scope.length > 0 && scope.length <= 256)); break;
    case "oauth.change": valid = keys(call, ["kind", "key", "action", "accountId"]) && field(call.key)
      && ["remove", "default", "clearClient"].includes(String(call.action))
      && (call.action === "clearClient" ? call.accountId === undefined : typeof call.accountId === "string" && call.accountId.length > 0 && call.accountId.length <= 64); break;
    case "connections.set": valid = keys(call, ["kind", "key", "host", "label", "value"]) && field(call.key) && secret(call.value)
      && typeof call.host === "string" && call.host.length > 0 && call.host.length <= 253 && (call.label === undefined || typeof call.label === "string" && call.label.length <= 80); break;
    case "connections.change": valid = keys(call, ["kind", "key", "action", "connectionId"]) && field(call.key)
      && ["remove", "default"].includes(String(call.action)) && typeof call.connectionId === "string" && call.connectionId.length > 0 && call.connectionId.length <= 64; break;
  }
  return valid ? value as unknown as ExtensionSettingsBridgeRequest : undefined;
}

/** Ahead-of-time source; it runs before the author's first script on all engines. */
export const EXTENSION_SETTINGS_SDK_SOURCE = String.raw`(() => {
  "use strict";
  for (const key of ["localStorage", "sessionStorage", "indexedDB", "caches", "Worker", "SharedWorker", "BroadcastChannel", "WebSocket", "EventSource", "RTCPeerConnection", "webkitRTCPeerConnection"]) {
    try { Object.defineProperty(window, key, { get() { throw new Error("Ambient settings capability is unavailable."); }, configurable: false }); } catch (_) {}
  }
  for (const key of ["serviceWorker", "credentials", "clipboard"]) try { Object.defineProperty(navigator, key, { get() { throw new Error("Ambient settings capability is unavailable."); } }); } catch (_) {}
  try { navigator.sendBeacon = () => false; } catch (_) {}
  try { Object.defineProperty(window, "console", { value: Object.freeze({ log() {}, error() {}, warn() {}, info() {}, debug() {}, trace() {} }) }); } catch (_) {}
  const pending = new Map(), sensitive = new Set(); let sequence = 0, revision, closed = false;
  const marker = Symbol.for("joko.extension-settings-mobile.transport"), ready = "joko:extension-settings-ready";
  const protect = value => { if (typeof value === "string" && value) { if (sensitive.size >= 64 && !sensitive.has(value)) throw new Error("Reopen settings before entering more secrets."); sensitive.add(value); } };
  addEventListener("input", event => { if (event.target && event.target.type === "password") protect(event.target.value); }, true);
  const call = command => new Promise((resolve, reject) => {
    if (closed || pending.size >= 16) { reject(new Error("Settings are unavailable or busy.")); return; }
    if (command.kind === "secret.set" || command.kind === "secret.check" || command.kind === "connections.set") protect(command.value);
    if (command.kind === "routing.set") for (const value of sensitive) if (command.dataJson.includes(value)) { reject(new Error("Secrets cannot be saved as plugin parameters.")); return; }
    const random = new Uint8Array(16); crypto.getRandomValues(random);
    const id = "settings_" + (++sequence) + "_" + Array.from(random, byte => byte.toString(16).padStart(2, "0")).join("");
    const send = () => parent.postMessage({ type: "joko:extension-settings-request", version: 1, id, command }, "*");
    const timer = setTimeout(() => { const item = pending.get(id); if (!item) return; pending.delete(id); removeEventListener(ready, send); reject(new Error("Settings result is unknown. Inspect the original operation before retrying.")); }, command.kind === "oauth.connect" ? 310000 : 60000);
    pending.set(id, { resolve, reject, timer, send });
    if (window.ReactNativeWebView && !window[marker]) addEventListener(ready, send, { once: true }); else send();
  });
  addEventListener("message", event => {
    if (event.source !== parent) return;
    const data = event.data;
    if (!data || data.type !== "joko:extension-settings-response" || data.version !== 1 || typeof data.id !== "string") return;
    const item = pending.get(data.id); if (!item) return; pending.delete(data.id); clearTimeout(item.timer); removeEventListener(ready, item.send);
    if (data.ok === true) item.resolve(data.result); else item.reject(new Error(typeof data.message === "string" ? data.message : "Settings request failed."));
  });
  addEventListener("pagehide", () => { closed = true; for (const item of pending.values()) { clearTimeout(item.timer); removeEventListener(ready, item.send); item.reject(new Error("Settings closed.")); } pending.clear(); sensitive.clear(); }, { once: true });
  Object.defineProperty(window, "joko", { value: Object.freeze({ settings: call }), writable: false, configurable: false });
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const target = typeof input === "string" ? input : input && input.url;
    if (typeof target !== "string" || target.startsWith("//")) return originalFetch(input, init);
    const base = globalThis[Symbol.for("joko.extension.surface.base")] || "https://settings.joko.invalid/";
    const url = new URL(target, base);
    if ((url.origin !== new URL(base).origin && url.origin !== location.origin) || !/^\/(kv|app-context|secrets|permissions|oauth|connections)(\/|$)/.test(url.pathname)) return originalFetch(input, init);
    if (url.username || url.password) throw new Error("Settings URL credentials are not allowed.");
    const method = String(init && init.method || input && input.method || "GET").toUpperCase();
    let body = init && init.body, command;
    if (body === undefined && input && typeof input.clone === "function" && method !== "GET" && method !== "HEAD") body = await input.clone().text();
    if (typeof body === "string" && body.length > 65536) throw new Error("Settings request is too large.");
    const json = () => typeof body === "string" ? JSON.parse(body || "{}") : {};
    if (url.search || url.hash) throw new Error("Settings query is not supported.");
    if (url.pathname === "/app-context" && method === "GET") command = { kind: "context.get" };
    else if (url.pathname === "/kv") {
      if (method === "GET") { const result = await call({ kind: "routing.get" }); revision = result.revision; return new Response(result.dataJson, { headers: { "content-type": "application/json" } }); }
      if (method === "PUT") { if (revision === undefined) revision = (await call({ kind: "routing.get" })).revision; command = { kind: "routing.set", revision, dataJson: JSON.stringify(json()) }; }
    } else if (url.pathname === "/secrets" && method === "GET") command = { kind: "setup.get" };
    else if (url.pathname === "/permissions" && method === "GET") command = { kind: "setup.get" };
    else if (url.pathname === "/permissions" && method === "POST") command = { kind: "setup.complete" };
    else if (url.pathname === "/oauth" && method === "GET") command = { kind: "oauth.get" };
    else if (url.pathname === "/connections" && method === "GET") command = { kind: "connections.get" };
    else {
      const secret = /^\/secrets\/([a-z][a-z0-9_]{0,31})(\/check)?$/.exec(url.pathname);
      const oauth = /^\/oauth\/([a-z][a-z0-9_]{0,31})\/(connect|remove|default|clearClient)$/.exec(url.pathname);
      const connection = /^\/connections\/([a-z][a-z0-9_]{0,31})(?:\/(remove|default))?$/.exec(url.pathname);
      if (secret) command = secret[2] && method === "POST" ? { kind: "secret.check", key: secret[1], value: json().value }
        : method === "PUT" ? { kind: "secret.set", fieldId: "network-secret:" + secret[1], value: json().value }
        : method === "DELETE" ? { kind: "secret.clear", fieldId: "network-secret:" + secret[1] } : undefined;
      else if (oauth && method === "POST") command = oauth[2] === "connect" ? { kind: "oauth.connect", key: oauth[1], ...(json().scopes ? { scopes: json().scopes } : {}) }
        : { kind: "oauth.change", key: oauth[1], action: oauth[2], ...(json().accountId ? { accountId: json().accountId } : {}) };
      else if (connection && method === "POST") command = connection[2] ? { kind: "connections.change", key: connection[1], action: connection[2], connectionId: json().connectionId }
        : { kind: "connections.set", key: connection[1], host: json().host, value: json().value, ...(json().label ? { label: json().label } : {}) };
    }
    if (!command) throw new Error("Settings endpoint is not supported.");
    const result = await call(command); if (command.kind === "routing.set") revision = result.revision;
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  };
})();`;
