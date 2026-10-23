import type { TimelineHistoryCursorView, TimelineItemView } from "./model.js";

export interface CachedTimelineHistory {
  readonly sessionId: string;
  readonly generation: bigint;
  readonly historyRevision: bigint;
  readonly ownerKey?: string;
  readonly sourceVersion?: string;
  readonly items: readonly TimelineItemView[];
  readonly nextBeforeCursor?: TimelineHistoryCursorView;
  readonly initialized: boolean;
}

/** Whole windows survive navigation until the shared count/text budget needs space. */
export class TimelineHistoryCache {
  readonly #entries = new Map<string, { readonly history: CachedTimelineHistory; readonly characters: number }>();
  constructor(private readonly budget = { sessions: 20, items: 4_000, characters: 32 * 1024 * 1024 }) {}
  clear(): void { this.#entries.clear(); }
  get(ownerKey: string): CachedTimelineHistory | undefined {
    const entry = this.#entries.get(ownerKey);
    if (!entry) return undefined;
    this.#entries.delete(ownerKey); this.#entries.set(ownerKey, entry);
    return entry.history;
  }
  set(history: CachedTimelineHistory): void {
    if (!history.ownerKey || !history.initialized) return;
    const characters = JSON.stringify(history, (_key, value: unknown) => typeof value === "bigint" ? value.toString(10) : value).length;
    this.#entries.delete(history.ownerKey);
    if (history.items.length > this.budget.items || characters > this.budget.characters) return;
    this.#entries.set(history.ownerKey, { history, characters });
    let items = 0, total = 0;
    for (const entry of this.#entries.values()) { items += entry.history.items.length; total += entry.characters; }
    while (this.#entries.size > this.budget.sessions || items > this.budget.items || total > this.budget.characters) {
      const first = this.#entries.keys().next().value as string | undefined;
      if (first === undefined) break;
      const entry = this.#entries.get(first)!; this.#entries.delete(first);
      items -= entry.history.items.length; total -= entry.characters;
    }
  }
}

export function timelineHistoryOwnerKey(profile: { readonly id: string; readonly origin: string; readonly serverId: string } | undefined,
  generation: bigint, sessionId: string, nativeGeneration: bigint, historyRevision: bigint): string | undefined {
  return profile ? JSON.stringify([profile.id, profile.origin, profile.serverId, generation.toString(10), sessionId,
    nativeGeneration.toString(10), historyRevision.toString(10)]) : undefined;
}
