import { useEffect, useRef, useState, type JSX } from "react";
import { partnerAutonomyMessages, type GetPartnerGlanceResponse, type PartnerAutonomyApi } from "@joko/contracts";
import type { SessionView } from "../model.js";
import { CodeHostPullRequestSummary } from "./CodeHostPullRequestSummary.js";
import { PartnerGlanceContents } from "./PartnerGlanceContents.js";
import type { Translator } from "./types.js";
import { Button } from "./ui.js";

export function PartnerAutonomyPanel({ api, partnerId, sessions, locale, t, onOpenTask, onOpenPullRequest }: {
  readonly api: PartnerAutonomyApi; readonly partnerId: string; readonly locale?: string; readonly t: Translator;
  readonly sessions: readonly SessionView[]; readonly onOpenTask: (sessionId: string) => void;
  readonly onOpenPullRequest?: (sessionId: string, url: string) => Promise<void>;
}): JSX.Element {
  const m = partnerAutonomyMessages(locale), element = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false), [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<GetPartnerGlanceResponse>(), [failed, setFailed] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    const owner = element.current!.ownerDocument;
    let request: AbortController | undefined;
    const read = () => {
      request?.abort();
      if (owner.hidden) return;
      const scope = request = new AbortController();
      void api.glance(partnerId, scope.signal).then(value => {
        if (!scope.signal.aborted) { setPage(value); setFailed(false); }
      }).catch(() => { if (!scope.signal.aborted) { setFailed(true); setPage(undefined); } });
    };
    read();
    const timer = owner.defaultView?.setInterval(read, 30_000);
    owner.addEventListener("visibilitychange", read);
    return () => { request?.abort(); owner.defaultView?.clearInterval(timer); owner.removeEventListener("visibilitychange", read); };
  }, [open, api, partnerId, refresh]);

  const close = () => { if (element.current) element.current.open = false; };
  const rows = page?.rows ?? [];
  const byId = new Map(sessions.map(session => [session.id, session]));
  const references = rows.flatMap(row => {
    const session = byId.get(row.sessionId);
    return session && session.generation === row.generation ? (session.codeHostPullRequests ?? []).map(ref => ({ ref, sessionId: row.sessionId })) : [];
  });
  const unique = new Map(references.map(item => [item.ref.key, item]));
  return <details ref={element} className="partner-glance" onToggle={event => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) { setExpanded(false); setPage(undefined); setFailed(false); setLinkFailed(false); }
  }}><summary>{m.glance}</summary>
    <div className="partner-glance__content" aria-label={m.glance}>
      <PartnerGlanceContents api={api} partnerId={partnerId} locale={locale} enabled={open} close={close} />
      {failed && <p role="alert">{m.failed} <Button onClick={() => setRefresh(value => value + 1)}>{m.refresh}</Button></p>}
      {rows.length > 0 && <section><h3>{m.recent}</h3><ul>{(expanded ? rows : rows.slice(0, 5)).map(row => {
        const task = byId.get(row.sessionId);
        return <li key={row.sessionId}><button type="button" disabled={!row.online} onClick={() => { close(); onOpenTask(row.sessionId); }}>
          {row.title}{task && task.generation === row.generation && task.attention?.unread && task.attention.kind === "done" && <small>{m.unread}</small>}
        </button></li>;
      })}</ul>{rows.length > 5 && <Button aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? m.less : m.more}</Button>}</section>}
      {unique.size > 0 && <section><h3>{m.requests}</h3><ul>{[...unique.values()].map(({ ref, sessionId }) => <li key={ref.key}>
        <span>{ref.projection?.title || `${ref.repositoryOwner}/${ref.repositoryName}`}</span>
        <CodeHostPullRequestSummary pullRequests={[ref]} t={t} onOpen={onOpenPullRequest && (url => {
          setLinkFailed(false);
          void onOpenPullRequest(sessionId, url).catch(() => setLinkFailed(true));
        })} />
      </li>)}</ul>{linkFailed && <p role="alert">{m.openFailed}</p>}</section>}
    </div>
  </details>;
}
