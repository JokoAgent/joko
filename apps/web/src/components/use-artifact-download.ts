import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ArtifactDownloadContext } from "../model.js";

/** One explicit save attempt, retired by its source/connection or closing view. */
export function useArtifactDownload(ownerKey: string, connectionOwner: unknown) {
  const scopeRef = useRef<object | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancel = useCallback((): void => {
    requestRef.current?.abort();
    requestRef.current = undefined;
    setPending(false);
  }, []);
  useLayoutEffect(() => {
    const scope = {};
    scopeRef.current = scope;
    setPending(false);
    setFailed(false);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = undefined;
      cancel();
    };
  }, [ownerKey, connectionOwner, cancel]);
  const run = (ownerDocument: Document, operation: (context: ArtifactDownloadContext) => Promise<unknown> | unknown): void => {
    const scope = scopeRef.current;
    if (scope === undefined || requestRef.current !== undefined) return;
    const request = new AbortController();
    requestRef.current = request;
    const ownsRequest = (): boolean => scopeRef.current === scope && requestRef.current === request;
    const current = (): boolean => ownsRequest() && !request.signal.aborted;
    const ownerWindow = ownerDocument.defaultView;
    const onPageHide = (): void => { if (ownsRequest()) cancel(); };
    ownerWindow?.addEventListener("pagehide", onPageHide, { once: true });
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        request.signal.throwIfAborted();
        await operation({ ownerDocument, signal: request.signal });
      } catch {
        if (current()) setFailed(true);
      } finally {
        ownerWindow?.removeEventListener("pagehide", onPageHide);
        if (ownsRequest()) {
          requestRef.current = undefined;
          setPending(false);
        }
      }
    })();
  };
  return { pending, failed, run, cancel };
}
