import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { ScheduleRunHistoryView, ScheduleView } from "../model.js";
import {
  compareScheduleFailureDismissals,
  dismissScheduleFailure,
  readLatestDismissedScheduleFailure,
  scheduleFailureDismissalPrefix,
  type ScheduleFailureDismissal
} from "../schedule-failure-dismissal.js";
import type { Translator } from "./types.js";
import { Button, IconButton } from "./ui.js";
import { isUnreadScheduleHistoryRun } from "./ScheduleRunHistoryCard.js";

export function SessionScheduleNotice({ ownerId, sessionId, schedules, markRead, t }: {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly schedules: readonly ScheduleView[];
  readonly markRead: (scheduleId: string, triggerId: string) => Promise<void>;
  readonly t: Translator;
}): JSX.Element | null {
  const rootRef = useRef<HTMLElement>(null);
  const receiptRef = useRef(new Set<string>());
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;
  const [revision, setRevision] = useState(0);
  const [readFailed, setReadFailed] = useState(false);
  const [foreground, setForeground] = useState(false);
  const [ownerWindow, setOwnerWindow] = useState<Window | null>(null);
  const [dismissed, setDismissed] = useState<{
    readonly prefix: string;
    readonly failure: ScheduleFailureDismissal | null;
  } | null>(null);
  const dismissalPrefix = scheduleFailureDismissalPrefix(ownerId, sessionId);
  const records = useMemo(() => schedules.flatMap((schedule) => schedule.history
    .filter((run) => run.sessionId === sessionId && run.state !== "running" && run.state !== "skipped")
    .map((run) => ({ schedule, run, key: JSON.stringify([ownerId, sessionId, schedule.id, run.id, run.finishedAt]) }))), [ownerId, schedules, sessionId]);
  const latest = records.reduce<(typeof records)[number] | undefined>((current, candidate) => {
    if (candidate.run.state !== "failed" && candidate.run.state !== "interrupted") return current;
    if (current === undefined) return candidate;
    return compareScheduleFailureDismissals(failureIdentity(candidate), failureIdentity(current)) > 0
      ? candidate
      : current;
  }, undefined);
  const latestFailure = latest === undefined ? undefined : failureIdentity(latest);
  const dismissedFailure = dismissed?.prefix === dismissalPrefix ? dismissed.failure : null;
  const visible = latestFailure !== undefined
    && (dismissedFailure === null || compareScheduleFailureDismissals(dismissedFailure, latestFailure) < 0);
  const captureRoot = useCallback((element: HTMLElement | null): void => {
    rootRef.current = element;
    const nextWindow = element?.ownerDocument.defaultView ?? null;
    if (nextWindow !== null) setOwnerWindow((current) => current === nextWindow ? current : nextWindow);
  }, []);

  useLayoutEffect(() => {
    if (ownerWindow === null) return;
    let storage: Storage;
    try {
      storage = ownerWindow.localStorage;
    } catch {
      setDismissed({ prefix: dismissalPrefix, failure: null });
      return;
    }
    setDismissed({ prefix: dismissalPrefix, failure: readLatestDismissedScheduleFailure(storage, dismissalPrefix) });
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && !event.key.startsWith(dismissalPrefix)) return;
      try {
        if (event.storageArea !== null && event.storageArea !== storage) return;
      } catch {
        return;
      }
      const stored = readLatestDismissedScheduleFailure(storage, dismissalPrefix);
      setDismissed((current) => {
        const previous = current?.prefix === dismissalPrefix ? current.failure : null;
        const failure = event.key === null || previous === null
          ? stored
          : stored === null || compareScheduleFailureDismissals(previous, stored) > 0
            ? previous
            : stored;
        return { prefix: dismissalPrefix, failure };
      });
    };
    ownerWindow.addEventListener("storage", onStorage);
    return () => ownerWindow.removeEventListener("storage", onStorage);
  }, [dismissalPrefix, ownerWindow]);

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument;
    if (ownerDocument === undefined) return;
    const ownerWindow = ownerDocument.defaultView;
    const update = (): void => setForeground(ownerDocument.visibilityState === "visible" && ownerDocument.hasFocus());
    update();
    ownerDocument.addEventListener("visibilitychange", update);
    ownerWindow?.addEventListener("focus", update);
    ownerWindow?.addEventListener("blur", update);
    return () => {
      ownerDocument.removeEventListener("visibilitychange", update);
      ownerWindow?.removeEventListener("focus", update);
      ownerWindow?.removeEventListener("blur", update);
    };
  }, []);

  useEffect(() => {
    receiptRef.current.clear();
    setReadFailed(false);
  }, [ownerId, sessionId]);

  useEffect(() => {
    if (!foreground) return;
    let current = true;
    setReadFailed(false);
    for (const { schedule, run, key } of records) {
      if (!isUnreadScheduleHistoryRun(run) || receiptRef.current.has(key)) continue;
      receiptRef.current.add(key);
      void markReadRef.current(schedule.id, run.id).catch(() => {
        receiptRef.current.delete(key);
        if (current) setReadFailed(true);
      });
    }
    return () => { current = false; };
  }, [foreground, ownerId, records, revision, sessionId]);

  if (!visible && !readFailed) return <span ref={captureRoot} hidden aria-hidden="true" />;
  return <div ref={captureRoot} className="error-tail-banner" role="status">
    {visible && latest !== undefined && latestFailure !== undefined && <>
      <AlertTriangle aria-hidden="true" />
      <div><strong>{latest.schedule.name} · {t("scheduler.runFailed")}</strong>
        {latest.run.error !== undefined && <p>{latest.run.error}</p>}
      </div>
      <Button onClick={() => {
        const targetWindow = rootRef.current?.ownerDocument.defaultView;
        if (targetWindow !== null && targetWindow !== undefined) {
          targetWindow.location.hash = `#/schedules?focus=${encodeURIComponent(latest.schedule.id)}`;
        }
      }}>{t("scheduler.history")}</Button>
      <IconButton label={t("common.dismiss")} onClick={() => {
        const targetWindow = rootRef.current?.ownerDocument.defaultView;
        try {
          if (targetWindow !== null && targetWindow !== undefined) {
            dismissScheduleFailure(targetWindow.localStorage, dismissalPrefix, latestFailure);
          }
        } catch {
          // A client preference failure must not prevent hiding this instance.
        }
        setDismissed((current) => {
          const previous = current?.prefix === dismissalPrefix ? current.failure : null;
          return {
            prefix: dismissalPrefix,
            failure: previous !== null && compareScheduleFailureDismissals(previous, latestFailure) > 0
              ? previous
              : latestFailure
          };
        });
      }}><X aria-hidden="true" /></IconButton>
    </>}
    {readFailed && <Button onClick={() => setRevision((value) => value + 1)}>{t("scheduler.markRunRead")}</Button>}
  </div>;
}

function finishedAt(run: ScheduleRunHistoryView): number {
  return run.finishedAt ?? run.triggeredAt;
}

function failureIdentity(record: {
  readonly schedule: ScheduleView;
  readonly run: ScheduleRunHistoryView;
}): ScheduleFailureDismissal {
  return {
    completedAt: finishedAt(record.run),
    scheduleId: record.schedule.id,
    runId: record.run.runId,
    triggerId: record.run.id
  };
}
