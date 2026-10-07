export const HOME_SUGGESTION_NARROW_COUNT = 2;
export const HOME_SUGGESTION_BATCH_SIZE = 4;
export const HOME_SUGGESTIONS_HIDDEN_KEY = "joko.homeSuggestions.hidden";

export type HomeSuggestionVisibleCount =
  | typeof HOME_SUGGESTION_NARROW_COUNT
  | typeof HOME_SUGGESTION_BATCH_SIZE;

/** Broad user scenarios rather than individual implementation actions. */
export const HOME_SUGGESTION_CATALOG = [
  { id: "storageUsage", category: "computer" },
  { id: "whySlow", category: "computer" },
  { id: "downloadsDesktop", category: "computer" },
  { id: "diagnoseNetwork", category: "computer" },
  { id: "unusedApps", category: "computer" },
  { id: "stockDigest", category: "automation" },
  { id: "morningBrief", category: "automation" },
  { id: "watchWebpage", category: "automation" },
  { id: "expenseTracker", category: "create" },
  { id: "kidsGame", category: "create" },
  { id: "habitTracker", category: "create" },
  { id: "recentDocs", category: "documents" },
  { id: "subscriptionSpend", category: "documents" },
  { id: "organizeFolder", category: "documents" },
  { id: "photoTimeline", category: "photos" },
  { id: "photoAlbumPage", category: "photos" },
  { id: "uncommittedChanges", category: "development" },
  { id: "exploreRepo", category: "development" },
  { id: "initAgentDoc", category: "development" },
  { id: "listCodeProjects", category: "development" },
  { id: "devEnvironment", category: "development" },
  { id: "makeExtension", category: "product" },
  { id: "sendProductFeedback", category: "product" },
  { id: "exploreProductSource", category: "product" },
  { id: "discoverCapabilities", category: "discovery" }
] as const;

export type HomeSuggestionId = (typeof HOME_SUGGESTION_CATALOG)[number]["id"];
export type HomeSuggestionCategory = (typeof HOME_SUGGESTION_CATALOG)[number]["category"];
export const HOME_SUGGESTION_IDS: readonly HomeSuggestionId[] = HOME_SUGGESTION_CATALOG.map(({ id }) => id);

export interface HomeSuggestionCandidate {
  /** Globally unique identity and broad category assigned by the host. */
  readonly id: string;
  readonly category: string;
  readonly extensionId?: string;
  readonly needsInstall?: boolean;
}

export interface HomeSuggestionBatchOptions<T extends HomeSuggestionCandidate> {
  readonly size?: HomeSuggestionVisibleCount;
  readonly pinnedId?: string;
  readonly fallback?: readonly T[];
}

/** Candidates arrive in host priority order; every position shares the same quotas. */
export function selectHomeSuggestionBatch<T extends HomeSuggestionCandidate>(
  candidates: readonly T[],
  {
    size = HOME_SUGGESTION_BATCH_SIZE,
    pinnedId,
    fallback = []
  }: HomeSuggestionBatchOptions<T> = {}
): T[] {
  const selected: T[] = [];
  const ids = new Set<string>();
  const categories = new Set<string>();
  const extensions = new Set<string>();
  let installGuideSelected = false;
  // A withdrawn candidate cannot be revived merely because its old ID was pinned.
  const pinned = candidates.find(({ id }) => id === pinnedId);
  for (const candidate of [...(pinned === undefined ? [] : [pinned]), ...candidates, ...fallback]) {
    if (
      ids.has(candidate.id)
      || categories.has(candidate.category)
      || candidate.extensionId !== undefined && extensions.has(candidate.extensionId)
      || candidate.needsInstall === true && installGuideSelected
    ) {
      continue;
    }
    selected.push(candidate);
    ids.add(candidate.id);
    categories.add(candidate.category);
    if (candidate.extensionId !== undefined) extensions.add(candidate.extensionId);
    if (candidate.needsInstall === true) installGuideSelected = true;
    if (selected.length === size) break;
  }
  return selected;
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

/** Gives every broad category one draw regardless of how many topics it owns. */
export function randomCategoryOrder<T extends HomeSuggestionCandidate>(
  candidates: readonly T[],
  random: () => number
): T[] {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.category) ?? [];
    group.push(candidate);
    groups.set(candidate.category, group);
  }
  return shuffled([...groups.values()], random).flatMap((group) => shuffled(group, random));
}

export interface HomeSuggestionBatchState {
  readonly ids: readonly HomeSuggestionId[];
  readonly seenIds: readonly HomeSuggestionId[];
  /** Largest number of rows actually displayed from this batch. */
  readonly displayedCount: HomeSuggestionVisibleCount;
}

/**
 * Marks a prepared batch as displayed at a new width without drawing again.
 * Shrinking retains the larger display history; widening reveals the two
 * already-prepared rows and makes them eligible for history on the next draw.
 */
export function markHomeSuggestionBatchDisplayed(
  state: HomeSuggestionBatchState,
  visibleCount: HomeSuggestionVisibleCount
): HomeSuggestionBatchState {
  return visibleCount <= state.displayedCount ? state : { ...state, displayedCount: visibleCount };
}

export function visibleHomeSuggestionIds(
  state: HomeSuggestionBatchState,
  visibleCount: HomeSuggestionVisibleCount
): readonly HomeSuggestionId[] {
  return state.ids.slice(0, visibleCount);
}

/** Draws unseen topics first while excluding every topic shown in the prior batch. */
export function nextHomeSuggestionBatch(
  previous: HomeSuggestionBatchState | null = null,
  visibleCount: HomeSuggestionVisibleCount = HOME_SUGGESTION_BATCH_SIZE,
  random: () => number = Math.random
): HomeSuggestionBatchState {
  const previousIds = new Set(previous?.ids.slice(0, previous.displayedCount));
  const seen = new Set<HomeSuggestionId>([...(previous?.seenIds ?? []), ...previousIds]);
  if (seen.size === HOME_SUGGESTION_CATALOG.length) seen.clear();

  const available = HOME_SUGGESTION_CATALOG.filter(({ id }) => !previousIds.has(id));
  const unseen = available.filter(({ id }) => !seen.has(id));
  const seenBefore = available.filter(({ id }) => seen.has(id));
  const candidates = [
    ...randomCategoryOrder(unseen, random),
    ...randomCategoryOrder(seenBefore, random)
  ];
  const selected = selectHomeSuggestionBatch(candidates, {
    fallback: randomCategoryOrder(
      HOME_SUGGESTION_CATALOG.filter(({ id }) => previousIds.has(id)),
      random
    )
  });
  // Four rows are always prepared. Narrow layouts expose only two, so resizing
  // can preserve the batch instead of consuming a fresh random draw.
  return { ids: selected.map(({ id }) => id), seenIds: [...seen], displayedCount: visibleCount };
}

export function homeSuggestionLabelKey(
  id: HomeSuggestionId
): `newTask.homeSuggestions.${HomeSuggestionId}.label` {
  return `newTask.homeSuggestions.${id}.label`;
}

export function homeSuggestionPromptKey(
  id: HomeSuggestionId
): `newTask.homeSuggestions.${HomeSuggestionId}.prompt` {
  return `newTask.homeSuggestions.${id}.prompt`;
}

export function isHomeSuggestionsHidden(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(HOME_SUGGESTIONS_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setHomeSuggestionsHidden(hidden: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (hidden) localStorage.setItem(HOME_SUGGESTIONS_HIDDEN_KEY, "1");
    else localStorage.removeItem(HOME_SUGGESTIONS_HIDDEN_KEY);
  } catch {
    // The caller retains its in-memory state when storage is unavailable.
  }
}
