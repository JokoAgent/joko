import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { MobileClient } from "./mobile-client";
import type { MobileFilePreview } from "./workspace-files";
import type { MobileFilesClipboard, MobileFilesClipboardResult } from "./mobile-files-clipboard";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";

type TextClient = Pick<MobileClient, "filesHtmlResourceOwnerKey" | "prepareFileTextSourceCopy" | "addFileTextQuoteToComposer" | "subscribe">;
export function useMobileFileTextActions(input: {
  readonly client: TextClient; readonly preview?: MobileFilePreview; readonly clipboard: MobileFilesClipboard;
  readonly disabled: boolean; readonly onQuoted?: () => void; readonly locale: MobileSupportedLocale
}) {
  const [busy, setBusy] = useState(false); const [quoting, setQuoting] = useState(false); const [error, setError] = useState("");
  const [copyResult, setCopyResult] = useState<Exclude<MobileFilesClipboardResult, "retired">>();
  const flight = useRef<AbortController | undefined>(undefined); const current = useRef(input); current.current = input;
  const alive = useRef(true);
  const stop = useCallback(() => { if (flight.current) { flight.current.abort(); flight.current = undefined; }
    if (alive.current) setBusy(false); }, [input.clipboard]);
  useEffect(() => {
    alive.current = true; setBusy(false); setQuoting(false); setError(""); setCopyResult(undefined);
    const preview = input.preview;
    const owner = preview?.kind === "text" ? input.client.filesHtmlResourceOwnerKey(preview) : undefined;
    const unsubscribe = input.client.subscribe(() => { if (preview?.kind === "text" && input.client.filesHtmlResourceOwnerKey(preview) !== owner) stop(); });
    const app = AppState.addEventListener("change", (state) => { if (state !== "active") stop(); });
    return () => { alive.current = false; unsubscribe(); app.remove(); stop(); };
  }, [input.client, input.preview, stop]);
  const run = useCallback((text?: string) => {
    const active = current.current; const preview = active.preview;
    if (!alive.current || active.disabled || flight.current || preview?.kind !== "text" || AppState.currentState !== "active"
      || !active.client.filesHtmlResourceOwnerKey(preview)) return;
    const controller = new AbortController(); flight.current = controller; setBusy(true); setQuoting(text !== undefined); setError(""); setCopyResult(undefined);
    const signal = controller.signal;
    const done = () => alive.current && flight.current === controller && current.current.preview === preview && !signal.aborted;
    const timeout = setTimeout(() => { if (done()) { stop(); if (alive.current) setError(mobileMessage(current.current.locale, "files.preview.actionTimedOut")); } }, 15_000);
    void (async () => {
      if (text !== undefined) { await active.client.addFileTextQuoteToComposer(preview, text, signal); if (done()) active.onQuoted?.(); }
      else {
        const lease = await active.client.prepareFileTextSourceCopy(preview, signal);
        if (!done()) return;
        const result = await active.clipboard.copy(lease, signal);
        if (done() && result !== "retired") { lease.assertCurrent(signal); setCopyResult(result); }
      }
    })().catch((failure) => { if (done()) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { clearTimeout(timeout); if (flight.current === controller) { flight.current = undefined; if (alive.current) setBusy(false); } });
  }, [stop]);
  const available = input.preview?.kind === "text" && !!input.client.filesHtmlResourceOwnerKey(input.preview);
  return { busy, quoting, error, copyResult, available, quote: useCallback((text: string) => run(text), [run]), copySource: useCallback(() => run(), [run]), cancel: stop };
}
