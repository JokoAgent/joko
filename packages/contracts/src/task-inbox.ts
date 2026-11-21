export const taskInboxSections = ["inbox", "working", "snoozed", "archived"] as const;
export type TaskInboxSection = typeof taskInboxSections[number];
export type TaskSnoozeChoice = number | "indefinitely" | "wake";

export function taskSnoozeDeadline(snooze?: { readonly until?: number }): number {
  return snooze === undefined ? 0 : snooze.until ?? Number.POSITIVE_INFINITY;
}

export function classifyTaskInbox(task: {
  readonly archived: boolean;
  readonly snooze?: { readonly until?: number };
  readonly awaiting: boolean;
  readonly running: boolean;
  readonly unread: boolean;
  readonly subscribed: boolean;
  readonly teammate: boolean;
}, now: number): TaskInboxSection | undefined {
  if (task.archived) return "archived";
  if (taskSnoozeDeadline(task.snooze) > now) return "snoozed";
  if (task.awaiting) return "inbox";
  if (task.running) return "working";
  if (task.teammate) return undefined;
  return task.subscribed && !task.unread ? "working" : "inbox";
}

export function taskSnoozeChoices(now: number): readonly {
  readonly id: "oneHour" | "threeHours" | "thisEvening" | "tomorrow" | "nextWeek";
  readonly until: number;
}[] {
  const atLocalHour = (days: number, hour: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    return date.setHours(hour, 0, 0, 0);
  };
  const evening = atLocalHour(0, 18);
  const daysUntilMonday = (8 - new Date(now).getDay()) % 7 || 7;
  return [
    { id: "oneHour", until: now + 3_600_000 },
    { id: "threeHours", until: now + 10_800_000 },
    ...(evening > now ? [{ id: "thisEvening" as const, until: evening }] : []),
    { id: "tomorrow", until: atLocalHour(1, 9) },
    { id: "nextWeek", until: atLocalHour(daysUntilMonday, 9) }
  ];
}

export function localTaskSnoozeTime(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseLocalTaskSnoozeTime(value: string, now: number): number | undefined {
  const time = new Date(value).getTime();
  return time > now && time <= now + 366 * 86_400_000 && localTaskSnoozeTime(time) === value ? time : undefined;
}
