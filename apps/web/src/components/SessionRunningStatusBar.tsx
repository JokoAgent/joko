import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Activity, ArrowDown, Check, Layers, Sparkles, Square } from "lucide-react";
import type { SessionView, TimelineItemView } from "../model.js";
import { formatCompactUsageTokens } from "./message-usage.js";
import { activeRunUsageSummary, formatRunningElapsed, latestRunningActivityLabel, resolveRunningUsageMeta } from "./running-status.js";
import type { Translator } from "./types.js";
import { cx } from "./ui.js";

const STATUS_LINGER_MS = 1_000;
const STATUS_FADE_MS = 400;

export function SessionRunningStatusBar({
  session,
  items,
  backgroundTaskIds,
  canStopBackgroundTasks,
  backgroundStopping,
  backgroundStopError,
  suppressed = false,
  t,
  onStopBackgroundTasks
}: {
  readonly session: SessionView;
  readonly items: readonly TimelineItemView[];
  readonly backgroundTaskIds: readonly string[];
  readonly canStopBackgroundTasks: boolean;
  readonly backgroundStopping: boolean;
  readonly backgroundStopError?: string;
  readonly suppressed?: boolean;
  readonly t: Translator;
  readonly onStopBackgroundTasks: () => void;
}): JSX.Element | null {
  const foregroundRunning = ["running", "waiting", "retrying"].includes(session.state) && session.activeRunId !== undefined;
  const backgroundMode = !foregroundRunning && backgroundTaskIds.length > 0;
  const visible = !suppressed && (foregroundRunning || backgroundMode);
  const [showContent, setShowContent] = useState(visible);
  const [fading, setFading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [shimmerCycle, setShimmerCycle] = useState(0);
  const reducedMotion = useReducedMotionPreference();
  const lastRunIdRef = useRef<string | undefined>(session.activeRunId);
  const lastStartedAtRef = useRef<number | undefined>(activeRunStartedAt(session));
  const shimmerPlayingRef = useRef(false);
  const shimmerPendingRef = useRef(false);

  if (foregroundRunning && session.activeRunId !== undefined) {
    if (lastRunIdRef.current !== session.activeRunId) lastStartedAtRef.current = undefined;
    lastRunIdRef.current = session.activeRunId;
    const startedAt = activeRunStartedAt(session);
    if (startedAt !== undefined) lastStartedAtRef.current = startedAt;
  }
  const displayedRunId = session.activeRunId ?? lastRunIdRef.current;
  const usage = activeRunUsageSummary(items, displayedRunId);
  const usageMeta = resolveRunningUsageMeta(usage);

  useEffect(() => {
    if (visible) {
      setShowContent(true);
      setFading(false);
      return;
    }
    if (!showContent) return;
    const linger = window.setTimeout(() => setFading(true), STATUS_LINGER_MS);
    const hide = window.setTimeout(() => setShowContent(false), STATUS_LINGER_MS + STATUS_FADE_MS);
    return () => {
      window.clearTimeout(linger);
      window.clearTimeout(hide);
    };
  }, [showContent, visible]);

  useEffect(() => {
    const startedAt = lastStartedAtRef.current;
    if (startedAt === undefined) {
      setElapsed(0);
      return;
    }
    const update = (): void => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [displayedRunId]);

  useEffect(() => {
    if (!visible || suppressed || reducedMotion) {
      shimmerPlayingRef.current = false;
      shimmerPendingRef.current = false;
      return;
    }
    if (shimmerPlayingRef.current) {
      shimmerPendingRef.current = true;
      return;
    }
    shimmerPlayingRef.current = true;
    setShimmerCycle((value) => value + 1);
  }, [backgroundTaskIds.length, reducedMotion, session.compacting, session.state, suppressed, usage.outputTokens, usage.totalTokens, visible]);

  const onShimmerEnd = useCallback(() => {
    shimmerPlayingRef.current = false;
    if (!shimmerPendingRef.current) return;
    shimmerPendingRef.current = false;
    shimmerPlayingRef.current = true;
    setShimmerCycle((value) => value + 1);
  }, []);

  const animatedTokens = useAnimatedNumber(usage.totalTokens, reducedMotion);
  if (!showContent && !visible) return null;
  const done = !visible && !backgroundMode;
  const status = backgroundMode
    ? t("runningStatus.background", { count: backgroundTaskIds.length })
    : done
      ? t("runningStatus.done")
      : session.compacting === true
        ? t("runningStatus.compacting")
        : latestRunningActivityLabel(items, session.activeRunId)
          ?? (session.state === "waiting" ? t("session.waiting") : t("session.running"));
  const tokenText = t("runningStatus.tokens", { tokens: formatCompactUsageTokens(animatedTokens) });
  const style = { opacity: fading && !visible ? 0 : 1, transition: `opacity ${STATUS_FADE_MS}ms ease-out` };

  return <div className="session-running-status" style={style} role="status" aria-live="polite" data-running-status="true">
    <div
      key={shimmerCycle}
      className={cx("session-running-status__leading", visible && !reducedMotion && "is-shimmering", done && "is-done")}
      onAnimationEnd={onShimmerEnd}
    >
      {done ? <Check aria-hidden="true" /> : backgroundMode ? <Activity aria-hidden="true" /> : session.compacting === true ? <Layers aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
      <span>{status}</span>
    </div>
    <div className="session-running-status__meta">
      {backgroundMode ? canStopBackgroundTasks && <button type="button" disabled={backgroundStopping} title={t("runningStatus.stopAllTitle")} onClick={onStopBackgroundTasks}><Square aria-hidden="true" />{backgroundStopping ? t("runningStatus.stopping") : t("runningStatus.stopAll")}</button> : <>
        {lastStartedAtRef.current !== undefined && <span>{formatRunningElapsed(elapsed)}</span>}
        {usageMeta.kind !== "none" && <span aria-hidden="true">·</span>}
        {usageMeta.kind === "rate" ? <span title={tokenText}>{t("runningStatus.rate", { rate: usageMeta.rate })}</span> : usageMeta.kind === "tokens" ? <span className="session-running-status__tokens" title={tokenText}><ArrowDown aria-hidden="true" />{tokenText}</span> : null}
      </>}
    </div>
    {backgroundStopError !== undefined && <span className="session-running-status__error" role="alert">{backgroundStopError}</span>}
  </div>;
}

function activeRunStartedAt(session: SessionView): number | undefined {
  const value = (session as SessionView & { readonly activeRunStartedAt?: number }).activeRunStartedAt;
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function useReducedMotionPreference(): boolean {
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReduced(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

function useAnimatedNumber(target: number, reducedMotion: boolean): number {
  const [displayed, setDisplayed] = useState(target);
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;
  useEffect(() => {
    if (reducedMotion || typeof window.requestAnimationFrame !== "function") {
      setDisplayed(target);
      return;
    }
    const from = displayedRef.current;
    const startedAt = performance.now();
    let frame = 0;
    const update = (now: number): void => {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / 400));
      setDisplayed(Math.round(from + (target - from) * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [reducedMotion, target]);
  return displayed;
}
