import { useEffect, useId, useRef, useState, type JSX } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import { MessageSquare, UsersRound } from "lucide-react";
import { parseTaskShareInvitation, type JoinedTaskShare, type TaskShare, type TaskShareMember } from "@joko/contracts";
import type { AppController } from "../controller.js";
import { randomUuid } from "../web-crypto.js";
import { LocalState } from "../local-state.js";
import { canOpenJoinedTask, openJoinedTask, type PendingTaskSharingAction } from "../task-sharing.js";
import { useTaskSharingDirectory } from "../use-task-sharing-directory.js";
import { clearTaskSharingInvitation, useTaskSharingInvitation } from "../task-sharing-invitation.js";
import type { Translator } from "./types.js";
import { Button, ErrorBanner, Modal, Pill, Spinner, cx } from "./ui.js";
import { moveTablistSelection } from "./tablist-navigation.js";
import { writeClipboardText } from "../clipboard-action.js";
import "./task-sharing.css";

type Confirmation = { readonly kind: "end"; readonly share: TaskShare }
  | { readonly kind: "remove"; readonly share: TaskShare; readonly member: TaskShareMember }
  | { readonly kind: "leave"; readonly joined: JoinedTaskShare }
  | { readonly kind: "endAll"; readonly shares: readonly TaskShare[] };

export function TaskSharingSettings({ controller, t, sessionId, initialInvitation }: {
  readonly controller: AppController; readonly t: Translator; readonly sessionId?: string; readonly initialInvitation?: string;
}): JSX.Element {
  const api = controller.taskSharing, directory = useTaskSharingDirectory(api);
  const tabId = useId();
  const [tab, setTab] = useState<"owned" | "joined" | "join">(initialInvitation ? "join" : "owned");
  const [invitation, setInvitation] = useState(initialInvitation ?? "");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<TaskShare>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [busy, setBusy] = useState(true), [error, setError] = useState<string>(), [notice, setNotice] = useState<string>();
  const [unknown, setUnknown] = useState<PendingTaskSharingAction>();
  const lifetime = useRef(new AbortController());
  const flight = useRef(false);
  const storage = useRef<LocalState | undefined>(undefined);
  const owner = JSON.stringify([controller.state.activeProfile?.serverId, controller.state.activeProfile?.id]);
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort;
    void LocalState.open().then(async local => {
      const actions = await local.taskSharingActions(owner);
      if (!abort.signal.aborted) { storage.current = local; setUnknown(actions[0]); setBusy(false); }
    }).catch(() => { if (!abort.signal.aborted) { setError(t("taskSharing.unavailable")); setBusy(false); } });
    return () => { abort.abort(); storage.current = undefined; };
  }, [owner, t]);
  const owned = directory.value?.owned.filter(share => share.status === "active") ?? [];
  const joined = directory.value?.joined.filter(item => item.status !== "left") ?? [];
  const selected = sessionId ? owned.find(share => share.sessionId === sessionId) : undefined;
  const run = async (kind: PendingTaskSharingAction["kind"] | "preview", action: (id: string, signal: AbortSignal) => Promise<void>,
    afterApplied?: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (!api || !storage.current || flight.current || unknown) return;
    flight.current = true; setBusy(true); setError(undefined); setNotice(undefined);
    const id = randomUuid(), signal = lifetime.current.signal, local = storage.current;
    let admitted = false, recorded = false;
    try {
      if (kind !== "preview") await local.saveTaskSharingAction(owner, { operationId: id, kind });
      signal.throwIfAborted(); admitted = true;
      await action(id, signal);
      if (kind !== "preview") await local.finishTaskSharingAction(owner, id);
      recorded = true;
      if (!signal.aborted) {
        await afterApplied?.(signal);
        if (!signal.aborted) { setConfirmation(undefined); await directory.refresh(); }
      }
    }
    catch (cause) {
      if (!signal.aborted) {
        setError(cause instanceof Error ? cause.message : t("taskSharing.unavailable"));
        const definite = cause instanceof ConnectError && [Code.InvalidArgument, Code.PermissionDenied, Code.NotFound, Code.FailedPrecondition].includes(cause.code);
        if (kind !== "preview" && !recorded) {
          if (admitted && !definite) setUnknown({ operationId: id, kind });
          else await local.finishTaskSharingAction(owner, id);
        }
      }
    } finally { if (!signal.aborted) setBusy(false); flight.current = false; }
  };
  const open = (item: JoinedTaskShare): void => {
    const profile = controller.state.activeProfile;
    if (!profile || !item.share || !item.member) return;
    openJoinedTask(controller, item.joinId);
  };
  const copyInvitation = (share: TaskShare, ownerDocument: Document): void => {
    let text: string | undefined;
    void run("invite", async (id, signal) => {
      const result = await api!.invite(id, share.shareId, signal);
      signal.throwIfAborted(); text = result.invitation;
    }, async signal => {
      try {
        if (text === undefined) throw new Error();
        await writeClipboardText(text, { ownerDocument, signal });
        signal.throwIfAborted(); setNotice(t("taskSharing.invitationCopied"));
      } catch {
        signal.throwIfAborted(); throw new Error(t("taskSharing.invitationCopyFailed"));
      } finally { text = undefined; }
    });
  };
  const confirm = (): void => { const captured = confirmation; if (!captured) return;
    void run(captured.kind, async (id, signal) => {
      if (captured.kind === "end") await api!.end(id, captured.share.shareId, signal);
      else if (captured.kind === "leave") await api!.leave(id, captured.joined.joinId, signal);
      else if (captured.kind === "remove") await api!.remove(id, captured.share.shareId, captured.member.memberId, captured.member.memberGeneration, signal);
      else { const result = await api!.endAll(id, captured.shares.map(share => share.shareId), signal);
        if (result.failedShareIds.length) setNotice(t("taskSharing.partial", { count: result.failedShareIds.length })); }
    });
  };
  const checkUnknown = async (): Promise<void> => {
    if (!api || !unknown || !storage.current || flight.current) return;
    flight.current = true; setBusy(true); setError(undefined);
    const signal = lifetime.current.signal, local = storage.current, pending = unknown;
    try {
      try {
        if (pending.kind === "join") {
          const result = await api.lookupJoin(pending.operationId, signal);
          signal.throwIfAborted();
          if (!result.intent?.joined && result.intent?.status !== "failed") throw new Error(t("taskSharing.unknown"));
        } else {
          const result = await api.lookupAction(pending.operationId, signal);
          signal.throwIfAborted();
          if (result.status !== "applied" && result.status !== "failed") throw new Error(t("taskSharing.unknown"));
          if (result.kind === "task_share_invite" && result.status === "applied") setNotice(t("taskSharing.invitationLost"));
          if (result.failedShareIds.length > 0) setNotice(t("taskSharing.partial", { count: result.failedShareIds.length }));
        }
      } catch (cause) {
        signal.throwIfAborted();
        if (!(cause instanceof ConnectError) || cause.code !== Code.NotFound) throw cause;
        setNotice(t("taskSharing.notAdmitted"));
      }
      await local.finishTaskSharingAction(owner, pending.operationId);
      const remaining = await local.taskSharingActions(owner);
      signal.throwIfAborted();
      setUnknown(remaining[0]); setConfirmation(undefined); void directory.refresh();
    } catch { if (!signal.aborted) setError(t("taskSharing.unknown")); }
    finally { flight.current = false; if (!signal.aborted) setBusy(false); }
  };
  const shareCard = (share: TaskShare): JSX.Element => <article className="settings-card settings-card--content" key={share.shareId} data-task-sharing-owned data-share-id={share.shareId} data-session-id={share.sessionId}>
    <h3>{share.title || share.sessionId}</h3><p>{share.hostOrigin}</p>
    <div className="settings-actions"><Button data-task-sharing-invite disabled={busy || !!unknown} onClick={event => copyInvitation(share, event.currentTarget.ownerDocument)}>{t("taskSharing.invite")}</Button>
      <Button data-task-sharing-end tone="danger" disabled={busy || !!unknown} onClick={() => setConfirmation({ kind: "end", share })}>{t("taskSharing.end")}</Button></div>
    <h4>{t("taskSharing.participants")}</h4>
    {share.members.filter(member => member.status === "active").map(member => <div className="setting-row" key={member.memberId}>
      <div><strong>{member.displayName}</strong></div><Button disabled={busy || !!unknown} onClick={() => setConfirmation({ kind: "remove", share, member })}>{t("taskSharing.remove")}</Button>
    </div>)}
  </article>;
  const heading = <header className="settings-heading"><h2>{t("taskSharing.title")}</h2><p>{t("taskSharing.body")}</p></header>;
  if (!api) return <section className="task-sharing-settings">{heading}<p role="status">{t("taskSharing.unavailable")}</p></section>;
  return <section className="task-sharing-settings" data-task-sharing-management data-state={error ? "error" : busy || !directory.value ? "loading" : "ready"} aria-label={t("taskSharing.title")}>
    {heading}
    {directory.error && <ErrorBanner message={directory.error} retryLabel={t("common.retry")} onRetry={() => { void directory.refresh(); }} />}
    {error && <ErrorBanner message={error} />}{notice && <p role="status">{notice}</p>}
    {unknown && <div role="status" className="settings-card settings-card--content"><p>{t("taskSharing.unknown")}</p><Button disabled={busy} onClick={() => { void checkUnknown(); }}>{t("taskSharing.check")}</Button></div>}
    {sessionId ? <>
      {selected ? shareCard(selected) : <Button data-task-sharing-start disabled={busy || !!unknown || directory.loading} onClick={() => { void run("create", async (id, signal) => { await api.create(id, sessionId, signal); }); }}>{t("taskSharing.start")}</Button>}
    </> : <>
      <div role="tablist" aria-label={t("taskSharing.title")}>{(["owned", "joined", "join"] as const).map(value => <Button key={value} id={`${tabId}-${value}`} role="tab" aria-selected={tab === value} aria-controls={`${tabId}-panel`} tabIndex={tab === value ? 0 : -1} tone={tab === value ? "primary" : "secondary"} disabled={busy} onKeyDown={event => { moveTablistSelection(event, "horizontal"); }} onClick={() => { setTab(value); setError(undefined); }}>{t(`taskSharing.${value}`)}</Button>)}</div>
      <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0}>
      {directory.loading && !directory.value && <Spinner label={t("common.loading")} />}
      {tab === "owned" && <>{owned.length === 0 && <p>{t("taskSharing.emptyOwned")}</p>}{owned.map(shareCard)}{owned.length > 0 && <Button tone="danger" disabled={busy || !!unknown} onClick={() => setConfirmation({ kind: "endAll", shares: owned })}>{t("taskSharing.endAll")}</Button>}</>}
      {tab === "joined" && <>{joined.length === 0 && <p>{t("taskSharing.emptyJoined")}</p>}{joined.map(item => <article className="settings-card settings-card--content" key={item.joinId}>
        <h3>{item.share?.title || item.share?.sessionId}</h3><p>{item.share?.hostOrigin}</p><Pill>{item.status}</Pill>
        <div className="settings-actions"><Button data-task-sharing-open data-join-id={item.joinId} disabled={busy || !canOpenJoinedTask(item.status)} onClick={() => open(item)}>{t(item.status === "disconnected" ? "connection.reconnect" : "common.open")}</Button><Button data-task-sharing-leave tone="danger" disabled={busy || !!unknown || item.status === "left"} onClick={() => setConfirmation({ kind: "leave", joined: item })}>{t("taskSharing.leave")}</Button></div>
      </article>)}</>}
      {tab === "join" && <form onSubmit={event => { event.preventDefault(); void run("preview", async (_id, signal) => {
        parseTaskShareInvitation(invitation); const response = await api.preview(invitation, signal);
        if (!response.share) throw new Error(t("taskSharing.unavailable")); setPreview(response.share);
      }); }}>
        <label>{t("taskSharing.invitation")}<textarea data-task-sharing-invitation value={invitation} maxLength={8192} disabled={busy || !!unknown} onChange={event => { setInvitation(event.target.value); setPreview(undefined); }} autoComplete="off" spellCheck={false} /></label>
        <label>{t("taskSharing.name")}<input data-task-sharing-name value={name} maxLength={128} disabled={busy || !!unknown} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
        <Button data-task-sharing-preview type="submit" disabled={busy || !!unknown || !invitation.trim()}>{t("taskSharing.preview")}</Button>
        {preview && <article className="settings-card settings-card--content"><h3>{preview.title || preview.sessionId}</h3><p>{preview.hostOrigin}</p><div className="settings-actions"><Button data-task-sharing-join tone="primary" disabled={busy || !!unknown || !name.trim()} onClick={() => { void run("join", async (id, signal) => {
          const result = await api.join(id, invitation, name.trim(), signal);
          if (!result.intent?.joined) throw new ConnectError(t("taskSharing.unknown"), Code.Unknown);
          setInvitation(""); setPreview(undefined); clearTaskSharingInvitation(invitation); open(result.intent.joined);
        }); }}>{t("taskSharing.confirmJoin")}</Button><Button disabled={busy} onClick={() => setPreview(undefined)}>{t("common.cancel")}</Button></div></article>}
      </form>}
      </div>
    </>}
    <Modal open={confirmation !== undefined} title={t("taskSharing.manage")} onClose={() => { if (!busy) setConfirmation(undefined); }}>
      {confirmation && <p>{confirmation.kind === "endAll" ? t("taskSharing.confirmEndAll", { count: confirmation.shares.length })
        : confirmation.kind === "remove" ? t("taskSharing.confirmRemove", { name: confirmation.member.displayName, task: confirmation.share.title || confirmation.share.sessionId })
        : confirmation.kind === "leave" ? t("taskSharing.confirmLeave", { name: confirmation.joined.share?.title || confirmation.joined.share?.sessionId || confirmation.joined.joinId })
        : t("taskSharing.confirmEnd", { name: confirmation.share.title || confirmation.share.sessionId })}</p>}
      {confirmation?.kind === "endAll" && <ul>{confirmation.shares.map(share => <li key={share.shareId}>{share.title || share.sessionId}</li>)}</ul>}
      <div className="settings-actions"><Button disabled={busy} onClick={() => setConfirmation(undefined)}>{t("common.cancel")}</Button><Button data-task-sharing-confirm tone="danger" disabled={busy} onClick={confirm}>{busy ? t("common.working") : t("common.confirm")}</Button></div>
    </Modal>
  </section>;
}

export function TaskSharingInvitationDialog({ controller, t }: { readonly controller: AppController; readonly t: Translator }): JSX.Element | null {
  const intent = useTaskSharingInvitation();
  if (!intent) return null;
  return <Modal open title={t("taskSharing.join")} onClose={() => clearTaskSharingInvitation(intent.invitation)}><TaskSharingSettings key={`${controller.state.activeProfile?.id}:${controller.state.connectionGeneration}:${intent.id}`} controller={controller} t={t} initialInvitation={intent.invitation} /></Modal>;
}

export function TaskSharingNavigation({ controller, t, onClose }: { readonly controller: AppController; readonly t: Translator; readonly onClose: () => void }): JSX.Element | null {
  const directory = useTaskSharingDirectory(controller.taskSharing), profile = controller.state.activeProfile;
  const joined = directory.value?.joined.filter(item => canOpenJoinedTask(item.status)) ?? [];
  if (!profile || joined.length === 0) return null;
  const route = controller.state.route;
  return <section className="sidebar-device-section" aria-label={t("taskSharing.joined")}>
    <div className="sidebar-device-section__header"><UsersRound aria-hidden="true" /><span>{t("taskSharing.joined")}</span><small>{joined.length}</small></div>
    <div className="sidebar-device-section__content"><ul>{joined.map(item => {
      const active = route.kind === "sharedTask" && route.profileId === profile.id && route.joinId === item.joinId;
      return <li key={item.joinId} className={cx("session-row", "session-row--remote", active && "is-active")}>
        <button type="button" className="session-row__main" aria-current={active ? "page" : undefined} onClick={() => { openJoinedTask(controller, item.joinId); onClose(); }}>
          <MessageSquare className="session-row__agent" aria-hidden="true" /><span className="session-row__copy"><strong>{item.share?.title || item.share?.sessionId}</strong>{item.status === "disconnected" && <small>{t("connection.reconnect")}</small>}</span>
        </button>
      </li>;
    })}</ul></div>
  </section>;
}
