import { useCallback, useEffect, useRef } from "react";

interface ArtifactUrlCacheEntry {
  readonly blobId: string;
  promise: Promise<string>;
  acquired: boolean;
  releaseAfterAcquire: boolean;
}

/**
 * Keeps one authenticated URL lease per artifact for the active timeline owner.
 * Pending acquisitions are still released if the task changes before they finish.
 */
export function useTimelineArtifactUrlCache(
  ownerKey: string,
  acquire: (blobId: string) => Promise<string>,
  release: (blobId: string) => void
): (blobId: string) => Promise<string> {
  const acquireRef = useRef(acquire);
  acquireRef.current = acquire;
  const releaseRef = useRef(release);
  releaseRef.current = release;
  const entriesRef = useRef(new Map<string, ArtifactUrlCacheEntry>());

  const releaseAll = useCallback((): void => {
    const entries = entriesRef.current;
    entriesRef.current = new Map();
    for (const entry of entries.values()) {
      if (entry.acquired) releaseRef.current(entry.blobId);
      else entry.releaseAfterAcquire = true;
    }
  }, []);

  const load = useCallback((blobId: string): Promise<string> => {
    const cached = entriesRef.current.get(blobId);
    if (cached !== undefined) return cached.promise;

    const entry = {
      blobId,
      promise: Promise.resolve(""),
      acquired: false,
      releaseAfterAcquire: false
    } as ArtifactUrlCacheEntry;
    const pending = acquireRef.current(blobId).then((url) => {
      entry.acquired = true;
      if (entry.releaseAfterAcquire) releaseRef.current(blobId);
      return url;
    }).catch((error: unknown) => {
      if (entriesRef.current.get(blobId) === entry) entriesRef.current.delete(blobId);
      throw error;
    });
    entry.promise = pending;
    entriesRef.current.set(blobId, entry);
    return pending;
  }, []);

  useEffect(() => () => releaseAll(), [ownerKey, releaseAll]);
  return load;
}
