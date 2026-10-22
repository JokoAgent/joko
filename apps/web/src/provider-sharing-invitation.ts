import { parseProviderSharingLink, PROVIDER_SHARING_LINK_PATH } from "@joko/contracts";

let invitation: string | undefined;

/** Strip the private fragment before the application router or any RPC starts.
 * Joining always requires the owner's explicit preview and comparison. */
export function captureProviderSharingInvitation(location: Pick<Location, "href" | "pathname">, history: Pick<History, "replaceState" | "state">): void {
  if (!location.pathname.endsWith(PROVIDER_SHARING_LINK_PATH)) return;
  const candidate = location.href, path = location.pathname.slice(0, -PROVIDER_SHARING_LINK_PATH.length) || "/";
  history.replaceState(history.state, "", `${path}#/settings/sharing`);
  try { parseProviderSharingLink(candidate); invitation = candidate; } catch { invitation = undefined; }
}
export function readProviderSharingInvitation(): string | undefined { return invitation; }
export function clearProviderSharingInvitation(expected?: string): void { if (expected === undefined || invitation === expected) invitation = undefined; }
