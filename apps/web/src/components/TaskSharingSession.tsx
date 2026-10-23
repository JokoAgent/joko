import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AppController } from "../controller.js";
import { createTaskSharingGateway, type OrchestratorGateway } from "../gateway.js";
import { createJoinedTaskPort } from "../task-sharing-api.js";
import { createTaskSharingController, type TaskSharingController } from "../task-sharing-controller.js";
import { canOpenJoinedTask, guestBackend, returnFromJoinedTask, taskSourceKey, type SessionAccess, type TaskSource } from "../task-sharing.js";
import { LocalState } from "../local-state.js";
import type { AppSnapshot, TimelineHistoryCursorView, TimelineItemView } from "../model.js";
import { randomUuid } from "../web-crypto.js";
import { SessionPane } from "./SessionPane.js";
import { TaskSharingRuntimeControls } from "./TaskSharingRuntimeControls.js";
import { TaskSharingTaskTools } from "./TaskSharingTaskTools.js";
import { Button, ErrorBanner, Modal, Spinner } from "./ui.js";
import type { RunAction, Translator } from "./types.js";

interface SharedView {
  readonly snapshot: AppSnapshot;
  readonly source: Extract<TaskSource, { readonly kind: "joined" }>;
  readonly controller: AppController;
}
export function TaskSharingSession({ controller: home, joinId, profileId, t, runAction, onOpenNavigation }: {
  readonly controller: AppController; readonly joinId: string; readonly profileId: string;
  readonly t: Translator; readonly runAction: RunAction; readonly onOpenNavigation: () => void;
}): JSX.Element {
  const homeRef = useRef(home); homeRef.current = home;
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const [view, setView] = useState<SharedView>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0), [leave, setLeave] = useState(false), [leaveOperation, setLeaveOperation] = useState<string>();
  const [history, setHistory] = useState<readonly TimelineItemView[]>([]);
  const [before, setBefore] = useState<TimelineHistoryCursorView>();
  const [loadingHistory, setLoadingHistory] = useState(false);
  const gatewayRef = useRef<OrchestratorGateway | undefined>(undefined);
  const owned = useRef<{ readonly abort: AbortController; readonly sourceKey: string; readonly local: LocalState; readonly leaveOwner: string } | undefined>(undefined);
  const historyFlight = useRef(false);
  const snapshotRef = useRef<AppSnapshot | undefined>(undefined);
  const api = home.taskSharing, profile = home.state.activeProfile;
  const connectionKey = JSON.stringify([profile?.id, profile?.serverId, profile?.origin, home.state.connectionGeneration, home.state.connectionState]);
  useEffect(() => {
    const changed = (): void => setVisible(document.visibilityState !== "hidden");
    const hidden = (): void => { visibleRef.current = false; owned.current?.abort.abort(); gatewayRef.current?.disconnect(); };
    document.addEventListener("visibilitychange", changed); window.addEventListener("pagehide", hidden);
    return () => { document.removeEventListener("visibilitychange", changed); window.removeEventListener("pagehide", hidden); };
  }, []);
  const back = useCallback(() => {
    returnFromJoinedTask(homeRef.current, profileId, joinId);
  }, [profileId, joinId]);
  useEffect(() => {
    const abort = new AbortController();
    const currentHome = (): boolean => {
      const state = homeRef.current.state;
      return !abort.signal.aborted && visibleRef.current && state.connectionState === "connected"
        && JSON.stringify([state.activeProfile?.id, state.activeProfile?.serverId, state.activeProfile?.origin, state.connectionGeneration, state.connectionState]) === connectionKey
        && state.route.kind === "sharedTask" && state.route.joinId === joinId && state.route.profileId === profileId;
    };
    if (!visible || !api || !profile || profile.id !== profileId || home.state.connectionState !== "connected") return;
    setError(undefined); setView(undefined); setHistory([]); setBefore(undefined); setLoadingHistory(false); setLeaveOperation(undefined);
    let gateway: OrchestratorGateway | undefined;
    let facade: TaskSharingController | undefined;
    // Retiring the connection must not erase state still read by the outgoing React tree.
    let ownedSnapshot: AppSnapshot | undefined;
    let ownedAccess: SessionAccess = { role: "guest", editableQueueItemIds: new Set() };
    let ready = false;
    const fail = (cause: unknown): void => {
      if (!currentHome()) return;
      setError(cause instanceof Error ? cause.message : t("taskSharing.unavailable"));
      const rawCause = cause instanceof Error ? cause.cause ?? cause : cause;
      if ([Code.PermissionDenied, Code.Unauthenticated, Code.NotFound].includes(ConnectError.from(rawCause).code)) {
        gateway?.disconnect(); setView(undefined); back();
      }
    };
    void (async () => {
      const directory = await api.list(abort.signal);
      if (!currentHome()) return;
      const joined = directory.joined.find(item => item.joinId === joinId);
      if (!joined?.share || !joined.member || !canOpenJoinedTask(joined.status)) throw new Error(t("taskSharing.unavailable"));
      const source: Extract<TaskSource, { readonly kind: "joined" }> = { kind: "joined", homeProfileId: profileId, homeServerId: profile.serverId, homeOrigin: profile.origin, joinId,
        remoteServerId: joined.share.hostServerId, shareId: joined.share.shareId, memberId: joined.member.memberId,
        sessionId: joined.share.sessionId, generation: joined.share.shareGeneration, memberGeneration: joined.member.memberGeneration };
      const local = await LocalState.open();
      if (!currentHome()) return;
      const key = taskSourceKey(source), leaveOwner = JSON.stringify(["guest-leave", profile.serverId, profileId, joinId]);
      const actions = await local.taskSharingActions(leaveOwner);
      if (!currentHome()) return;
      setLeaveOperation(actions[0]?.operationId);
      owned.current = { abort, sourceKey: key, local, leaveOwner };
      gateway = createTaskSharingGateway(profile, {
        onSnapshot(snapshot) {
          if (!currentHome() || owned.current?.sourceKey !== key) return;
          const projected = { ...snapshot, backends: snapshot.backends.map(guestBackend) };
          const previous = snapshotRef.current;
          if (previous && (previous.generation !== projected.generation
            || previous.sessions[0]?.generation !== projected.sessions[0]?.generation
            || previous.timelineHistoryRevisionBySession.get(source.sessionId) !== projected.timelineHistoryRevisionBySession.get(source.sessionId))) {
            setHistory([]); setBefore(undefined);
          }
          snapshotRef.current = projected;
          ownedSnapshot = projected;
          ownedAccess = { role: "guest", memberId: source.memberId, editableQueueItemIds: new Set(projected.queue.filter(item => {
            const author = item.sharedTaskAuthor;
            return author?.shareId === source.shareId && author.shareGeneration === source.generation
              && author.memberId === source.memberId && author.memberGeneration === source.memberGeneration;
          }).map(item => item.id)) };
          if (facade && ready) setView({ snapshot: projected, source, controller: facade });
        },
        onState(state) {
          if (!currentHome()) return;
          ready = state === "connected";
          if (ready && facade && snapshotRef.current) setView({ snapshot: snapshotRef.current, source, controller: facade });
        },
        onError: fail,
        onAuthenticationInvalidated: async () => { if (currentHome()) { setView(undefined); back(); } }
      }, createJoinedTaskPort(api, joined, abort.signal, {
        pending: () => local.taskSharingOperations(key),
        begin: operationId => local.setTaskSharingOperation(key, operationId, true),
        finish: operationId => local.setTaskSharingOperation(key, operationId, false)
      }));
      facade = createTaskSharingController({ home: () => homeRef.current, gateway, source,
        snapshot: () => ownedSnapshot!, access: () => ownedAccess, current: currentHome, local });
      gatewayRef.current = gateway;
      await gateway.connect();
      if (!currentHome()) return;
      const initial = snapshotRef.current;
      const page = await gateway.loadSessionTimelinePage(source.sessionId);
      if (!currentHome() || snapshotRef.current?.generation !== initial?.generation
        || snapshotRef.current?.sessions[0]?.generation !== initial?.sessions[0]?.generation
        || snapshotRef.current?.timelineHistoryRevisionBySession.get(source.sessionId) !== initial?.timelineHistoryRevisionBySession.get(source.sessionId)) return;
      setHistory(page.items); setBefore(page.nextBeforeCursor);
    })().catch(fail);
    return () => { facade?.retireTaskSharingInput(); abort.abort(); gateway?.disconnect(); if (gatewayRef.current === gateway) gatewayRef.current = undefined;
      if (owned.current?.abort === abort) owned.current = undefined; snapshotRef.current = undefined; historyFlight.current = false; };
  }, [api, connectionKey, joinId, profileId, retry, visible, back, t]);

  const loadEarlier = async (): Promise<void> => {
    const context = owned.current, gateway = gatewayRef.current, source = view?.source;
    if (!context || !gateway || !source || !before || historyFlight.current) return;
    historyFlight.current = true; setLoadingHistory(true);
    const generation = view.snapshot.generation, runtimeGeneration = view.snapshot.sessions[0]?.generation;
    const revision = view.snapshot.timelineHistoryRevisionBySession.get(source.sessionId);
    try {
      const page = await gateway.loadSessionTimelinePage(source.sessionId, before);
      if (context.abort.signal.aborted || owned.current !== context || snapshotRef.current?.generation !== generation
        || snapshotRef.current.sessions[0]?.generation !== runtimeGeneration
        || snapshotRef.current.timelineHistoryRevisionBySession.get(source.sessionId) !== revision) return;
      setHistory(previous => [...new Map([...page.items, ...previous].map(item => [item.id, item])).values()]); setBefore(page.nextBeforeCursor);
    } catch (cause) { if (!context.abort.signal.aborted) setError(cause instanceof Error ? cause.message : t("taskSharing.unavailable")); }
    finally { if (owned.current === context) { historyFlight.current = false; setLoadingHistory(false); } }
  };
  const session = view?.snapshot.sessions.find(item => item.id === view.source.sessionId);
  const attemptLeave = (): void => { if (!api || !view) return;
    runAction("leave-shared-task", async () => {
      const context = owned.current; if (!context) return;
      const signal = context.abort.signal;
      if (leaveOperation) {
        const receipt = await api.lookupAction(leaveOperation, signal);
        if (receipt.status === "failed") {
          await context.local.finishTaskSharingAction(context.leaveOwner, leaveOperation);
          signal.throwIfAborted(); setLeaveOperation(undefined); throw new Error(receipt.errorCode || t("taskSharing.unavailable"));
        }
        if (receipt.status !== "applied" || receipt.kind !== "leave" || receipt.joined?.joinId !== joinId) throw new Error(t("taskSharing.unknown"));
      } else {
        const id = randomUuid();
        await context.local.saveTaskSharingAction(context.leaveOwner, { operationId: id, kind: "leave" });
        signal.throwIfAborted(); setLeaveOperation(id); await api.leave(id, joinId, signal);
        await context.local.finishTaskSharingAction(context.leaveOwner, id);
      }
      if (leaveOperation) await context.local.finishTaskSharingAction(context.leaveOwner, leaveOperation);
      signal.throwIfAborted(); back();
    });
  };
  const unavailable = !view || !session;
  return <div className="task-sharing-session" data-task-sharing-session data-join-id={joinId} data-session-id={session?.id} data-state={error ? "error" : unavailable ? "loading" : "ready"}>
    <div className="settings-actions"><Button onClick={back}>{t("taskSharing.return")}</Button>{error && <ErrorBanner message={error} retryLabel={t("common.retry")} onRetry={() => setRetry(value => value + 1)} />}</div>
    {unavailable ? <main className="empty-session-page">{error || profile?.id !== profileId || home.state.connectionState !== "connected" ? <><p role="status">{t("taskSharing.unavailable")}</p>{home.state.profiles.find(item => item.id === profileId) && <Button onClick={() => runAction("connect-shared-task-home", async () => { const target = homeRef.current.state.profiles.find(item => item.id === profileId); if (target) await homeRef.current.connect(target); })}>{t("connection.connect")}</Button>}</> : <Spinner label={t("common.loading")} />}</main>
      : <>{gatewayRef.current && <TaskSharingRuntimeControls gateway={gatewayRef.current} session={session} t={t} />}<TaskSharingTaskTools controller={view.controller} sessionId={session.id} t={t} runAction={runAction} /><SessionPane controller={view.controller} session={session} target={view.snapshot.targets.find(item => item.id === session.targetId)}
        backend={view.snapshot.backends.find(item => item.id === session.backendId)} models={view.snapshot.models}
        timeline={[...new Map([...history, ...(view.snapshot.timelineBySession.get(session.id) ?? [])].map(item => [item.id, item])).values()].sort((a, b) => Number(a.sequence - b.sequence))}
        timelineHasEarlier={before !== undefined} timelineHistoryLoading={loadingHistory} timelineHistoryError={error} onLoadEarlierTimeline={loadEarlier}
        extensionWidgets={[]} extensionStatuses={[]} queue={view.snapshot.queue.filter(item => item.sessionId === session.id)} queueControl={view.snapshot.queueControls.find(item => item.sessionId === session.id)}
        extraDirectories={[]} resources={[]} commandRefreshSignal={[]} interaction={view.snapshot.interactions.find(item => item.sessionId === session.id)} remainingInteractions={view.snapshot.interactions.filter(item => item.sessionId === session.id).length}
        navigationOpen={false} inspectorOpen={false} inspectorAvailable={false} t={t} runAction={runAction} onOpenNavigation={onOpenNavigation}
        onOpenInspector={() => { throw new Error(t("taskSharing.unavailable")); }} onRename={() => { throw new Error(t("taskSharing.unavailable")); }}
        onArchive={() => setLeave(true)} onDelete={() => { throw new Error(t("taskSharing.unavailable")); }} /></>}
    <Modal open={leave} title={t("taskSharing.leave")} onClose={() => setLeave(false)}><p>{leaveOperation ? t("taskSharing.unknown") : t("taskSharing.confirm")}</p>
      <Button onClick={() => setLeave(false)}>{t("common.cancel")}</Button><Button data-task-sharing-confirm tone="danger" onClick={attemptLeave}>{t(leaveOperation ? "taskSharing.check" : "common.confirm")}</Button></Modal>
  </div>;
}
