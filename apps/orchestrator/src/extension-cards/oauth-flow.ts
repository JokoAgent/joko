import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { extensionNetworkUrl } from "./network-manifest.js";
import type { ExtensionOAuthDeclaration } from "./oauth-manifest.js";

export interface ExtensionOAuthClient extends ExtensionOAuthDeclaration { readonly clientId: string; readonly hosts: readonly string[] }
export interface ExtensionOAuthOffer { readonly authorizeUrl: string; readonly callbackUrl: string; readonly state: string; readonly corsOrigins: readonly string[]; readonly corsHosts: readonly string[] }
export interface ExtensionOAuthCallback { readonly state: string; readonly code?: string; readonly error?: string }
export interface ExtensionOAuthTokens { readonly accessToken: string; readonly refreshToken: string | null; readonly expiresAt: number | null; readonly grantedScope: string | null }
export type ExtensionOAuthTokenResult = { readonly ok: true; readonly tokens: ExtensionOAuthTokens } | { readonly ok: false; readonly error: "EXCHANGE_FAILED" | "REFRESH_FAILED" | "INVALID_GRANT" | "NETWORK" };
interface Scope { readonly signal: AbortSignal; readonly assertCurrent: () => void }
interface Options extends Scope { readonly fetch: typeof fetch; readonly client: ExtensionOAuthClient }

function current(scope: Scope): void { scope.signal.throwIfAborted(); scope.assertCurrent(); }
/** Only the validated controller receives this offer; the verifier stays in the
 * service and the callback code returns through the protected input channel. */
export async function prepareExtensionOAuth(client: ExtensionOAuthClient, scope: Scope): Promise<{ readonly offer: ExtensionOAuthOffer; exchange(callback: ExtensionOAuthCallback, fetchImpl: typeof fetch): Promise<ExtensionOAuthTokenResult> }> {
  current(scope);
  if (!client.clientId || client.clientId.length > 200 || /\s/u.test(client.clientId)) throw new Error("OAuth client is unavailable.");
  extensionNetworkUrl(client.authorizeUrl, client.hosts); extensionNetworkUrl(client.tokenUrl, client.hosts);
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", () => reject(new Error("OAuth callback port is unavailable.")));
    server.listen(client.redirectPort ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("OAuth callback address is unavailable.")); return; }
      server.close(error => error ? reject(new Error("OAuth callback listener could not close.")) : resolve(address.port));
    });
  });
  current(scope);
  const state = randomBytes(32).toString("base64url"), verifier = client.pkce === false ? undefined : randomBytes(32).toString("base64url");
  const callbackUrl = `http://127.0.0.1:${port}/callback`, authorize = extensionNetworkUrl(client.authorizeUrl, client.hosts);
  for (const [key, value] of Object.entries(client.extraAuthorizeParams ?? {})) authorize.searchParams.set(key, value);
  authorize.searchParams.set("response_type", "code"); authorize.searchParams.set("client_id", client.clientId); authorize.searchParams.set("redirect_uri", callbackUrl); authorize.searchParams.set("state", state);
  if (client.scopes.length) authorize.searchParams.set("scope", client.scopes.join(client.scopeDelimiter ?? " "));
  if (verifier) { authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url")); authorize.searchParams.set("code_challenge_method", "S256"); }
  let claimed = false;
  return { offer: { authorizeUrl: authorize.href, callbackUrl, state, corsOrigins: [...new Set([new URL(client.authorizeUrl).origin, new URL(client.tokenUrl).origin])], corsHosts: [...client.hosts] },
    exchange: async (callback, fetchImpl) => {
      current(scope);
      if (claimed || callback.state !== state || !callback.code || callback.code.length > 8192 || callback.error !== undefined || /[\u0000-\u001f\u007f]/u.test(callback.code)) throw new Error("OAuth callback is unavailable.");
      claimed = true;
      const form = new URLSearchParams({ grant_type: "authorization_code", code: callback.code, redirect_uri: callbackUrl, client_id: client.clientId });
      if (client.clientSecret) form.set("client_secret", client.clientSecret);
      if (verifier) form.set("code_verifier", verifier);
      return tokenRequest({ ...scope, client, fetch: fetchImpl }, form);
    } };
}

export function refreshExtensionOAuth(options: Options, refreshToken: string): Promise<ExtensionOAuthTokenResult> {
  current(options);
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: options.client.clientId });
  if (options.client.clientSecret) form.set("client_secret", options.client.clientSecret);
  return tokenRequest(options, form, refreshToken);
}
async function tokenRequest(options: Options, form: URLSearchParams, previousRefresh?: string): Promise<ExtensionOAuthTokenResult> {
  let response: Response;
  try {
    response = await scopedFetch(options, options.client.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() });
  } catch { current(options); return { ok: false, error: "NETWORK" }; }
  try {
    const parsed = JSON.parse(await boundedText(response, 256 * 1024, options)) as Record<string, unknown>;
    current(options);
    if (!response.ok) return { ok: false, error: previousRefresh && parsed.error === "invalid_grant" ? "INVALID_GRANT" : previousRefresh ? "REFRESH_FAILED" : "EXCHANGE_FAILED" };
    if (typeof parsed.access_token !== "string" || !parsed.access_token || /[\r\n\u0000]/u.test(parsed.access_token)) return { ok: false, error: previousRefresh ? "REFRESH_FAILED" : "EXCHANGE_FAILED" };
    const expires = typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in) ? parsed.expires_in : null;
    return { ok: true, tokens: { accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === "string" && parsed.refresh_token ? parsed.refresh_token : previousRefresh ?? null,
      expiresAt: expires === null ? null : Date.now() + Math.max(0, expires * 1000 - 60_000), grantedScope: typeof parsed.scope === "string" && parsed.scope ? parsed.scope : null } };
  } catch { current(options); return { ok: false, error: previousRefresh ? "REFRESH_FAILED" : "EXCHANGE_FAILED" }; }
}
export async function scopedFetch(options: Options, input: string, init: RequestInit): Promise<Response> {
  let url = extensionNetworkUrl(input, options.client.hosts), method = init.method ?? "GET", body = init.body;
  const headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    current(options);
    const response = await options.fetch(url, { ...init, method, headers, body: body ?? null, redirect: "manual", signal: options.signal });
    try { current(options); } catch (error) { await response.body?.cancel().catch(() => undefined); throw error; }
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response;
    await response.body?.cancel(); current(options);
    if (hop >= 3) throw new Error("OAuth redirect limit reached.");
    const next = extensionNetworkUrl(new URL(location, url).href, options.client.hosts);
    if (next.origin !== url.origin) headers.delete("authorization");
    url = next;
    if (response.status === 303 || [301, 302].includes(response.status) && method === "POST") { method = "GET"; body = undefined; headers.delete("content-type"); headers.delete("content-encoding"); }
  }
}
export async function boundedText(response: Response, limit: number, scope: Scope): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { current(scope); const read = await reader.read(); current(scope); if (read.done) break; length += read.value.byteLength;
      if (length > limit) throw new Error("OAuth response limit reached."); chunks.push(read.value); }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function readExtensionOAuthIdentity(options: Options, accessToken: string, redact: (value: string) => string): Promise<{ readonly label?: string; readonly displayLabel?: string }> {
  const identity = options.client.identity; if (!identity) return {};
  try {
    const response = await scopedFetch(options, identity.url, { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (!response.ok) { await response.body?.cancel(); return {}; }
    const data: unknown = JSON.parse(await boundedText(response, 256 * 1024, options));
    const at = (path: string): string | undefined => {
      let value: unknown = data;
      for (const part of path.split(".")) { if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part)) return; value = (value as Record<string, unknown>)[part]; }
      return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value) && redact(value) === value ? value : undefined;
    };
    const label = at(identity.labelPath); let displayLabel: string | undefined;
    if (identity.displayTemplate) {
      let broken = false; const rendered = identity.displayTemplate.replace(/\{([^{}]+)\}/gu, (_match, path: string) => { const value = at(path); if (!value) broken = true; return value ?? ""; });
      if (!broken && rendered.length > 0 && rendered.length <= 200 && redact(rendered) === rendered) displayLabel = rendered;
    }
    // Arbitrary avatar URLs are a privileged host read primitive in the fixed
    // implementation. Ordinary installed plugins do not obtain that capability.
    return { ...(label ? { label } : {}), ...(displayLabel ? { displayLabel } : {}) };
  } catch { current(options); return {}; }
}
