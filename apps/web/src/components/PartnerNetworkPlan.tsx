import { useEffect, useRef, useState } from "react";
import { partnerGroupMessages, partnerNetworkActorName, type PartnerNetworkPlan, type PartnerNetworkRoom } from "@joko/contracts";
import type { PartnerNetworkApi } from "../partner-network-api.js";
import { Button } from "./ui.js";

export function NetworkPlanCard({ plan, room, locale, busy, action }: { plan: PartnerNetworkPlan; room: PartnerNetworkRoom; locale: string; busy: boolean;
  action(action: string, plan: PartnerNetworkPlan, position?: number, actorId?: string): void }) {
  const m = partnerGroupMessages(locale), [now, setNow] = useState(Date.now());
  useEffect(() => { if (plan.status !== "running") return; const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, [plan.status]);
  const editable = plan.status === "proposed" || plan.status === "waiting", proposed = plan.status === "proposed";
  const candidates = room.members.filter(actor => actor.kind === "partner" && actor.state === "joined" && (actor.ownerId === room.selfId || actor.guestAccess !== "none"));
  const actorName = (id: string) => { const actor = room.members.find(actor => actor.id === id); return actor ? partnerNetworkActorName(actor, room) : m.memberUnavailable; };
  const label = (status: string) => ({ pending: m.pending, running: m.running, completed: m.done, failed: m.failed, proposed: m.proposed, waiting: m.waiting,
    stopped: m.stopped, dismissed: m.dismissed, superseded: m.superseded })[status] ?? status;
  return <section className={`partner-group-plan${["dismissed", "superseded", "stopped"].includes(plan.status) ? " is-muted" : ""}`} aria-label={m.plan}>
    <p className="partner-group-plan-intro">{m.planIntro.replace("{count}", String(plan.steps.length))}</p>
    <div className="partner-group-plan-card"><ol>{plan.steps.map(step => <li key={step.position} className={step.status === "running" ? "is-running" : step.status === "failed" ? "is-failed" : ""}>
      <span className="partner-group-step-lead">{step.position + 1}</span><span className="partner-group-step-task"><strong>{actorName(step.actorId)}</strong> {step.task}</span>
      <small>{label(step.status)}{step.status === "running" && step.startedAtMs > 0n ? ` · ${Math.max(0, Math.floor((now - Number(step.startedAtMs)) / 1_000))}s` : step.finishedAtMs > 0n ? ` · ${new Date(Number(step.finishedAtMs)).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}` : ""}</small>
      {editable && (proposed || step.status !== "completed") && <select aria-label={`${m.reassign} ${step.position + 1}`} value={step.actorId} disabled={busy} onChange={event => action("reassign", plan, step.position, event.target.value)}>
        {!candidates.some(actor => actor.id === step.actorId) && <option value={step.actorId}>{m.memberUnavailable}</option>}{candidates.map(actor => <option key={actor.id} value={actor.id}>{partnerNetworkActorName(actor, room)}</option>)}</select>}
      {proposed && <Button disabled={busy || plan.steps.length < 2} onClick={() => action("remove-step", plan, step.position)}>{m.remove}</Button>}
    </li>)}</ol></div><small>{m.pauseNote}</small>
    <div className="partner-group-plan-actions">{proposed ? <><Button disabled={busy} onClick={() => action("start", plan)}>{m.start}</Button><Button disabled={busy} tone="ghost" onClick={() => action("dismiss", plan)}>{m.dismiss}</Button></> : <span>{label(plan.status)}</span>}</div>
  </section>;
}

export function NetworkPlanFollowUp({ plan, room, locale, busy, action }: { plan: PartnerNetworkPlan; room: PartnerNetworkRoom; locale: string; busy: boolean;
  action(action: string, plan: PartnerNetworkPlan): void }) {
  const m = partnerGroupMessages(locale); if (plan.status !== "waiting") return null;
  const failed = plan.steps[plan.currentStep]?.status === "failed", next = plan.steps[failed ? plan.currentStep : plan.currentStep + 1];
  if (!next) return null;
  const actor = room.members.find(actor => actor.id === next.actorId);
  return <div className="partner-group-follow-up" role="status"><span>{failed ? m.failed : m.nextStep}: {actor ? partnerNetworkActorName(actor, room) : m.memberUnavailable} · {next.task}</span>
    <Button disabled={busy} onClick={() => action(failed ? "retry" : "continue", plan)}>{failed ? m.retry : m.next}</Button><Button tone="ghost" disabled={busy} onClick={() => action("stop", plan)}>{m.stop}</Button></div>;
}

export function NetworkProjectSetting({ api, target, locale, room }: { api: PartnerNetworkApi; target: { roomId: string; joinId: string }; locale: string; room: PartnerNetworkRoom }) {
  const m = partnerGroupMessages(locale), [path, setPath] = useState(""), [busy, setBusy] = useState(true), [error, setError] = useState(false), lifetime = useRef(new AbortController());
  useEffect(() => { const signal = lifetime.current.signal; void api.configurePartnerNetworkProject(target, { signal }).then(result => { if (!signal.aborted) { setPath(result.directory); setBusy(false); } })
    .catch(() => { if (!signal.aborted) { setError(true); setBusy(false); } }); return () => lifetime.current.abort(); }, []);
  const save = async (directory: string) => { setBusy(true); setError(false); try { const result = await api.configurePartnerNetworkProject({ ...target, replace: true, directory }, { signal: lifetime.current.signal });
    if (!lifetime.current.signal.aborted) setPath(result.directory); } catch { if (!lifetime.current.signal.aborted) setError(true); } finally { if (!lifetime.current.signal.aborted) setBusy(false); } };
  return <><label>{m.project}<input value={path} disabled={busy || room.state !== "active"} onChange={event => setPath(event.target.value)} /></label><small>{m.folderHint}</small>
    <Button disabled={busy || room.state !== "active"} onClick={() => { void save(path); }}>{m.save}</Button><Button disabled={busy || room.state !== "active"} onClick={() => { void save(""); }}>{m.clearProject}</Button>{error && <p role="alert">{m.workdirUnavailable}</p>}</>;
}
