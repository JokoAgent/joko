import { useEffect, useMemo, useRef, useState } from "react";
import { PermissionMode, PartnerHomeBusyAction, PartnerHomeMovePhase, partnerHomeMessages,
  type ListPartnerHomeTargetsResponse, type PartnerHomeApi, type PartnerHomeMove, type PartnerHomeModelChoice } from "@joko/contracts";
import { Modal, Button } from "./ui.js";

export function PartnerHomeDialog({ api, partnerId, revision, inputHandoff = true, locale, onClose, onChanged }: {
  readonly api: PartnerHomeApi; readonly partnerId: string; readonly revision: bigint; readonly locale: string;
  readonly inputHandoff?: boolean;
  readonly onClose: () => void; readonly onChanged: (sessionId: string) => void;
}) {
  const text = partnerHomeMessages(locale), [catalog, setCatalog] = useState<ListPartnerHomeTargetsResponse>();
  const [selected, setSelected] = useState(""), [models, setModels] = useState<readonly PartnerHomeModelChoice[]>([]);
  const [model, setModel] = useState(""), [permission, setPermission] = useState(PermissionMode.ASK), [plan, setPlan] = useState(false);
  const [busyAction, setBusyAction] = useState(PartnerHomeBusyAction.WAIT), [offline, setOffline] = useState(false);
  const [move, setMove] = useState<PartnerHomeMove>(), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const alive = useRef(true), sent = useRef<string | undefined>(undefined), notified = useRef<string | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const target = catalog?.targets[Number(selected)], choice = models[Number(model)];
  const running = !!move && move.phase !== PartnerHomeMovePhase.READY && move.phase !== PartnerHomeMovePhase.NEEDS_ATTENTION;
  const load = async (signal: AbortSignal) => { setError(false); const value = await api.list(partnerId, signal);
    if (alive.current && !signal.aborted) { setCatalog(value); if (value.pendingMove) setMove(value.pendingMove); } };
  useEffect(() => { const request = new AbortController(); void load(request.signal).catch(() => { if (!request.signal.aborted) setError(true); }); return () => request.abort(); }, [api, partnerId]);
  useEffect(() => {
    setModels([]); setModel(""); setPlan(false); setPermission(PermissionMode.ASK);
    if (selected === "" || !target?.destination) return;
    const request = new AbortController(); setBusy(true); setError(false);
    void api.inspect(partnerId, target.destination, request.signal).then(value => { if (!request.signal.aborted) setModels(value.models); })
      .catch(() => { if (!request.signal.aborted) setError(true); }).finally(() => { if (!request.signal.aborted) setBusy(false); });
    return () => request.abort();
  }, [api, partnerId, selected, target?.destination]);
  useEffect(() => {
    if (!move || move.phase === PartnerHomeMovePhase.READY || move.phase === PartnerHomeMovePhase.NEEDS_ATTENTION) return;
    const request = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => { try { const value = await api.status(move.requestId, request.signal); if (!request.signal.aborted && value.move) setMove(value.move); }
      catch { if (!request.signal.aborted) setError(true); }
      if (!request.signal.aborted) timer = setTimeout(() => void poll(), 1500); };
    timer = setTimeout(() => void poll(), 500); return () => { request.abort(); clearTimeout(timer); };
  }, [api, move?.requestId, move?.phase]);
  useEffect(() => { if (move?.phase === PartnerHomeMovePhase.READY && move.canonicalSessionId && notified.current !== move.requestId) {
    notified.current = move.requestId; onChanged(move.canonicalSessionId); } }, [move, onChanged]);
  const modes = useMemo(() => choice?.permissionModes ?? [], [choice]);
  const submit = async () => {
    if (!catalog?.home?.identity || !target?.destination || !choice?.route || busy || selected === "" || model === "") return;
    setBusy(true); setError(false); const signal = new AbortController().signal;
    try { const requestId = sent.current ?? crypto.randomUUID(); sent.current = requestId;
      const value = await api.move({ requestId, expectedHome: catalog.home.identity, expectedPartnerRevision: { value: revision }, destination: target.destination,
        capabilities: { modelChain: [choice.route], permissionMode: permission, planMode: plan, inputHandoff }, busyAction, continueWhenSourceOffline: offline }, signal);
      if (alive.current) { setMove(value.move); if (value.move) sent.current = undefined; }
    } catch { if (alive.current) setError(true); } finally { if (alive.current) setBusy(false); }
  };
  return <Modal open title={text.title} size="medium" onClose={onClose}><div className="partner-editor">
    <p>{text.body}</p>{catalog?.home && <p><strong>{text.current}: </strong>{catalog.home.deviceName}</p>}
    {move && <div role="status"><strong>{move.phase === PartnerHomeMovePhase.READY ? text.ready : move.phase === PartnerHomeMovePhase.NEEDS_ATTENTION ? text.attention : text.running}</strong><p>{move.sourceDeviceName} → {move.targetDeviceName}</p>
      {move.phase === PartnerHomeMovePhase.NEEDS_ATTENTION && <Button disabled={busy} onClick={() => { setBusy(true); setError(false); void api.retry(move.requestId, new AbortController().signal).then(value => { if (alive.current) setMove(value.move); }).catch(() => { if (alive.current) setError(true); }).finally(() => { if (alive.current) setBusy(false); }); }}>{text.retry}</Button>}</div>}
    {!running && !catalog?.home?.changing && move?.phase !== PartnerHomeMovePhase.READY && <>
      <label className="field"><span>{text.choose}</span><select value={selected} disabled={busy} onChange={event => { sent.current = undefined; setSelected(event.target.value); }}><option value="">—</option>{catalog?.targets.map((item, index) => <option key={index} value={index} disabled={item.destination?.location.case === "serviceNode" ? catalog.home?.serviceNode : item.destination?.location.case === "peer" && item.destination.location.value.targetDeviceId === catalog.home?.deviceId}>{item.deviceName} · {item.platform}</option>)}</select></label>
      {selected !== "" && !busy && !models.length && <p>{text.unavailable}</p>}
      {!!models.length && <><p>{text.channel}</p><label className="field"><span>{text.model}</span><select value={model} disabled={busy} onChange={event => { sent.current = undefined; setModel(event.target.value); setPermission(PermissionMode.ASK); setPlan(false); }}><option value="">—</option>{models.map((item, index) => <option key={index} value={index}>{item.displayName}</option>)}</select></label>
        {choice && <><label className="field"><span>{text.permissions}</span><select value={permission} disabled={busy} onChange={event => { sent.current = undefined; setPermission(Number(event.target.value)); }}>{modes.map(mode => <option key={mode} value={mode}>{mode === PermissionMode.ASK ? text.ask : mode === PermissionMode.ACCEPT_EDITS ? text.edits : mode === PermissionMode.AUTO ? text.auto : text.full}</option>)}</select></label>
        {choice.canSetPlanMode && <label className="check-row"><input type="checkbox" checked={plan} onChange={event => { sent.current = undefined; setPlan(event.target.checked); }} />{text.plan}</label>}</>}
      </>}
      <label className="check-row"><input type="radio" checked={busyAction === PartnerHomeBusyAction.WAIT} onChange={() => { sent.current = undefined; setBusyAction(PartnerHomeBusyAction.WAIT); }} />{text.wait}</label>
      <label className="check-row"><input type="radio" checked={busyAction === PartnerHomeBusyAction.STOP} onChange={() => { sent.current = undefined; setBusyAction(PartnerHomeBusyAction.STOP); }} />{text.stop}</label>
      <label className="check-row"><input type="checkbox" checked={offline} onChange={event => { sent.current = undefined; setOffline(event.target.checked); }} />{text.offline}</label>
      <Button tone="primary" disabled={busy || selected === "" || model === "" || !choice || !modes.includes(permission)} onClick={() => void submit()}>{text.change}</Button>
    </>}
    {error && <p role="alert" className="partner-editor__error">{text.error}</p>}
    <div className="modal__actions"><Button disabled={busy} onClick={() => { const request = new AbortController(); void load(request.signal).catch(() => setError(true)); }}>{text.refresh}</Button><Button onClick={onClose}>{text.close}</Button></div>
  </div></Modal>;
}
