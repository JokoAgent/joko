import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, nativeTheme: {} }));
vi.mock("../src/remote-desktop-native-manifest.js", () => ({ verifyPackagedDesktopRemoteDesktopPrivacy: vi.fn() }));
import {
  DesktopRemoteDesktopLinuxPrivacyScreen, prepareDesktopRemoteDesktopLinuxPrivacy,
  supportsDesktopRemoteDesktopLinuxPrivacy, type DesktopRemoteDesktopLinuxPrivacyRuntime
} from "../src/remote-desktop-linux-privacy.js";

const commit = "a".repeat(40), source = "b".repeat(64);
const idleSignal = (): AbortSignal => new AbortController().signal;
function deferred<Value>() {
  let resolve!: (value: Value) => void, reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const state = { phase: "active", ready: `ready:${source}`, current: true, supported: true,
    session: "unlocked" as "unlocked" | "unsupported", version: { version: "0.56.2", commit, dirty: false },
    metadata: { version: "0.56.2", hash: commit, source } };
  const order: string[] = [];
  const native = {
    nativeRoute: vi.fn(() => state.supported), session: vi.fn(async () => state.session),
    version: vi.fn(async () => state.version),
    artifact: vi.fn(async () => ({ path: "/native/joko-hyprland-privacy.so", metadata: state.metadata })),
    call: vi.fn(async (request: Record<string, unknown>): Promise<string> => {
      const op = String(request["op"]); order.push(op);
      if (op === "probe") return state.ready;
      if (op === "retire") return "/old/joko-hyprland-privacy.so";
      if (op === "stop") return "off";
      if (op === "confirm") return "confirming";
      if (op === "resume") return "active";
      return state.phase;
    }),
    plugin: vi.fn(async (operation: "load" | "unload", _path: string) => { order.push(operation); state.ready = `ready:${source}`; }),
    labels: () => ["status", "hint", "title", "detail", "cancel", "disconnect"], dark: () => true
  } satisfies DesktopRemoteDesktopLinuxPrivacyRuntime;
  const resume = vi.fn(async () => { order.push("input-resume"); });
  const dependencies = {
    stopped: vi.fn(async (_owner: object) => { order.push("stopped"); state.current = false; }),
    suspendInput: vi.fn(async (_current: () => boolean, _signal: AbortSignal): Promise<() => Promise<void>> => {
      order.push("input-drained"); return resume;
    })
  };
  const screen = new DesktopRemoteDesktopLinuxPrivacyScreen(dependencies, native);
  const owner = {}, cancellation = new AbortController();
  const set = () => screen.set(owner, "hyprland:DP-1", () => state.current, cancellation.signal);
  return { state, order, native, resume, dependencies, screen, owner, cancellation, set };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Linux native privacy ownership", () => {
  it("requires the owned native route and matching clean fixed compositor metadata without loading a plugin", async () => {
    const value = fixture();
    await expect(supportsDesktopRemoteDesktopLinuxPrivacy(idleSignal(), value.native)).resolves.toBe(true);
    expect(value.native.call).not.toHaveBeenCalled(); expect(value.native.plugin).not.toHaveBeenCalled();
    for (const condition of ["route", "session", "version", "dirty", "commit", "source"] as const) {
      const next = fixture();
      if (condition === "route") next.state.supported = false;
      if (condition === "session") next.state.session = "unsupported";
      if (condition === "version") next.state.version.version = "0.56.3";
      if (condition === "dirty") next.state.version.dirty = true;
      if (condition === "commit") next.state.metadata.hash = "c".repeat(40);
      if (condition === "source") next.state.metadata.source = "unknown";
      await expect(supportsDesktopRemoteDesktopLinuxPrivacy(idleSignal(), next.native)).resolves.toBe(false);
      expect(next.native.plugin).not.toHaveBeenCalled();
    }
  });

  it("permits retirement/load only at the pre-lease prepare and fences current after retirement", async () => {
    const value = fixture(); value.state.ready = `ready:${"c".repeat(64)}`;
    await expect(prepareDesktopRemoteDesktopLinuxPrivacy(() => true, idleSignal(), false, value.native))
      .rejects.toThrow(/^REMOTE_DESKTOP_PRIVACY_UNAVAILABLE$/);
    expect(value.order).toEqual(["probe"]);
    value.order.length = 0;
    await prepareDesktopRemoteDesktopLinuxPrivacy(() => true, idleSignal(), true, value.native);
    expect(value.order).toEqual(["probe", "retire", "unload", "load", "probe"]);
    expect(value.native.plugin.mock.calls).toEqual([["unload", "/old/joko-hyprland-privacy.so"], ["load", "/native/joko-hyprland-privacy.so"]]);
    const retired = fixture(), call = retired.native.call.getMockImplementation()!;
    retired.state.ready = `ready:${"c".repeat(64)}`;
    retired.native.call.mockImplementation(async request => {
      const receipt = await call(request); if (request["op"] === "retire") retired.state.current = false; return receipt;
    });
    await expect(prepareDesktopRemoteDesktopLinuxPrivacy(() => retired.state.current, idleSignal(), true, retired.native))
      .rejects.toThrow(/^REMOTE_DESKTOP_PRIVACY_EXPIRED$/);
    expect(retired.native.plugin).not.toHaveBeenCalled();
  });

  it("waits for loading source readiness but rejects an unrelated retire path and an aborted prepare", async () => {
    const value = fixture(); value.state.ready = "unavailable";
    value.native.plugin.mockImplementation(async () => { value.state.ready = `loading:${source}`; });
    const prepared = prepareDesktopRemoteDesktopLinuxPrivacy(() => true, idleSignal(), true, value.native);
    await vi.advanceTimersByTimeAsync(0);
    expect(value.native.plugin).toHaveBeenCalledOnce();
    value.state.ready = `ready:${source}`; await vi.advanceTimersByTimeAsync(25); await prepared;
    const bad = fixture(); bad.state.ready = `ready:${"c".repeat(64)}`;
    const call = bad.native.call.getMockImplementation()!;
    bad.native.call.mockImplementation(request => request["op"] === "retire" ? Promise.resolve("/old/other.so") : call(request));
    await expect(prepareDesktopRemoteDesktopLinuxPrivacy(() => true, idleSignal(), true, bad.native)).rejects.toThrow("REMOTE_DESKTOP_PRIVACY_UNAVAILABLE");
    expect(bad.native.plugin).not.toHaveBeenCalled();
    const cancellation = new AbortController(); cancellation.abort(new Error("private cancellation reason"));
    await expect(prepareDesktopRemoteDesktopLinuxPrivacy(() => true, cancellation.signal, true, fixture().native))
      .rejects.toThrow(/^REMOTE_DESKTOP_PRIVACY_EXPIRED$/);
  });

  it("acknowledges only the first complete physical mask, carrying a captured theme and six native labels", async () => {
    const value = fixture(); value.state.phase = "starting";
    let settled = false;
    const setting = value.set().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    const request = value.native.call.mock.calls.find(([request]) => request["op"] === "start")![0];
    expect(request).toMatchObject({ op: "start", labels: value.native.labels(), dark: true });
    expect(request["token"]).toMatch(/^[a-f0-9]{32}$/u);
    await vi.advanceTimersByTimeAsync(25); expect(settled).toBe(false);
    value.state.phase = "active"; await vi.advanceTimersByTimeAsync(25); await setting;
    expect(value.screen.active).toBe(true);
    await value.screen.release(value.owner);
  });

  it("fails a stalled first mask after two seconds and obtains actual off cleanup", async () => {
    const value = fixture(); value.state.phase = "starting";
    const failure = expect(value.set()).rejects.toThrow(/^REMOTE_DESKTOP_PRIVACY_UNAVAILABLE$/);
    await vi.advanceTimersByTimeAsync(2_000); await failure;
    expect(value.screen.active).toBe(false); expect(value.order.at(-1)).toBe("stop");
    expect(value.dependencies.suspendInput).not.toHaveBeenCalled();
  });

  it("joins actual input drain before confirmation and current input resume before the native cancel receipt", async () => {
    const value = fixture(); await value.set(); value.order.length = 0;
    const drain = deferred<() => Promise<void>>();
    value.dependencies.suspendInput.mockImplementation(() => { value.order.push("input-pausing"); return drain.promise; });
    value.state.phase = "pending"; await vi.advanceTimersByTimeAsync(250);
    expect(value.order).toEqual(["ping", "input-pausing"]);
    drain.resolve(value.resume); await vi.advanceTimersByTimeAsync(0);
    expect(value.order).toEqual(["ping", "input-pausing", "confirm"]);
    value.state.phase = "resume"; await vi.advanceTimersByTimeAsync(250);
    expect(value.order.slice(-3)).toEqual(["ping", "input-resume", "resume"]);
    expect(value.resume).toHaveBeenCalledOnce();
    await value.screen.release(value.owner);
    expect(value.resume).toHaveBeenCalledOnce();
  });

  it.each(["disconnect", "unavailable"])("routes native %s through the captured owner stop and avoids resuming revoked input", async phase => {
    const value = fixture(); await value.set(); value.state.phase = "pending";
    await vi.advanceTimersByTimeAsync(250);
    value.state.phase = phase; await vi.advanceTimersByTimeAsync(250);
    expect(value.dependencies.stopped).toHaveBeenCalledExactlyOnceWith(value.owner);
    expect(value.resume).not.toHaveBeenCalled(); expect(value.screen.active).toBe(false);
    expect(value.order.slice(-2)).toEqual(["stopped", "stop"]);
  });

  it("awaits a late input drain through release without confirming a retired owner or resuming replacement input", async () => {
    const value = fixture(); await value.set();
    const drain = deferred<() => Promise<void>>(); value.dependencies.suspendInput.mockImplementation(() => drain.promise);
    value.state.phase = "pending"; await vi.advanceTimersByTimeAsync(250);
    const released = value.screen.release(value.owner);
    value.state.phase = "active";
    const next = {}, setting = value.screen.set(next, "hyprland:DP-1", () => true, idleSignal());
    await vi.advanceTimersByTimeAsync(0);
    expect(value.native.call.mock.calls.filter(([request]) => request["op"] === "start")).toHaveLength(1);
    drain.resolve(value.resume); await released; await setting;
    expect(value.resume).not.toHaveBeenCalled();
    expect(value.native.call.mock.calls.filter(([request]) => request["op"] === "confirm")).toHaveLength(0);
    await value.screen.release(value.owner); expect(value.screen.active).toBe(true);
    await value.screen.release(next);
  });

  it.each(["release", "abort"] as const)("re-clears a late native start after %s and joins cleanup before a replacement", async retirement => {
    const value = fixture(), start = deferred<string>(), call = value.native.call.getMockImplementation()!;
    let first = true;
    value.native.call.mockImplementation(request => {
      if (request["op"] === "start" && first) { first = false; value.order.push("start"); return start.promise; }
      return call(request);
    });
    const rejected = expect(value.set()).rejects.toThrow(/^REMOTE_DESKTOP_PRIVACY_EXPIRED$/);
    await vi.advanceTimersByTimeAsync(0);
    const oldToken = value.native.call.mock.calls.find(([request]) => request["op"] === "start")![0]["token"];
    if (retirement === "abort") value.cancellation.abort();
    const release = value.screen.release(value.owner);
    const next = {}, replacement = value.screen.set(next, "hyprland:DP-1", () => true, idleSignal());
    await vi.advanceTimersByTimeAsync(0);
    expect(value.native.call.mock.calls.filter(([request]) => request["op"] === "start")).toHaveLength(1);
    start.resolve("active"); await rejected; await release; await replacement;
    const calls = value.native.call.mock.calls.map(([request]) => request);
    expect(calls.filter(request => request["op"] === "stop" && request["token"] === oldToken)).toHaveLength(2);
    const nextToken = calls.filter(request => request["op"] === "start")[1]!["token"];
    await value.screen.release(value.owner);
    expect(value.screen.active).toBe(true);
    expect(value.native.call.mock.calls.filter(([request]) => request["op"] === "stop" && request["token"] === nextToken)).toHaveLength(0);
    await value.screen.release(next);
  });

  it("retains rejected native cleanup and blocks replacement until explicit exact-owner retry succeeds", async () => {
    const value = fixture(); await value.set();
    const call = value.native.call.getMockImplementation()!;
    let failStop = true;
    value.native.call.mockImplementation(request => request["op"] === "stop" && failStop ? Promise.resolve("unavailable") : call(request));
    await expect(value.screen.release(value.owner)).rejects.toThrow(/^REMOTE_DESKTOP_PRIVACY_UNAVAILABLE$/);
    const next = {};
    await expect(value.screen.set(next, "hyprland:DP-1", () => true, idleSignal())).rejects.toThrow(/^REMOTE_DESKTOP_PRIVACY_UNAVAILABLE$/);
    expect(value.native.call.mock.calls.filter(([request]) => request["op"] === "start")).toHaveLength(1);
    failStop = false; await value.screen.release(value.owner);
    await value.screen.set(next, "hyprland:DP-1", () => true, idleSignal());
    expect(value.screen.active).toBe(true);
    await value.screen.release(next);
  });
});
