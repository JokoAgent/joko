import { useEffect, useRef, useState, type JSX } from "react";
import { partnerIdentityMessages, type PartnerIdentityGrant, type PartnerIdentityLink } from "@joko/contracts";
import { Link2 } from "lucide-react";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";
import { Button } from "./ui.js";
import "./partner-identity.css";

export function PartnerIdentityDirectory({ controller, partners }: { controller: AppController; partners: readonly PartnerProfileView[] }): JSX.Element | null {
  const api = controller.partnerIdentity, m = partnerIdentityMessages(controller.state.effectiveLocale);
  const [links, setLinks] = useState<PartnerIdentityLink[]>([]), [grants, setGrants] = useState<PartnerIdentityGrant[]>([]);
  const [invitation, setInvitation] = useState(""), [alias, setAlias] = useState(""), [issued, setIssued] = useState("");
  const [participant, setParticipant] = useState("Joko"), [partnerId, setPartnerId] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const current = useRef(controller), lifetime = useRef(new AbortController()), active = useRef(false);
  current.current = controller;
  useEffect(() => {
    lifetime.current = new AbortController(); const signal = lifetime.current.signal;
    if (api) void api.listPartnerIdentities({}, { signal }).then(result => { if (!signal.aborted) { setLinks(result.links); setGrants(result.grants); } }, () => { if (!signal.aborted) setError(m.failed); });
    return () => lifetime.current.abort();
  }, [api, reload]);
  useEffect(() => { setIssued(""); setInvitation(""); }, [api]);
  if (!api) return null;
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (active.current) return; active.current = true; setBusy(true); setError("");
    const signal = lifetime.current.signal;
    try { await work(signal); if (!signal.aborted) setReload(value => value + 1); }
    catch { if (!signal.aborted) setError(m.failed); }
    finally { active.current = false; if (!signal.aborted) setBusy(false); }
  };
  const own = partners.filter(partner => partner.lifecycle === "active" && partner.canonicalSessionId);
  return <section className="partner-groups-section partner-identity-section" aria-label={m.title}>
    <header><h2><Link2 aria-hidden="true" />{m.title}</h2><Button disabled={busy} onClick={() => setReload(value => value + 1)}>{m.refresh}</Button></header>
    <p>{m.description}</p>
    <div className="partner-group-inline-form">
      <label>{m.invitation}<input aria-label={m.invitation} type="password" autoComplete="off" value={invitation} onChange={event => setInvitation(event.target.value)} /></label>
      <label>{m.alias}<input aria-label={m.alias} value={alias} onChange={event => setAlias(event.target.value)} /></label>
      <Button disabled={busy || !invitation.trim()} onClick={() => void run(async signal => { await api.importPartnerIdentity({ invitation, alias }, { signal }); if (!signal.aborted) { setInvitation(""); setAlias(""); } })}>{m.add}</Button>
    </div>
    <label>{m.name}<input aria-label={m.name} value={participant} onChange={event => setParticipant(event.target.value)} /></label>
    {!links.length && <p>{m.empty}</p>}
    {links.map(link => <div className="partner-group-directory-row partner-identity-link" key={link.linkId}>
      <span><strong>{link.alias}</strong><small>{link.identity?.displayName} · {link.identity?.authorityServerId}</small></span>
      <input aria-label={`${m.alias}: ${link.alias}`} value={aliases[link.linkId] ?? link.alias} onChange={event => setAliases(previous => ({ ...previous, [link.linkId]: event.target.value }))} />
      <Button disabled={busy || !(aliases[link.linkId]?.trim()) || aliases[link.linkId] === link.alias} onClick={() => void run(async signal => { await api.renamePartnerIdentity({ linkId: link.linkId, alias: aliases[link.linkId]! }, { signal }); })}>{m.save}</Button>
      <Button disabled={busy || !participant.trim()} onClick={() => void run(async signal => {
        const profileId = current.current.state.activeProfile?.id;
        const response = await api.openPartnerIdentity({ operationId: crypto.randomUUID(), linkId: link.linkId, displayName: participant }, { signal });
        if (signal.aborted || !profileId || current.current.state.activeProfile?.id !== profileId || current.current.partnerIdentity !== api) return;
        if (!response.joined || response.joined.status !== "active") { setError(m.unknown); return; }
        current.current.navigate({ kind: "sharedTask", joinId: response.joined.joinId, profileId });
      })}>{m.open}</Button>
      <Button disabled={busy} onClick={() => void run(async signal => { await api.forgetPartnerIdentity({ operationId: crypto.randomUUID(), linkId: link.linkId }, { signal }); })}>{m.forget}</Button>
    </div>)}
    {!!own.length && <div className="partner-group-inline-form"><label>{m.partner}<select aria-label={m.partner} value={partnerId} onChange={event => setPartnerId(event.target.value)}><option value="">—</option>{own.map(partner => <option key={partner.id} value={partner.id}>{partner.displayName}</option>)}</select></label>
      <Button disabled={busy || !own.some(partner => partner.id === partnerId)} onClick={() => void run(async signal => {
        const partner = own.find(partner => partner.id === partnerId); if (!partner) return;
        const response = await api.issuePartnerIdentity({ operationId: crypto.randomUUID(), partnerId, expectedRevision: partner.revision }, { signal });
        if (!signal.aborted) setIssued(response.invitation);
      })}>{m.issue}</Button></div>}
    {issued && <div><p>{m.copy}</p><textarea aria-label={m.invitation} readOnly value={issued} /><Button onClick={() => setIssued("")}>{m.close}</Button></div>}
    {!!grants.length && <div><h3>{m.grants}</h3>{grants.map(grant => <div className="partner-group-directory-row" key={grant.grantId}><span>{grant.identity?.displayName} · {grant.grantId}</span><Button disabled={busy || grant.status !== "active"} onClick={() => void run(async signal => { await api.revokePartnerIdentity({ operationId: crypto.randomUUID(), grantId: grant.grantId }, { signal }); })}>{m.revoke}</Button></div>)}</div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
