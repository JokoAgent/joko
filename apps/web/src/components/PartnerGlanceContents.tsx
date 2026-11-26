import { useEffect, useRef, useState, type JSX } from "react";
import { PartnerTaskOutputReadiness, partnerAutonomyMessages, type PartnerAutonomyApi, type PartnerTaskOutput,
  type PartnerHomeApi, type PartnerHomeDestination, type ListPartnerHomeTargetsResponse } from "@joko/contracts";
import { usePartnerConversation } from "./PartnerConversation.js";
import { Button } from "./ui.js";

export function PartnerGlanceContents({ api, partnerId, locale, enabled, close }: { readonly api: PartnerAutonomyApi;
  readonly partnerId: string; readonly locale?: string; readonly enabled: boolean; readonly close: () => void }): JSX.Element {
  const m = partnerAutonomyMessages(locale), conversation = usePartnerConversation();
  const [all, setAll] = useState(false);
  const [outputs, setOutputs] = useState<readonly PartnerTaskOutput[]>([]), [outputFailed, setOutputFailed] = useState(false), [outputRefresh, setOutputRefresh] = useState(0);
  const alive = useRef(true), outputFlight = useRef<AbortController | undefined>(undefined);
  useEffect(() => { alive.current = true; return () => { alive.current = false; outputFlight.current?.abort(); }; }, []);
  useEffect(() => {
    if (!enabled) return; const abort = new AbortController(); outputFlight.current?.abort(); outputFlight.current = abort;
    void api.outputs(partnerId, abort.signal).then(value => { if (!abort.signal.aborted) { setOutputs(value); setOutputFailed(false); } })
      .catch(() => { if (!abort.signal.aborted) setOutputFailed(true); });
    return () => { abort.abort(); outputFlight.current?.abort(); };
  }, [api, partnerId, enabled, outputRefresh]);
  const openOutput = async (source: PartnerTaskOutput, path: string) => {
    const abort = new AbortController(); outputFlight.current?.abort(); outputFlight.current = abort;
    try {
      const latest = (await api.outputs(partnerId, abort.signal)).find(row => row.sourceId === source.sourceId && row.sourceKind === source.sourceKind);
      if (!alive.current || abort.signal.aborted) return;
      if (!latest || latest.sessionId !== source.sessionId || latest.execution !== source.execution || latest.sourceRevision?.value !== source.sourceRevision?.value
        || latest.runIds.join("\0") !== source.runIds.join("\0") || !latest.files.some(file => file.path === path)) throw new Error("The output source changed.");
      close(); conversation?.openOutputFile?.(source.sessionId, path);
    } catch { if (alive.current && !abort.signal.aborted) setOutputFailed(true); }
  };
  const files = outputs.filter(output => output.readiness === PartnerTaskOutputReadiness.READY).flatMap(output => output.files.map(file => ({ output, file })));
  return <>
    {conversation?.homeApi && conversation.openHomeSettings ? <PartnerGlanceComputers key={`${conversation.homeApi.ownerKey}:${partnerId}`} api={conversation.homeApi} partnerId={partnerId} locale={locale} enabled={enabled}
      onSelect={destination => { close(); conversation.openHomeSettings?.(destination); }} /> : <section><h3>{m.computers}</h3><span>{conversation?.homeLabel || m.here}</span></section>}
    {(files.length > 0 || outputFailed) && <section><h3>{m.outputs}</h3>{outputFailed && <Button onClick={() => setOutputRefresh(value => value + 1)}>{m.failed} {m.refresh}</Button>}
      <ul>{files.slice(0, all ? 30 : 3).map(({ output, file }) => <li key={`${output.sourceKind}:${output.sourceId}:${file.path}`}>
        <button type="button" onClick={() => void openOutput(output, file.path)}><span>{file.path.split('/').at(-1)}</span><small>{output.title}</small></button>
      </li>)}</ul>{files.length > 3 && <Button aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? m.less : m.more} ({files.length})</Button>}
    </section>}
  </>;
}

/** Reads only the existing residence catalog; choosing a row opens its ordinary confirmation. */
export function PartnerGlanceComputers({ api, partnerId, locale, enabled, onSelect }: { readonly api: PartnerHomeApi; readonly partnerId: string; readonly locale?: string;
  readonly enabled: boolean; readonly onSelect: (destination: PartnerHomeDestination) => void }): JSX.Element {
  const m = partnerAutonomyMessages(locale), [catalog, setCatalog] = useState<ListPartnerHomeTargetsResponse>(), [failed, setFailed] = useState(false), [offline, setOffline] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return; const scope = new AbortController(); let reading = false;
    const read = async () => { if (reading || scope.signal.aborted || document.hidden) return; reading = true;
      try { const value = await api.list(partnerId, scope.signal); if (!value.home) throw new Error("The home computer is unavailable."); if (!scope.signal.aborted) { setCatalog(value); setFailed(false); } }
      catch { if (!scope.signal.aborted) setFailed(true); } finally { reading = false; } };
    void read(); document.addEventListener("visibilitychange", read);
    return () => { scope.abort(); document.removeEventListener("visibilitychange", read); };
  }, [api, partnerId, enabled, refresh]);
  const others = catalog?.targets.filter(target => target.destination?.location.case === "serviceNode" ? !catalog.home?.serviceNode
    : target.destination?.location.case === "peer" && target.destination.location.value.targetDeviceId !== catalog.home?.deviceId) ?? [];
  const disconnected = others.filter(target => !target.available);
  return <section><h3>{m.computers}</h3>{catalog?.home ? <p><strong>{catalog.home.deviceName}</strong><small> · {m.here} · {catalog.home.available ? m.online : m.offline}</small></p> : !failed && <p>{m.loading}</p>}
    {others.filter(target => target.available).map((target, index) => <button type="button" key={index} disabled={catalog?.home?.changing || !target.destination} onClick={() => target.destination && onSelect(target.destination)}><span>{target.deviceName}</span><small> · {m.online}</small></button>)}
    {disconnected.length > 0 && <Button tone="ghost" aria-expanded={offline} onClick={() => setOffline(value => !value)}>{m.offlineCount.replace("{count}", String(disconnected.length))}</Button>}
    {offline && disconnected.map((target, index) => <p key={index}><span>{target.deviceName}</span><small> · {m.offline}</small></p>)}
    {failed && <p role="alert">{m.computersFailed}<Button onClick={() => setRefresh(value => value + 1)}>{m.refresh}</Button></p>}
  </section>;
}
