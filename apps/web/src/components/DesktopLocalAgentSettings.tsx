import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

type LocalAgentApi = NonNullable<JokoDesktopApi["localAgents"]>;

export function DesktopLocalAgentSettings({ t }: { readonly t: Translator }): JSX.Element | null {
  const api = typeof window === "undefined" ? undefined : window.jokoDesktop?.localAgents;
  return api === undefined ? null : <LocalAgentSettingsPanel api={api} t={t} />;
}

function LocalAgentSettingsPanel({ api, t }: { readonly api: LocalAgentApi; readonly t: Translator }): JSX.Element {
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<LocalAgentApi["list"]>>>();
  const [unavailable, setUnavailable] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const readId = useRef(0);
  const load = useCallback(async () => {
    const current = ++readId.current;
    try {
      const result = await api.list();
      if (current === readId.current) { setSnapshot(result); setUnavailable(false); }
    } catch {
      if (current === readId.current) { setSnapshot(undefined); setUnavailable(true); }
    }
  }, [api]);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const tick = async () => {
      await load();
      if (active) timer = window.setTimeout(() => { void tick(); }, 2_500);
    };
    void tick();
    return () => { active = false; readId.current++; window.clearTimeout(timer); };
  }, [load]);
  const change = async (action: () => Promise<void>) => {
    setPending(true);
    setActionFailed(false);
    try { await action(); }
    catch { setActionFailed(true); }
    finally { await load(); setPending(false); }
  };
  return <>
    <h3 className="settings-subheading">{t("settings.localAgents.title")}</h3>
    <section className="settings-card settings-list">
      {snapshot === undefined ? <p className="muted" role="status">{t(unavailable ? "settings.localAgents.unavailable" : "common.loading")}</p> : <>
        <article><div><span><strong>{t("settings.localAgents.endpoint")}</strong><small>{snapshot.origin}</small></span></div></article>
        {snapshot.applications.requests.map(request => <article key={request.requestId}>
          <div><span><strong>{request.application?.displayName}</strong><small>{request.application?.clientId}</small></span></div>
          <Button disabled={pending} onClick={() => void change(() => api.review(request.requestId))}>{t("settings.localAgents.review")}</Button>
        </article>)}
        {snapshot.applications.grants.map(grant => <article key={grant.grantId}>
          <div><span><strong>{grant.application?.displayName}</strong><small>{grant.application?.clientId}</small>
            {grant.retired && <small role="status">{t("settings.localAgents.retired")}</small>}</span></div>
          <Button disabled={pending} tone="ghost" onClick={() => void change(() => api.revoke(grant.grantId))}>
            {t(grant.retired ? "common.retry" : "settings.localAgents.revoke")}
          </Button>
        </article>)}
        {snapshot.applications.requests.length === 0 && snapshot.applications.grants.length === 0 && <p className="muted">{t("settings.localAgents.empty")}</p>}
      </>}
      {actionFailed && <p role="alert">{t("settings.localAgents.actionFailed")}</p>}
    </section>
  </>;
}
