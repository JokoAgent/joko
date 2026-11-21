import { isIP } from "node:net";

export interface IMessageChatBinding {
  readonly guid: string;
  readonly activation: "mention" | "always" | "disabled";
  readonly selfAddress?: string;
}

export interface IMessageConfiguration {
  readonly serverOrigin: string;
  readonly chats: readonly IMessageChatBinding[];
  readonly aliases: readonly string[];
}

export function parseIMessageOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || !["https:", "http:"].includes(url.protocol)) throw new Error("Enter the BlueBubbles server origin.");
  if (url.protocol === "http:" && !privateBlueBubblesHost(url.hostname)) {
    throw new Error("Use HTTPS for a BlueBubbles server outside this local network.");
  }
  return url.origin;
}

export function iMessageChatGuid(guid: unknown): guid is string {
  return typeof guid === "string" && /^(?:iMessage|any);[-+];[^\u0000-\u0020\u007f]{1,480}$/u.test(guid);
}

export function iMessageAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed.length > 320 || /[\s\u0000-\u001f\u007f/;:@]/u.test(trimmed.replace("@", ""))) return undefined;
  return /^(?:\+?[0-9]{3,24}|[^@]+@[^@]+)$/u.test(trimmed) ? trimmed : undefined;
}

export function parseIMessageConfiguration(value: unknown): IMessageConfiguration {
  if (!record(value) || typeof value["serverOrigin"] !== "string" || !Array.isArray(value["chats"])
    || value["chats"].length < 1 || value["chats"].length > 100 || !Array.isArray(value["aliases"]) || value["aliases"].length > 20
    || value["aliases"].some(alias => typeof alias !== "string" || alias.trim().length === 0 || alias.length > 100 || /[\u0000-\u001f\u007f]/u.test(alias))) {
    throw new Error("Configure a BlueBubbles server and the allowed iMessage chats.");
  }
  const guids = new Set<string>();
  const chats = value["chats"].map((chat): IMessageChatBinding => {
    if (!record(chat) || !iMessageChatGuid(chat["guid"]) || guids.has(chat["guid"])
      || (chat["activation"] !== "mention" && chat["activation"] !== "always" && chat["activation"] !== "disabled")) {
      throw new Error("Each allowed iMessage chat needs a unique GUID and activation rule.");
    }
    const selfAddress = iMessageAddress(chat["selfAddress"]);
    if (chat["selfAddress"] !== undefined && selfAddress === undefined) throw new Error("The configured Apple account address is invalid.");
    guids.add(chat["guid"]);
    return { guid: chat["guid"], activation: chat["activation"], ...(selfAddress === undefined ? {} : { selfAddress }) };
  });
  return { serverOrigin: parseIMessageOrigin(value["serverOrigin"]), chats, aliases: [...new Set((value["aliases"] as string[]).map(alias => alias.trim()))] };
}

function privateBlueBubblesHost(host: string): boolean {
  if (host === "localhost" || host === "[::1]") return true;
  if (host.startsWith("[") && /^(?:\[(?:fc|fd)[0-9a-f]{2}:)/iu.test(host)) return isIP(host.slice(1, -1)) === 6;
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split(".").map(Number);
  return first === 10 || first === 127 || first === 192 && second === 168
    || first === 172 && second !== undefined && second >= 16 && second <= 31;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
