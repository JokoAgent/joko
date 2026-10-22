import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { inputHandoffHeldElsewhere, inputHandoffQrLink, inputHandoffStepKey, isInputHandoffDeviceCode, type InputHandoffAction,
  type InputHandoffDecision, type InputHandoffPicture, type InputHandoffSnapshot, type InputHandoffSubmission, type InputHandoffValues } from "@joko/contracts";
import type { InputHandoffApi } from "../input-handoff.js";
import { Button, Modal, Pill } from "./ui.js";
import "./input-handoff.css";

interface Lifetime { readonly controller: AbortController; active: boolean; reading: boolean; sequence: number }
export interface InputHandoffPanelProps {
  readonly api: InputHandoffApi; readonly sessionId: string;
  /** Service/profile/connection occurrence; changing it destroys every draft. */
  readonly ownerKey: string; readonly viewer: { readonly local: true } | { readonly deviceId: string | null };
}
/** Owner-only mounting is performed by the normal Session controller. This
 * panel never persists drafts, pixels or entered values in a global store. */
export function InputHandoffPanel(props: InputHandoffPanelProps): JSX.Element | null {
  return <InputHandoffPanelScope key={`${props.ownerKey}:${props.sessionId}`} {...props} />;
}
function InputHandoffPanelScope({ api, sessionId, viewer }: InputHandoffPanelProps): JSX.Element | null {
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
  if (!snapshots.length) return failed ? <div className="input-handoff-unavailable" role="status">代填状态暂时不可用。</div> : null;
  return <div className="input-handoff-list">{snapshots.map(snapshot => <InputHandoffCard key={snapshot.requestId} api={api} snapshot={snapshot} viewer={viewer} />)}</div>;
}
export function InputHandoffCard({ api, snapshot, viewer }: { readonly api: InputHandoffApi; readonly snapshot: InputHandoffSnapshot; readonly viewer: InputHandoffPanelProps["viewer"] }): JSX.Element {
  const stepKey = inputHandoffStepKey(snapshot);
  return <InputHandoffStep key={stepKey} api={api} snapshot={snapshot} viewer={viewer} />;
}
function InputHandoffStep({ api, snapshot, viewer }: { readonly api: InputHandoffApi; readonly snapshot: InputHandoffSnapshot; readonly viewer: InputHandoffPanelProps["viewer"] }): JSX.Element {
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
      .catch(() => { if (owner.active && owner.operation === operation) setError("无法读取当前窗口，请刷新步骤后再试。"); });
    return () => { if (owner.operation === operation) owner.operation++; };
  }, [api, open, snapshot.picture, snapshot.revision, held, actionable]);
  const act = async (work: (latest: InputHandoffSnapshot, signal: AbortSignal) => Promise<boolean | void>, clears = false): Promise<void> => {
    const owner = current.current; if (!owner.active || owner.pending) return; owner.pending = true; setBusy(true); setError(""); setNotice(""); const operation = ++owner.operation;
    try { const accepted = await work(owner.snapshot, owner.lifetime.signal); if (owner.active && owner.operation === operation && accepted === false) setError("此步骤已变化，请刷新后重新填写。"); }
    catch { if (owner.active && owner.operation === operation) setError("无法确认提交结果，请刷新当前步骤后继续。"); }
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
  const phase = phaseText(snapshot, now);
  return <section className="input-handoff-card" aria-label="输入代填">
    <div className="input-handoff-heading"><div><strong>需要你代为输入</strong><p>{snapshot.purpose}</p></div><Pill>{phase}</Pill></div>
    <div className="input-handoff-source"><span>{snapshot.source.app}{snapshot.source.window ? ` · ${snapshot.source.window}` : ""}</span>{snapshot.source.origin && <code>{snapshot.source.origin}</code>}</div>
    {snapshot.requester && <p className="input-handoff-muted">来自：{snapshot.requester}</p>}
    {snapshot.command && <pre className="input-handoff-command">{snapshot.command}</pre>}
    {snapshot.note && <p className="input-handoff-muted">Agent 说明：{snapshot.note}</p>}
    {snapshot.source.warning && <p role="note" className="input-handoff-warning">{warningText(snapshot.source.warning)}</p>}
    {snapshot.agentControlled && <p className="input-handoff-muted">Agent 可操作这个应用。填写内容只交给本机输入通道。</p>}
    {snapshot.failure && <p role="status" className="input-handoff-warning">{failureText(snapshot.failure)}</p>}
    {held && <p className="input-handoff-muted">另一台设备正在填写。你可以接管此步骤。</p>}
    {snapshot.qr === "scanned" && <p>二维码已离开，正在等待登录完成。</p>}
    <div className="input-handoff-actions">
      {actionable && !held && <Button onClick={() => setOpen(true)} disabled={busy}>{snapshot.qr === "scan" ? "查看登录二维码" : "在此设备填写"}</Button>}
      {actionable && held && <Button onClick={() => void decide("claim")} disabled={busy}>在此设备接管</Button>}
      {snapshot.phase === "finishing" && <Button onClick={() => void decide("stay")} disabled={busy}>继续等待</Button>}
      {!snapshot.terminal && <Button onClick={() => void decide("refresh")} disabled={busy} tone="secondary">刷新步骤</Button>}
      {snapshot.liveView && api.openInputHandoffLiveView && !snapshot.terminal && <Button tone="secondary" disabled={busy} onClick={() => void act((latest, signal) => api.openInputHandoffLiveView!(latest, signal))}>查看这个窗口</Button>}
      {!snapshot.terminal && <Button tone="ghost" disabled={busy} onClick={() => void decide("done")}>已完成</Button>}
      {!snapshot.terminal && <Button tone="ghost" disabled={busy} onClick={() => void decide("cancel")}>取消代填</Button>}
    </div>
    {error && <p role="alert" className="input-handoff-warning">{error}</p>}
    <Modal open={open && actionable && !held} title={snapshot.qr === "scan" ? "扫描登录二维码" : "填写当前步骤"} onClose={() => { if (!busy) close(); }} closeLabel="关闭" showClose className="input-handoff-modal">
        <p>{snapshot.source.origin ?? snapshot.source.app}</p>
        {snapshot.picture ? <>
          {picture ? <img className="input-handoff-picture" alt={qr ? "当前登录二维码" : "当前目标窗口"} src={`data:image/jpeg;base64,${picture.data}`} onClick={event => {
            if (busy) return; const bounds = event.currentTarget.getBoundingClientRect(); if (bounds.width && bounds.height) submit({ kind: "tap", x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) });
          }} /> : <p role="status">正在读取当前窗口…</p>}
          {qr && <div className="input-handoff-actions">{link && <a href={link.url} target="_blank" rel="noopener noreferrer">在此设备打开 {link.site}</a>}
            <Button tone="secondary" onClick={() => { void navigator.clipboard.writeText(qr.text).then(() => setNotice("二维码内容已复制。"), () => setNotice("复制未完成。")); }}>复制二维码内容</Button>
            <Button tone="secondary" onClick={() => { if (picture) void copyPicture(picture).then(() => setNotice("二维码图片已复制。"), () => setNotice("此设备无法复制图片，请扫描二维码。")); }}>复制二维码图片</Button></div>}
        </> : null}
        {code && <div className="input-handoff-device-code"><strong>{code.code}</strong><span>{code.origin}</span><a href={code.url} target="_blank" rel="noopener noreferrer">打开登录页面</a><Button tone="secondary" onClick={() => { void navigator.clipboard.writeText(code.code).then(() => setNotice("登录代码已复制。"), () => setNotice("复制未完成。")); }}>复制代码</Button></div>}
        {!qr && !code && <form onSubmit={formSubmit} autoComplete="on">
          {snapshot.controls.map(control => control.kind === "note" ? <p key={control.id} role="alert">{control.text}</p> : <label className="input-handoff-field" key={control.id}>
            <span>{control.label || (control.contentType === "password" ? "密码" : control.contentType === "one-time-code" ? "验证码" : "输入内容")}</span>
            {control.filled && <small>此字段已填写，留空可保留原内容。</small>}
            {control.multiline && control.contentType !== "password" ? <textarea maxLength={4096} value={draft[control.id] ?? ""} disabled={busy} placeholder={control.placeholder} onChange={event => setDraft(value => ({ ...value, [control.id]: event.target.value }))} /> : <div className="input-handoff-field-row">
              <input name={`input-handoff-${control.id}`} type={control.contentType === "password" && !revealed[control.id] ? "password" : ["email", "tel", "url", "search"].includes(control.contentType) ? control.contentType : "text"}
                autoComplete={completeHint(control.contentType)} inputMode={control.contentType === "number" || control.contentType === "one-time-code" ? "numeric" : undefined} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                maxLength={4096} value={draft[control.id] ?? ""} disabled={busy} placeholder={control.placeholder} list={control.suggestions?.length ? `input-handoff-${snapshot.requestId}-${control.id}` : undefined}
                onChange={event => setDraft(value => ({ ...value, [control.id]: event.target.value }))} />
              {control.contentType === "password" && <Button type="button" tone="ghost" disabled={busy} onClick={() => setRevealed(value => ({ ...value, [control.id]: !value[control.id] }))}>{revealed[control.id] ? "隐藏密码" : "显示密码"}</Button>}
            </div>}
            {control.suggestions?.length ? <datalist id={`input-handoff-${snapshot.requestId}-${control.id}`}>{control.suggestions.map(option => <option key={option.id} value={option.label} />)}</datalist> : null}
          </label>)}
          <div className="input-handoff-actions">{snapshot.picture && <Button type="button" disabled={busy || !picture} onClick={() => submit({ kind: "fill" })}>只输入</Button>}<Button type="submit" disabled={busy || snapshot.picture && !picture}>{snapshot.picture ? "输入并回车" : "填写并继续"}</Button></div>
        </form>}
        {snapshot.picture && !qr && <Button tone="ghost" disabled={busy} onClick={() => void decide("refresh")}>返回表单</Button>}
        {!snapshot.picture && !code && <Button tone="ghost" disabled={busy} onClick={() => void decide("picture")}>改用窗口画面</Button>}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert" className="input-handoff-warning">{error}</p>}
    </Modal>
  </section>;
}
function completeHint(type: string): string { return type === "password" ? "current-password" : ["username", "email", "tel", "url", "one-time-code"].includes(type) ? type : "off"; }
function phaseText(snapshot: InputHandoffSnapshot, now: number): string { if (snapshot.phase === "finishing") return `即将交还 · ${Math.max(0, Math.ceil(((snapshot.finishingUntil ?? now) - now) / 1000))} 秒`; return ({ reading: "正在读取", ready: "等待填写", working: "正在输入", succeeded: "已完成", cancelled: "已取消", failed: "未完成", expired: "已超时" } as const)[snapshot.phase]; }
function warningText(value: string): string { return ({ insecure: "页面使用未加密连接，请核对来源。", "ip-address": "页面地址为 IP，请核对来源。", "local-host": "这是本机或局域网页面。", "local-file": "这是本地文件页面。", punycode: "页面域名含特殊字符，请仔细核对。", "embedded-frame": "字段位于嵌入页面，请核对来源。" } as Record<string, string>)[value] ?? "请核对当前页面来源。"; }
function failureText(value: string): string { return ({ permission: "请在执行电脑允许辅助功能访问后重新请求。", screen_locked: "执行电脑已锁定，请先解锁。", nothing_to_fill: "当前页面没有需要你填写的字段，请交给 Agent 处理。", origin_changed: "当前页面已变化，本次未填写。", target_gone: "目标窗口已关闭。", picture_unavailable: "无法读取窗口画面，请检查屏幕录制许可。", timeout: "等待填写已超时。", unsupported: "此执行电脑暂不支持屏幕代填。" } as Record<string, string>)[value] ?? "此步骤未完成，请刷新页面状态后继续。"; }
async function copyPicture(picture: InputHandoffPicture): Promise<void> { const binary = atob(picture.data), bytes = Uint8Array.from(binary, value => value.charCodeAt(0)); try { await navigator.clipboard.write([new ClipboardItem({ "image/jpeg": new Blob([bytes], { type: "image/jpeg" }) })]); } finally { bytes.fill(0); } }
