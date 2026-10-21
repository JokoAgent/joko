export const REMOTE_DESKTOP_CHANNEL_MAX_BYTES = 32_768;
export const REMOTE_DESKTOP_CHANNEL_TIMEOUT_MS = 8_000;
export const REMOTE_DESKTOP_CHANNEL_OPS: ReadonlySet<string> = new Set([
  "control", "presentation", "hostMute", "privacyScreen", "systemAction", "displayModes", "clipboardSync", "clipboardVersion"
]);

export interface RemoteDesktopChannelRequest {
  readonly type: "request";
  readonly id: string;
  readonly request: Readonly<Record<string, unknown>> & { readonly op: string; readonly lease: string };
}
export type RemoteDesktopChannelReply =
  | { readonly type: "reply"; readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly type: "reply"; readonly id: string; readonly ok: false; readonly error: string };

export function isRemoteDesktopChannelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

export function parseRemoteDesktopChannelRequest(value: unknown): RemoteDesktopChannelRequest | undefined {
  if (!record(value) || value.type !== "request" || !isRemoteDesktopChannelId(value.id)
    || Object.keys(value).some(key => !["type", "id", "request"].includes(key)) || !record(value.request)
    || typeof value.request.op !== "string" || !REMOTE_DESKTOP_CHANNEL_OPS.has(value.request.op)
    || typeof value.request.lease !== "string" || value.request.lease.length < 1 || value.request.lease.length > 256
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > REMOTE_DESKTOP_CHANNEL_MAX_BYTES) return undefined;
  return { type: "request", id: value.id, request: value.request as RemoteDesktopChannelRequest["request"] };
}

export function parseRemoteDesktopChannelReply(value: unknown): RemoteDesktopChannelReply | undefined {
  if (!record(value) || value.type !== "reply" || !isRemoteDesktopChannelId(value.id)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > REMOTE_DESKTOP_CHANNEL_MAX_BYTES) return undefined;
  if (value.ok === true && Object.keys(value).every(key => ["type", "id", "ok", "result"].includes(key))) {
    return { type: "reply", id: value.id, ok: true, result: value.result };
  }
  if (value.ok === false && typeof value.error === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value.error)
    && Object.keys(value).every(key => ["type", "id", "ok", "error"].includes(key))) return { type: "reply", id: value.id, ok: false, error: value.error };
  return undefined;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

type ChannelResult = { readonly available: false } | { readonly available: true; readonly result: unknown };
export class RemoteDesktopChannelClient {
  #next = 0;
  #pending = new Map<string, { readonly resolve: (result: ChannelResult) => void; readonly reject: (error: Error) => void;
    readonly timeout: ReturnType<typeof setTimeout> }>();

  async request(request: RemoteDesktopChannelRequest["request"], send: (message: RemoteDesktopChannelRequest) => Promise<boolean | void> | boolean | void): Promise<ChannelResult> {
    if (this.#pending.size >= 8) return { available: false };
    const message: RemoteDesktopChannelRequest = { type: "request", id: `control-${++this.#next}`, request };
    if (!parseRemoteDesktopChannelRequest(message)) return { available: false };
    const result = new Promise<ChannelResult>((resolve, reject) => {
      const timeout = setTimeout(() => this.#fail(message.id), REMOTE_DESKTOP_CHANNEL_TIMEOUT_MS);
      this.#pending.set(message.id, { resolve, reject, timeout });
    });
    void Promise.resolve().then(() => send(message)).then(sent => { if (sent === false) this.unavailable(message.id); }, () => this.#fail(message.id));
    return result;
  }

  receive(raw: unknown): void {
    const reply = parseRemoteDesktopChannelReply(raw); if (!reply) return;
    const pending = this.#pending.get(reply.id); if (!pending) return;
    clearTimeout(pending.timeout); this.#pending.delete(reply.id);
    if (reply.ok) pending.resolve({ available: true, result: reply.result });
    else pending.reject(new Error(reply.error));
  }

  unavailable(id: string): void {
    const pending = this.#pending.get(id); if (!pending) return;
    clearTimeout(pending.timeout); this.#pending.delete(id); pending.resolve({ available: false });
  }

  retire(): void { for (const id of this.#pending.keys()) this.#fail(id); }
  #fail(id: string): void {
    const pending = this.#pending.get(id); if (!pending) return;
    clearTimeout(pending.timeout); this.#pending.delete(id);
    pending.reject(new Error("REMOTE_DESKTOP_REQUEST_RESULT_UNKNOWN"));
  }
}
