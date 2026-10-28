import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DesktopRemoteDesktopInput } from "../src/remote-desktop-input.js";
vi.mock("electron", () => ({ app: { isPackaged: false }, screen: {}, nativeImage: {} }));
import { DesktopRemoteDesktopWindowsHost, parseDesktopRemoteDesktopWindowsDiagnostic, prepareDevelopmentWindowsAddon, type DesktopRemoteDesktopWindowsConnection,
  type DesktopRemoteDesktopWindowsRuntime } from "../src/remote-desktop-windows-host.js";
import { DesktopRemoteDesktopWindowsInput } from "../src/remote-desktop-windows-input.js";
import { DesktopRemoteDesktopWindowsCapture, decodeDesktopRemoteDesktopWindowsFrame } from "../src/remote-desktop-windows-capture.js";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const connection = (): DesktopRemoteDesktopWindowsConnection => ({ ready: true, request: vi.fn(async () => "ok\n"), close: vi.fn(async () => undefined) });
function runtime(overrides: Partial<DesktopRemoteDesktopWindowsRuntime> = {}): DesktopRemoteDesktopWindowsRuntime {
  return { platform: "win32", packaged: true, resolve: vi.fn(async () => ({ service: "protected-host.exe", addon: "protected-host.node" })),
    execute: vi.fn(async () => "ready\n"), open: vi.fn(async () => connection()), ...overrides };
}
function fallback() { return { start: vi.fn(async () => undefined), stop: vi.fn(), release: vi.fn(async () => undefined),
  retire: vi.fn(async () => undefined), send: vi.fn(), pauseForPrivacy: vi.fn(), resumeAfterPrivacy: vi.fn() } as unknown as DesktopRemoteDesktopInput; }

describe("Windows authorized service boundary", () => {
  it("uses explicit development setup only for the fixed source-mode runtime", async () => {
    const native = runtime({ packaged: false }); const host = new DesktopRemoteDesktopWindowsHost(native);
    expect(await host.readSupport()).toBe("ready");
    await host.configure(true);
    expect(native.execute).toHaveBeenCalledWith("protected-host.exe", ["--elevate-install", String(process.pid), "--development"], 130_000);
    await host.configure(false);
    expect(native.execute).toHaveBeenCalledWith("protected-host.exe", ["--elevate-uninstall"], 130_000);
  });
  it("keeps only bounded typed setup diagnostics through failure and clears them after confirmed setup", async () => {
    const execute = vi.fn(async () => "missing\n");
    execute.mockRejectedValueOnce(Object.assign(new Error("C:\\private\\source"), { stdout: "error elevate-child/stage-write 5\n" }));
    const native = runtime({ execute }); const host = new DesktopRemoteDesktopWindowsHost(native);
    await expect(host.configure(true)).rejects.toThrow("REMOTE_DESKTOP_SYSTEM_SERVICE_UNAVAILABLE");
    expect(host.diagnostic).toEqual({ step: "elevate-child", childStep: "stage-write", osError: 5 });
    expect(await host.readSupport()).toBe("missing");
    expect(host.diagnostic?.step).toBe("elevate-child");
    execute.mockResolvedValue("ready\n"); await host.configure(true);
    expect(host.diagnostic).toBeUndefined();
    expect(parseDesktopRemoteDesktopWindowsDiagnostic("installRequired protected-reparse 0")).toEqual({ step: "protected-reparse", osError: 0 });
    for (const invalid of ["error C:\\private 5", "error credential-account 5", "error stage-read -1", "error stage-read 5\nC:\\private"]) {
      expect(parseDesktopRemoteDesktopWindowsDiagnostic(invalid)).toBeUndefined();
    }
  });
  it("keeps loaded source addons immutable across rebuilds and refuses altered cached bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-windows-addon-"));
    try {
      const source = join(directory, "source.node"), cache = join(directory, "cache");
      await writeFile(source, "first native build");
      const first = await prepareDevelopmentWindowsAddon(source, cache);
      await writeFile(source, "second native build");
      const second = await prepareDevelopmentWindowsAddon(source, cache);
      expect(second).not.toBe(first); expect(await readFile(first, "utf8")).toBe("first native build");
      expect(await prepareDevelopmentWindowsAddon(source, cache)).toBe(second);
      await writeFile(second, "unexpected replacement");
      await expect(prepareDevelopmentWindowsAddon(source, cache)).rejects.toThrow("REMOTE_DESKTOP_SYSTEM_SERVICE_UNAVAILABLE");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("requires an authenticated Main probe and actual release, retaining failed close for retry", async () => {
    const probe = connection(); vi.mocked(probe.close).mockRejectedValueOnce(new Error("private OS detail"));
    const native = runtime({ open: vi.fn(async () => probe) }); const host = new DesktopRemoteDesktopWindowsHost(native);
    expect(await host.readSupport()).toBe("missing");
    expect(await host.readSupport()).toBe("ready");
    expect(probe.close).toHaveBeenCalledTimes(3);
    await host.configure(true);
    expect(native.execute).toHaveBeenCalledWith("protected-host.exe", ["--elevate-install", String(process.pid)], 130_000);
    await host.configure(false);
    expect(native.execute).toHaveBeenCalledWith("protected-host.exe", ["--elevate-uninstall"], 130_000);
  });
  it("cancellation after a late native open joins worker close and exposes only finite errors", async () => {
    const opening = deferred<DesktopRemoteDesktopWindowsConnection>(); const closed = deferred<void>();
    const native = runtime({ open: vi.fn(() => opening.promise) }); const host = new DesktopRemoteDesktopWindowsHost(native);
    const abort = new AbortController(); const pending = host.open({ mode: "input" }, abort.signal);
    const rejected = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce()); abort.abort(new Error("cancelled"));
    const worker = connection(); vi.mocked(worker.close).mockImplementation(() => closed.promise); opening.resolve(worker);
    await vi.waitFor(() => expect(worker.close).toHaveBeenCalledOnce());
    let done = false; void pending.catch(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    closed.resolve(); await rejected;
    const live = await host.open({ mode: "input" });
    await expect(live.request("injected\nline")).rejects.toThrow("REMOTE_DESKTOP_SYSTEM_SERVICE_UNAVAILABLE");
    await live.close();
  });
  it("retains an unconfirmed native handshake until its worker can actually close", async () => {
    const unknown: DesktopRemoteDesktopWindowsConnection = { ...connection(), ready: false };
    vi.mocked(unknown.close).mockRejectedValueOnce(new Error("close unknown"));
    const next = connection(); const native = runtime({ open: vi.fn().mockResolvedValueOnce(unknown).mockResolvedValueOnce(next) });
    const host = new DesktopRemoteDesktopWindowsHost(native);
    await expect(host.open({ mode: "input" })).rejects.toThrow("REMOTE_DESKTOP_SYSTEM_SERVICE_UNAVAILABLE");
    const live = await host.open({ mode: "input" });
    expect(unknown.close).toHaveBeenCalledTimes(2); expect(native.open).toHaveBeenCalledTimes(2);
    await live.close();
  });
});

describe("Windows input and capture worker ownership", () => {
  it("does not let a late input worker outlive explicit release", async () => {
    const opening = deferred<DesktopRemoteDesktopWindowsConnection>(); const closed = deferred<void>(); const worker = connection();
    vi.mocked(worker.close).mockImplementation(() => closed.promise);
    const open = vi.fn(() => opening.promise);
    const port = new DesktopRemoteDesktopWindowsInput(vi.fn(), fallback(), { supported: async () => true,
      open, project: (_id, x, y) => ({ x, y }) });
    const start = port.start("1", new AbortController().signal); const rejection = expect(start).rejects.toThrow("REMOTE_DESKTOP_LEASE_EXPIRED");
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const release = port.release(); let released = false; void release.then(() => { released = true; });
    opening.resolve(worker); await vi.waitFor(() => expect(worker.close).toHaveBeenCalled()); expect(released).toBe(false);
    closed.resolve(); await Promise.all([rejection, release]); expect(released).toBe(true);
  });
  it("projects physical coordinates, acknowledges bounded FIFO batches, and discards queued input on stop", async () => {
    const worker = connection(); const first = deferred<string>(); vi.mocked(worker.request).mockImplementationOnce(() => first.promise);
    const failed = vi.fn(); const ordinary = fallback();
    const port = new DesktopRemoteDesktopWindowsInput(failed, ordinary, { supported: async () => true, open: async () => worker,
      project: (_id, x, y) => ({ x: 100 + x * 100, y: 200 + y * 100 }) });
    await port.start("1", new AbortController().signal);
    port.send([{ kind: "move", x: 0.5, y: 0.25 }]); port.send([{ kind: "key", code: "KeyA", down: true }]);
    await vi.waitFor(() => expect(worker.request).toHaveBeenCalledOnce());
    expect(worker.request).toHaveBeenCalledWith('[{"kind":"move","x":150,"y":225}]');
    port.stop(); first.resolve("ok\n"); await port.release();
    expect(worker.request).toHaveBeenCalledOnce(); expect(ordinary.send).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
  });
  it("joins old capture worker before replacement and rejects stale pixels", async () => {
    const worker = connection(); const read = deferred<string>(); const closed = deferred<void>();
    vi.mocked(worker.request).mockImplementation(() => read.promise); vi.mocked(worker.close).mockImplementation(() => closed.promise);
    const open = vi.fn(async () => worker); const capture = new DesktopRemoteDesktopWindowsCapture({
      display: () => ({ rect: [0, 0, 100, 100], scale: 1 }), open, encodeCursor: () => Buffer.alloc(33) });
    const frame = capture.frame("1", true, true);
    await vi.waitFor(() => expect(worker.request).toHaveBeenCalledWith("f")); capture.stop();
    const next = capture.frame("2", true, true); await Promise.resolve(); expect(open).toHaveBeenCalledOnce();
    read.resolve(JSON.stringify({ jpeg: Buffer.from([255,216,255,217]).toString("base64"), width: 100, height: 100, cursor: null }) + "\n");
    expect(await frame).toBeNull(); closed.resolve(); await next; await capture.release();
    expect(open).toHaveBeenCalledTimes(2);
  });
  it("requires current frame JSON while dropping malformed cursor independently", () => {
    const jpeg = Buffer.from([255,216,255,217]).toString("base64");
    expect(() => decodeDesktopRemoteDesktopWindowsFrame(jpeg + "\n", true, 1, () => Buffer.alloc(33))).toThrow();
    const frame = decodeDesktopRemoteDesktopWindowsFrame(JSON.stringify({ jpeg, width: 100, height: 100,
      cursor: { visible: true, x: 0.5, y: 0.5, width: 1, height: 1, hotX: 0, hotY: 0, bgra: "bad" } }) + "\n", true, 1, () => Buffer.alloc(33));
    expect(frame).toMatchObject({ jpeg, cursor: null });
  });
});
