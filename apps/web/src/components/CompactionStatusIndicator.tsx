import type { JSX } from "react";
import { LoaderCircle } from "lucide-react";
import type { ActiveCompactionProjection } from "./compaction-status-behavior.js";
import type { Translator } from "./types.js";

export function CompactionStatusIndicator({ compaction, t }: {
  readonly compaction: ActiveCompactionProjection;
  readonly t: Translator;
}): JSX.Element {
  const message = compaction.reason === "overflow"
    ? t("compactionStatus.overflow")
    : compaction.automatic || compaction.reason === "threshold"
      ? t("compactionStatus.automatic")
      : t("compactionStatus.manual");
  return (
    <div className="compaction-status-region">
      <div className="compaction-status-indicator" role="status" aria-live="polite" aria-atomic="true">
        <LoaderCircle aria-hidden="true" />
        <span>{message}</span>
      </div>
    </div>
  );
}
