export interface ExtensionOAuthDeclaration {
  readonly authorizeUrl: string; readonly tokenUrl: string;
  readonly clientId?: string; readonly clientSecret?: string;
  readonly scopes: readonly string[]; readonly scopeDelimiter?: ","; readonly pkce?: boolean;
  readonly extraAuthorizeParams?: Readonly<Record<string, string>>;
  readonly identity?: { readonly url: string; readonly labelPath: string; readonly displayTemplate?: string; readonly avatarPath?: string };
  readonly redirectPort?: number;
}
export const EXTENSION_OAUTH_RESERVED_PARAMS = new Set(["response_type", "client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method"]);
const PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u;
function object(value: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error("Extension OAuth declaration is invalid.");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 200): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Extension OAuth text is invalid.");
  return value;
}
function path(value: unknown): string { const result = text(value, 128); if (!PATH.test(result)) throw new Error("Extension OAuth identity path is invalid."); return result; }
export function parseExtensionOAuth(value: unknown, approvedUrl: (value: unknown) => string): ExtensionOAuthDeclaration {
  const raw = object(value, ["authorizeUrl", "tokenUrl", "clientId", "clientSecret", "scopes", "scopeDelimiter", "pkce", "extraAuthorizeParams", "identity", "redirectPort"], ["authorizeUrl", "tokenUrl"]);
  const authorizeUrl = approvedUrl(raw.authorizeUrl), tokenUrl = approvedUrl(raw.tokenUrl);
  const clientId = raw.clientId === undefined ? undefined : text(raw.clientId), clientSecret = raw.clientSecret === undefined ? undefined : text(raw.clientSecret);
  if (clientId !== undefined && /\s/u.test(clientId) || clientSecret !== undefined && (/\s/u.test(clientSecret) || clientId === undefined)) throw new Error("Extension OAuth client declaration is invalid.");
  const scopes = raw.scopes ?? [];
  if (!Array.isArray(scopes) || scopes.length > 256 || scopes.some(scope => typeof scope !== "string" || !scope || scope.length > 200 || /\s|[\u0000-\u001f\u007f]/u.test(scope))
    || new Set(scopes).size !== scopes.length) throw new Error("Extension OAuth scopes are invalid.");
  if (raw.scopeDelimiter !== undefined && raw.scopeDelimiter !== "," || raw.pkce !== undefined && typeof raw.pkce !== "boolean"
    || raw.redirectPort !== undefined && (typeof raw.redirectPort !== "number" || !Number.isInteger(raw.redirectPort) || raw.redirectPort < 1024 || raw.redirectPort > 65535)) throw new Error("Extension OAuth options are invalid.");
  let extraAuthorizeParams: Record<string, string> | undefined;
  if (raw.extraAuthorizeParams !== undefined) {
    if (!raw.extraAuthorizeParams || typeof raw.extraAuthorizeParams !== "object" || Array.isArray(raw.extraAuthorizeParams) || Object.getPrototypeOf(raw.extraAuthorizeParams) !== Object.prototype) throw new Error("Extension OAuth parameters are invalid.");
    const entries = Object.entries(raw.extraAuthorizeParams);
    if (!entries.length || entries.length > 8 || entries.some(([key]) => !/^[a-z][a-z0-9_]{0,31}$/u.test(key) || EXTENSION_OAUTH_RESERVED_PARAMS.has(key))) throw new Error("Extension OAuth protocol parameters are reserved.");
    extraAuthorizeParams = Object.fromEntries(entries.map(([key, value]) => [key, text(value)]));
  }
  let identity: ExtensionOAuthDeclaration["identity"];
  if (raw.identity !== undefined) {
    const data = object(raw.identity, ["url", "labelPath", "displayTemplate", "avatarPath"], ["url", "labelPath"]);
    const displayTemplate = data.displayTemplate === undefined ? undefined : text(data.displayTemplate);
    if (displayTemplate !== undefined) {
      const placeholders = [...displayTemplate.matchAll(/\{([^{}]+)\}/gu)];
      if (!placeholders.length) throw new Error("Extension OAuth identity template requires a path.");
      for (const match of placeholders) path(match[1]);
    }
    identity = { url: approvedUrl(data.url), labelPath: path(data.labelPath), ...(displayTemplate === undefined ? {} : { displayTemplate }), ...(data.avatarPath === undefined ? {} : { avatarPath: path(data.avatarPath) }) };
  }
  return { authorizeUrl, tokenUrl, scopes: [...scopes] as string[], ...(clientId === undefined ? {} : { clientId }), ...(clientSecret === undefined ? {} : { clientSecret }),
    ...(raw.scopeDelimiter === undefined ? {} : { scopeDelimiter: "," }), ...(raw.pkce === undefined ? {} : { pkce: raw.pkce as boolean }),
    ...(extraAuthorizeParams ? { extraAuthorizeParams } : {}), ...(identity ? { identity } : {}), ...(raw.redirectPort === undefined ? {} : { redirectPort: raw.redirectPort as number }) };
}
