import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { LoaderCircle } from "lucide-react";
import { timelineErrorCopy } from "../timeline-error-copy.js";
import type { ActiveRetryProjection } from "./retry-status-behavior.js";
import { hasVisibleAutoRetryNotice, retryCountdownSeconds } from "./retry-status-behavior.js";
import type { Translator } from "./types.js";

export function RetryStatusIndicator({ retry, t }: {
  readonly retry: ActiveRetryProjection;
  readonly t: Translator;
}): JSX.Element | null {
  if (retry.source === "auto" ? !hasVisibleAutoRetryNotice(retry) : retry.source !== "summarization") return null;
  return <VisibleRetryStatusIndicator retry={retry} t={t} />;
}

function VisibleRetryStatusIndicator({ retry, t }: {
  readonly retry: ActiveRetryProjection;
  readonly t: Translator;
}): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (retry.retryAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [retry.itemId, retry.retryAt]);

  const seconds = retryCountdownSeconds(retry.retryAt, now);
  const cancellable = retry.source === "auto";
  const progress = useMemo(() => {
    if (seconds === undefined) {
      return retry.maxAttempts === undefined
        ? t(cancellable ? "retryStatus.runningUnknownMax" : "retryStatus.runningUnknownMaxNoCancel", { attempt: retry.attemptNumber })
        : t(cancellable ? "retryStatus.running" : "retryStatus.runningNoCancel", { attempt: retry.attemptNumber, maxAttempts: retry.maxAttempts });
    }
    return retry.maxAttempts === undefined
      ? t(cancellable ? "retryStatus.countdownUnknownMax" : "retryStatus.countdownUnknownMaxNoCancel", { attempt: retry.attemptNumber, seconds })
      : t(cancellable ? "retryStatus.countdown" : "retryStatus.countdownNoCancel", { attempt: retry.attemptNumber, maxAttempts: retry.maxAttempts, seconds });
  }, [cancellable, retry.attemptNumber, retry.maxAttempts, seconds, t]);
  const friendly = retry.error === undefined ? undefined : timelineErrorCopy(retry.error.code);
  const message = `${friendly === undefined ? "" : t(friendly.messageKey)} ${progress}`.trim();

  return (
    <div className="retry-status-region">
      <div className="retry-status-indicator" role="status" aria-live="polite" aria-atomic="true">
        <LoaderCircle aria-hidden="true" />
        <span>{message}</span>
      </div>
    </div>
  );
}
