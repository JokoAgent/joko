import type { PartnerGroupMessage } from "./gen/joko/v1/partner_group_pb.js";

export function collectPartnerGroupMessageTimeGroups(messages: readonly PartnerGroupMessage[]): ReadonlyMap<string, number> {
  const groups = new Map<string, number>();
  let start: number | undefined;
  for (const message of messages) {
    if (!message.createdAt) continue;
    const timestamp = Number(message.createdAt.seconds) * 1000 + message.createdAt.nanos / 1_000_000;
    if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
    if (start === undefined || timestamp - start >= 5 * 60_000) {
      groups.set(message.id, timestamp); start = timestamp;
    }
  }
  return groups;
}

export function formatPartnerGroupMessageTime(timestamp: number, locale: string, now = Date.now()): string {
  const date = new Date(timestamp), current = new Date(now);
  const sameDay = date.getFullYear() === current.getFullYear() && date.getMonth() === current.getMonth() && date.getDate() === current.getDate();
  const dateFields: Intl.DateTimeFormatOptions = sameDay ? {} : date.getFullYear() === current.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en", { ...dateFields, hour: "2-digit", minute: "2-digit" }).format(date);
}
