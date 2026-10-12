import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { PartnerMemoryEditor, partnerMemoryMessages, validMemoryDraft, type MemoryDraft } from "@joko/contracts";
import remarkGfm from "remark-gfm";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";
import { Button, Modal } from "./ui.js";
import { usePartnerDocumentForeground } from "./use-partner-working-status.js";
import { TimelineMarkdownDocument } from "./TimelineMarkdownDocument.js";

const memoryMarkdownPlugins = [remarkGfm];
const memoryMarkdownUrl = (url: string) => /^(?:https?:\/\/|mailto:|#)/iu.test(url) ? url : "";

export function PartnerMemoryDialog({ controller, partner, ownerKey, onClose }: {
  readonly controller: AppController; readonly partner: PartnerProfileView; readonly ownerKey: string; readonly onClose: () => void;
}): JSX.Element {
  const editor = useMemo(() => new PartnerMemoryEditor(controller.partnerMemoryApi(partner.id, ownerKey), {
    partnerId: partner.id, homeTargetId: partner.homeTargetId, canonicalSessionId: partner.canonicalSessionId!
  }), [controller, ownerKey, partner.id, partner.homeTargetId, partner.canonicalSessionId]);
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot); const foreground = usePartnerDocumentForeground();
  const [composing, setComposing] = useState(false); const composingRef = useRef(false);
  const [compositionDraft, setCompositionDraft] = useState<MemoryDraft>(); const compositionDraftRef = useRef<MemoryDraft | undefined>(undefined);
  const connected = foreground && controller.state.connectionState === "connected";
  const m = partnerMemoryMessages(controller.state.effectiveLocale);
  useEffect(() => { void editor.refresh(); return () => editor.dispose(); }, [editor]);
  useEffect(() => { if (connected) editor.activate(); else editor.suspend(); }, [editor, connected]);
  useEffect(() => {
    if (!connected || composing || state.view !== "edit" || !state.draft || !editor.dirty || !editor.writable || !validMemoryDraft(state.draft)) return;
    const timer = setTimeout(() => { if (!composingRef.current) void editor.save(); }, 800);
    return () => clearTimeout(timer);
  }, [editor, state.draft, state.view, connected, composing]);
  const close = async () => { if (state.busy || composingRef.current) return; if (editor.dirty && !await editor.save() && !window.confirm(m.discardBody)) return; onClose(); };
  const back = async () => { if (!await editor.back() && editor.dirty && window.confirm(m.discardBody)) { editor.discard(); await editor.back(); } };
  const entry = state.detail; const locked = !connected || !editor.writable;
  const fieldsLocked = !connected || !editor.editable;
  const composition = { onCompositionStart: () => { composingRef.current = true; compositionDraftRef.current = state.draft; setCompositionDraft(state.draft); setComposing(true); },
    onCompositionEnd: () => { composingRef.current = false; if (compositionDraftRef.current) editor.change(compositionDraftRef.current);
      compositionDraftRef.current = undefined; setCompositionDraft(undefined); setComposing(false); } };
  const change = (patch: Partial<MemoryDraft>) => { if (composingRef.current && compositionDraftRef.current) {
    compositionDraftRef.current = { ...compositionDraftRef.current, ...patch }; setCompositionDraft(compositionDraftRef.current);
  } else editor.change(patch); };
  const shownDraft = compositionDraft ?? state.draft;
  return <Modal open title={m.title} size="large" onClose={() => { void close(); }} showClose closeLabel={m.close}>
    <div className="partner-memory">
      <div className="partner-memory__actions">
        {state.view !== "list" && <Button disabled={state.busy || !!state.pending} onClick={() => { void back(); }}>{m.back}</Button>}
        <Button disabled={!connected || state.busy} onClick={() => { void editor.refresh(); }}>{m.refresh}</Button>
      </div>
      {state.busy && <p role="status">{m.loading}</p>}
      {state.error && <p role="alert">{m[state.error]}</p>}
      {state.receipt && <p role="status">{m[state.receipt]}</p>}
      {state.view === "list" ? <>
        {state.catalog && <label className="partner-memory__toggle"><input type="checkbox" checked={state.catalog.owner.memoryEnabled} disabled={locked}
          onChange={event => { void editor.setMemoryEnabled(event.currentTarget.checked); }} />{m.enabled}</label>}
        {state.catalog && !state.catalog.owner.memoryEnabled && <p>{m.disabled}</p>}
        <label>{m.search}<input type="search" value={state.query} maxLength={200} disabled={!connected} onChange={event => editor.search(event.currentTarget.value)} /></label>
        {state.catalog?.owner.readOnly && <p>{m.readonly}</p>}
        {state.catalog?.truncated && <p role="status">{m.truncated}</p>}
        {state.catalog?.groups.every(group => group.count === 0) && <p>{state.query.trim() ? m.noResults : m.empty}</p>}
        {state.catalog?.groups.filter(group => group.count > 0).map(group => <section key={group.kind} aria-label={m[group.kind]}>
          <h3>{m[group.kind]} <span>{group.count}</span></h3>
          <ul className="partner-memory__list">{group.entries.map(item => <li key={item.id}><button type="button" aria-label={item.title} disabled={!connected || state.busy}
            onClick={() => { void editor.open(item.id); }}><span><strong>{item.title}</strong>{item.preview && <span>{item.preview}</span>}</span>
            <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleDateString(controller.state.effectiveLocale)}</time></button></li>)}</ul>
        </section>)}
      </> : state.view === "detail" && entry ? <>
        <h3>{entry.title}</h3><p>{m[entry.kind]} · {new Date(entry.updatedAt).toLocaleString(controller.state.effectiveLocale)}</p>
        <div className="partner-memory__body markdown-body"><TimelineMarkdownDocument remarkPlugins={memoryMarkdownPlugins} urlTransform={memoryMarkdownUrl} skipHtml>{entry.body}</TimelineMarkdownDocument></div>
        {entry.owner.readOnly && <p>{m.readonly}</p>}
        <div className="partner-memory__actions"><Button disabled={locked} onClick={() => editor.edit()}>{m.edit}</Button>
          <Button tone="danger" disabled={locked} onClick={() => { if (window.confirm(m.removeBody)) void editor.remove(); }}>{m.remove}</Button></div>
      </> : state.view === "edit" && shownDraft ? <>
        {state.latest && <div role="alert"><pre className="partner-memory__body">{state.latest.body}</pre>
          <div className="partner-memory__actions"><Button disabled={state.busy} onClick={() => editor.useLatest()}>{m.useLatest}</Button>
            <Button disabled={!connected || state.busy} onClick={() => { void editor.keepMine(); }}>{m.keepMine}</Button></div></div>}
        <label>{m.titleField}<input value={shownDraft.title} maxLength={100} disabled={fieldsLocked} {...composition} onChange={event => change({ title: event.currentTarget.value })} /></label>
        <label>{m.bodyField}<textarea value={shownDraft.body} rows={12} disabled={fieldsLocked} {...composition} onChange={event => change({ body: event.currentTarget.value })} /></label>
        <Button disabled={locked || composing} onClick={() => { void back(); }}>{m.done}</Button>
      </> : null}
    </div>
  </Modal>;
}
