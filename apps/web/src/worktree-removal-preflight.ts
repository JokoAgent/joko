import type { SessionWorktreeRemovalPreviewView } from "./model.js";

export type WorktreeRemovalPreflight = "clean" | "dirty" | "unknown";

export interface WorktreeRemovalPreflightSummary {
  readonly clean: number;
  readonly dirty: number;
  readonly unknown: number;
}

export type WorktreeRemovalPreviewReader = (
  sessionId: string
) => Promise<SessionWorktreeRemovalPreviewView>;

const DIRTY_PREFLIGHT_TTL_MS = 8_000;

interface PreflightCacheEntry {
  readonly observedAt: number;
  readonly promise: Promise<WorktreeRemovalPreflight>;
  result?: WorktreeRemovalPreflight;
}

const preflightCache = new Map<string, PreflightCacheEntry>();

/** Resolve a removal preview without ever treating a failed query as clean.
 * Only a settled dirty result is safe to reuse: a cached clean result could
 * become stale after an editor writes to the checkout. */
export function resolveWorktreeRemovalPreflight(
  ownerId: string,
  sessionId: string,
  readPreview: WorktreeRemovalPreviewReader,
  now = Date.now()
): Promise<WorktreeRemovalPreflight> {
  const key = cacheKey(ownerId, sessionId);
  const cached = preflightCache.get(key);
  const cachedAge = cached === undefined ? undefined : now - cached.observedAt;
  if (cached?.result === "dirty" && cachedAge !== undefined && cachedAge >= 0 && cachedAge < DIRTY_PREFLIGHT_TTL_MS) {
    return cached.promise;
  }

  const promise = Promise.resolve().then(() => readPreview(sessionId)).then(
    (preview): WorktreeRemovalPreflight => {
      if (preview === undefined || typeof preview.hasWorktree !== "boolean" || typeof preview.dirty !== "boolean") {
        return "unknown";
      }
      if (!preview.hasWorktree && preview.dirty) return "unknown";
      return preview.hasWorktree && preview.dirty ? "dirty" : "clean";
    }
  ).catch((): WorktreeRemovalPreflight => "unknown");
  const entry: PreflightCacheEntry = { observedAt: now, promise };
  preflightCache.set(key, entry);
  void promise.then((result) => {
    if (preflightCache.get(key) === entry) entry.result = result;
  });
  for (const [candidate, value] of preflightCache) {
    if (now - value.observedAt >= DIRTY_PREFLIGHT_TTL_MS) preflightCache.delete(candidate);
  }
  return promise;
}

export function prefetchWorktreeRemovalPreflight(
  ownerId: string,
  sessionId: string,
  readPreview: WorktreeRemovalPreviewReader
): void {
  void resolveWorktreeRemovalPreflight(ownerId, sessionId, readPreview);
}

export async function summarizeWorktreeRemovalPreflights(
  ownerId: string,
  sessionIds: readonly string[],
  readPreview: WorktreeRemovalPreviewReader
): Promise<WorktreeRemovalPreflightSummary> {
  const uniqueSessionIds = [...new Set(sessionIds)];
  const results = await Promise.all(uniqueSessionIds.map((sessionId) =>
    resolveWorktreeRemovalPreflight(ownerId, sessionId, readPreview)
  ));
  return Object.freeze({
    clean: results.filter((result) => result === "clean").length,
    dirty: results.filter((result) => result === "dirty").length,
    unknown: results.filter((result) => result === "unknown").length
  });
}

export function resetWorktreeRemovalPreflightCache(): void {
  preflightCache.clear();
}

function cacheKey(ownerId: string, sessionId: string): string {
  return `${ownerId.length}:${ownerId}${sessionId}`;
}
