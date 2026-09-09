import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { ScheduleRunHistoryView, ScheduleView } from "../model.js";
import type { Translator } from "./types.js";
import { Button, IconButton } from "./ui.js";
import { isUnreadScheduleHistoryRun } from "./ScheduleRunHistoryCard.js";

// A dismissal affects only this client's exact historical failure projection.
const dismissedFailures = new Set<string>();

export function SessionScheduleNotice({ ownerId, sessionId, schedules, markRead, t }: {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly schedules: readonly ScheduleView[];
  readonly markRead: (scheduleId: string, triggerId: string) => Promise<void>;
  readonly t: Translator;
}): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null);
  const receiptRef = useRef(new Set<string>());
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;
  const [revision, setRevision] = useState(0);
  const [readFailed, setReadFailed] = useState(false);
  const [foreground, setForeground] = useState(false);
  const records = useMemo(() => schedules.flatMap((schedule) => schedule.history
    .filter((run) => run.sessionId === sessionId && run.state !== "running" && run.state !== "skipped")
    .map((run) => ({ schedule, run, key: JSON.stringify([ownerId, sessionId, schedule.id, run.id, run.finishedAt]) }))), [ownerId, schedules, sessionId]);
  const latest = records.filter(({ run }) => run.state === "failed" || run.state === "interrupted")
    .sort((left, right) => finishedAt(right.run) - finishedAt(left.run))[0];
  const visible = latest !== undefined && !dismissedFailures.has(latest.key);

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument ?? document;
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

  if (!visible && !readFailed) return null;
  return <div ref={rootRef} className="error-tail-banner" role="status">
    {visible && <>
      <AlertTriangle aria-hidden="true" />
      <div><strong>{latest.schedule.name} · {t("scheduler.runFailed")}</strong>
        {latest.run.error !== undefined && <p>{latest.run.error}</p>}
      </div>
      <Button onClick={() => { window.location.hash = `#/schedules?focus=${encodeURIComponent(latest.schedule.id)}`; }}>{t("scheduler.history")}</Button>
      <IconButton label={t("common.dismiss")} onClick={() => {
        dismissedFailures.add(latest.key);
        while (dismissedFailures.size > 256) dismissedFailures.delete(dismissedFailures.values().next().value!);
        setRevision((value) => value + 1);
      }}><X aria-hidden="true" /></IconButton>
    </>}
    {readFailed && <Button onClick={() => setRevision((value) => value + 1)}>{t("scheduler.markRunRead")}</Button>}
  </div>;
}

function finishedAt(run: ScheduleRunHistoryView): number {
  return run.finishedAt ?? run.triggeredAt;
}
