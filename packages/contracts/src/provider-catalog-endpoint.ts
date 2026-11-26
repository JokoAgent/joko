/** An explicit catalog may only receive credentials from its inference origin. */
export function sameOriginProviderCatalogEndpoint(base: URL, endpoint: URL): boolean {
  if (base.protocol !== endpoint.protocol || base.origin !== endpoint.origin || endpoint.username || endpoint.password || endpoint.hash) return false;
  if ([...endpoint.searchParams.keys()].some(key => /(?:token|secret|key|password|auth|credential)/iu.test(key))) return false;
  const versions = endpoint.searchParams.getAll("client_version");
  if (versions.length === 0) return true;
  // Self-hosted Responses gateways use this version marker to advertise compatible models.
  return endpoint.pathname === base.pathname.replace(/\/+$/u, "") + "/models"
    && versions.length === 1 && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(versions[0]!);
}

export function resolveProviderCatalogEndpoint(baseUrl: string | URL, value: string): URL | undefined {
  try {
    const base = new URL(baseUrl);
    const endpoint = value.startsWith("/") && !value.startsWith("//") ? new URL(value, base) : new URL(value);
    return sameOriginProviderCatalogEndpoint(base, endpoint) ? endpoint : undefined;
  } catch { return undefined; }
}

export const GEMINI_CHAT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai";

export function isGeminiChatEndpoint(endpoint: string | undefined): boolean {
  return endpoint?.replace(/\/+$/u, "") === GEMINI_CHAT_ENDPOINT;
}
