import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteDesktopChannelClient, parseRemoteDesktopChannelRequest, parseRemoteDesktopChannelReply } from "@joko/contracts";

afterEach(() => vi.useRealTimers());
describe("remote desktop small control channel", () => {
  it("rejects adjacent operations and oversized messages before dispatch", () => {
    expect(parseRemoteDesktopChannelRequest({ type: "request", id: "one", request: { op: "stop", lease: "lease" } })).toBeUndefined();
    expect(parseRemoteDesktopChannelRequest({ type: "request", id: "one", request: { op: "control", lease: "lease", body: "x".repeat(33_000) } })).toBeUndefined();
    expect(parseRemoteDesktopChannelReply({ type: "reply", id: "one", ok: false, error: "untrusted detail" })).toBeUndefined();
  });
  it("distinguishes unsent requests from a lost reply and never sends a replacement", async () => {
    const client = new RemoteDesktopChannelClient();
    const send = vi.fn(async () => false);
    expect(await client.request({ op: "control", lease: "lease", enabled: true }, send)).toEqual({ available: false });
    expect(send).toHaveBeenCalledOnce();
    vi.useFakeTimers(); send.mockResolvedValue(true);
    const waiting = client.request({ op: "control", lease: "lease", enabled: true }, send);
    const rejected = expect(waiting).rejects.toThrow("REMOTE_DESKTOP_REQUEST_RESULT_UNKNOWN");
    await vi.advanceTimersByTimeAsync(8_000); await rejected; expect(send).toHaveBeenCalledTimes(2);
    client.receive({ type: "reply", id: "control-2", ok: true, result: { controlling: true } });
    client.retire(); expect(send).toHaveBeenCalledTimes(2);
  });
  it("matches one reply and immediately retires in-flight work when media is rebuilt", async () => {
    const client = new RemoteDesktopChannelClient(); let id = "";
    const first = client.request({ op: "displayModes", lease: "lease" }, message => { id = message.id; return true; });
    await Promise.resolve(); client.receive({ type: "reply", id, ok: true, result: { modes: [] } });
    expect(await first).toEqual({ available: true, result: { modes: [] } });
    const second = client.request({ op: "control", lease: "lease", enabled: false }, () => true);
    const rejected = expect(second).rejects.toThrow("REMOTE_DESKTOP_REQUEST_RESULT_UNKNOWN"); client.retire(); await rejected;
  });
});
