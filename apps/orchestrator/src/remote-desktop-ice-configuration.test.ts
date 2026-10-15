import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfiguredRemoteDesktopIceConfiguration } from "./remote-desktop-ice-configuration.js";

const now = Date.parse("2026-10-15T00:00:00Z");
const configuration = { url: "https://relay.example.test/ice-servers", tokenPath: "/private/ice-token" };
const input = () => ({ controllerDeviceId: "controller", targetDeviceId: "target", leaseId: "lease",
  signal: new AbortController().signal });
const valid = () => ({ iceServers: [{ urls: ["turn:relay.example.test:3478?transport=udp",
  "turn:relay.example.test:3478?transport=tcp", "turns:relay.example.test:5349?transport=tcp"],
  username: "temporary-user", credential: "temporary-password" }], expiresAt: new Date(now + 600_000).toISOString() });
afterEach(() => vi.useRealTimers());

describe("private remote desktop ICE configuration", () => {
  it("fetches fresh authenticated material per request and preserves the supplied expiration", async () => {
    const readToken = vi.fn().mockResolvedValueOnce("token-one").mockResolvedValueOnce("token-two");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(valid()));
    const provider = new ConfiguredRemoteDesktopIceConfiguration({ configuration, fetch: fetcher, readToken, now: () => now });
    const first = await provider.getConfiguration(input());
    const second = await provider.getConfiguration(input());
    expect(first).toMatchObject([{ username: "temporary-user", credential: "temporary-password",
      expiresAt: { seconds: BigInt((now + 600_000) / 1000) } }]);
    expect(second).toEqual(first);
    expect(readToken).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(call => call[1]?.headers)).toEqual(["token-one", "token-two"].map(token => ({
      authorization: `Bearer ${token}`, accept: "application/json", "cache-control": "no-store"
    })));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
  });

  it.each(["expired", "permanent", "malformed", "oversized", "http failure", "token failure"])(
    "falls back to public STUN without returning sensitive failures: %s", async failure => {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        if (failure === "http failure") return new Response("private upstream error", { status: 403 });
        if (failure === "oversized") return new Response("x".repeat(16_385));
        const body = valid();
        if (failure === "expired") body.expiresAt = new Date(now + 120_000).toISOString();
        if (failure === "permanent") body.expiresAt = new Date(now + 86_400_001).toISOString();
        if (failure === "malformed") body.iceServers[0]!.urls = ["https://private.example.test/token"];
        return Response.json(body);
      });
      const provider = new ConfiguredRemoteDesktopIceConfiguration({ configuration, fetch: fetcher, now: () => now,
        readToken: async () => { if (failure === "token failure") throw new Error("private-token-path"); return "token"; } });
      const result = await provider.getConfiguration(input());
      expect(result).toMatchObject([{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }]);
      expect(result[0]?.credential).toBeUndefined();
    });

  it("bounds stalled token reads and never sends a late token after cancellation", async () => {
    vi.useFakeTimers();
    let resolveToken!: (value: string) => void;
    const fetcher = vi.fn<typeof fetch>();
    const provider = new ConfiguredRemoteDesktopIceConfiguration({ configuration, fetch: fetcher, now: () => now,
      readToken: () => new Promise(resolve => { resolveToken = resolve; }) });
    const pending = provider.getConfiguration(input());
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending)[0]?.credential).toBeUndefined();
    resolveToken("late-private-token");
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    const abort = new AbortController();
    const cancelled = provider.getConfiguration({ ...input(), signal: abort.signal });
    const rejected = expect(cancelled).rejects.toThrow();
    abort.abort();
    await rejected;
  });
});
