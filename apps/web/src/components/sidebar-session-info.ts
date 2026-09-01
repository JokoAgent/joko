import type { SessionView } from "../model.js";
import {
  normalizeSidebarSessionInfoFields,
  type SidebarSessionInfoField
} from "../sidebar-layout.js";
import { formatCompactUsageTokens, formatKnownUsageCost } from "./session-usage.js";
import { formatRelativeTime } from "./ui.js";

export interface SidebarSessionInfoPiece {
  readonly field: SidebarSessionInfoField;
  readonly text: string;
  readonly dateTime?: string;
}

export function sidebarSessionInfoPieces(
  session: SessionView,
  fields: readonly SidebarSessionInfoField[],
  locale: string
): readonly SidebarSessionInfoPiece[] {
  const pieces: SidebarSessionInfoPiece[] = [];
  for (const field of normalizeSidebarSessionInfoFields(fields)) {
    if (field === "time") {
      pieces.push({
        field,
        text: formatRelativeTime(session.updatedAt, locale),
        dateTime: new Date(session.updatedAt).toISOString()
      });
      continue;
    }
    if (field === "pr" && (session.codeHostPullRequests?.length ?? 0) > 0) {
      pieces.push({ field, text: "" });
      continue;
    }
    if (field === "worktree" && session.worktree !== undefined) {
      pieces.push({ field, text: "" });
      continue;
    }
    if (field === "tokens" && session.usage !== undefined && session.usage.totalTokens > 0) {
      pieces.push({ field, text: compactSidebarTokenCount(session.usage.totalTokens) });
      continue;
    }
    if (field === "cost" && session.usage !== undefined) {
      const text = formatKnownUsageCost(session.usage.costMicros, session.usage.currencyCode, locale);
      if (text !== undefined) pieces.push({ field, text });
    }
  }
  return pieces;
}

export function compactSidebarTokenCount(value: number): string {
  return formatCompactUsageTokens(value);
}

export function formatSidebarCost(value: number, currency: string, locale: string): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return formatKnownUsageCost(Math.round(value * 1_000_000), currency, locale);
}
