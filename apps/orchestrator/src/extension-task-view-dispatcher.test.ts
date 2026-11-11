import { expect, it, vi } from "vitest";
import { ExtensionTaskViewDispatcher, type ExtensionTaskViewOpen } from "./extension-task-view-dispatcher.js";

function fixture() {
  let installed = "original", now = 10_000;
  const taskAvailable = vi.fn((_extension: string, session: string) => ["task-a", "task-b"].includes(session));
  const dispatcher = new ExtensionTaskViewDispatcher({ authority: id => id === "plugin" ? { installationKey: installed, revision: 1n } : undefined, taskAvailable, now: () => now });
  return { dispatcher, taskAvailable, replace: () => { installed = "replacement"; }, expire: () => { now += 3_001; } };
}

it("keeps task pages separate, supports a side-effect-free peek and requires a receiving UI", () => {
  const f = fixture(), send = vi.fn((_event: ExtensionTaskViewOpen) => true);
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-a" })).toMatchObject({ ok: false, errorCode: "HOST_NOT_READY" });
  const stop = f.dispatcher.register({ connectionId: "original-ui", focusedSessionId: "task-a", assertCurrent: () => {}, send });
  expect(f.dispatcher.request("plugin", "original", { peek: true })).toEqual({ ok: true, sessionId: "task-a" });
  expect(send).not.toHaveBeenCalled();
  expect(f.dispatcher.request("plugin", "original", undefined)).toEqual({ ok: true, sessionId: "task-a" });
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-b" })).toEqual({ ok: true, sessionId: "task-b" });
  expect(send.mock.calls.map(([event]) => event.sessionId)).toEqual(["task-a", "task-b"]);
  expect(send.mock.calls[0]![0].requestId).not.toBe(send.mock.calls[1]![0].requestId);
  stop();
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-b", peek: true })).toEqual({ ok: true, sessionId: "task-b" });
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-b" })).toMatchObject({ ok: false, errorCode: "HOST_NOT_READY" });
});

it("requires an explicit target when clients have different foreground tasks", () => {
  const f = fixture();
  for (const session of ["task-a", "task-b"]) f.dispatcher.register({ connectionId: session, focusedSessionId: session, assertCurrent: () => {}, send: () => true });
  expect(f.dispatcher.request("plugin", "original", { peek: true })).toMatchObject({ ok: false, errorCode: "HOST_NOT_READY" });
  expect(f.dispatcher.request("plugin", "original", { peek: true }, { sourceSessionId: "task-b" })).toMatchObject({ ok: false, errorCode: "HOST_NOT_READY" });
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-b", peek: true })).toEqual({ ok: true, sessionId: "task-b" });
});

it("focuses only the original connection with one current host-observed gesture", () => {
  const f = fixture(), original = vi.fn(() => true), other = vi.fn(() => true);
  f.dispatcher.register({ connectionId: "original", focusedSessionId: "task-a", assertCurrent: () => {}, send: original });
  f.dispatcher.register({ connectionId: "other", focusedSessionId: "task-b", assertCurrent: () => {}, send: other });
  let consumed = false;
  const gesture = { connectionId: "original", observedAt: 10_000, assertCurrent: () => {}, consume: () => { if (consumed) return false; consumed = true; return true; } };
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-b", focus: true })).toMatchObject({ ok: false, errorCode: "PERMISSION_DENIED" });
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-b", focus: true }, { gesture })).toEqual({ ok: true, sessionId: "task-b", focusRequested: true });
  expect(original).toHaveBeenCalledTimes(1); expect(other).not.toHaveBeenCalled();
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-a", focus: true }, { gesture })).toMatchObject({ ok: false, errorCode: "PERMISSION_DENIED" });
});

it("retires replaced installations and expired gestures, denies foreign tasks and closed payloads", () => {
  const f = fixture(), send = vi.fn(() => true), consume = vi.fn(() => true);
  f.dispatcher.register({ connectionId: "ui", assertCurrent: () => {}, send });
  for (const payload of [[], null, { focus: "yes" }, { peek: false }, { sessionId: "bad\ntask" }, { sessionId: "task-a", url: "https://example.com" }]) {
    expect(f.dispatcher.request("plugin", "original", payload)).toMatchObject({ ok: false, errorCode: "INVALID_REQUEST" });
  }
  expect(f.dispatcher.request("plugin", "original", { sessionId: "foreign" })).toMatchObject({ ok: false, errorCode: "PERMISSION_DENIED" });
  f.expire();
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-a", focus: true }, { gesture: {
    connectionId: "ui", observedAt: 10_000, assertCurrent: () => {}, consume
  } })).toMatchObject({ ok: false, errorCode: "PERMISSION_DENIED" });
  expect(consume).not.toHaveBeenCalled();
  f.replace();
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-a" })).toMatchObject({ ok: false, errorCode: "PERMISSION_DENIED" });
  expect(send).not.toHaveBeenCalled();
});

it("does not acknowledge delivery through retired, failed or non-receiving viewers", () => {
  const f = fixture(); let current = true;
  f.dispatcher.register({ connectionId: "retired", focusedSessionId: "task-a", assertCurrent: () => { if (!current) throw new Error("retired"); }, send: () => true });
  current = false;
  f.dispatcher.register({ connectionId: "failed", assertCurrent: () => {}, send: () => { throw new Error("closed"); } });
  f.dispatcher.register({ connectionId: "not-receiving", assertCurrent: () => {}, send: () => false });
  expect(f.dispatcher.request("plugin", "original", { sessionId: "task-a" })).toMatchObject({ ok: false, errorCode: "HOST_NOT_READY" });
});
