/**
 * Resolve the release feed supplied by the packaging environment. Update
 * endpoints are executable-distribution infrastructure, so fail closed on
 * insecure origins and URL fields that commonly carry credentials.
 */
export function resolveDesktopUpdateFeedUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (candidate === undefined || candidate.length === 0) return undefined;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || url.hostname.length === 0
      || url.username.length > 0
      || url.password.length > 0
      || url.search.length > 0
      || url.hash.length > 0
    ) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
