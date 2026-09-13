import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";

export type ClipboardActionState = "idle" | "pending" | "copied" | "failed";

export interface ClipboardActionOptions {
  readonly ownerKey: string;
  readonly sourceKey: string;
  readonly ownerDocument: Document | undefined;
  readonly connectionOwner?: unknown;
  readonly feedbackDurationMs?: number;
}

export function useClipboardAction({ ownerKey, sourceKey, ownerDocument, connectionOwner, feedbackDurationMs = 1_600 }: ClipboardActionOptions) {
  const scopeRef = useRef<{ readonly ownerDocument: Document | undefined } | undefined>(undefined);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const feedbackRef = useRef<{ readonly ownerWindow: Window; readonly timer: number } | undefined>(undefined);
  const [state, setState] = useState<ClipboardActionState>("idle");
  const clearFeedback = useCallback((): void => {
    const feedback = feedbackRef.current;
    feedbackRef.current = undefined;
    if (feedback !== undefined) feedback.ownerWindow.clearTimeout(feedback.timer);
  }, []);
  const cancel = useCallback((): void => {
    requestRef.current?.abort();
    requestRef.current = undefined;
    clearFeedback();
    setState("idle");
  }, [clearFeedback]);

  useLayoutEffect(() => {
    const scope = { ownerDocument };
    scopeRef.current = scope;
    setState("idle");
    const ownerWindow = ownerDocument?.defaultView;
    const onPageHide = (): void => { if (scopeRef.current === scope) cancel(); };
    ownerWindow?.addEventListener("pagehide", onPageHide);
    return () => {
      ownerWindow?.removeEventListener("pagehide", onPageHide);
      if (scopeRef.current === scope) {
        scopeRef.current = undefined;
        cancel();
      }
    };
  }, [ownerKey, sourceKey, ownerDocument, connectionOwner, cancel]);

  const run = useCallback((initiatingDocument: Document, operation: (context: BrowserActionContext) => void | Promise<void>): void => {
    const scope = scopeRef.current;
    if (scope?.ownerDocument === undefined || scope.ownerDocument !== initiatingDocument || requestRef.current !== undefined) return;
    clearFeedback();
    const request = new AbortController();
    requestRef.current = request;
    const ownsRequest = (): boolean => scopeRef.current === scope && requestRef.current === request;
    const current = (): boolean => ownsRequest() && !request.signal.aborted;
    const context: BrowserActionContext = { ownerDocument: initiatingDocument, signal: request.signal };
    const ownerWindow = initiatingDocument.defaultView;
    setState("pending");
    void (async () => {
      try {
        assertBrowserActionCurrent(context);
        // Invoke before yielding so an explicit click retains its user activation.
        await operation(context);
        if (!current()) return;
        setState("copied");
        if (ownerWindow !== null) {
          const feedback = {
            ownerWindow,
            timer: ownerWindow.setTimeout(() => {
              if (scopeRef.current === scope && feedbackRef.current === feedback) {
                feedbackRef.current = undefined;
                setState("idle");
              }
            }, feedbackDurationMs)
          };
          feedbackRef.current = feedback;
        }
      } catch {
        if (current()) setState("failed");
      } finally {
        if (ownsRequest()) requestRef.current = undefined;
      }
    })();
  }, [clearFeedback, feedbackDurationMs]);

  return { state, pending: state === "pending", run, cancel };
}
