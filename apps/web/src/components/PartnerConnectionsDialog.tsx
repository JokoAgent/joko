import { useEffect, useMemo, useRef, useSyncExternalStore, type JSX } from "react";
import { PartnerConnectionsEditor, partnerConnectionsMessages } from "@joko/contracts";
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
  }), [controller, ownerKey, partner.id, partner.homeTargetId, partner.canonicalSessionId]);
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot), foreground = usePartnerDocumentForeground();
  const connected = foreground && controller.state.connectionState === "connected", m = partnerConnectionsMessages(controller.state.effectiveLocale);
  const skillsRef = useRef<HTMLElement | null>(null), skillsFocused = useRef(false);
  useEffect(() => {
    if (focusSkills && state.detail && !skillsFocused.current && skillsRef.current) {
      skillsFocused.current = true; skillsRef.current.focus();
    }
  }, [focusSkills, state.detail]);
  useEffect(() => { void editor.refresh(); return () => editor.dispose(); }, [editor]);
  useEffect(() => { if (connected) editor.activate(); else editor.suspend(); }, [editor, connected]);
  useEffect(() => {
    if (!connected || !editor.dirty || !editor.editable || state.error) return;
    const timer = setTimeout(() => { void editor.save(); }, 800); return () => clearTimeout(timer);
  }, [editor, state.draft, state.busy, state.error, connected]);
  const close = async () => { if (state.busy) return; if (editor.dirty && !await editor.save() && !window.confirm(m.discardBody)) return; onClose(); };
  return <Modal open title={m.title} size="large" onClose={() => { void close(); }} showClose closeLabel={m.close}>
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
        {editor.rows(kind).map(entry => <label key={entry.id} className="partner-memory__toggle"><input type="checkbox" checked={editor.selected(entry)}
          disabled={!editor.editable || entry.personal || !entry.available && !editor.selected(entry)} onChange={event => editor.toggle(entry, event.currentTarget.checked)} />
          <span title={entry.description}>{entry.name}{entry.personal && <span> · {m.personal}</span>}{!entry.available && <span> · {m.unavailable}</span>}</span></label>)}
      </section>)}
      <Button disabled={!editor.editable || !editor.dirty} onClick={() => { void editor.save(); }}>{m.save}</Button>
    </div>
  </Modal>;
}
