import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PartnerImportEditor, PartnerImportReceipts, PartnerImportCategory, PartnerImportStatus, PartnerImportCheckStatus,
  partnerImportMessages, importCategoryLabel, importCheckLabel, importReasonLabel, type PartnerImportResult } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { Translator } from "./types.js";
import { AvatarPicker } from "./PartnerAvatarPicker.js";
import { Button, Modal, Spinner } from "./ui.js";
import "./partner-import.css";

const categories = [PartnerImportCategory.PERSONALITY, PartnerImportCategory.MEMORY, PartnerImportCategory.SKILLS, PartnerImportCategory.CONNECTIONS, PartnerImportCategory.AUTOMATIONS];
export function PartnerImportDialog({ controller, ownerKey, foreground, t, onClose, onCreated }: {
  readonly controller: AppController; readonly ownerKey: string; readonly foreground: boolean; readonly t: Translator;
  readonly onClose: () => void; readonly onCreated: (result: PartnerImportResult) => void;
}) {
  const m = partnerImportMessages(controller.state.effectiveLocale); const latest = useRef({ onClose, onCreated }); latest.current = { onClose, onCreated };
  const editor = useMemo(() => {
    const node = controller.state.activeProfile;
    const nodeKey = JSON.stringify([node?.serverId, node?.id, node?.deviceId, node?.origin]);
    return new PartnerImportEditor(controller.partnerImportApi(ownerKey), new PartnerImportReceipts({
      getItem: key => window.localStorage.getItem(key), setItem: (key, value) => window.localStorage.setItem(key, value), removeItem: key => window.localStorage.removeItem(key),
      exclusive: async (key, action) => await (navigator.locks ? navigator.locks.request(key, action) : action()),
    }, nodeKey));
  }, [ownerKey]);
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot); const [preparing, setPreparing] = useState(false);
  useEffect(() => { if (foreground) void editor.load(); else editor.suspend(); return () => editor.suspend(); }, [editor, foreground]);
  useEffect(() => () => editor.dispose(), [editor]);
  const opened = useRef<string | undefined>(undefined);
  const result = state.result; const saved = new Set(result?.savedEntryIds);
  const incomplete = state.preview ? [...state.selected].some(id => !saved.has(id)) : result?.checks.some(check => check.status === PartnerImportCheckStatus.NEEDS_ATTENTION && !saved.has(check.entryId) && check.entryId !== "import");
  const open = async () => {
    if (!foreground || preparing || !result?.saved || !result.canonicalSessionId || state.busy || opened.current === result.requestId) return;
    opened.current = result.requestId;
    await editor.release(); if (editor.active && editor.api.ownerKey === ownerKey) latest.current.onCreated(result);
  };
  useEffect(() => { if (foreground && result?.saved && result.canonicalSessionId && !incomplete && !state.busy && result.status !== PartnerImportStatus.RUNNING) void open(); }, [result, state.busy, foreground, incomplete]);
  const entries = state.preview?.entries ?? [];
  const filtered = entries.filter(entry => entry.category === state.category && `${entry.name} ${entry.description ?? ""}`.toLocaleLowerCase().includes(state.query.toLocaleLowerCase()));
  const locked = editor.locked || preparing || !foreground;
  const controls = (page: number, count: number, details = false) => count > 20 && <div className="partner-import__pagination">
    <Button disabled={page === 0} onClick={() => editor.page(page - 1, details)}>{m.previous}</Button><span>{page + 1} / {Math.ceil(count / 20)}</span>
    <Button disabled={(page + 1) * 20 >= count} onClick={() => editor.page(page + 1, details)}>{m.next}</Button></div>;
  const checkbox = (ids: string[], checked: boolean, label: string, partial = false) => <input type="checkbox" aria-label={label} disabled={locked} checked={checked}
    ref={node => { if (node) node.indeterminate = partial; }} onChange={event => editor.select(ids, event.target.checked)} />;
  return <Modal open title={m.title} onClose={() => { if (!preparing) latest.current.onClose(); }} className="partner-import">
    {state.error && <p role="alert">{importReasonLabel(state.error, m)} {state.pendingId && m.unknown}</p>}
    {!state.hydrated && <Spinner />}
    {state.pendingId ? <>
      <p role="status">{result?.status === PartnerImportStatus.RUNNING ? m.running : result?.saved ? incomplete ? m.partial : m.saved : state.absent ? m.absent : m.unknown}</p>
      {categories.map(category => {
        const group = entries.filter(entry => entry.category === category); if (!group.length) return null;
        return <p key={category}>{importCategoryLabel(category, m)} · {group.filter(entry => saved.has(entry.id)).length} / {group.filter(entry => state.selected.has(entry.id)).length}</p>;
      })}
      <div className="partner-import__checks">{result?.checks.slice(state.detailPage * 20, (state.detailPage + 1) * 20).map(check => <div key={check.entryId}>
        <strong>{check.name ?? entries.find(entry => entry.id === check.entryId)?.name ?? m.details}</strong><p>{importCheckLabel(check.status, m)}{check.message ? ` · ${importReasonLabel(check.message, m)}` : ""}</p>
        {check.progress && <span>{check.progress.saved} / {check.progress.total}</span>}</div>)}</div>
      {controls(state.detailPage, result?.checks.length ?? 0, true)}
      <div className="partner-import__actions"><Button onClick={() => void editor.refresh()} disabled={state.busy}>{m.refresh}</Button>
        {state.absent ? <Button disabled={state.busy} onClick={() => void editor.release()}>{m.reset}</Button> : result && result.status !== PartnerImportStatus.COMPLETE && <>
          <Button onClick={() => void editor.retry()} disabled={state.busy}>{m.retry}</Button>
          <Button onClick={() => void editor.retry(true)} disabled={state.busy || !result.saved}>{m.continueSetup}</Button></>}
        {result?.canonicalSessionId && <Button tone="primary" disabled={state.busy || preparing || !foreground} onClick={() => void open()}>{m.open}</Button>}</div>
    </> : !state.preview ? <div className="partner-import__sources">{state.sources?.map(source => <Button key={source.id} disabled={state.busy || !foreground} onClick={() => void editor.choose(source.id)}>{source.name}</Button>)}
      {state.sources?.length === 0 && <p>{m.empty}</p>}{state.error && <Button disabled={state.busy} onClick={() => void editor.load()}>{m.refresh}</Button>}</div>
      : state.category !== undefined ? <>
        <Button onClick={() => editor.filter()}>{m.back}</Button><h3>{importCategoryLabel(state.category, m)}</h3>
        <label>{checkbox(entries.filter(entry => entry.category === state.category).map(entry => entry.id), entries.filter(entry => entry.category === state.category).every(entry => state.selected.has(entry.id)), m.selectAll)}{m.selectAll}</label>
        <input type="search" aria-label={m.search} value={state.query} onChange={event => editor.filter(state.category, event.target.value)} />
        <div className="partner-import__entries">{filtered.slice(state.page * 20, (state.page + 1) * 20).map(entry => <label key={entry.id}>
          {checkbox([entry.id], state.selected.has(entry.id), entry.name)}<span><strong>{entry.name}</strong>{entry.description && <p>{entry.description}</p>}
            {entry.exclusiveWith.length > 0 && <small>{m.conflict}</small>}{state.selected.has(entry.id) && entry.dependsOn.some(id => !state.selected.has(id)) && <small>{m.dependency}</small>}
            {entry.issues.map(issue => <small key={issue}>{importReasonLabel(issue, m)}</small>)}</span>{entry.enabled === false && <span>{m.paused}</span>}</label>)}</div>{controls(state.page, filtered.length)}
      </> : <>
        <AvatarPicker value={state.avatarImageBase64 ? { base64: state.avatarImageBase64 } : "orbit"} options={["orbit"]} ownerKey={ownerKey} disabled={locked} t={t}
          onPreparing={setPreparing} onChange={value => editor.edit({ avatarImageBase64: typeof value === "string" ? undefined : value.base64 })} />
        <label>{m.name}<input value={state.name} maxLength={200} disabled={locked} onChange={event => editor.edit({ name: event.target.value })} /></label>
        <div className="partner-import__groups">{categories.map(category => {
          const group = entries.filter(entry => entry.category === category); if (!group.length) return null;
          const count = group.filter(entry => state.selected.has(entry.id)).length;
          return <div key={category}>{checkbox(group.map(entry => entry.id), count === group.length, importCategoryLabel(category, m), count > 0 && count < group.length)}
            <Button disabled={locked} onClick={() => editor.filter(category)}>{importCategoryLabel(category, m)} · {count} / {group.length}</Button></div>;
        })}</div>
        {entries.some(entry => entry.category === PartnerImportCategory.AUTOMATIONS && state.selected.has(entry.id)) && <label>
          <input type="checkbox" checked={state.takeover} disabled={locked} onChange={event => editor.edit({ takeover: event.target.checked })} />{m.takeover}</label>}
        <p>{m.deferred}</p><Button tone="primary" disabled={locked || !state.name.trim()} onClick={() => void editor.start()}>{m.submit}</Button>
      </>}
    <Button disabled={preparing} onClick={onClose}>{m.close}</Button>
  </Modal>;
}
