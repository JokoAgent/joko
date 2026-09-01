import type { JSX } from "react";
import type { ContextView } from "../model.js";
import type { Translator } from "./types.js";
import { IconButton, Tip } from "./ui.js";

/** The 20px context-capacity ring, including its warning thresholds. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function ContextCapacityRing({ context, modelContextWindow, onCompact, t }: {
  readonly context?: ContextView;
  readonly modelContextWindow?: number;
  readonly onCompact?: () => void;
  readonly t: Translator;
}): JSX.Element {
  const contextKnown = context !== undefined
    && Number.isFinite(context.usedTokens)
    && context.usedTokens >= 0
    && Number.isFinite(context.contextWindow)
    && context.contextWindow > 0;
  const contextWindow = resolveDisplayContextWindow(context?.contextWindow ?? 0, modelContextWindow);
  const usedTokens = contextKnown ? Math.min(context.usedTokens, contextWindow) : 0;
  const percent = contextKnown && contextWindow > 0
    ? Math.min(Math.max(Math.round((usedTokens / contextWindow) * 100), 0), 100)
    : 0;
  const size = 20;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (circumference * percent) / 100;
  const fillColor = percent > 90 ? "#EF4444" : percent > 70 ? "#F59E0B" : "var(--text-soft)";
  const usage = contextKnown
    ? t("context.capacityUsage", { used: formatTokenCount(usedTokens), total: formatTokenCount(contextWindow), percent })
    : t("context.noData");
  const title = onCompact === undefined ? usage : `${usage}\n${t("context.compactHint")}`;
  const content = (
    <>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line-strong)" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={fillColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span style={{ color: fillColor }}>{contextKnown ? `${percent}%` : "—"}</span>
    </>
  );
  return onCompact === undefined
    ? <Tip text={title} focusable><div className="context-capacity-ring">{content}</div></Tip>
    : <IconButton className="context-capacity-ring context-capacity-ring--button" label={t("context.compactHint")} tip={title} onClick={onCompact}>{content}</IconButton>;
}

/** Format a token count for the context ring. */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
  }
  return value.toString();
}

/** SDK/model/default precedence for the displayed context window. */
export function resolveDisplayContextWindow(sdkContextWindow: number, modelContextWindow?: number): number {
  const configured = Number.isFinite(modelContextWindow) && (modelContextWindow ?? 0) > 0
    ? Math.floor(modelContextWindow as number)
    : undefined;
  const sdk = Number.isFinite(sdkContextWindow) && sdkContextWindow > 0
    ? Math.floor(sdkContextWindow)
    : undefined;
  if (configured !== undefined && (sdk === undefined || (sdk <= DEFAULT_CONTEXT_WINDOW && configured > sdk))) return configured;
  return sdk ?? configured ?? DEFAULT_CONTEXT_WINDOW;
}
