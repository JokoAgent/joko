import type { JSX } from "react";
import { AlertCircle, CalendarClock, RotateCcw, X } from "lucide-react";
import type { ErrorView, TimelineItemView } from "../model.js";
import type { UsageLimitRecoveryHint } from "../usage-limit-recovery.js";
import type { ExecutableRecoveryAction } from "./coding-ui-behavior.js";
import type { Translator } from "./types.js";
import { Button, IconButton } from "./ui.js";

export function ErrorTailBanner({ item, actions, usageLimitRecovery, actionFailure, t, onAction, onScheduleUsageRecovery, onDismiss }: {
  readonly item: TimelineItemView;
  readonly actions: readonly ExecutableRecoveryAction[];
  readonly usageLimitRecovery?: UsageLimitRecoveryHint;
  readonly actionFailure?: string;
  readonly t: Translator;
  readonly onAction: (error: ErrorView, action: ExecutableRecoveryAction) => void;
  readonly onScheduleUsageRecovery?: (hint: UsageLimitRecoveryHint) => void;
  readonly onDismiss?: () => void;
}): JSX.Element {
  const error = item.error;
  return (
    <div className="error-tail-region">
      <aside className="error-tail-banner" role="alert" data-testid="error-tail-banner" data-error-id={item.id}>
        <AlertCircle className="error-tail-banner__icon" aria-hidden="true" />
        <div className="error-tail-banner__copy">
          <strong>{item.title ?? error?.code ?? t("timeline.error")}</strong>
          <span>{error?.message ?? item.text ?? t("errorTail.fallback")}</span>
          {actionFailure !== undefined && <small>{t("errorTail.actionFailed", { message: actionFailure })}</small>}
        </div>
        {error !== undefined && (actions.length > 0 || usageLimitRecovery !== undefined) && (
          <div className="error-tail-banner__actions">
            {actions.map((action, index) => (
              <Button key={action.id} tone="ghost" className={index === 0 ? "is-primary" : undefined} onClick={() => onAction(error, action)}>
                <RotateCcw aria-hidden="true" />{action.label || recoveryActionLabel(action.kind, t)}
              </Button>
            ))}
            {usageLimitRecovery !== undefined && onScheduleUsageRecovery !== undefined && (
              <Button tone="ghost" className={actions.length === 0 ? "is-primary" : undefined} onClick={() => onScheduleUsageRecovery(usageLimitRecovery)}>
                <CalendarClock aria-hidden="true" />{t("errorTail.scheduleAfterReset")}
              </Button>
            )}
          </div>
        )}
        {onDismiss !== undefined && <IconButton className="error-tail-banner__dismiss" label={t("errorTail.dismiss")} onClick={onDismiss}><X aria-hidden="true" /></IconButton>}
      </aside>
    </div>
  );
}

function recoveryActionLabel(kind: ExecutableRecoveryAction["kind"], t: Translator): string {
  if (kind === "wait") return t("recovery.wait");
  if (kind === "retry") return t("common.retry");
  if (kind === "resnapshot") return t("common.refresh");
  if (kind === "openSession") return t("interaction.openTask");
  if (kind === "openDiagnostics") return t("errorTail.openDiagnostics");
  if (kind === "reauthenticate") return t("errorTail.reauthenticate");
  if (kind === "contactOwner") return t("recovery.contactOwner");
  return t("common.stop");
}
