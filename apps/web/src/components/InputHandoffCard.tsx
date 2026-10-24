import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { inputHandoffHeldElsewhere, inputHandoffQrLink, inputHandoffStepKey, isInputHandoffDeviceCode, type InputHandoffAction,
  type InputHandoffDecision, type InputHandoffPicture, type InputHandoffSnapshot, type InputHandoffSubmission, type InputHandoffValues } from "@joko/contracts";
import type { Translator } from "./types.js";
import type { InputHandoffApi } from "../input-handoff.js";
import { Button, Modal, Pill } from "./ui.js";
import "./input-handoff.css";

interface Lifetime { readonly controller: AbortController; active: boolean; reading: boolean; sequence: number }
export interface InputHandoffPanelProps {
  readonly api: InputHandoffApi; readonly sessionId: string; readonly t: Translator;
  /** Service/profile/connection occurrence; changing it destroys every draft. */
  readonly ownerKey: string; readonly viewer: { readonly local: true } | { readonly deviceId: string | null };
}
/** Owner-only mounting is performed by the normal Session controller. This
 * panel never persists drafts, pixels or entered values in a global store. */
export function InputHandoffPanel(props: InputHandoffPanelProps): JSX.Element | null {
  return <InputHandoffPanelScope key={`${props.ownerKey}:${props.sessionId}`} {...props} />;
}
function InputHandoffPanelScope({ api, sessionId, viewer, t }: InputHandoffPanelProps): JSX.Element | null {
  const [snapshots, setSnapshots] = useState<readonly InputHandoffSnapshot[]>([]), [failed, setFailed] = useState(false);
  const lifetime = useRef<Lifetime | undefined>(undefined);
  useEffect(() => {
    const owner: Lifetime = { controller: new AbortController(), active: true, reading: false, sequence: 0 }; lifetime.current = owner;
    const read = async () => {
      if (!owner.active || owner.reading) return; owner.reading = true; const sequence = ++owner.sequence;
      try { const next = await api.listInputHandoffs(sessionId, owner.controller.signal); if (owner.active && sequence === owner.sequence) { setSnapshots(next); setFailed(false); } }
      catch { if (owner.active) { setSnapshots([]); setFailed(true); } } finally { owner.reading = false; }
    };
    void read(); const timer = setInterval(() => { void read(); }, 1_000);
    return () => { owner.active = false; owner.controller.abort(); clearInterval(timer); };
  }, [api, sessionId]);
  if (!snapshots.length) return failed ? <div className="input-handoff-unavailable" role="status">{t("inputHandoff.unavailable")}</div> : null;
  return <div className="input-handoff-list">{snapshots.map(snapshot => <InputHandoffCard key={snapshot.requestId} api={api} snapshot={snapshot} viewer={viewer} t={t} />)}</div>;
}
export function InputHandoffCard({ api, snapshot, viewer, t }: { readonly t: Translator; readonly api: InputHandoffApi; readonly snapshot: InputHandoffSnapshot; readonly viewer: InputHandoffPanelProps["viewer"] }): JSX.Element {
  const stepKey = inputHandoffStepKey(snapshot);
  return <InputHandoffStep key={stepKey} api={api} snapshot={snapshot} viewer={viewer} t={t} />;
}
function InputHandoffStep({ api, snapshot, viewer, t }: { readonly t: Translator; readonly api: InputHandoffApi; readonly snapshot: InputHandoffSnapshot; readonly viewer: InputHandoffPanelProps["viewer"] }): JSX.Element {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [draft, setDraft] = useState<InputHandoffValues>({}), [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [picture, setPicture] = useState<InputHandoffPicture | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState(""), [now, setNow] = useState(Date.now());
  const current = useRef({ active: true, snapshot, api, pending: false, operation: 0, lifetime: new AbortController() });
  current.current.snapshot = snapshot; current.current.api = api;
  useEffect(() => { const owner = current.current; const timer = setInterval(() => setNow(Date.now()), 500); return () => { owner.active = false; owner.operation++; owner.lifetime.abort(); clearInterval(timer); }; }, []);
  const held = inputHandoffHeldElsewhere(snapshot, viewer), actionable = !snapshot.terminal && snapshot.phase === "ready";
  useEffect(() => { if (!actionable || held) { setDraft({}); setRevealed({}); setPicture(null); setOpen(false); } }, [actionable, held]);
  useEffect(() => {
    const owner = current.current, revision = snapshot.revision; if (!open || !snapshot.picture || held || !actionable) { setPicture(null); return; }
    const operation = ++owner.operation; setError("");
    void api.readInputHandoffPicture(snapshot, owner.lifetime.signal).then(value => { if (owner.active && owner.operation === operation && owner.snapshot.revision === revision) setPicture(value); })
      .catch(() => { if (owner.active && owner.operation === operation) setError(t("inputHandoff.pictureFailed")); });
    return () => { if (owner.operation === operation) owner.operation++; };
  }, [api, open, snapshot.picture, snapshot.revision, held, actionable]);
  const act = async (work: (latest: InputHandoffSnapshot, signal: AbortSignal) => Promise<boolean | void>, clears = false): Promise<void> => {
    const owner = current.current; if (!owner.active || owner.pending) return; owner.pending = true; setBusy(true); setError(""); setNotice(""); const operation = ++owner.operation;
    try { const accepted = await work(owner.snapshot, owner.lifetime.signal); if (owner.active && owner.operation === operation && accepted === false) setError(t("inputHandoff.stepChanged")); }
    catch { if (owner.active && owner.operation === operation) setError(t("inputHandoff.resultUnknown")); }
    finally { owner.pending = false; if (owner.active) { setBusy(false); if (clears) { setDraft({}); setRevealed({}); } } };
  };
  const decide = (action: InputHandoffDecision["action"]) => act((latest, signal) => api.decideInputHandoff(latest.requestId, { kind: "input_handoff", action, expectedRevision: latest.revision }, signal), true);
  const submit = (action: InputHandoffAction) => {
    if (!actionable || held) return;
    const values: InputHandoffValues = {};
    if (action.kind !== "tap") for (const control of snapshot.controls) if (control.kind === "text" && Object.hasOwn(draft, control.id) && !(control.filled && draft[control.id] === "")) values[control.id] = draft[control.id]!;
    void act(async (latest, signal) => { const submission: InputHandoffSubmission = { expectedRevision: latest.revision, values, action };
      try { return await api.submitInputHandoff(latest, submission, signal); } finally { for (const key of Object.keys(values)) delete values[key]; } }, true);
  };
  const formSubmit = (event: FormEvent) => { event.preventDefault(); submit({ kind: "submit" }); };
  const close = () => { setOpen(false); setDraft({}); setRevealed({}); setPicture(null); current.current.operation++; };
  const qr = picture?.qr, link = qr ? inputHandoffQrLink(qr) : null;
  const code = snapshot.deviceCode && isInputHandoffDeviceCode(snapshot.deviceCode) ? snapshot.deviceCode : undefined;
  const phase = phaseText(snapshot, now, t);
  return <section className="input-handoff-card" aria-label={t("inputHandoff.title")}>
    <div className="input-handoff-heading"><div><strong>{t("inputHandoff.needed")}</strong><p>{snapshot.purpose}</p></div><Pill>{phase}</Pill></div>
    <div className="input-handoff-source"><span>{snapshot.source.app}{snapshot.source.window ? ` · ${snapshot.source.window}` : ""}</span>{snapshot.source.origin && <code>{snapshot.source.origin}</code>}</div>
    {snapshot.requester && <p className="input-handoff-muted">{t("inputHandoff.requester", { name: snapshot.requester })}</p>}
    {snapshot.command && <pre className="input-handoff-command">{snapshot.command}</pre>}
    {snapshot.note && <p className="input-handoff-muted">{t("inputHandoff.agentNote", { note: snapshot.note })}</p>}
    {snapshot.source.warning && <p role="note" className="input-handoff-warning">{warningText(snapshot.source.warning, t)}</p>}
    {snapshot.agentControlled && <p className="input-handoff-muted">{t("inputHandoff.agentControlled")}</p>}
    {snapshot.failure && <p role="status" className="input-handoff-warning">{failureText(snapshot.failure, t)}</p>}
    {held && <p className="input-handoff-muted">{t("inputHandoff.heldElsewhere")}</p>}
    {snapshot.qr === "scanned" && <p>{t("inputHandoff.qrScanned")}</p>}
    <div className="input-handoff-actions">
      {actionable && !held && <Button onClick={() => setOpen(true)} disabled={busy}>{snapshot.qr === "scan" ? t("inputHandoff.viewQr") : t("inputHandoff.fillHere")}</Button>}
      {actionable && held && <Button onClick={() => void decide("claim")} disabled={busy}>{t("inputHandoff.takeOver")}</Button>}
      {snapshot.phase === "finishing" && <Button onClick={() => void decide("stay")} disabled={busy}>{t("inputHandoff.keepWaiting")}</Button>}
      {!snapshot.terminal && <Button onClick={() => void decide("refresh")} disabled={busy} tone="secondary">{t("inputHandoff.refresh")}</Button>}
      {snapshot.liveView && api.openInputHandoffLiveView && !snapshot.terminal && <Button tone="secondary" disabled={busy} onClick={() => void act((latest, signal) => api.openInputHandoffLiveView!(latest, signal))}>{t("inputHandoff.viewWindow")}</Button>}
      {!snapshot.terminal && <Button tone="ghost" disabled={busy} onClick={() => void decide("done")}>{t("inputHandoff.done")}</Button>}
      {!snapshot.terminal && <Button tone="ghost" disabled={busy} onClick={() => void decide("cancel")}>{t("inputHandoff.cancel")}</Button>}
    </div>
    {error && <p role="alert" className="input-handoff-warning">{error}</p>}
    <Modal open={open && actionable && !held} title={snapshot.qr === "scan" ? t("inputHandoff.scanQr") : t("inputHandoff.fillStep")} onClose={() => { if (!busy) close(); }} closeLabel={t("common.close")} showClose className="input-handoff-modal">
        <p>{snapshot.source.origin ?? snapshot.source.app}</p>
        {snapshot.picture ? <>
          {picture ? <img className="input-handoff-picture" alt={qr ? t("inputHandoff.qrAlt") : t("inputHandoff.windowAlt")} src={`data:image/jpeg;base64,${picture.data}`} onClick={event => {
            if (busy) return; const bounds = event.currentTarget.getBoundingClientRect(); if (bounds.width && bounds.height) submit({ kind: "tap", x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) });
          }} /> : <p role="status">{t("inputHandoff.readingWindow")}</p>}
          {qr && <div className="input-handoff-actions">{link && <a href={link.url} target="_blank" rel="noopener noreferrer">{t("inputHandoff.openQrLink", { site: link.site })}</a>}
            <Button tone="secondary" onClick={() => { void navigator.clipboard.writeText(qr.text).then(() => setNotice(t("inputHandoff.qrCopied")), () => setNotice(t("inputHandoff.copyFailed"))); }}>{t("inputHandoff.copyQr")}</Button>
            <Button tone="secondary" onClick={() => { if (picture) void copyPicture(picture).then(() => setNotice(t("inputHandoff.qrImageCopied")), () => setNotice(t("inputHandoff.copyImageFailed"))); }}>{t("inputHandoff.copyQrImage")}</Button></div>}
        </> : null}
        {code && <div className="input-handoff-device-code"><strong>{code.code}</strong><span>{code.origin}</span><a href={code.url} target="_blank" rel="noopener noreferrer">{t("inputHandoff.openLogin")}</a><Button tone="secondary" onClick={() => { void navigator.clipboard.writeText(code.code).then(() => setNotice(t("inputHandoff.codeCopied")), () => setNotice(t("inputHandoff.copyFailed"))); }}>{t("inputHandoff.copyCode")}</Button></div>}
        {!qr && !code && <form onSubmit={formSubmit} autoComplete="on">
          {snapshot.controls.map(control => control.kind === "note" ? <p key={control.id} role="alert">{control.text}</p> : <label className="input-handoff-field" key={control.id}>
            <span>{control.label || (control.contentType === "password" ? t("inputHandoff.password") : control.contentType === "one-time-code" ? t("inputHandoff.oneTimeCode") : t("inputHandoff.input"))}</span>
            {control.filled && <small>{t("inputHandoff.filled")}</small>}
            {control.multiline && control.contentType !== "password" ? <textarea maxLength={4096} value={draft[control.id] ?? ""} disabled={busy} placeholder={control.placeholder} onChange={event => setDraft(value => ({ ...value, [control.id]: event.target.value }))} /> : <div className="input-handoff-field-row">
              <input name={`input-handoff-${control.id}`} type={control.contentType === "password" && !revealed[control.id] ? "password" : ["email", "tel", "url", "search"].includes(control.contentType) ? control.contentType : "text"}
                autoComplete={completeHint(control.contentType)} inputMode={control.contentType === "number" || control.contentType === "one-time-code" ? "numeric" : undefined} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                maxLength={4096} value={draft[control.id] ?? ""} disabled={busy} placeholder={control.placeholder} list={control.suggestions?.length ? `input-handoff-${snapshot.requestId}-${control.id}` : undefined}
                onChange={event => setDraft(value => ({ ...value, [control.id]: event.target.value }))} />
              {control.contentType === "password" && <Button type="button" tone="ghost" disabled={busy} onClick={() => setRevealed(value => ({ ...value, [control.id]: !value[control.id] }))}>{revealed[control.id] ? t("inputHandoff.hidePassword") : t("inputHandoff.showPassword")}</Button>}
            </div>}
            {control.suggestions?.length ? <datalist id={`input-handoff-${snapshot.requestId}-${control.id}`}>{control.suggestions.map(option => <option key={option.id} value={option.label} />)}</datalist> : null}
          </label>)}
          <div className="input-handoff-actions">{snapshot.picture && <Button type="button" disabled={busy || !picture} onClick={() => submit({ kind: "fill" })}>{t("inputHandoff.fillOnly")}</Button>}<Button type="submit" disabled={busy || snapshot.picture && !picture}>{snapshot.picture ? t("inputHandoff.fillReturn") : t("inputHandoff.fillContinue")}</Button></div>
        </form>}
        {snapshot.picture && !qr && <Button tone="ghost" disabled={busy} onClick={() => void decide("refresh")}>{t("inputHandoff.backToForm")}</Button>}
        {!snapshot.picture && !code && <Button tone="ghost" disabled={busy} onClick={() => void decide("picture")}>{t("inputHandoff.usePicture")}</Button>}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert" className="input-handoff-warning">{error}</p>}
    </Modal>
  </section>;
}
function completeHint(type: string): string { return type === "password" ? "current-password" : ["username", "email", "tel", "url", "one-time-code"].includes(type) ? type : "off"; }
function phaseText(snapshot: InputHandoffSnapshot, now: number, t: Translator): string { if (snapshot.phase === "finishing") return t("inputHandoff.phaseFinishing", { seconds: Math.max(0, Math.ceil(((snapshot.finishingUntil ?? now) - now) / 1000)) }); return ({ reading: t("inputHandoff.phaseReading"), ready: t("inputHandoff.phaseReady"), working: t("inputHandoff.phaseWorking"), succeeded: t("inputHandoff.done"), cancelled: t("inputHandoff.phaseCancelled"), failed: t("inputHandoff.phaseFailed"), expired: t("inputHandoff.phaseExpired") } as const)[snapshot.phase]; }
function warningText(value: string, t: Translator): string { return ({ insecure: t("inputHandoff.warningInsecure"), "ip-address": t("inputHandoff.warningIp"), "local-host": t("inputHandoff.warningLocalHost"), "local-file": t("inputHandoff.warningLocalFile"), punycode: t("inputHandoff.warningPunycode"), "embedded-frame": t("inputHandoff.warningFrame") } as Record<string, string>)[value] ?? t("inputHandoff.warningDefault"); }
function failureText(value: string, t: Translator): string { return ({ permission: t("inputHandoff.failurePermission"), screen_locked: t("inputHandoff.failureLocked"), nothing_to_fill: t("inputHandoff.failureNoFields"), origin_changed: t("inputHandoff.failureOrigin"), target_gone: t("inputHandoff.failureTarget"), picture_unavailable: t("inputHandoff.failurePicture"), timeout: t("inputHandoff.failureTimeout"), unsupported: t("inputHandoff.failureUnsupported") } as Record<string, string>)[value] ?? t("inputHandoff.failureDefault"); }
async function copyPicture(picture: InputHandoffPicture): Promise<void> { const binary = atob(picture.data), bytes = Uint8Array.from(binary, value => value.charCodeAt(0)); try { await navigator.clipboard.write([new ClipboardItem({ "image/jpeg": new Blob([bytes], { type: "image/jpeg" }) })]); } finally { bytes.fill(0); } }
