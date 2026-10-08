import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { AlertTriangle, Pause, Pencil, Play, RotateCcw, Target, Trash2 } from "lucide-react";

import type { AppController } from "../controller.js";
import type { ComposerDraft, ObjectiveView, SessionView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, IconButton, Pill, Spinner, cx } from "./ui.js";
import {
  ObjectiveDialog,
  objectiveLimitsFromDialog,
  type ObjectiveDialogLimits
} from "./ObjectiveDialog.js";

export interface ObjectiveDialogOwnerFence {
  readonly serverId: string;
  readonly profileId: string;
  readonly connectionGeneration: number;
  readonly sessionId: string;
  readonly sessionGeneration: bigint;
}

export interface ObjectiveDialogHandoffRequest extends ObjectiveDialogOwnerFence {
  readonly id: string;
  readonly expectedDraft: ComposerDraft;
}

export interface ObjectiveDialogRequest extends ObjectiveDialogOwnerFence {
  readonly id: string | number;
  readonly onSaved: () => void;
}

export function objectiveDialogOwnerFence(
  controller: Pick<AppController, "state">,
  session: SessionView
): ObjectiveDialogOwnerFence | undefined {
  const profile = controller.state.activeProfile;
  const connectionGeneration = controller.state.connectionGeneration;
  if (controller.state.connectionState !== "connected" || profile === undefined || connectionGeneration === undefined) return undefined;
  return {
    serverId: profile.serverId,
    profileId: profile.id,
    connectionGeneration,
    sessionId: session.id,
    sessionGeneration: session.generation
  };
}

export function objectiveDialogRequestMatchesOwner(
  request: ObjectiveDialogOwnerFence,
  controller: Pick<AppController, "state">,
  session: SessionView
): boolean {
  const owner = objectiveDialogOwnerFence(controller, session);
  return owner !== undefined
    && request.serverId === owner.serverId
    && request.profileId === owner.profileId
    && request.connectionGeneration === owner.connectionGeneration
    && request.sessionId === owner.sessionId
    && request.sessionGeneration === owner.sessionGeneration;
}

type ObjectiveDialogFence =
  | { readonly key: string; readonly kind: "absent"; readonly sessionGeneration: bigint }
  | {
      readonly key: string;
      readonly kind: "present";
      readonly ownerGeneration: bigint;
      readonly sessionGeneration: bigint;
    };

export function ObjectiveIndicator({
  controller,
  session,
  readOnly,
  dialogRequest,
  onDialogRequestHandled,
  t
}: {
  readonly controller: AppController;
  readonly session: SessionView;
  readonly readOnly: boolean;
  readonly dialogRequest?: ObjectiveDialogRequest;
  readonly onDialogRequestHandled: (requestId?: string | number) => void;
  readonly t: Translator;
}): JSX.Element {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [objective, setObjective] = useState<ObjectiveView>();
  const objectiveRef = useRef<ObjectiveView | undefined>(undefined);
  objectiveRef.current = objective;
  const [loadState, setLoadState] = useState<{
    readonly ownerKey: string;
    readonly phase: "loading" | "ready" | "error";
  }>({ ownerKey: "", phase: "loading" });
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<string>();
  const [editRequestId, setEditRequestId] = useState<number>();
  const editRequestIdRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const requestRef = useRef<AbortController | undefined>(undefined);
  const loadOwnerRef = useRef<object | undefined>(undefined);
  const dialogFenceRef = useRef<ObjectiveDialogFence | undefined>(undefined);
  const latestRef = useRef({
    controller,
    sessionId: session.id,
    sessionGeneration: session.generation,
    profileId: controller.state.activeProfile?.id,
    serverId: controller.state.activeProfile?.serverId,
    connected: controller.state.connectionState === "connected",
    host
  });
  latestRef.current = {
    controller,
    sessionId: session.id,
    sessionGeneration: session.generation,
    profileId: controller.state.activeProfile?.id,
    serverId: controller.state.activeProfile?.serverId,
    connected: controller.state.connectionState === "connected",
    host
  };

  const ownerKey = useMemo(() => JSON.stringify([
    controller.state.activeProfile?.id,
    controller.state.activeProfile?.serverId,
    session.id,
    String(session.generation),
    controller.state.connectionGeneration
  ]), [controller.state.activeProfile?.id, controller.state.activeProfile?.serverId, controller.state.connectionGeneration, session.generation, session.id]);

  useEffect(() => {
    requestRef.current?.abort();
    requestRef.current = undefined;
    setPending(undefined);
    setActionError(undefined);
    setEditRequestId(undefined);
  }, [ownerKey]);

  useEffect(() => {
    if (dialogRequest !== undefined && !objectiveDialogRequestMatchesOwner(dialogRequest, controller, session)) {
      onDialogRequestHandled(dialogRequest.id);
    }
  }, [controller, dialogRequest, onDialogRequestHandled, ownerKey, session]);

  useEffect(() => {
    const owner = {};
    loadOwnerRef.current = owner;
    setObjective(undefined);
    setLoadError(undefined);
    setLoadState({ ownerKey, phase: "loading" });
    if (controller.state.connectionState !== "connected" || host === null) return () => {
      if (loadOwnerRef.current === owner) loadOwnerRef.current = undefined;
    };
    const request = new AbortController();
    const ownerWindow = host.ownerDocument.defaultView;
    const retire = (): void => request.abort();
    ownerWindow?.addEventListener("pagehide", retire);
    const isCurrent = (): boolean => loadOwnerRef.current === owner
      && !request.signal.aborted
      && latestRef.current.controller === controller
      && latestRef.current.sessionId === session.id
      && latestRef.current.sessionGeneration === session.generation
      && latestRef.current.profileId === controller.state.activeProfile?.id
      && latestRef.current.serverId === controller.state.activeProfile?.serverId
      && latestRef.current.connected
      && latestRef.current.host === host
      && host.isConnected;
    void (async () => {
      let initialReady = false;
      try {
        const initial = await controller.getObjective(session.id, request.signal);
        if (!isCurrent()) return;
        if (initial !== undefined && initial.sessionGeneration !== session.generation) {
          throw new Error(t("objective.ownerChanged"));
        }
        objectiveRef.current = initial;
        setObjective(initial);
        initialReady = true;
        setLoadState({ ownerKey, phase: "ready" });
        for await (const update of controller.watchObjective(session.id, initial?.revision, request.signal)) {
          if (!isCurrent()) return;
          if (update.kind === "cleared") {
            objectiveRef.current = undefined;
            setObjective(undefined);
            continue;
          }
          if (update.objective.sessionGeneration !== session.generation) throw new Error(t("objective.ownerChanged"));
          setObjective((current) => {
            if (current !== undefined && current.revision >= update.objective.revision) return current;
            objectiveRef.current = update.objective;
            return update.objective;
          });
        }
        if (isCurrent()) setLoadError(t("objective.loadFailed"));
      } catch (reason) {
        if (isCurrent()) {
          setLoadError(reason instanceof Error ? reason.message : t("objective.loadFailed"));
          if (!initialReady) setLoadState({ ownerKey, phase: "error" });
        }
      }
    })();
    return () => {
      request.abort();
      ownerWindow?.removeEventListener("pagehide", retire);
      if (loadOwnerRef.current === owner) loadOwnerRef.current = undefined;
    };
  }, [controller, host, ownerKey, reload, session.generation, session.id, t]);

  useEffect(() => {
    if (objective?.status !== "active") return;
    const ownerWindow = host?.ownerDocument.defaultView;
    if (ownerWindow === undefined || ownerWindow === null) return;
    setNow(Date.now());
    const timer = ownerWindow.setInterval(() => setNow(Date.now()), 1_000);
    return () => ownerWindow.clearInterval(timer);
  }, [host, objective?.status]);

  const mutate = async <T,>(name: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (pending !== undefined || requestRef.current !== undefined) throw new Error(t("objective.actionPending"));
    const source = latestRef.current;
    const sourceHost = source.host;
    const ownerDocument = sourceHost?.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!source.connected || sourceHost === null || sourceHost === undefined || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) {
      throw new Error(t("objective.ownerChanged"));
    }
    const request = new AbortController();
    requestRef.current = request;
    const retire = (): void => request.abort();
    ownerWindow.addEventListener("pagehide", retire);
    const current = (): boolean => requestRef.current === request
      && !request.signal.aborted
      && latestRef.current.controller === source.controller
      && latestRef.current.sessionId === source.sessionId
      && latestRef.current.sessionGeneration === source.sessionGeneration
      && latestRef.current.profileId === source.profileId
      && latestRef.current.serverId === source.serverId
      && latestRef.current.connected
      && latestRef.current.host === sourceHost
      && sourceHost.isConnected
      && sourceHost.ownerDocument === ownerDocument;
    setPending(name);
    setActionError(undefined);
    try {
      const result = await action(request.signal);
      if (!current()) throw new Error(t("objective.ownerChanged"));
      return result;
    } catch (reason) {
      if (current()) setActionError(reason instanceof Error ? reason.message : t("objective.actionFailed"));
      throw reason;
    } finally {
      ownerWindow.removeEventListener("pagehide", retire);
      if (requestRef.current === request) {
        requestRef.current = undefined;
        setPending(undefined);
      }
    }
  };

  const adopt = (next: ObjectiveView): void => {
    objectiveRef.current = next;
    setObjective((current) => current !== undefined && current.revision > next.revision ? current : next);
  };
  const submitDialog = async (text: string, limits: ObjectiveDialogLimits): Promise<void> => {
    const fence = dialogFenceRef.current;
    const source = objectiveRef.current;
    const ownerMatches = fence !== undefined && fence.sessionGeneration === session.generation && (
      fence.kind === "absent"
        ? source === undefined
        : source !== undefined
          && source.sessionGeneration === fence.sessionGeneration
          && source.ownerGeneration === fence.ownerGeneration
    );
    if (!ownerMatches) throw new Error(t("objective.ownerChanged"));
    // A completed Objective is immutable history. Editing it starts a fresh
    // replacement lifecycle instead of changing completed text in place.
    const next = await mutate("save", (signal) => source === undefined || source.status === "complete"
      ? controller.setObjective(session.id, session.generation, text, objectiveLimitsFromDialog(limits), signal)
      : controller.updateObjective(source, {
          text,
          maximumTurns: limits.maximumTurns,
          tokenBudget: limits.tokenBudget,
          noProgressTurnLimit: limits.noProgressTurnLimit
        }, signal));
    adopt(next);
  };
  const clear = (): void => {
    const source = objectiveRef.current;
    if (source === undefined) return;
    void mutate("clear", (signal) => controller.clearObjective(source, signal)).then(() => {
      objectiveRef.current = undefined;
      setObjective(undefined);
    }).catch(() => undefined);
  };
  const attention = objective !== undefined && ["blocked", "budgetLimited", "usageLimited", "dispatchUnknown"].includes(objective.status);
  const objectiveReady = loadState.ownerKey === ownerKey && loadState.phase === "ready";
  const dialogRequestCurrent = dialogRequest !== undefined && objectiveDialogRequestMatchesOwner(dialogRequest, controller, session);
  const dialogOpen = !readOnly && objectiveReady && (dialogRequestCurrent || editRequestId !== undefined);
  const dialogInvocationKey = `${ownerKey}:${dialogRequest === undefined ? `edit:${editRequestId ?? 0}` : `command:${dialogRequest.id}`}`;
  if (!dialogOpen) {
    dialogFenceRef.current = undefined;
  } else if (dialogFenceRef.current?.key !== dialogInvocationKey) {
    dialogFenceRef.current = objective === undefined
      ? { key: dialogInvocationKey, kind: "absent", sessionGeneration: session.generation }
      : {
          key: dialogInvocationKey,
          kind: "present",
          ownerGeneration: objective.ownerGeneration,
          sessionGeneration: objective.sessionGeneration
        };
  }

  return <div className="objective-host" ref={setHost}>
    {dialogRequest !== undefined && !objectiveReady && loadError === undefined && <div className="objective-indicator" role="status">
      <Spinner label={t("common.loading")} />
      <span>{t("objective.loading")}</span>
    </div>}
    {loadError !== undefined && <div className="objective-indicator objective-indicator--error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <span>{loadError}</span>
      <Button tone="ghost" onClick={() => setReload((value) => value + 1)}>{t("common.retry")}</Button>
    </div>}
    {objective !== undefined && <div className={cx("objective-indicator", attention && "objective-indicator--attention")} role="status">
      <Target aria-hidden="true" />
      <Pill tone={attention ? "danger" : objective.status === "active" ? "accent" : "neutral"}>{t(`objective.status.${objective.status}`)}</Pill>
      {objective.status === "usageLimited" && <span className="objective-indicator__reset">
        {objective.usageResetAt === undefined
          ? t("objective.usageManualResume")
          : t("objective.usageResetsAt", { time: formatResetTime(objective.usageResetAt, controller.state.effectiveLocale) })}
      </span>}
      <span className="objective-indicator__text" title={objective.text}>{objective.text}</span>
      <span className="objective-indicator__metric">{objective.maximumTurns === undefined
        ? t("objective.turns", { used: objective.turnsUsed })
        : t("objective.turnsWithMaximum", { used: objective.turnsUsed, maximum: objective.maximumTurns })}</span>
      {objective.tokenBudget !== undefined && <span className="objective-indicator__metric">{t("objective.tokens", { used: formatTokens(objective.tokensUsed), maximum: formatTokens(objective.tokenBudget) })}</span>}
      {objective.status === "active" && <span className="objective-indicator__metric" title={t("objective.elapsed")}>{formatElapsed(now - objective.startedAt)}</span>}
      {!readOnly && <>
        <IconButton label={t("common.edit")} disabled={pending !== undefined} onClick={() => setEditRequestId(++editRequestIdRef.current)}><Pencil aria-hidden="true" /></IconButton>
        {objective.status === "active" && <IconButton label={t("objective.pause")} disabled={pending !== undefined} onClick={() => {
          const source = objectiveRef.current;
          if (source === undefined) return;
          void mutate("pause", (signal) => controller.pauseObjective(source, "Paused by the task owner.", signal)).then(adopt).catch(() => undefined);
        }}>{pending === "pause" ? <Spinner label={t("common.loading")} /> : <Pause aria-hidden="true" />}</IconButton>}
        {["paused", "blocked", "usageLimited"].includes(objective.status) && <IconButton label={t("objective.resume")} disabled={pending !== undefined} onClick={() => {
          const source = objectiveRef.current;
          if (source === undefined) return;
          void mutate("resume", (signal) => controller.resumeObjective(source, signal)).then(adopt).catch(() => undefined);
        }}>{pending === "resume" ? <Spinner label={t("common.loading")} /> : <Play aria-hidden="true" />}</IconButton>}
        <IconButton label={t("objective.clear")} disabled={pending !== undefined} onClick={clear}>{pending === "clear" ? <Spinner label={t("common.loading")} /> : <Trash2 aria-hidden="true" />}</IconButton>
      </>}
    </div>}
    {actionError !== undefined && <div className="objective-indicator__action-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{actionError}</span><IconButton label={t("common.dismiss")} onClick={() => setActionError(undefined)}><RotateCcw aria-hidden="true" /></IconButton></div>}
    {objectiveReady && <ObjectiveDialog
      key={dialogInvocationKey}
      open={dialogOpen}
      objective={objective}
      ownerDocument={host?.ownerDocument}
      t={t}
      onClose={() => {
        setEditRequestId(undefined);
        onDialogRequestHandled(dialogRequest?.id);
      }}
      onSubmit={submitDialog}
      onSaved={dialogRequest?.onSaved}
    />}
  </div>;
}

function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1_000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3_600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
  if (value >= 1_000) return `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return value.toLocaleString();
}

function formatResetTime(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
