import { useEffect, useId, useRef, useState, type JSX } from "react";
import { Menu } from "lucide-react";
import { classifyTaskInbox, parseLocalTaskSnoozeTime, taskInboxSections, taskSnoozeChoices, taskSnoozeDeadline,
  type TaskInboxSection, type TaskSnoozeChoice } from "@joko/contracts";
import type { Translator } from "../i18n.js";
import type { AppSnapshot, SessionView } from "../model.js";
import { Button, IconButton, Modal } from "./ui.js";

interface InboxRow {
  readonly session: SessionView;
  readonly section: TaskInboxSection;
  readonly subscribed: boolean;
}

export function TaskInboxPage({ snapshot, t, locale, editable, navigationOpen, onOpenNavigation, onOpen, onSnooze, onDone }: {
  readonly snapshot: AppSnapshot;
  readonly t: Translator;
  readonly locale: string;
  readonly editable: boolean;
  readonly navigationOpen: boolean;
  readonly onOpenNavigation: () => void;
  readonly onOpen: (session: SessionView) => void;
  readonly onSnooze: (session: SessionView) => void;
  readonly onDone: (session: SessionView, subscribed: boolean) => void;
}): JSX.Element {
  const sectionsId = useId();
  const [now, setNow] = useState(Date.now);
  const [frozen, setFrozen] = useState<readonly InboxRow[]>();
  const [finished, setFinished] = useState<string>();
  const heldAction = useRef<HTMLButtonElement | null>(null);
  useEffect(() => setNow(Date.now()), [snapshot.sessions]);
  useEffect(() => {
    const next = snapshot.sessions.reduce((earliest, session) => {
      const until = session.snooze?.until ?? 0;
      return until > now ? Math.min(earliest, until) : earliest;
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(2_147_483_647, next - Date.now())));
    return () => window.clearTimeout(timer);
  }, [snapshot.sessions, now]);

  const schedules = snapshot.schedules.filter(schedule => schedule.enabled);
  const followed = new Set(schedules.flatMap(schedule => schedule.sessionId === undefined ? [] : [schedule.sessionId]));
  const enabledScheduleIds = new Set(schedules.map(schedule => schedule.id));
  const awaiting = new Set(snapshot.interactions.map(interaction => interaction.sessionId));
  const rows = snapshot.sessions.flatMap((session): InboxRow[] => {
    if (session.hidden || session.derivationOrigin?.sideChat || session.provisionalDraftId) return [];
    const subscribed = followed.has(session.id) || (session.automationOrigin !== undefined
      && enabledScheduleIds.has(session.automationOrigin.scheduleId));
    const section = classifyTaskInbox({ archived: session.archived, snooze: session.snooze, subscribed,
      awaiting: awaiting.has(session.id) || session.state === "waiting" || session.attention?.kind === "error",
      running: session.state === "running" || session.state === "retrying",
      unread: session.attention?.unread === true, teammate: session.inboxSnoozeAllowed === false
        || session.taskActivity?.completionNotification === "teammate"
    }, now);
    return section === undefined ? [] : [{ session, subscribed, section }];
  }).sort((left, right) => {
    const deadline = left.section === "snoozed" && right.section === "snoozed"
      ? taskSnoozeDeadline(left.session.snooze) - taskSnoozeDeadline(right.session.snooze) : 0;
    return deadline || Number(right.session.pinned) - Number(left.session.pinned)
      || right.session.updatedAt - left.session.updatedAt || left.session.id.localeCompare(right.session.id);
  });
  const visible = frozen === undefined ? rows : holdInboxPlacement(rows, frozen, finished);
  const unfreeze = () => { heldAction.current = null; setFrozen(undefined); setFinished(undefined); };
  const freeze = (button: HTMLButtonElement) => {
    heldAction.current = button;
    setFrozen(current => current ?? rows);
  };
  useEffect(() => {
    if (frozen !== undefined && heldAction.current?.isConnected === false) unfreeze();
  });
  return <main className="route-page task-inbox-page" onPointerLeave={unfreeze}>
    <header className="route-header">
      {!navigationOpen && <IconButton className="mobile-panel-toggle" label={t("a11y.openNavigation")} onClick={onOpenNavigation}><Menu aria-hidden="true" /></IconButton>}
      <h1>{t("inbox.title")}</h1>
    </header>
    <div className="task-inbox-sections">
      {taskInboxSections.map(section => {
        const sectionId = `${sectionsId}-${section}`;
        const listed = visible.filter(row => row.section === section);
        return <section key={section} aria-labelledby={sectionId}>
          <h2 id={sectionId}>{t(`inbox.section.${section}`)}</h2>
          {listed.length === 0 ? <p className="task-inbox-empty">{t("inbox.empty")}</p> : <ul>
            {listed.map(({ session, subscribed }) => <li key={session.id}>
              <button type="button" className="task-inbox-task" onClick={() => onOpen(session)}>
                <span>{session.name}</span>
                {section === "snoozed" && <small>{session.snooze?.until === undefined
                  ? t("inbox.indefinitely")
                  : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(session.snooze.until)}</small>}
              </button>
              <div className="task-inbox-actions">
                {session.inboxSnoozeAllowed && <Button disabled={!editable} onClick={() => onSnooze(session)}>
                  {t(section === "snoozed" ? "inbox.wake" : "inbox.snooze")}
                </Button>}
                {(session.archived || session.inboxSnoozeAllowed) && !(subscribed && section === "working") && <Button
                  disabled={!editable || !session.archived && (session.state === "running" || session.state === "retrying"
                    || subscribed && session.attention?.unread !== true)}
                  onPointerEnter={event => freeze(event.currentTarget)} onPointerLeave={unfreeze}
                  onFocus={event => freeze(event.currentTarget)} onBlur={unfreeze}
                  onClick={() => { setFinished(session.id); onDone(session, subscribed); }}>
                  {t(session.archived ? "session.unarchive" : "inbox.done")}
                </Button>}
              </div>
            </li>)}
          </ul>}
        </section>;
      })}
    </div>
  </main>;
}

function holdInboxPlacement(current: readonly InboxRow[], frozen: readonly InboxRow[], finished?: string): readonly InboxRow[] {
  const remaining = new Map(current.map(row => [row.session.id, row]));
  const visible: InboxRow[] = [];
  const settled = (section: TaskInboxSection) => section === "snoozed" || section === "archived";
  const moved = new Set<string>();
  for (const previous of frozen) {
    const next = remaining.get(previous.session.id);
    if (next === undefined) continue;
    if (previous.section !== next.section && (settled(previous.section) || settled(next.section) || next.session.id === finished)) {
      moved.add(next.session.id);
      continue;
    }
    visible.push({ ...next, section: previous.section });
    remaining.delete(next.session.id);
  }
  for (const row of remaining.values()) if (settled(row.section) || moved.has(row.session.id)) visible.push(row);
  return visible;
}

export function TaskSnoozeDialog({ session, t, locale, onClose, onChoose }: {
  readonly session: SessionView;
  readonly t: Translator;
  readonly locale: string;
  readonly onClose: () => void;
  readonly onChoose: (choice: TaskSnoozeChoice) => void;
}): JSX.Element {
  const [custom, setCustom] = useState("");
  const now = Date.now();
  const deadline = parseLocalTaskSnoozeTime(custom, now);
  const clock = new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" });
  return <Modal open title={t("inbox.snooze")} description={session.name} onClose={onClose} closeLabel={t("common.close")} showClose size="small">
    <div className="task-snooze-choices">
      {taskSnoozeChoices(now).map(({ id, until }) => <Button key={id} onClick={() => onChoose(until)}>
        <span>{t(`inbox.choice.${id}`)}</span><small>{clock.format(until)}</small>
      </Button>)}
      <Button onClick={() => onChoose("indefinitely")}>{t("inbox.indefinitely")}</Button>
    </div>
    <form className="task-snooze-custom" onSubmit={event => { event.preventDefault(); if (deadline !== undefined) onChoose(deadline); }}>
      <label className="field"><span>{t("inbox.custom")}</span>
        <input type="datetime-local" value={custom} onChange={event => setCustom(event.target.value)} />
      </label>
      <Button type="submit" disabled={deadline === undefined}>{t("common.confirm")}</Button>
    </form>
  </Modal>;
}
