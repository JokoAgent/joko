import { create, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import { Code } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDesktopService, RemoteDesktopFailureReason } from "@joko/contracts";
import { ClipboardSyncError } from "@joko/remote-desktop-sync";
import type { DesktopRemoteDesktopViewerConnection } from "../src/remote-desktop-viewer-connection.js";
vi.mock("electron", () => ({ clipboard: {}, nativeImage: {}, app: {}, screen: {} }));
import { DesktopRemoteDesktopViewerClipboardSync, type DesktopViewerClipboardSyncScope } from "../src/remote-desktop-viewer-clipboard-sync.js";

const owners: DesktopRemoteDesktopViewerClipboardSync[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const owner of owners.splice(0)) owner.retire(); vi.useRealTimers(); });
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }
function fixture(opaque = false) {
  let localVersion = 1, remoteVersion = 1, syncGeneration = 0n, enabled = false;
  let localJson = '{"text":"local baseline"}', remoteJson = '{"text":"remote baseline"}';
  let pendingAck: Promise<void> | undefined, permission = false;
  let unknownNative = false, unknownRemote = false;
  const versionOf = (counter: number, json: string) => opaque ? createHash("sha256").update(json).digest("hex") : String(counter);
  const remoteWrite = vi.fn(), localWrite = vi.fn();
  const calls: { name: string; input: any }[] = [];
  const connection = { current: true, caps: { clipboardSync: true, clipboardInline: true },
    lease: { leaseId: "lease", controlling: true, controlGeneration: 2n },
    syncRequest: vi.fn(async (name: keyof typeof RemoteDesktopService.method, input: any, _lease: object, guard: () => void) => {
      guard(); calls.push({ name, input });
      if (permission && name === "getRemoteDesktopClipboardVersion") return { ok: false, code: Code.PermissionDenied, reason: RemoteDesktopFailureReason.UNSPECIFIED };
      let output: object;
      if (name === "setRemoteDesktopClipboardSync") { enabled = input.request.enabled; syncGeneration++; output = { result: { enabled, syncGeneration } }; }
      else if (name === "getRemoteDesktopClipboardVersion") { expect(enabled).toBe(true); expect(input.request.syncGeneration).toBe(syncGeneration); output = { result: { version: versionOf(remoteVersion, remoteJson) } }; }
      else {
        const transfer = input.transfer; expect(transfer.sync).toBe(true); expect(transfer.syncGeneration).toBe(syncGeneration);
        if (transfer.action.case === "copy") { expect(transfer.version).toBe(versionOf(remoteVersion, remoteJson)); output = { result: { data: remoteJson, length: remoteJson.length } }; }
        else if (transfer.action.case === "paste") {
          expect(transfer.version).toBe(versionOf(remoteVersion, remoteJson)); remoteWrite(transfer.action.value.data);
          remoteJson = transfer.action.value.data; remoteVersion++; const version = versionOf(remoteVersion, remoteJson);
          if (unknownRemote) { unknownRemote = false; return { ok: false, code: Code.Aborted, reason: RemoteDesktopFailureReason.CLIPBOARD_UNAVAILABLE }; }
          if (pendingAck) await pendingAck; output = { result: { version } };
        } else throw new Error("Unexpected synthetic operation.");
      }
      guard(); const method = RemoteDesktopService.method[name];
      return { ok: true, bytes: toBinary(method.output, create(method.output, output as never)) };
    })
  } as unknown as DesktopRemoteDesktopViewerConnection;
  let scope: DesktopViewerClipboardSyncScope = { connection, generation: 1, focusRevision: 0, desired: false, eligible: true };
  const stop = vi.fn();
  const owner = new DesktopRemoteDesktopViewerClipboardSync({ scope: () => scope, changed: vi.fn(), clipboard: {
    available: true, platform: opaque ? "linux" : "win32", stop, version: async () => versionOf(localVersion, localJson),
    read: async () => localJson,
    write: async (json, version, current) => {
      if (!current()) throw new ClipboardSyncError("expired"); expect(version).toBe(versionOf(localVersion, localJson));
      localWrite(json); localJson = json; localVersion++;
      if (unknownNative) { unknownNative = false; throw Object.assign(new Error("REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN"), { outcomeUnknown: true }); }
      return versionOf(localVersion, localJson);
    }
  } }); owners.push(owner);
  return { owner, connection, calls, stop, remoteWrite, localWrite,
    update: (patch: Partial<DesktopViewerClipboardSyncScope>) => { scope = { ...scope, ...patch }; owner.refresh(); },
    local: (text: string) => { localJson = JSON.stringify({ text }); localVersion++; },
    remote: (text: string) => { remoteJson = JSON.stringify({ text }); remoteVersion++; },
    deferAck: (promise?: Promise<void>) => { pendingAck = promise; }, permission: (value: boolean) => { permission = value; },
    unknown: (side: "local" | "remote") => { if (side === "local") unknownNative = true; else unknownRemote = true; },
    localJson: () => localJson, remoteJson: () => remoteJson };
}

describe("Desktop viewer Main clipboard sync owner", () => {
  it("retains the same target baseline across a paused lease replacement and propagates the changed side on reconnect", async () => {
    const f = fixture(); f.update({ desired: true }); await flush();
    f.update({ eligible: false, focusRevision: 1 }); await flush(); f.remote("remote changed while disconnected");
    Object.assign(f.connection.lease!, { leaseId: "replacement-lease" });
    f.update({ eligible: true, generation: 2 }); await flush(); await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.localWrite).toHaveBeenCalledTimes(1); expect(f.localJson()).toBe(f.remoteJson());
    expect(f.remoteWrite).not.toHaveBeenCalled();
  });

  it.each([false, true])("starts only after opt-in and syncs both directions without echo (opaque=%s)", async (opaque) => {
    const f = fixture(opaque); f.owner.refresh(); await flush(); expect(f.calls).toHaveLength(0);
    f.update({ desired: true }); await flush();
    expect(f.owner.snapshot).toMatchObject({ active: true, pending: false }); expect(f.remoteWrite).not.toHaveBeenCalled(); expect(f.localWrite).not.toHaveBeenCalled();
    f.local("new local item"); await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.remoteJson()).toBe(f.localJson()); expect(f.remoteWrite).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500); expect(f.localWrite).not.toHaveBeenCalled();
    f.remote("new remote item"); await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.localJson()).toBe(f.remoteJson()); expect(f.localWrite).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500); expect(f.remoteWrite).toHaveBeenCalledTimes(1);
    f.update({ desired: false }); await flush(); expect(f.owner.snapshot.active).toBe(false);
    expect(f.calls.at(-1)?.input.request.enabled).toBe(false);
  });

  it.each(["local", "remote"] as const)("requires explicit Retry after a typed %s unknown write and does not replay it", async side => {
    const f = fixture(true); f.update({ desired: true }); await flush();
    f.unknown(side);
    if (side === "local") f.remote("remote unknown effect"); else f.local("local unknown effect");
    await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.owner.snapshot).toMatchObject({ active: false, pending: false, notice: "unknown" });
    const count = f.calls.length;
    await vi.advanceTimersByTimeAsync(60_000); await flush(); expect(f.calls).toHaveLength(count);
    expect(f.localWrite.mock.calls.length + f.remoteWrite.mock.calls.length).toBe(1);
    f.owner.retry(); await flush(); expect(f.owner.snapshot).toMatchObject({ active: true, notice: undefined });
    await vi.advanceTimersByTimeAsync(3000); await flush();
    expect(f.localWrite.mock.calls.length + f.remoteWrite.mock.calls.length).toBe(1);
  });

  it("preserves focus-pause baseline, retains both sides on conflict and requires explicit retry for permission", async () => {
    const f = fixture(); f.update({ desired: true }); await flush();
    f.update({ eligible: false, focusRevision: 1 }); await flush(); f.local("local changed while paused");
    f.update({ eligible: true }); await flush(); await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.remoteWrite).toHaveBeenCalledTimes(1);
    f.local("local conflict"); f.remote("remote conflict"); await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.owner.snapshot.notice).toBe("conflict"); expect(f.localJson()).not.toBe(f.remoteJson());
    expect(f.remoteWrite).toHaveBeenCalledTimes(1); expect(f.localWrite).not.toHaveBeenCalled();
    f.permission(true); await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.owner.snapshot).toMatchObject({ active: false, notice: "permission" });
    const calls = f.calls.length; await vi.advanceTimersByTimeAsync(30000); expect(f.calls).toHaveLength(calls);
    f.permission(false); f.owner.retry(); await flush(); expect(f.owner.snapshot).toMatchObject({ active: true, notice: undefined });
  });

  it("keeps an unknown effect in the same owner's slot through focus retirement and ignores its late acknowledgement", async () => {
    const f = fixture(); f.update({ desired: true }); await flush();
    let acknowledge!: () => void; f.deferAck(new Promise<void>((resolve) => { acknowledge = resolve; }));
    f.local("effect already dispatched"); await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.remoteWrite).toHaveBeenCalledTimes(1); expect(f.owner.snapshot.pending).toBe(true);
    f.update({ eligible: false, focusRevision: 1 }); await flush(); expect(f.owner.snapshot.active).toBe(false);
    f.update({ eligible: true }); await vi.advanceTimersByTimeAsync(6000); await flush();
    expect(f.calls.filter((call) => call.name === "setRemoteDesktopClipboardSync" && call.input.request.enabled)).toHaveLength(1);
    expect(f.remoteWrite).toHaveBeenCalledTimes(1); expect(f.owner.snapshot.pending).toBe(true);
    f.deferAck(); acknowledge(); await flush(); await vi.advanceTimersByTimeAsync(1500); await flush();
    expect(f.calls.filter((call) => call.name === "setRemoteDesktopClipboardSync" && call.input.request.enabled)).toHaveLength(2);
    expect(f.remoteWrite).toHaveBeenCalledTimes(1);
  });
});
