import type { NativeAccountRateLimitResetSnapshot, ProviderAccountUsageSnapshot } from "@joko/core";
import { objectValue, ProtocolShapeError, type JsonValue } from "./protocol.js";

export function codexAccountResetFacts(value: JsonValue, usage: ProviderAccountUsageSnapshot): Pick<NativeAccountRateLimitResetSnapshot, "credits" | "ordinaryQuota"> {
  const response = objectValue(value, "account reset quota"), rawCredits = response["rateLimitResetCredits"];
  let credits: NativeAccountRateLimitResetSnapshot["credits"];
  if (rawCredits !== undefined && rawCredits !== null) {
    const summary = objectValue(rawCredits, "account reset credits"), count = summary["availableCount"], details = summary["credits"];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > 0xffff_ffff
      || details !== undefined && details !== null && (!Array.isArray(details) || details.length > 4096)) throw invalid();
    credits = { availableCount: count, ...(Array.isArray(details) ? { details: details.map(value => {
      const row = objectValue(value, "account reset credit"), creditId = text(row["id"], 1024), grantedAt = timestamp(row["grantedAt"]);
      if (creditId === undefined || !creditId.trim() || /[\0\r\n]/u.test(creditId) || grantedAt === undefined) throw invalid();
      const status = row["status"], expiresAt = timestamp(row["expiresAt"]), title = text(row["title"], 512), description = text(row["description"], 4096);
      return { creditId, grantedAt, resetType: row["resetType"] === "codexRateLimits" ? "codexRateLimits" as const : "unknown" as const,
        status: status === "available" || status === "redeeming" || status === "redeemed" ? status : "unknown" as const,
        ...(expiresAt === undefined ? {} : { expiresAt }), ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }) };
    }) } : {}) };
  }
  const buckets = response["rateLimitsByLimitId"], rows = buckets === undefined || buckets === null ? undefined : objectValue(buckets, "account quota buckets");
  const detailed = rows !== undefined && Object.keys(rows).length > 0;
  let ordinary = detailed ? undefined : objectValue(response["rateLimits"], "account quota");
  let parsed: Pick<ProviderAccountUsageSnapshot, "primaryWindow" | "secondaryWindow"> | undefined = detailed ? undefined : usage;
  if (rows) for (const key of ["codex", "__default__"]) {
    const raw = Object.hasOwn(rows, key) ? rows[key] : undefined;
    if (raw === undefined || raw === null) continue;
    const bucket = objectValue(raw, "ordinary account quota");
    const windows = [bucket["primary"], bucket["secondary"]].filter(value => value !== undefined && value !== null).map(value => objectValue(value, "account quota window"));
    const resets = windows.map(window => timestamp(window["resetsAt"]));
    if (windows.length && resets.every((reset): reset is number => reset !== undefined && reset > 0)
      && Math.max(...resets) + 86_400_000 < usage.observedAt) continue;
    ordinary = bucket; parsed = usage.buckets?.find(bucket => bucket.id === key); break;
  }
  if (!ordinary || !parsed) return { ...(credits === undefined ? {} : { credits }) };
  return { ...(credits === undefined ? {} : { credits }), ordinaryQuota: {
    ...(parsed.primaryWindow === undefined ? {} : { primaryWindow: parsed.primaryWindow }),
    ...(parsed.secondaryWindow === undefined ? {} : { secondaryWindow: parsed.secondaryWindow }),
    creditsDepleted: typeof ordinary["rateLimitReachedType"] === "string" && ordinary["rateLimitReachedType"].includes("credits_depleted") } };
}
function text(value: JsonValue | undefined, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw invalid(); return value;
}
function timestamp(value: JsonValue | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 253_402_300_799) throw invalid(); return value * 1000;
}
function invalid(): ProtocolShapeError { return new ProtocolShapeError("account reset credit facts are invalid"); }
