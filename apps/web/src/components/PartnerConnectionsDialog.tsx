import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { PartnerConnectionsEditor, PartnerSkillsEditor, partnerConnectionsMessages, partnerSkillsMessages } from "@joko/contracts";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";
import { Button, Modal } from "./ui.js";
import { usePartnerDocumentForeground } from "./use-partner-working-status.js";

export function PartnerConnectionsDialog({ controller, partner, ownerKey, onClose, focusSkills = false }: {
  readonly controller: AppController; readonly partner: PartnerProfileView; readonly ownerKey: string; readonly onClose: () => void;
  readonly focusSkills?: boolean;
}): JSX.Element {
  const editor = useMemo(() => new PartnerConnectionsEditor(controller.partnerConnectionsApi(partner.id, ownerKey), {
    partnerId: partner.id, homeTargetId: partner.homeTargetId, canonicalSessionId: partner.canonicalSessionId!
  }), [ownerKey, partner.id, partner.homeTargetId, partner.canonicalSessionId]);
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot), foreground = usePartnerDocumentForeground();
  const connected = foreground && controller.state.connectionState === "connected", m = partnerConnectionsMessages(controller.state.effectiveLocale);
  const [skill, setSkill] = useState<{ id: string; editor: PartnerSkillsEditor }>();
  const skillsRef = useRef<HTMLElement | null>(null), skillsFocused = useRef(false);
  useEffect(() => {
    if (focusSkills && state.detail && !skillsFocused.current && skillsRef.current) {
      skillsFocused.current = true; skillsRef.current.focus();
    }
  }, [focusSkills, state.detail]);
  useEffect(() => {
    if (connected) { editor.activate(); void editor.refresh(); } else editor.suspend();
    return () => editor.suspend();
  }, [editor, connected]);
  useEffect(() => {
    if (!connected || !editor.dirty || !editor.editable || state.error) return;
    const timer = setTimeout(() => { void editor.save(); }, 800); return () => clearTimeout(timer);
  }, [editor, state.draft, state.busy, state.error, connected]);
  const close = async () => { if (state.busy) return; if (editor.dirty && !await editor.save() && !window.confirm(m.discardBody)) return; onClose(); };
  const openSkill = async (id: string) => {
    if (!connected || state.busy || !state.detail || (editor.dirty && !await editor.save())) return;
    setSkill({ id, editor: new PartnerSkillsEditor(controller.partnerSkillsApi(partner.id, ownerKey), state.detail.owner) });
  };
  return <Modal open title={m.title} size="large" onClose={() => { void close(); }} showClose closeLabel={m.close}>
    {skill && <PersonalSkillDialog id={skill.id} editor={skill.editor} connected={connected} locale={controller.state.effectiveLocale}
      onClose={() => { skill.editor.dispose(); setSkill(undefined); void editor.refresh(); }} />}
    <div className="partner-memory">
      <div className="partner-memory__actions"><Button disabled={!connected || state.busy} onClick={() => { void editor.refresh(); }}>{m.refresh}</Button></div>
      {state.busy && <p role="status">{m.loading}</p>}{state.error && <p role="alert">{m[state.error]}</p>}{state.saved && <p role="status">{m.saved}</p>}
      {state.detail?.owner.readOnly && <p>{m.readonly}</p>}
      {state.latest && <div className="partner-memory__actions"><Button disabled={state.busy} onClick={() => editor.useLatest()}>{m.useLatest}</Button>
        <Button disabled={!connected || state.busy || state.latest.owner.readOnly} onClick={() => editor.keepMine()}>{m.keepMine}</Button></div>}
      <label>{m.search}<input type="search" value={state.query} maxLength={200} disabled={!connected} onChange={event => editor.query(event.currentTarget.value)} /></label>
      {(["skills", "mcp", "toolsets"] as const).map(kind => <section key={kind} aria-label={m[kind]}
        ref={kind === "skills" ? skillsRef : undefined} tabIndex={kind === "skills" ? -1 : undefined}><h3>{m[kind]}</h3>
        {kind !== "skills" && state.draft && <label className="partner-memory__toggle"><input type="checkbox" checked={state.draft[kind].mode === "inherit"} disabled={!editor.editable}
          onChange={event => { if (event.currentTarget.checked) editor.inherit(kind); else editor.customize(kind); }} />{m.inherit}</label>}
        {state.draft?.[kind].mode === "allowlist" && <p>{m.selected}</p>}
        {state.detail && editor.rows(kind).length === 0 && <p>{m.empty}</p>}
        {editor.rows(kind).map(entry => entry.personal && kind === "skills"
          ? <Button key={entry.id} disabled={!connected || state.busy} title={entry.description} onClick={() => { void openSkill(entry.id); }}>
            {entry.name} · {m.personal}{!entry.available && <span> · {m.unavailable}</span>}</Button>
          : <label key={entry.id} className="partner-memory__toggle"><input type="checkbox" checked={editor.selected(entry)}
            disabled={!editor.editable || !entry.available && !editor.selected(entry)} onChange={event => editor.toggle(entry, event.currentTarget.checked)} />
            <span title={entry.description}>{entry.name}{!entry.available && <span> · {m.unavailable}</span>}</span></label>)}
      </section>)}
      <Button disabled={!editor.editable || !editor.dirty} onClick={() => { void editor.save(); }}>{m.save}</Button>
    </div>
  </Modal>;
}

function PersonalSkillDialog({ id, editor, connected, locale, onClose }: {
  readonly id: string; readonly editor: PartnerSkillsEditor; readonly connected: boolean; readonly locale: string; readonly onClose: () => void;
}): JSX.Element {
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot), m = partnerSkillsMessages(locale);
  const refresh = () => editor.state.detail ? editor.refresh() : editor.open(id);
  useEffect(() => {
    if (connected) { editor.activate(); void refresh(); } else editor.suspend();
    return () => editor.suspend();
  }, [editor, id, connected]);
  useEffect(() => { if (state.view === "list" && state.saved && !state.busy) onClose(); }, [state.view, state.saved, state.busy, onClose]);
  const close = async () => {
    if (state.busy) return;
    if (editor.dirty && !await editor.save() && !window.confirm(m.discardBody)) return;
    onClose();
  };
  const locked = !connected || !editor.editable;
  return <Modal open title={state.detail?.name ?? m.title} size="large" onClose={() => { void close(); }} showClose closeLabel={m.close}>
    <div className="partner-memory">
      <div className="partner-memory__actions"><Button disabled={!connected || state.busy} onClick={() => { void refresh(); }}>{m.refresh}</Button></div>
      {state.busy && <p role="status">{m.loading}</p>}
      {state.error && <p role="alert">{m[state.error]}</p>}
      {state.saved && <p role="status">{m.saved}</p>}
      {state.latest && <div role="alert"><pre className="partner-memory__body">{state.latest.body}</pre>
        <div className="partner-memory__actions"><Button disabled={state.busy} onClick={() => editor.useLatest()}>{m.useLatest}</Button>
          <Button disabled={!connected || state.busy || state.latest.readOnly} onClick={() => editor.keepMine()}>{m.keepMine}</Button></div></div>}
      {state.view === "edit" && state.draft ? <>
        <label>{m.name}<input maxLength={64} value={state.draft.name} disabled={locked} onChange={event => editor.change({ name: event.currentTarget.value })} /></label>
        <label>{m.description}<input maxLength={280} value={state.draft.description} disabled={locked} onChange={event => editor.change({ description: event.currentTarget.value })} /></label>
        <label>{m.body}<textarea rows={12} maxLength={55_000} value={state.draft.body} disabled={locked} onChange={event => editor.change({ body: event.currentTarget.value })} /></label>
        <Button disabled={locked || !editor.dirty} onClick={() => { void editor.save(); }}>{m.save}</Button>
      </> : state.detail && <>
        <p>{state.detail.description}</p><pre className="partner-memory__body">{state.detail.body}</pre>
        {state.detail.readOnly ? <p>{m.readonly}</p> : <div className="partner-memory__actions">
          <Button disabled={locked} onClick={() => editor.edit()}>{m.edit}</Button>
          <Button tone="danger" disabled={locked} onClick={() => { if (window.confirm(m.removeBody)) void editor.remove(); }}>{m.remove}</Button></div>}
      </>}
    </div>
  </Modal>;
}
