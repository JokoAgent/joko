import type { Event } from "@joko/contracts";
import type { MobileNativeTreeSnapshot } from "./mobile-native-tree";
import { timelineRows } from "./timeline";
import {
  boundMobileComposerMessageReference,
  type MobileComposerRouteResolutionTarget
} from "./mobile-composer-route-links";

export function referencedMobileTimelineText(
  events: readonly Event[],
  target: Extract<MobileComposerRouteResolutionTarget, { readonly kind: "message" }>
): string | undefined {
  const identities = new Set([target.messageId, target.eventId]
    .filter((value): value is string => value !== undefined));
  if (identities.size === 0) return undefined;
  const row = timelineRows(events).find((candidate) =>
    identities.has(candidate.id) || identities.has(candidate.eventId));
  if (row?.kind !== "user" && row?.kind !== "assistant") return undefined;
  const text = boundMobileComposerMessageReference(row.text);
  return text === "" ? undefined : text;
}

export function referencedMobileNativeTreeText(
  tree: MobileNativeTreeSnapshot,
  messageId: string
): string | undefined {
  const matches = tree.rows.filter((row) => row.entryId === messageId
    && row.kind === "message" && (row.role === "user" || row.role === "assistant"));
  if (matches.length !== 1) return undefined;
  const text = boundMobileComposerMessageReference(matches[0]!.label);
  return text === "" ? undefined : text;
}
