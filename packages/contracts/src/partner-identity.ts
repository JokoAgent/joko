import { taskShareIdentity, taskShareOrigin } from "./task-sharing.js";

export interface PartnerIdentityInvitation {
  readonly authorityServerId: string;
  readonly partnerId: string;
  readonly origin: string;
  readonly grantId: string;
  readonly secret: string;
}
export function buildPartnerIdentityInvitation(value: PartnerIdentityInvitation): string {
  const url = new URL("joko://partner-link");
  url.searchParams.set("v", "1");
  for (const [key, item] of Object.entries(value)) url.searchParams.set(key, item);
  const result = url.toString(); parsePartnerIdentityInvitation(result); return result;
}
export function parsePartnerIdentityInvitation(value: string): PartnerIdentityInvitation {
  if (value.length > 8_192) throw new Error("The partner identity invitation is invalid.");
  const url = new URL(value.trim());
  const keys = ["v", "authorityServerId", "partnerId", "origin", "grantId", "secret"];
  if (url.protocol !== "joko:" || url.hostname !== "partner-link" || url.pathname || url.hash || url.username || url.password || url.port
    || url.searchParams.get("v") !== "1" || [...url.searchParams.keys()].length !== keys.length
    || [...url.searchParams.keys()].some(key => !keys.includes(key))) throw new Error("The partner identity invitation is invalid.");
  const secret = url.searchParams.get("secret") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw new Error("The partner identity invitation is invalid.");
  return { authorityServerId: taskShareIdentity(url.searchParams.get("authorityServerId") ?? ""),
    partnerId: taskShareIdentity(url.searchParams.get("partnerId") ?? ""),
    grantId: taskShareIdentity(url.searchParams.get("grantId") ?? ""),
    origin: taskShareOrigin(url.searchParams.get("origin") ?? ""), secret };
}
