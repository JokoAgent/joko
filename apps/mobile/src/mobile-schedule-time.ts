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

export function isValidMobileScheduleTimeZone(timeZone: string): boolean {
  try {
    const normalized = timeZone.trim();
    if (normalized.length === 0 || normalized !== timeZone) return false;
    formatter(normalized).format(0);
    return true;
  } catch {
    return false;
  }
}

export function mobileScheduleEpochFromLocalDateTime(value: string, timeZone: string): number | undefined {
  const intended = parseLocalDateTime(value);
  if (intended === undefined || !isValidMobileScheduleTimeZone(timeZone)) return undefined;
  const wallClockAsUtc = partsAsUtc(intended);
  let candidate = wallClockAsUtc;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = dateTimeParts(candidate, timeZone);
    const delta = wallClockAsUtc - partsAsUtc(actual);
    if (delta === 0) break;
    candidate += delta;
  }
  return sameParts(dateTimeParts(candidate, timeZone), intended) ? candidate : undefined;
}

export function mobileScheduleLocalDateTimeFromEpoch(epoch: number, timeZone: string): string {
  if (!Number.isFinite(epoch) || !isValidMobileScheduleTimeZone(timeZone)) return "";
  const parts = dateTimeParts(epoch, timeZone);
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
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31
    || parts.hour > 23 || parts.minute > 59 || parts.second > 59) return undefined;
  const normalized = new Date(partsAsUtc(parts));
  return normalized.getUTCFullYear() === parts.year && normalized.getUTCMonth() + 1 === parts.month
    && normalized.getUTCDate() === parts.day && normalized.getUTCHours() === parts.hour
    && normalized.getUTCMinutes() === parts.minute && normalized.getUTCSeconds() === parts.second
    ? parts : undefined;
}

function dateTimeParts(epoch: number, timeZone: string): DateTimeParts {
  const values = new Map(formatter(timeZone).formatToParts(new Date(epoch))
    .map((part) => [part.type, part.value] as const));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second"))
  };
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const value = new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  value.format(0);
  formatters.set(timeZone, value);
  return value;
}

function partsAsUtc(parts: DateTimeParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function sameParts(left: DateTimeParts, right: DateTimeParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute && left.second === right.second;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
