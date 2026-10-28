import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type JSX } from "react";
import { readRemoteModelAccess, toRemoteModelAccess, type ProviderSharingApi, type GetHostedAgentCatalogResponse, type ListProviderSharesResponse, type ProviderSharingPreview, type ProviderSharingRequest,
  type ProviderSharingOwned, type ProviderSharingMember } from "@joko/contracts";
import { Button, Pill } from "./ui.js";
import { providerSharingText } from "../provider-sharing-text.js";
import { moveTablistSelection } from "./tablist-navigation.js";
import { RemoteModelAccessEditor } from "./RemoteModelAccessEditor.js";
import { ProviderSharingInsights } from "./ProviderSharingInsights.js";
import "./provider-sharing.css";

export interface ProviderSharingSettingsProps {
  readonly api: ProviderSharingApi; readonly nodeKey: string; readonly nodeName: string;
  readonly catalog: GetHostedAgentCatalogResponse | undefined; readonly language?: string; readonly initialLink?: string;
}
interface Owner { readonly api: ProviderSharingApi; readonly nodeKey: string; readonly lifetime: AbortController; reading: boolean; writing: boolean; readId: number; }
/** An ordinary Home page. Invitation fragments never enter the route history,
 * operation journal, browser storage, or a foreign credential response. */
export function ProviderSharingSettings(props: ProviderSharingSettingsProps): JSX.Element {
  return <ProviderSharingPanel key={props.nodeKey} {...props} />;
}
function ProviderSharingPanel({ api, nodeKey, nodeName, catalog, language, initialLink }: ProviderSharingSettingsProps): JSX.Element {
  const text = providerSharingText(language), current = useRef<Owner | undefined>(undefined);
  const tabId = useId();
  const [value, setValue] = useState<Omit<ListProviderSharesResponse, "$typeName">>(), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [tab, setTab] = useState<"owned" | "received">(initialLink ? "received" : "owned");
  const [name, setName] = useState(nodeName), [providerKey, setProviderKey] = useState("");
  const [link, setLink] = useState(initialLink ?? ""), [preview, setPreview] = useState<ProviderSharingPreview>();
  const [issued, setIssued] = useState<{ readonly link: string; readonly expiresAtMs: bigint }>(), [now, setNow] = useState(Date.now());
  const [compared, setCompared] = useState<ReadonlySet<string>>(new Set());
  const providers = (catalog?.remoteControlEnabled ? catalog.backends : []).flatMap(backend => backend.providers.filter(provider => provider.connected && provider.remoteInvocationEnabled && provider.models.length)
    .map(provider => ({ backendId: backend.backendId, providerId: provider.providerId, displayName: `${backend.displayName} · ${provider.displayName}` })));
  const selected = providers.find(provider => JSON.stringify([provider.backendId, provider.providerId]) === providerKey) ?? providers[0];
  const live = (owner: Owner) => current.current === owner && !owner.lifetime.signal.aborted;
  const read = useCallback(async (refresh: boolean) => {
    const owner = current.current; if (!owner || owner.api !== api || owner.nodeKey !== nodeKey || owner.reading || owner.writing) return;
    owner.reading = true; const readId = ++owner.readId;
    try { const result = await (refresh ? api.refresh(owner.lifetime.signal) : api.list(owner.lifetime.signal)); if (live(owner) && owner.readId === readId) { setValue(result); setError(false); } }
    catch { if (live(owner) && owner.readId === readId) setError(true); }
    finally { owner.reading = false; if (live(owner)) setLoading(false); }
  }, [api, nodeKey]);
  useEffect(() => {
    const owner: Owner = { api, nodeKey, lifetime: new AbortController(), reading: false, writing: false, readId: 0 }; current.current = owner;
    void read(false); const refresh = window.setInterval(() => { void read(true); }, 5_000), clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { owner.lifetime.abort(); window.clearInterval(refresh); window.clearInterval(clock); if (current.current === owner) current.current = undefined; };
  }, [api, nodeKey, read]);
  const action = async (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const owner = current.current; if (!owner || owner.writing) return;
    owner.writing = true; owner.readId++; setBusy(true); setError(false);
    try { await work(owner.lifetime.signal); }
    catch { if (live(owner)) setError(true); }
    finally { owner.writing = false; if (live(owner)) { setBusy(false); void read(true); } }
  };
  const createLink = (event: FormEvent) => { event.preventDefault(); if (!selected || !name.trim()) return;
    void action(async signal => { const result = await api.createLink({ operationId: crypto.randomUUID(), backendId: selected.backendId, providerId: selected.providerId,
      providerName: selected.displayName, owner: { name: name.trim() } }, signal); if (current.current?.lifetime.signal === signal) setIssued(result); }); };
  const inspect = (event: FormEvent) => { event.preventDefault(); setPreview(undefined); void action(async signal => {
    const result = await api.preview(link.trim(), signal); if (current.current?.lifetime.signal === signal) setPreview(result.preview); }); };
  const approve = (request: ProviderSharingRequest, allowed: boolean) => { if (allowed && !compared.has(request.requestId)) return;
    void action(async signal => { await api.decide(crypto.randomUUID(), request.requestId, allowed, signal); setCompared(previous => { const next = new Set(previous); next.delete(request.requestId); return next; }); }); };
  const member = (share: ProviderSharingOwned, row: ProviderSharingMember, kind: string) => void action(async signal => {
    await api.member({ operationId: crypto.randomUUID(), shareId: share.shareId, memberId: row.memberId, generation: row.generation, action: kind }, signal); });
  const disabled = busy || loading;
  return <section className="provider-sharing-settings" aria-labelledby="provider-sharing-heading">
    <div className="settings-section-heading"><h3 id="provider-sharing-heading">{text.title}</h3><p>{text.body}</p></div>
    <div className="settings-actions"><div role="tablist" aria-label={text.title} className="settings-actions">
      {(["owned", "received"] as const).map(value => <Button key={value} id={`${tabId}-${value}`} role="tab" aria-selected={tab === value} aria-controls={`${tabId}-panel`} tabIndex={tab === value ? 0 : -1} tone={tab === value ? "primary" : "secondary"} onKeyDown={event => { moveTablistSelection(event, "horizontal"); }} onClick={() => setTab(value)}>{text[value]}</Button>)}
      </div>
      <Button disabled={disabled} onClick={() => { void read(true); }}>{text.refresh}</Button>
    </div>
    {error && <p role="alert">{text.unknown}</p>}
    {loading && <p role="status">{text.loading}</p>}
    {tab === "owned" ? <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-owned`} tabIndex={0}>
      <form onSubmit={createLink} className="settings-card">
        <label>{text.name}<input value={name} maxLength={200} onChange={event => setName(event.target.value)} disabled={busy} autoComplete="name" /></label>
        <label>{text.provider}<select value={selected ? JSON.stringify([selected.backendId, selected.providerId]) : ""} onChange={event => setProviderKey(event.target.value)} disabled={busy || !providers.length}>
          {providers.map(provider => <option key={JSON.stringify([provider.backendId, provider.providerId])} value={JSON.stringify([provider.backendId, provider.providerId])}>{provider.displayName}</option>)}
        </select></label>
        {!providers.length && <p>{text.enableRemote}</p>}
        <Button type="submit" tone="primary" disabled={disabled || !selected || !name.trim()}>{text.createLink}</Button>
        {issued && <div className="provider-sharing-invitation"><label>{Number(issued.expiresAtMs) > now ? text.privateLink : text.expired}<input readOnly value={issued.link} onFocus={event => event.currentTarget.select()} aria-label={text.privateLink} /></label>
          <p>{text.linkRule}</p><Button disabled={Number(issued.expiresAtMs) <= now} onClick={() => { void navigator.clipboard?.writeText(issued.link).catch(() => setError(true)); }}>{text.copy}</Button></div>}
      </form>
      {value?.owned.map(share => <article className="settings-card" key={share.shareId}>
        <h4>{share.providerName}</h4>
        {share.requests.map(request => <div className="provider-sharing-person" key={request.requestId}>
          <p><strong>{request.person?.name}</strong> · {text.applying}</p><p>{text.compare}</p><output className="provider-sharing-code" aria-label={text.code}>{request.pairingCode}</output>
          <label className="provider-sharing-compare"><input type="checkbox" checked={compared.has(request.requestId)} onChange={event => setCompared(previous => { const next = new Set(previous); if (event.target.checked) next.add(request.requestId); else next.delete(request.requestId); return next; })} disabled={busy} />{text.compared}</label>
          <div className="settings-actions"><Button tone="primary" disabled={disabled || !compared.has(request.requestId)} onClick={() => approve(request, true)}>{text.approve}</Button><Button disabled={disabled} onClick={() => approve(request, false)}>{text.reject}</Button></div>
        </div>)}
        {share.members.map(row => <div className="provider-sharing-person" key={row.memberId}>
          <div className="provider-sharing-person-heading"><strong>{row.person?.name}</strong><Pill>{text.state(row.status)}</Pill></div>
          <div className="settings-actions"><Button disabled={disabled} onClick={() => member(share, row, row.status === "paused" ? "resume" : "pause")}>{row.status === "paused" ? text.resume : text.pause}</Button>
            <Button disabled={disabled} onClick={() => member(share, row, "remove")}>{text.remove}</Button></div>
          <RemoteModelAccessEditor key={`${row.memberId}:${row.generation}`} member disabled={disabled} language={language}
            models={share.availableModels.flatMap(model => model.key ? [{ id: model.key.modelId, name: model.displayName || model.key.modelId }] : [])}
            selected={readRemoteModelAccess(row.modelAccess)} providerSelected={readRemoteModelAccess(share.providerModelAccess)}
            onSave={models => action(async signal => { await api.modelAccess({ operationId: crypto.randomUUID(), shareId: share.shareId, memberId: row.memberId,
              expectedRevision: share.revision, memberGeneration: row.generation, access: toRemoteModelAccess(models) }, signal); })} />
        </div>)}
        {share.reshares.map(row => <div className="provider-sharing-person" key={row.id}>
          <p>{text.reshare(share.members.find(member => member.memberId === row.memberId)?.person?.name ?? "", row.person?.name ?? "")}</p><Pill>{text.state(row.state)}</Pill>
          <div className="settings-actions"><Button tone="primary" disabled={disabled || row.state === "approved"} onClick={() => void action(async signal => { await api.reshare(crypto.randomUUID(), row.id, true, signal); })}>{text.approve}</Button>
            <Button disabled={disabled || row.state === "rejected"} onClick={() => void action(async signal => { await api.reshare(crypto.randomUUID(), row.id, false, signal); })}>{text.reject}</Button></div>
        </div>)}
        {!share.requests.length && !share.members.length && !share.reshares.length && <p>{text.noMembers}</p>}
        <div className="provider-sharing-person">
          <label><input type="checkbox" checked={share.visibility?.quota === true} disabled={disabled} onChange={event => {
            const quota = event.target.checked; void action(async signal => { await api.visibility({ operationId: crypto.randomUUID(), shareId: share.shareId,
              expectedRevision: share.revision, visibility: { quota, usage: share.visibility?.usage ?? false } }, signal); });
          }} />{language?.startsWith("zh") ? "允许成员查看账户额度" : "Allow members to view account quota"}</label>
          <label><input type="checkbox" checked={share.visibility?.usage === true} disabled={disabled} onChange={event => {
            const usage = event.target.checked; void action(async signal => { await api.visibility({ operationId: crypto.randomUUID(), shareId: share.shareId,
              expectedRevision: share.revision, visibility: { quota: share.visibility?.quota ?? false, usage } }, signal); });
          }} />{language?.startsWith("zh") ? "允许成员查看自己的使用明细" : "Allow members to view their own usage details"}</label>
        </div>
      </article>)}
    </div> : <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-received`} tabIndex={0}>
      <form onSubmit={inspect} className="settings-card"><label>{text.paste}<textarea value={link} onChange={event => { setLink(event.target.value); setPreview(undefined); }} disabled={busy} spellCheck={false} /></label>
        <Button type="submit" disabled={disabled || !link.trim()}>{text.preview}</Button>
        {preview && <div><h4>{preview.providerName}</h4><p>{text.from(preview.owner?.name ?? "", preview.hostServerId)}</p><Pill>{text.state(preview.state)}</Pill>
          <label>{text.name}<input value={name} maxLength={200} onChange={event => setName(event.target.value)} disabled={busy} autoComplete="name" /></label>
          <p>{text.applicationRule}</p><Button tone="primary" disabled={disabled || !name.trim() || preview.state !== "unused" || Number(preview.expiresAtMs) <= now} onClick={() => void action(async signal => {
            await api.apply({ operationId: crypto.randomUUID(), link: link.trim(), person: { name: name.trim() } }, signal);
            if (current.current?.lifetime.signal === signal) { setLink(""); setPreview(undefined); }
          })}>{text.apply}</Button></div>}
      </form>
      {value?.intents.filter(intent => intent.status !== "approved").map(intent => <article className="settings-card" key={intent.operationId}>
        <h4>{intent.preview?.providerName}</h4><Pill>{text.state(intent.status)}</Pill>
        {intent.request?.pairingCode && <><p>{text.compare}</p><output className="provider-sharing-code" aria-label={text.code}>{intent.request.pairingCode}</output></>}
        {intent.status === "pending" && <Button disabled={disabled} onClick={() => void action(async signal => { await api.withdraw(crypto.randomUUID(), intent.operationId, signal); })}>{text.withdraw}</Button>}
        {intent.status === "unknown" && <p>{text.unknown}</p>}
      </article>)}
      {value?.received.map(row => <article className="settings-card" key={row.joinId}><h4>{row.providerName}</h4><p>{text.from(row.owner?.name ?? "", row.hostServerId)}</p>
        <Pill>{text.state(row.state)}</Pill>{row.state === "active" && <p>{text.models(row.models.length)}</p>}
        <ProviderSharingInsights key={`${row.joinId}:${row.generation}:${row.accessRevision}:${row.state}`} api={api} joinId={row.joinId} language={language}
          disabled={row.state === "removed" || row.state === "paused"} />
        {row.state !== "removed" && <Button disabled={disabled} onClick={() => void action(async signal => { await api.leave(crypto.randomUUID(), row.joinId, signal); })}>{text.leave}</Button>}
      </article>)}
    </div>}
  </section>;
}
