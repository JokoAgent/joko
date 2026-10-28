import { useEffect, useRef, useState } from "react";
import type { ExtensionSettingsDirectoryChoice } from "@joko/contracts";
import type { Translator } from "./types.js";
import { Button, Modal, Spinner } from "./ui.js";

export function ExtensionSettingsDirectoryDialog({ choice, signal, finish, t, ownerDocument }: {
  readonly choice: ExtensionSettingsDirectoryChoice; readonly signal: AbortSignal;
  readonly finish: (entryId?: string) => void; readonly t: Translator; readonly ownerDocument: Document;
}) {
  const [page, setPage] = useState(choice.initialPage), [directoryPath, setDirectoryPath] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const live = useRef(true), occurrence = useRef(0), lock = useRef(false);
  useEffect(() => {
    live.current = true;
    const cancel = () => finish();
    const hidden = () => { if (ownerDocument.visibilityState === "hidden") cancel(); };
    signal.addEventListener("abort", cancel, { once: true }); ownerDocument.addEventListener("visibilitychange", hidden);
    const expiry = page.picker?.expiresAt, at = expiry ? Number(expiry.seconds) * 1000 + expiry.nanos / 1_000_000 : 0;
    const timer = setTimeout(cancel, Math.max(0, at - Date.now()));
    if (signal.aborted) cancel();
    return () => { live.current = false; occurrence.current++; clearTimeout(timer); signal.removeEventListener("abort", cancel); ownerDocument.removeEventListener("visibilitychange", hidden); };
  }, [choice, signal, finish, ownerDocument]);
  const browse = async (input: Parameters<ExtensionSettingsDirectoryChoice["browse"]>[0], append = false) => {
    if (lock.current || signal.aborted) return;
    lock.current = true; const request = ++occurrence.current; setBusy(true); setError(false);
    try {
      const next = await choice.browse(input);
      if (!live.current || signal.aborted || request !== occurrence.current) return;
      const entries = append ? [...page.entries, ...next.entries] : next.entries;
      if (entries.length > 10_000 || new Set(entries.map(entry => entry.entryId)).size !== entries.length
        || append && next.directory?.entryId !== page.directory?.entryId) throw new Error("Directory listing changed.");
      setPage({ ...next, entries });
      setDirectoryPath(next.directory?.displayPath ?? "");
    } catch { if (live.current && !signal.aborted && request === occurrence.current) setError(true); }
    finally { if (live.current && request === occurrence.current) { lock.current = false; setBusy(false); } }
  };
  return <Modal open ownerDocument={ownerDocument} title={t("extensions.directoryPicker.title")}
    description={choice.name} onClose={() => finish()} closeLabel={t("common.cancel")} size="medium">
    <p>{t("extensions.directoryPicker.description")}</p>
    {choice.title && <p>{choice.title}</p>}
    <form onSubmit={event => { event.preventDefault(); void browse({ directoryPath }); }} style={{ display: "flex", gap: 8, marginBlock: 12 }}>
      <label style={{ flex: 1 }}>{t("extensions.directoryPicker.path")}<input style={{ display: "block", width: "100%" }} value={directoryPath}
        onChange={event => setDirectoryPath(event.target.value)} disabled={busy} maxLength={4096} autoComplete="off" spellCheck={false} /></label>
      <Button type="submit" disabled={busy || !directoryPath.trim()}>{t("extensions.directoryPicker.open")}</Button>
    </form>
    {page.directory && <p style={{ overflowWrap: "anywhere" }}>{page.directory.displayPath}</p>}
    {page.directory?.parentEntryId && <Button tone="ghost" disabled={busy} onClick={() => void browse({ entryId: page.directory!.parentEntryId })}>{t("common.back")}</Button>}
    {error && <p role="alert">{t("extensions.directoryPicker.failed")}</p>}
    <div aria-busy={busy} style={{ maxHeight: "40vh", overflowY: "auto", display: "grid", gap: 4, marginBlock: 8 }}>
      {page.entries.map(entry => <Button key={entry.entryId} tone="ghost" disabled={busy} onClick={() => void browse({ entryId: entry.entryId })}>
        <span style={{ overflowWrap: "anywhere", textAlign: "start" }}>{page.directory ? entry.name : entry.displayPath}</span>
      </Button>)}
      {!busy && !page.entries.length && <p>{t("extensions.directoryPicker.empty")}</p>}
      {busy && <Spinner />}
      {page.nextPageToken && <Button tone="ghost" disabled={busy} onClick={() => void browse({ entryId: page.directory?.entryId, pageToken: page.nextPageToken }, true)}>{t("common.more")}</Button>}
    </div>
    <div className="modal-actions"><Button tone="ghost" onClick={() => finish()}>{t("common.cancel")}</Button>
      <Button tone="primary" disabled={busy || error || !page.directory || signal.aborted} onClick={() => { if (!lock.current && !error && !signal.aborted) finish(page.directory?.entryId); }}>{t("extensions.directoryPicker.select")}</Button></div>
  </Modal>;
}
