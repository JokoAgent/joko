const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u;
const formatters = new Map<string, Intl.DateTimeFormat>();

interface DateTimeParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export function isValidScheduleTimeZone(timeZone: string): boolean {
  try {
    scheduleDateTimeFormatter(timeZone.trim()).format(0);
    return timeZone.trim().length > 0;
  } catch {
    return false;
  }
}

/** Convert a datetime-local wall clock in the selected IANA timezone. Native
 * Date.parse() would instead apply the browser's own timezone and silently
 * move a remote schedule. Nonexistent DST wall clocks fail closed. */
export function scheduleEpochFromLocalDateTime(value: string, timeZone: string): number | undefined {
  const intended = parseLocalDateTime(value);
  if (intended === undefined || !isValidScheduleTimeZone(timeZone)) return undefined;
  const wallClockAsUtc = partsAsUtc(intended);
  let candidate = wallClockAsUtc;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = dateTimeParts(candidate, timeZone.trim());
    const delta = wallClockAsUtc - partsAsUtc(actual);
    if (delta === 0) break;
    candidate += delta;
  }
  return sameDateTimeParts(dateTimeParts(candidate, timeZone.trim()), intended) ? candidate : undefined;
}

/** Render a persisted instant as the wall clock owned by its schedule, not by
 * whichever client happens to edit it. */
export function scheduleLocalDateTimeFromEpoch(epoch: number, timeZone: string): string {
  if (!Number.isFinite(epoch) || !isValidScheduleTimeZone(timeZone)) return "";
  const parts = dateTimeParts(epoch, timeZone.trim());
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

function parseLocalDateTime(value: string): DateTimeParts | undefined {
  const match = LOCAL_DATE_TIME.exec(value.trim());
  if (match === null) return undefined;
  const parts: DateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0)
  };
  if (
    parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 ||
    parts.hour > 23 || parts.minute > 59 || parts.second > 59
  ) return undefined;
  const normalized = new Date(partsAsUtc(parts));
  return normalized.getUTCFullYear() === parts.year && normalized.getUTCMonth() + 1 === parts.month &&
    normalized.getUTCDate() === parts.day && normalized.getUTCHours() === parts.hour &&
    normalized.getUTCMinutes() === parts.minute && normalized.getUTCSeconds() === parts.second
    ? parts
    : undefined;
}

function dateTimeParts(epoch: number, timeZone: string): DateTimeParts {
  const values = new Map(scheduleDateTimeFormatter(timeZone).formatToParts(new Date(epoch)).map((part) => [part.type, part.value] as const));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second"))
  };
}

function scheduleDateTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const current = formatters.get(timeZone);
  if (current !== undefined) return current;
  const formatter = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  // Force timezone validation before caching. Some engines construct lazily.
  formatter.format(0);
  formatters.set(timeZone, formatter);
  return formatter;
}

function partsAsUtc(parts: DateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function sameDateTimeParts(left: DateTimeParts, right: DateTimeParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
