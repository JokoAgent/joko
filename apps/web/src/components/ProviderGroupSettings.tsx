import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import * as contract from "@joko/contracts";
import { providerGroupDraft, providerGroupUsageDateRange, type ProviderGroupSettingsApi } from "../provider-group-settings.js";
import { Button, Spinner, SwitchControl } from "./ui.js";
import "./provider-group-settings.css";

export const providerGroupSettingsMessageKeys = ["title", "body", "provider", "loading", "loadFailed", "saveFailed", "conflict", "saved", "refresh", "save", "delete", "reloadDraft", "strategy",
  "leastBusy", "roundRobin", "ordered", "weighted", "autoSwitch", "members", "noCandidates", "unavailable", "capacity", "weight", "paused", "localPause", "moveUp", "moveDown", "invalidNumbers",
  "usage", "period", "all", "last30Days", "last7Days", "today", "specificDay", "person", "node", "model", "turns", "tokens", "cost", "estimated", "incomplete", "noUsage"] as const;
export type ProviderGroupSettingsMessage = typeof providerGroupSettingsMessageKeys[number];
export type ProviderGroupSettingsTranslator = (key: `settings.providerGroups.${ProviderGroupSettingsMessage}`, values?: Readonly<Record<string, string | number>>) => string;
export interface ProviderGroupSettingsProps {
  readonly api: ProviderGroupSettingsApi; readonly nodeName: string; readonly t: ProviderGroupSettingsTranslator;
  readonly providers: readonly { readonly backendId: string; readonly providerId: string; readonly displayName: string }[];
}
interface DraftMember { readonly value: contract.ProviderGroupMember; readonly capacity: string; readonly weight: string; }
interface Draft { readonly strategy: contract.ProviderGroupStrategy; readonly autoSwitch: boolean; readonly members: readonly DraftMember[]; }
interface Owner { readonly api: ProviderGroupSettingsApi; readonly key: string; readonly abort: AbortController; dirty: boolean; writing: boolean; }

export function ProviderGroupSettings({ api, nodeName, providers, t }: ProviderGroupSettingsProps): JSX.Element | null {
  const [selected, setSelected] = useState<string>("");
  const available = providers.some(provider => keyOf(provider) === selected) ? selected : providers[0] ? keyOf(providers[0]) : "";
  const provider = providers.find(provider => keyOf(provider) === available);
  return <section className="provider-group-settings" aria-labelledby="provider-group-settings-title">
    <div className="settings-section-heading"><div className="settings-section-heading__copy"><h3 id="provider-group-settings-title">{t("settings.providerGroups.title")}</h3>
      <p>{t("settings.providerGroups.body", { name: nodeName })}</p></div></div>
    <label className="setting-row"><span className="setting-row__copy"><strong>{t("settings.providerGroups.provider")}</strong></span><select value={available} onChange={event => setSelected(event.target.value)}>
      {providers.map(provider => <option key={keyOf(provider)} value={keyOf(provider)}>{provider.displayName}</option>)}
    </select></label>
    {provider && <GroupPanel key={available} api={api} provider={provider} t={t} />}
  </section>;
}
function GroupPanel({ api, provider, t }: { readonly api: ProviderGroupSettingsApi; readonly provider: { readonly backendId: string; readonly providerId: string }; readonly t: ProviderGroupSettingsTranslator }): JSX.Element {
  const [snapshot, setSnapshot] = useState<contract.ProviderGroupSnapshot>();
  const [candidates, setCandidates] = useState<readonly contract.ProviderGroupCandidate[]>([]);
  const [draft, setDraft] = useState<Draft>();
  const [feedback, setFeedback] = useState<"loadFailed" | "saveFailed" | "conflict" | "saved">();
  const [busy, setBusy] = useState(true), [readVersion, setReadVersion] = useState(0);
  const owner = useRef<Owner | undefined>(undefined);
  useEffect(() => {
    const current: Owner = { api, key: keyOf(provider), abort: new AbortController(), dirty: false, writing: false }; owner.current = current;
    return () => { current.abort.abort(); if (owner.current === current) owner.current = undefined; };
  }, [api, provider.backendId, provider.providerId]);
  useEffect(() => {
    const current = owner.current; if (!current) return; let live = true;
    setBusy(true);
    void Promise.all([api.getProviderGroup(provider, current.abort.signal), api.listProviderGroupCandidates(provider, current.abort.signal)]).then(([group, choices]) => {
      if (!live || owner.current !== current || current.abort.signal.aborted) return;
      setSnapshot(group); setCandidates(choices); if (!current.dirty) setDraft(toDraft(providerGroupDraft(group.config, choices, provider))); setFeedback(undefined);
    }).catch(() => { if (live && !current.abort.signal.aborted) setFeedback("loadFailed"); }).finally(() => { if (live && owner.current === current) setBusy(false); });
    return () => { live = false; };
  }, [api, provider.backendId, provider.providerId, readVersion]);
  const change = (value: Draft) => { if (owner.current) owner.current.dirty = true; setDraft(value); };
  const config = draft && validDraft(draft);
  const mutate = async (deleting: boolean) => {
    const current = owner.current; if (!current || !snapshot || current.writing || busy || !deleting && !config) return;
    current.writing = true; setBusy(true); setFeedback(undefined);
    try {
      const group = await api.updateProviderGroup(provider, snapshot.revision, deleting ? undefined : config!, current.abort.signal);
      if (owner.current !== current || current.abort.signal.aborted) return;
      current.dirty = false; setSnapshot(group); setDraft(toDraft(providerGroupDraft(group.config, candidates, provider))); setFeedback("saved");
    } catch (error) {
      if (owner.current !== current || current.abort.signal.aborted) return;
      if (ConnectError.from(error).code === Code.Aborted) {
        try { const group = await api.getProviderGroup(provider, current.abort.signal); if (owner.current === current) setSnapshot(group); } catch { /* Keep the user's draft and existing revision. */ }
        if (owner.current === current) setFeedback("conflict");
      } else setFeedback("saveFailed");
    } finally { if (owner.current === current) { current.writing = false; setBusy(false); } }
  };
  const rows = useMemo(() => [...new Map([...(draft?.members.map(member => ({ member: member.value, available: false })) ?? []), ...candidates].filter(candidate => candidate.member).map(candidate => [candidate.member!.key, candidate])).values()], [draft, candidates]);
  return <div className="settings-card-stack">
    {feedback && <p role={feedback === "saved" ? "status" : "alert"}>{t(`settings.providerGroups.${feedback}`)}</p>}
    {!draft && <Button disabled={busy} onClick={() => setReadVersion(value => value + 1)}>{t("settings.providerGroups.refresh")}</Button>}
    {busy && !draft && <p role="status">{t("settings.providerGroups.loading")}</p>}
    {draft && <div className="settings-card">
      <label className="setting-row"><span className="setting-row__copy"><strong>{t("settings.providerGroups.strategy")}</strong></span><select value={draft.strategy} disabled={busy} onChange={event => change({ ...draft, strategy: Number(event.target.value) })}>
        <option value={contract.ProviderGroupStrategy.LEAST_BUSY}>{t("settings.providerGroups.leastBusy")}</option><option value={contract.ProviderGroupStrategy.ROUND_ROBIN}>{t("settings.providerGroups.roundRobin")}</option>
        <option value={contract.ProviderGroupStrategy.ORDERED}>{t("settings.providerGroups.ordered")}</option><option value={contract.ProviderGroupStrategy.WEIGHTED}>{t("settings.providerGroups.weighted")}</option>
      </select></label>
      <div className="setting-row provider-group-settings__toggle"><div><strong>{t("settings.providerGroups.autoSwitch")}</strong></div><SwitchControl checked={draft.autoSwitch} disabled={busy} aria-label={t("settings.providerGroups.autoSwitch")}
        onChange={event => change({ ...draft, autoSwitch: event.target.checked })} /></div>
      <h4>{t("settings.providerGroups.members")}</h4>
      {!rows.length && <p>{t("settings.providerGroups.noCandidates")}</p>}
      {rows.map(candidate => {
        const member = candidate.member!, selected = draft.members.find(row => row.value.key === member.key), index = draft.members.findIndex(row => row.value.key === member.key);
        const setMember = (patch: Partial<DraftMember>) => change({ ...draft, members: draft.members.map(row => row.value.key === member.key ? { ...row, ...patch } : row) });
        const move = (direction: number) => { const members = [...draft.members], other = index + direction; if (other < 0 || other >= members.length) return; [members[index], members[other]] = [members[other]!, members[index]!]; change({ ...draft, members }); };
        return <div className="provider-group-settings__member" key={member.key}>
          <label className="provider-group-settings__choice"><input type="checkbox" checked={selected !== undefined} disabled={busy} onChange={event => change({ ...draft,
            members: event.target.checked ? [...draft.members, { value: member, capacity: String(member.capacity), weight: String(member.weight) }] : draft.members.filter(row => row.value.key !== member.key) })} />
            <strong>{member.displayName}</strong>{!candidate.available && <span className="muted">{t("settings.providerGroups.unavailable")}</span>}</label>
          {selected && <div className="provider-group-settings__fields">
            <label>{t("settings.providerGroups.capacity")}<input type="number" min={1} max={16} step={1} inputMode="numeric" value={selected.capacity} disabled={busy}
              aria-invalid={!parseInteger(selected.capacity, 16)} onChange={event => setMember({ capacity: event.target.value })} /></label>
            <label>{t("settings.providerGroups.weight")}<input type="number" min={1} max={100} step={1} inputMode="numeric" value={selected.weight} disabled={busy}
              aria-invalid={!parseInteger(selected.weight, 100)} onChange={event => setMember({ weight: event.target.value })} /></label>
            <label>{t("settings.providerGroups.paused")}<SwitchControl checked={selected.value.paused} disabled={busy} aria-label={`${t("settings.providerGroups.paused")} ${member.displayName}`}
              onChange={event => setMember({ value: create(contract.ProviderGroupMemberSchema, { ...selected.value, paused: event.target.checked }) })} /></label>
            <div className="provider-group-settings__reorder">
              <Button disabled={busy || index === 0} onClick={() => move(-1)} aria-label={t("settings.providerGroups.moveUp", { name: member.displayName })}>↑</Button>
              <Button disabled={busy || index === draft.members.length - 1} onClick={() => move(1)} aria-label={t("settings.providerGroups.moveDown", { name: member.displayName })}>↓</Button>
            </div>
            {member.kind === contract.ProviderGroupMemberKind.LOCAL && <p className="muted">{t("settings.providerGroups.localPause")}</p>}
          </div>}
        </div>;
      })}
      {!config && <p role="alert">{t("settings.providerGroups.invalidNumbers")}</p>}
      <div className="provider-group-settings__actions"><Button disabled={busy} onClick={() => setReadVersion(value => value + 1)}>{t("settings.providerGroups.refresh")}</Button>
        <Button disabled={busy} onClick={() => { if (owner.current) owner.current.dirty = false; setReadVersion(value => value + 1); }}>{t("settings.providerGroups.reloadDraft")}</Button>
        <Button disabled={busy || !snapshot?.config} onClick={() => { void mutate(true); }}>{t("settings.providerGroups.delete")}</Button>
        <Button disabled={busy || !config} onClick={() => { void mutate(false); }}>{t("settings.providerGroups.save")}</Button></div>
    </div>}
    <UsagePanel api={api} provider={provider} t={t} />
  </div>;
}
function UsagePanel({ api, provider, t }: { readonly api: ProviderGroupSettingsApi; readonly provider: { readonly backendId: string; readonly providerId: string }; readonly t: ProviderGroupSettingsTranslator }): JSX.Element {
  const [period, setPeriod] = useState<"all" | "30d" | "7d" | "today" | "day">("all"), [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const queryKey = JSON.stringify([provider.backendId, provider.providerId, period, date]);
  const [readVersion, setReadVersion] = useState(0);
  const [result, setResult] = useState<{ readonly api: ProviderGroupSettingsApi; readonly queryKey: string; readonly readVersion: number; readonly rows?: readonly contract.ProviderGroupUsageRow[]; readonly failed: boolean }>();
  const [party, setParty] = useState(""), [node, setNode] = useState(""), [model, setModel] = useState("");
  const current = result?.api === api && result.queryKey === queryKey && result.readVersion === readVersion ? result : undefined;
  const rows = current?.rows ?? [], error = current?.failed === true, loading = !current;
  useEffect(() => { const abort = new AbortController();
    void Promise.resolve().then(() => api.getProviderGroupUsage({ key: create(contract.ProviderGroupKeySchema, provider), ...providerGroupUsageDateRange(period, date) }, abort.signal))
      .then(rows => { if (!abort.signal.aborted) setResult({ api, queryKey, readVersion, rows, failed: false }); })
      .catch(() => { if (!abort.signal.aborted) setResult({ api, queryKey, readVersion, failed: true }); }); return () => abort.abort();
  }, [api, provider.backendId, provider.providerId, period, date, queryKey, readVersion]);
  const selectedParty = rows.some(row => row.partyId === party) ? party : "", selectedNode = rows.some(row => row.nodeId === node) ? node : "", selectedModel = rows.some(row => row.modelId === model) ? model : "";
  const filtered = rows.filter(row => (!selectedParty || row.partyId === selectedParty) && (!selectedNode || row.nodeId === selectedNode) && (!selectedModel || row.modelId === selectedModel));
  const totals = [...new Map(filtered.map(row => [row.currencyCode, row.currencyCode])).keys()].map(currency => ({ currency, turns: filtered.filter(row => row.currencyCode === currency).reduce((sum, row) => sum + row.turns, 0n),
    tokens: filtered.filter(row => row.currencyCode === currency).reduce((sum, row) => sum + row.totalTokens, 0n), cost: filtered.filter(row => row.currencyCode === currency).reduce((sum, row) => sum + row.costMicros, 0n),
    estimated: filtered.some(row => row.currencyCode === currency && row.estimated), incomplete: filtered.some(row => row.currencyCode === currency && (!row.tokensComplete || !row.costComplete)) }));
  const filter = (label: "person" | "node" | "model", selected: string, change: (value: string) => void, values: readonly [string, string][]) => <label>{t(`settings.providerGroups.${label}`)}<select value={selected} disabled={loading || error} onChange={event => change(event.target.value)}>
    <option value="">{t("settings.providerGroups.all")}</option>{[...new Map(values).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
  return <div className="settings-card settings-card--content provider-group-settings__usage"><h4>{t("settings.providerGroups.usage")}</h4><div className="provider-group-settings__usage-filters">
    <label>{t("settings.providerGroups.period")}<select value={period} onChange={event => setPeriod(event.target.value as typeof period)}>
      {[["all", "all"], ["30d", "last30Days"], ["7d", "last7Days"], ["today", "today"], ["day", "specificDay"]].map(([value, label]) => <option key={value} value={value}>{t(`settings.providerGroups.${label as ProviderGroupSettingsMessage}`)}</option>)}
    </select></label>{period === "day" && <input type="date" value={date} aria-label={t("settings.providerGroups.specificDay")} onChange={event => setDate(event.target.value)} />}
    {filter("person", selectedParty, setParty, rows.map(row => [row.partyId, row.partyName]))}{filter("node", selectedNode, setNode, rows.map(row => [row.nodeId, row.nodeName]))}{filter("model", selectedModel, setModel, rows.map(row => [row.modelId, row.modelId]))}
  </div>{loading && <Spinner label={t("settings.providerGroups.loading")} />}
    {error && <><p role="alert">{t("settings.providerGroups.loadFailed")}</p><Button onClick={() => setReadVersion(value => value + 1)}>{t("settings.providerGroups.refresh")}</Button></>}
    {!loading && !error && (!filtered.length ? <p className="muted">{t("settings.providerGroups.noUsage")}</p> : <div className="provider-group-settings__usage-table"><table><thead><tr><th>{t("settings.providerGroups.turns")}</th><th>{t("settings.providerGroups.tokens")}</th><th>{t("settings.providerGroups.cost")}</th></tr></thead>
      <tbody>{totals.map(total => <tr key={total.currency}><td>{total.turns.toString()}</td><td>{total.tokens.toString()}</td><td>{total.currency ? `${total.currency} ${formatMicros(total.cost)}` : "—"}
        {total.estimated && <span> · {t("settings.providerGroups.estimated")}</span>}{total.incomplete && <span> · {t("settings.providerGroups.incomplete")}</span>}</td></tr>)}</tbody></table></div>)}
  </div>;
}
function keyOf(value: { readonly backendId: string; readonly providerId: string }): string { return JSON.stringify([value.backendId, value.providerId]); }
function formatMicros(value: bigint): string { const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, ""); return (value / 1_000_000n).toLocaleString() + (fraction ? "." + fraction : ""); }
function toDraft(value: contract.ProviderGroupConfig): Draft { return { strategy: value.strategy, autoSwitch: value.autoSwitch, members: value.members.map(value => ({ value, capacity: String(value.capacity), weight: String(value.weight) })) }; }
function parseInteger(value: string, maximum: number): number | undefined { const number = Number(value); return /^\d+$/u.test(value) && Number.isSafeInteger(number) && number >= 1 && number <= maximum ? number : undefined; }
function validDraft(value: Draft): contract.ProviderGroupConfig | undefined {
  if (value.members.some(member => !parseInteger(member.capacity, 16) || !parseInteger(member.weight, 100))) return undefined;
  return create(contract.ProviderGroupConfigSchema, { strategy: value.strategy, autoSwitch: value.autoSwitch, members: value.members.map(member => ({ ...member.value, capacity: parseInteger(member.capacity, 16)!, weight: parseInteger(member.weight, 100)! })) });
}
