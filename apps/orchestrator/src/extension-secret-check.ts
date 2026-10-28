import { extensionNetworkUrl, type ExtensionNetworkDeclaration, type ExtensionNetworkSecret } from "./extension-cards/network-manifest.js";

const MAXIMUM_BYTES = 64 * 1024;
const pathValue = (value: unknown, path: string): unknown => {
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};

/** A candidate never enters installed credentials or the runtime exchange cache.
 * Only a locally constructed boolean and optional timestamp leave this call. */
export async function checkExtensionSecretCandidate(input: {
  readonly declaration: ExtensionNetworkDeclaration; readonly secret: ExtensionNetworkSecret; readonly value: string;
  readonly fetch: typeof fetch; readonly signal: AbortSignal; readonly assertCurrent: () => void;
}): Promise<{ readonly valid: boolean; readonly expiresAt?: number }> {
  const { secret, value } = input;
  if (!secret.check || secret.source === "oauth" || !value || Buffer.byteLength(value) > MAXIMUM_BYTES || /[\r\n]/u.test(value)) {
    throw new Error("The credential candidate cannot be checked.");
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
  const current = () => { signal.throwIfAborted(); input.assertCurrent(); };
  const post = async (url: string, body: string, headers: Record<string, string>) => {
    current();
    const response = await input.fetch(extensionNetworkUrl(url, input.declaration.hosts), { method: "POST", body, headers, redirect: "manual", signal });
    try {
      current();
      if (!response.ok || !response.body || response.headers.has("content-length") && Number(response.headers.get("content-length")) > MAXIMUM_BYTES) throw new Error();
      const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read(); current(); if (chunk.done) break;
          size += chunk.value.byteLength; if (size > MAXIMUM_BYTES) throw new Error(); chunks.push(Buffer.from(chunk.value));
        }
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
      } finally { await reader.cancel().catch(() => undefined); }
    } finally { await response.body?.cancel().catch(() => undefined); }
  };
  try {
    let token = value;
    if (secret.exchange) {
      const exchange = secret.exchange, contentType = exchange.contentType ?? "application/json";
      const encoded = contentType === "application/json" ? JSON.stringify(value).slice(1, -1) : encodeURIComponent(value);
      const response = await post(exchange.url, exchange.bodyFormat.replace("{value}", () => encoded), { "content-type": contentType });
      const result = pathValue(response, exchange.tokenPath);
      if (typeof result !== "string" || !result || Buffer.byteLength(result) > MAXIMUM_BYTES || /[\r\n]/u.test(result)) throw new Error();
      token = result;
    }
    const check = secret.check;
    const data = await post(check.url, check.bodyFormat.replace("{value}", () => JSON.stringify(value).slice(1, -1)), {
      "content-type": "application/json", [secret.inject.header]: secret.inject.format.replace("{value}", () => token)
    });
    const valid = pathValue(data, check.validPath);
    if (typeof valid !== typeof check.validValue) throw new Error();
    let expiresAt: number | undefined;
    if (check.expiresAtPath) {
      const expiry = pathValue(data, check.expiresAtPath);
      if (expiry !== undefined && expiry !== null) {
        if ((check.expiresAtFormat ?? "iso") === "iso") {
          if (typeof expiry !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(expiry)) throw new Error();
          expiresAt = Date.parse(expiry);
        } else {
          if (typeof expiry !== "number") throw new Error();
          expiresAt = expiry * (check.expiresAtFormat === "unix-seconds" ? 1000 : 1);
        }
        if (!Number.isFinite(expiresAt) || expiresAt < 0 || expiresAt > 253402300799999) throw new Error();
      }
    }
    current(); return { valid: valid === check.validValue, ...(expiresAt === undefined ? {} : { expiresAt }) };
  } catch { throw new Error("The credential check could not be completed."); }
}
