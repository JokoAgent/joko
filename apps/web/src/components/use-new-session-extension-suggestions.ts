import { useEffect, useRef, useState } from "react";
import type { AppController } from "../controller.js";
import type { ExtensionCatalogEntryView } from "../model.js";
import type { HomeTaskHints } from "../extension-home-suggestions.js";

const EMPTY_ENTRIES: readonly ExtensionCatalogEntryView[] = [];
const EMPTY_HINTS: HomeTaskHints = {};

/** A failed catalog read does not remove the built-in task suggestions. */
export function useNewSessionExtensionSuggestions(controller: AppController, contextKey: string | undefined, runtimeSessionId?: string, newlyInstalledId?: string, catalogRevision?: bigint): {
  readonly extensions: readonly ExtensionCatalogEntryView[];
  readonly hints: HomeTaskHints;
} {
  const currentKey = useRef(contextKey); currentKey.current = contextKey;
  const controllerRef = useRef(controller); controllerRef.current = controller;
  const [result, setResult] = useState<{ readonly key: string; readonly entries: readonly ExtensionCatalogEntryView[]; readonly recentIds: readonly string[] }>();
  useEffect(() => {
    setResult(undefined);
    const sourceController = controllerRef.current;
    if (contextKey === undefined || typeof sourceController.listExtensions !== "function") return;
    const request = new AbortController();
    void Promise.all([
      sourceController.listExtensions({ ...(runtimeSessionId === undefined ? {} : { sessionId: runtimeSessionId }), signal: request.signal }),
      sourceController.readRecentExtensionSuggestions?.().catch(() => []) ?? Promise.resolve([])
    ]).then(([catalog, recentIds]) => {
      if (!request.signal.aborted && currentKey.current === contextKey) setResult({ key: contextKey, entries: catalog.extensions, recentIds });
    }).catch(() => { /* Keep the built-in catalog available while offline. */ });
    return () => request.abort();
  }, [contextKey, runtimeSessionId, catalogRevision]);
  if (result === undefined || result.key !== contextKey) return { extensions: EMPTY_ENTRIES, hints: EMPTY_HINTS };
  return { extensions: result.entries, hints: { recentIds: result.recentIds, ...(newlyInstalledId === undefined ? {} : { newlyInstalledId }) } };
}
