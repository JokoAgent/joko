import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { Circle, CircleCheck, CircleDot, X } from "lucide-react";
import type { TimelineItemView } from "../model.js";
import { IconButton, cx } from "./ui.js";
import type { Translator } from "./types.js";
import { pinnedPlanRetirement, pinnedPlanStepPosition, projectPinnedPlan, type PinnedPlanProjection, type PinnedPlanStepState } from "./pinned-plan-behavior.js";

type OpenMode = "closed" | "hover" | "pinned";

export function PinnedPlanPanel({ sessionId, items, running, visible = true, inlinePlanVisibility, t }: {
  readonly sessionId: string;
  readonly items: readonly TimelineItemView[];
  readonly running: boolean;
  readonly visible?: boolean;
  readonly inlinePlanVisibility?: { readonly key: string; readonly visible: boolean } | null;
  readonly t: Translator;
}): JSX.Element | null {
  const projection = useMemo(() => projectPinnedPlan(items), [items]);
  const [dismissedIdentity, setDismissedIdentity] = useState<string>();
  const [expiredIdentity, setExpiredIdentity] = useState<string>();
  const retirement = projection === undefined ? undefined : pinnedPlanRetirement(projection, running);
  const inlineHandoff = inlinePlanVisibility !== undefined;

  useEffect(() => {
    if (inlineHandoff || projection === undefined || retirement?.retired !== true) {
      setExpiredIdentity((current) => current === projection?.identity ? undefined : current);
      return;
    }
    const now = Date.now();
    // Treat a future host timestamp as clock skew and start one local
    // grace period instead of leaving the plan visible for the skew duration.
    const anchor = retirement.anchorAt;
    const remaining = anchor !== undefined && Number.isFinite(anchor) && anchor <= now
      ? Math.max(0, anchor + 2_000 - now)
      : 2_000;
    if (remaining === 0) {
      setExpiredIdentity(projection.identity);
      return;
    }
    const timer = window.setTimeout(() => setExpiredIdentity(projection.identity), remaining);
    return () => window.clearTimeout(timer);
  }, [inlineHandoff, projection?.identity, retirement?.anchorAt, retirement?.retired]);

  const hiddenByInlinePlan = inlinePlanVisibility === null ||
    (inlinePlanVisibility !== undefined && inlinePlanVisibility.key === projection?.identity && inlinePlanVisibility.visible);
  const completedInlinePlan = inlineHandoff && retirement?.retired === true;

  if (
    !visible ||
    hiddenByInlinePlan ||
    completedInlinePlan ||
    projection === undefined ||
    projection.steps.length < 2 ||
    dismissedIdentity === projection.identity ||
    (retirement?.retired === true && expiredIdentity === projection.identity)
  ) return null;

  return (
    <div className="pinned-plan-region" data-pinned-plan="true" data-session-id={sessionId}>
      <PinnedPlanCard
        key={projection.identity}
        projection={projection}
        animated={running}
        t={t}
        onDismiss={() => setDismissedIdentity(projection.identity)}
      />
    </div>
  );
}

function PinnedPlanCard({ projection, animated, t, onDismiss }: {
  readonly projection: PinnedPlanProjection;
  readonly animated: boolean;
  readonly t: Translator;
  readonly onDismiss: () => void;
}): JSX.Element {
  const flyoutId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [openMode, setOpenMode] = useState<OpenMode>("closed");
  const [renderFlyout, setRenderFlyout] = useState(false);
  const revealed = openMode !== "closed";
  const position = pinnedPlanStepPosition(projection.steps);

  useEffect(() => {
    if (revealed) setRenderFlyout(true);
  }, [revealed]);

  useEffect(() => {
    if (openMode !== "pinned") return;
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpenMode("closed");
    };
    const closeWithEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.repeat || event.isComposing) return;
      event.preventDefault();
      setOpenMode("closed");
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [openMode]);

  const stepLabel = t("planPill.step", position);
  return (
    <div
      ref={rootRef}
      className="pinned-plan-card"
      onMouseEnter={() => setOpenMode((current) => current === "closed" ? "hover" : current)}
      onMouseLeave={() => setOpenMode((current) => current === "hover" ? "closed" : current)}
    >
      <button
        ref={triggerRef}
        type="button"
        className="pinned-plan-pill"
        aria-controls={flyoutId}
        aria-expanded={revealed}
        aria-label={stepLabel}
        onClick={() => setOpenMode((current) => current === "pinned" ? "closed" : "pinned")}
      >
        {projection.allCompleted
          ? <CircleCheck aria-hidden="true" />
          : <ProgressRing progress={position.total === 0 ? 0 : position.current / position.total} />}
        <span>{stepLabel}</span>
      </button>

      {renderFlyout && <span className="pinned-plan-hover-bridge" aria-hidden="true" />}
      {renderFlyout && (
        <div id={flyoutId} className="pinned-plan-flyout" role="group" aria-label={t("planPill.title")}>
          <div
            className={cx("pinned-plan-flyout__surface", revealed ? "is-open" : "is-closing")}
            aria-hidden={!revealed}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget && !revealed) setRenderFlyout(false);
            }}
          >
            {revealed && <IconButton className="pinned-plan-flyout__dismiss" label={t("planPill.dismiss")} onClick={onDismiss}><X aria-hidden="true" /></IconButton>}
            <ol aria-label={t("planPill.steps")}>
              {projection.steps.map((step) => (
                <li key={step.id} className={`is-${step.state}`}>
                  <PlanStepIcon state={step.state} animated={animated} />
                  <span className="sr-only">{stateLabel(step.state, t)}: </span>
                  <span className="pinned-plan-flyout__text">{step.content}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressRing({ progress }: { readonly progress: number }): JSX.Element {
  const size = 16;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <svg className="pinned-plan-progress" data-plan-progress-ring="true" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
      <circle className="pinned-plan-progress__track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} />
      <circle
        className="pinned-plan-progress__value"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

function PlanStepIcon({ state, animated }: { readonly state: PinnedPlanStepState; readonly animated: boolean }): JSX.Element {
  if (state === "completed") return <CircleCheck aria-hidden="true" />;
  if (state === "inProgress") return (
    <span className={cx("pinned-plan-step-icon", animated && "session-status-breathing")} data-plan-step-breathing={animated ? "true" : "false"}>
      <CircleDot aria-hidden="true" />
    </span>
  );
  return <Circle aria-hidden="true" />;
}

function stateLabel(state: PinnedPlanStepState, t: Translator): string {
  if (state === "completed") return t("timeline.completed");
  if (state === "inProgress") return t("timeline.running");
  return t("timeline.requested");
}
