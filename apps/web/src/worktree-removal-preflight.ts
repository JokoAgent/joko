import type { SessionWorktreeRemovalPreviewView } from "./model.js";
import { readSessionArchivePreview, type SessionArchivePreview } from "@joko/contracts";

export type WorktreeRemovalPreflight = "clean" | "dirty" | "unknown";

export interface WorktreeRemovalPreflightSummary {
  readonly clean: number;
  readonly dirty: number;
  readonly unknown: number;
  readonly activeBoundScheduleCount?: number;
  readonly activeBoundScheduleNames?: readonly string[];
  readonly archiveConfirmations?: Readonly<Record<string, string>>;
  readonly archiveUnavailable?: boolean;
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

/** Archive bindings are always read afresh, independently of the dirty-worktree cache. */
export async function summarizeSessionArchivePreflights(
  sessionIds: readonly string[],
  readPreview: (sessionId: string, signal: AbortSignal) => Promise<SessionWorktreeRemovalPreviewView>
): Promise<WorktreeRemovalPreflightSummary> {
  const results = await Promise.all([...new Set(sessionIds)].map(async (sessionId) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => readPreview(sessionId, controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Archive preview timed out."));
          }, 3_000);
        })
      ]);
      return { sessionId, preview: readSessionArchivePreview(value as SessionArchivePreview) };
    } catch { return { sessionId, preview: undefined }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }));
  return {
    clean: results.filter(({ preview }) => preview !== undefined && !preview.dirty).length,
    dirty: results.filter(({ preview }) => preview?.dirty === true).length,
    unknown: results.filter(({ preview }) => preview === undefined).length,
    archiveUnavailable: results.some(({ preview }) => preview === undefined),
    activeBoundScheduleCount: results.reduce((count, { preview }) => count + (preview?.activeBoundScheduleCount ?? 0), 0),
    activeBoundScheduleNames: results.flatMap(({ preview }) => preview?.activeBoundScheduleNames ?? []).slice(0, 20),
    archiveConfirmations: Object.fromEntries(results.flatMap(({ sessionId, preview }) =>
      preview === undefined ? [] : [[sessionId, preview.archiveConfirmation]]))
  };
}

function cacheKey(ownerId: string, sessionId: string): string {
  return `${ownerId.length}:${ownerId}${sessionId}`;
}
