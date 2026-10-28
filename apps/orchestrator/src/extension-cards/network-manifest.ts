import { createHash } from "node:crypto";
import { parseExtensionOAuth, type ExtensionOAuthDeclaration } from "./oauth-manifest.js";

export interface ExtensionNetworkSecret {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  readonly source?: "oauth";
  readonly oauth?: ExtensionOAuthDeclaration;
  readonly inject: { readonly hosts?: readonly string[]; readonly header: string; readonly format: string };
  readonly exchange?: { readonly url: string; readonly bodyFormat: string; readonly contentType?: "application/json" | "application/x-www-form-urlencoded"; readonly tokenPath: string; readonly ttlSeconds?: number };
  readonly check?: { readonly url: string; readonly bodyFormat: string; readonly validPath: string; readonly validValue: string | number | boolean;
    readonly expiresAtPath?: string; readonly expiresAtFormat?: "iso" | "unix-seconds" | "unix-milliseconds" };
}
export interface ExtensionNetworkDeclaration {
  readonly hosts: readonly string[];
  readonly secrets?: readonly ExtensionNetworkSecret[];
  readonly connections?: readonly ExtensionNetworkConnection[];
}
export interface ExtensionNetworkConnection {
  readonly key: string; readonly label: string; readonly hint?: string;
  readonly inject: { readonly header: string; readonly format: string };
  readonly maxConnections?: number;
}
export function extensionNetworkHostMatches(pattern: string, hostname: string): boolean {
  return pattern.startsWith("*.") ? hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1 : pattern === hostname;
}
function object(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error("Extension network declaration is invalid.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Extension network declaration contains invalid text.");
  return value;
}
function host(value: unknown): string {
  const pattern = text(value, 253), bare = pattern.startsWith("*.") ? pattern.slice(2) : pattern;
  const labels = bare.split(".");
  if (pattern !== pattern.toLowerCase() || labels.length < 2 || labels.every(label => /^\d+$/u.test(label))
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) throw new Error("Extension network host is invalid.");
  return pattern;
}
export function normalizeExtensionConnectionHost(value: unknown): string {
  if (typeof value !== "string" || value.includes("*")) throw new Error("Extension connection requires a concrete host.");
  return host(value.trim().toLowerCase());
}
export function extensionNetworkUrl(value: unknown, hosts: readonly string[]): URL {
  const parsed = new URL(text(value, 2048));
  if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.username || parsed.password
    || !hosts.some(pattern => extensionNetworkHostMatches(pattern, parsed.hostname))) throw new Error("Extension network destination is not approved.");
  return parsed;
}
export function parseExtensionNetwork(value: unknown): ExtensionNetworkDeclaration {
  const raw = object(value, ["hosts", "secrets", "connections"], []);
  if (raw.hosts !== undefined && (!Array.isArray(raw.hosts) || raw.hosts.length > 8)) throw new Error("Extension network may declare at most eight hosts.");
  const hosts = ((raw.hosts ?? []) as unknown[]).map(host);
  if (new Set(hosts).size !== hosts.length) throw new Error("Extension network hosts must be unique.");
  let connections: ExtensionNetworkConnection[] | undefined;
  if (raw.connections !== undefined) {
    if (!Array.isArray(raw.connections) || raw.connections.length < 1 || raw.connections.length > 2) throw new Error("Extension network may declare one or two connection types.");
    connections = raw.connections.map(value => {
      const data = object(value, ["key", "label", "hint", "inject", "maxConnections"], ["key", "label", "inject"]);
      const key = text(data.key, 32), label = text(data.label, 64), inject = object(data.inject, ["header", "format"], ["header", "format"]);
      const header = text(inject.header, 64), format = text(inject.format, 200);
      if (!/^[a-z][a-z0-9_]{0,31}$/u.test(key) || ["constructor", "prototype"].includes(key)
        || !/^[A-Za-z0-9-]{1,64}$/u.test(header) || ["host", "cookie", "set-cookie", "content-length", "connection", "transfer-encoding", "origin", "referer"].includes(header.toLowerCase())
        || header.toLowerCase().startsWith("sec-") || header.toLowerCase().startsWith("proxy-") || format.split("{value}").length !== 2
        || data.maxConnections !== undefined && (typeof data.maxConnections !== "number" || !Number.isInteger(data.maxConnections) || data.maxConnections < 1 || data.maxConnections > 8)) throw new Error("Extension network connection declaration is invalid.");
      return { key, label, inject: { header, format }, ...(data.hint === undefined ? {} : { hint: text(data.hint, 200) }), ...(data.maxConnections === undefined ? {} : { maxConnections: data.maxConnections as number }) };
    });
    if (new Set(connections.map(value => value.key)).size !== connections.length) throw new Error("Extension network connection keys must be unique.");
  }
  if (hosts.length === 0 && !connections?.length) throw new Error("Extension network requires hosts or a connection declaration.");
  if (raw.secrets === undefined) return { hosts, ...(connections ? { connections } : {}) };
  if (!Array.isArray(raw.secrets) || raw.secrets.length > 4) throw new Error("Extension network may declare at most four secrets.");
  const secrets = raw.secrets.map(value => {
    const secret = object(value, ["key", "label", "hint", "inject", "exchange", "check", "source", "oauth"], ["key", "label", "inject"]);
    const key = text(secret.key, 32), label = text(secret.label, 80);
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(key)) throw new Error("Extension network secret key is invalid.");
    const inject = object(secret.inject, ["hosts", "header", "format"], ["header", "format"]);
    const header = text(inject.header, 128), format = text(inject.format, 2048);
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu.test(header) || ["host", "cookie", "set-cookie", "content-length", "connection", "transfer-encoding", "origin", "referer"].includes(header.toLowerCase())
      || header.toLowerCase().startsWith("sec-") || header.toLowerCase().startsWith("proxy-")
      || format.split("{value}").length !== 2) throw new Error("Extension network secret injection is invalid.");
    let injectionHosts: readonly string[] | undefined;
    if (inject.hosts !== undefined) {
      if (!Array.isArray(inject.hosts) || inject.hosts.length < 1 || inject.hosts.length > hosts.length) throw new Error("Extension secret hosts are invalid.");
      injectionHosts = inject.hosts.map(host);
      if (injectionHosts.some(value => !hosts.includes(value)) || new Set(injectionHosts).size !== injectionHosts.length) throw new Error("Extension secret hosts must be an exact subset of network hosts.");
    }
    let exchange: ExtensionNetworkSecret["exchange"];
    if (secret.exchange !== undefined) {
      const data = object(secret.exchange, ["url", "bodyFormat", "contentType", "tokenPath", "ttlSeconds"], ["url", "bodyFormat", "tokenPath"]);
      const url = extensionNetworkUrl(data.url, hosts).href, bodyFormat = text(data.bodyFormat, 2048), tokenPath = text(data.tokenPath, 256);
      if (bodyFormat.split("{value}").length !== 2 || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u.test(tokenPath)
        || data.contentType !== undefined && data.contentType !== "application/json" && data.contentType !== "application/x-www-form-urlencoded"
        || data.ttlSeconds !== undefined && (typeof data.ttlSeconds !== "number" || !Number.isInteger(data.ttlSeconds) || data.ttlSeconds < 60 || data.ttlSeconds > 30 * 24 * 3600)) throw new Error("Extension secret exchange is invalid.");
      exchange = { url, bodyFormat, tokenPath, ...(data.contentType === undefined ? {} : { contentType: data.contentType as "application/json" | "application/x-www-form-urlencoded" }),
        ...(data.ttlSeconds === undefined ? {} : { ttlSeconds: data.ttlSeconds as number }) };
    }
    if (secret.source !== undefined && secret.source !== "user" && secret.source !== "oauth" || secret.source === "oauth" && (secret.oauth === undefined || exchange !== undefined)
      || secret.source !== "oauth" && secret.oauth !== undefined) throw new Error("Extension network credential source is invalid.");
    const oauth = secret.source === "oauth" ? parseExtensionOAuth(secret.oauth, value => extensionNetworkUrl(value, hosts).href) : undefined;
    let check: ExtensionNetworkSecret["check"];
    if (secret.check !== undefined) {
      if (oauth) throw new Error("Only user-provided credentials can declare candidate validation.");
      const value = object(secret.check, ["url", "bodyFormat", "validPath", "validValue", "expiresAtPath", "expiresAtFormat"], ["url", "bodyFormat", "validPath", "validValue"]);
      const url = extensionNetworkUrl(value.url, hosts).href, bodyFormat = text(value.bodyFormat, 2048), validPath = text(value.validPath, 256);
      const path = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;
      if (!path.test(validPath) || bodyFormat.split("{value}").length !== 2
        || !["string", "number", "boolean"].includes(typeof value.validValue)
        || typeof value.validValue === "number" && !Number.isFinite(value.validValue)
        || typeof value.validValue === "string" && value.validValue.length > 1024
        || value.expiresAtPath !== undefined && (typeof value.expiresAtPath !== "string" || !path.test(value.expiresAtPath) || value.expiresAtPath.length > 256)
        || value.expiresAtFormat !== undefined && !["iso", "unix-seconds", "unix-milliseconds"].includes(String(value.expiresAtFormat))) throw new Error("Extension credential check is invalid.");
      try { JSON.parse(bodyFormat.replace("{value}", "example")); } catch { throw new Error("Extension credential check body must be JSON."); }
      check = { url, bodyFormat, validPath, validValue: value.validValue as string | number | boolean,
        ...(value.expiresAtPath === undefined ? {} : { expiresAtPath: value.expiresAtPath as string }),
        ...(value.expiresAtFormat === undefined ? {} : { expiresAtFormat: value.expiresAtFormat as NonNullable<ExtensionNetworkSecret["check"]>["expiresAtFormat"] }) };
    }
    return { key, label, ...(secret.hint === undefined ? {} : { hint: text(secret.hint, 200) }), inject: { header, format, ...(injectionHosts ? { hosts: injectionHosts } : {}) },
      ...(exchange ? { exchange } : {}), ...(check ? { check } : {}), ...(oauth ? { source: "oauth" as const, oauth } : {}) };
  });
  if (new Set(secrets.map(secret => secret.key)).size !== secrets.length || new Set(secrets.map(secret => secret.inject.header.toLowerCase())).size !== secrets.length) throw new Error("Extension network secret keys and headers must be unique.");
  if (connections?.some(connection => secrets.some(secret => secret.key === connection.key))) throw new Error("Extension connection and secret keys share one namespace.");
  return { hosts, secrets, ...(connections ? { connections } : {}) };
}

export function extensionConnectionScope(extensionId: string, declaration: ExtensionNetworkConnection): string {
  return createHash("sha256").update(JSON.stringify({ extensionId, key: declaration.key, inject: declaration.inject })).digest("hex");
}
export function extensionConnectionCredentialReference(extensionId: string, declaration: ExtensionNetworkConnection, id: string): string {
  return `extension-connection:${extensionConnectionScope(extensionId, declaration)}:${id}`;
}

/** A wider destination or different injection/exchange gets a fresh reservation.
 * Labels and presentation changes never transfer an existing secret's scope. */
export function extensionNetworkCredentialReference(extensionId: string, declaration: ExtensionNetworkDeclaration, secret: ExtensionNetworkSecret): string {
  const digest = createHash("sha256").update(JSON.stringify({ extensionId, key: secret.key, hosts: declaration.hosts, inject: secret.inject, exchange: secret.exchange })).digest("hex");
  return `extension-network:${digest}`;
}
