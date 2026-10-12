import type { TimelineRow } from "./timeline";
import { isWorkGroup, type MobileWorkItem } from "./mobile-work-projection";

export interface MobileConversationSearchHit { readonly itemKey: string; readonly sourceKey: string }
export interface MobileConversationSearchText extends MobileConversationSearchHit { readonly text: string }

/** Each rendered top-level item has at most one hit. Nested work points to its
 * visible parent; pending inputs and private hidden rows are never searched. */
export function findMobileConversationSearchHits(items: readonly MobileWorkItem<TimelineRow>[], query: string,
  additional: readonly MobileConversationSearchText[] = []): MobileConversationSearchHit[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const search = (item: MobileWorkItem<TimelineRow>, itemKey: string): MobileConversationSearchHit | undefined => {
    if (isWorkGroup(item)) {
      for (const child of item.children) { const found = search(child, itemKey); if (found) return found; }
      return undefined;
    }
    if (item.optimistic || item.internalInput) return undefined;
    const text = [item.label, item.text, item.tool?.name, item.tool?.input, item.tool?.output, item.tool?.error,
      ...item.messageParts?.flatMap((part) => part.kind === "text" ? [part.text] : part.kind === "thinking" ? [part.thinking.text] : []) ?? [],
      ...item.plan?.steps.flatMap((step) => [step.content, step.activeForm ?? "", step.state]) ?? [],
      ...item.images?.flatMap((image) => [image.title, image.mediaType]) ?? [],
      ...item.artifacts?.flatMap((artifact) => [artifact.title, artifact.mediaType]) ?? []].filter(Boolean).join("\n");
    return normalizeSearchText(text).includes(normalized) ? { itemKey, sourceKey: item.id } : undefined;
  };
  return [...items.flatMap((item) => { const hit = search(item, item.id); return hit ? [hit] : []; }),
    ...additional.flatMap((item) => normalizeSearchText(item.text).includes(normalized) ? [{ itemKey: item.itemKey, sourceKey: item.sourceKey }] : [])];
}

export function normalizeConversationSearchIndex(hitCount: number, currentIndex: number): number {
  if (hitCount <= 0) return -1;
  if (!Number.isFinite(currentIndex) || currentIndex < 0) return 0;
  return currentIndex >= hitCount ? hitCount - 1 : currentIndex;
}

export function nextConversationSearchIndex(hitCount: number, currentIndex: number, direction: "previous" | "next"): number {
  if (hitCount <= 0) return -1;
  if (!Number.isFinite(currentIndex) || currentIndex < 0) return direction === "previous" ? hitCount - 1 : 0;
  const normalized = normalizeConversationSearchIndex(hitCount, currentIndex);
  return direction === "previous" ? (normalized - 1 + hitCount) % hitCount : (normalized + 1) % hitCount;
}

function normalizeSearchText(value: string): string { return value.trim().replace(/\s+/g, " ").toLocaleLowerCase(); }
