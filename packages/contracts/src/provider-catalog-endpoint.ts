/** An explicit catalog may only receive credentials from its inference origin. */
export function sameOriginProviderCatalogEndpoint(base: URL, endpoint: URL): boolean {
  if (base.protocol !== endpoint.protocol || base.origin !== endpoint.origin || endpoint.username || endpoint.password || endpoint.hash) return false;
  if (!endpoint.search) return true;
  // Self-hosted Responses gateways use this version marker to advertise compatible models.
  const query = [...endpoint.searchParams];
  return endpoint.pathname === base.pathname.replace(/\/+$/u, "") + "/models"
    && query.length === 1 && query[0]?.[0] === "client_version"
    && /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u.test(query[0][1]);
}

export const GEMINI_CHAT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai";

export function isGeminiChatEndpoint(endpoint: string | undefined): boolean {
  return endpoint?.replace(/\/+$/u, "") === GEMINI_CHAT_ENDPOINT;
}
