import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, nativeImage: {} }));
import {
  DesktopRemoteDesktopLinuxCapture, desktopRemoteDesktopLinuxJpegSize,
  type DesktopRemoteDesktopLinuxCaptureRuntime
} from "../src/remote-desktop-linux-capture.js";
import { DesktopRemoteDesktopNativeCapture } from "../src/remote-desktop-native-capture.js";

function child() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const stdio: [PassThrough, PassThrough, PassThrough] = [stdin, stdout, stderr];
  return { stdin, stdout, process: Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio, kill: vi.fn(() => true) }) };
}
function jpeg(width = 100, height = 80) {
  const bytes = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 255, 217]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); return bytes;
}
function runtime(native = child()): DesktopRemoteDesktopLinuxCaptureRuntime {
  return {
    supported: () => true, session: vi.fn(async () => "unlocked" as const),
    monitor: vi.fn(async () => ({ name: "DP-1", width: 100, height: 80, x: 0, y: 0, scale: 2, transform: 0 })),
    resolveBinary: vi.fn(async () => "/trusted/capture"), spawn: vi.fn(() => native.process),
    grim: vi.fn(async () => jpeg()), image: (bytes) => ({ jpeg: bytes, width: desktopRemoteDesktopLinuxJpegSize(bytes)!.width, height: desktopRemoteDesktopLinuxJpegSize(bytes)!.height })
  };
}
describe("Linux native and fallback capture ownership", () => {
  it("uses a selected actual output and decoded JPEG geometry through the existing native seam", async () => {
    const native = child(), deps = runtime(native); const linux = new DesktopRemoteDesktopLinuxCapture(deps);
    const capture = new DesktopRemoteDesktopNativeCapture({ platform: "linux", resolveBinary: deps.resolveBinary, spawn: deps.spawn, linuxCapture: linux });
    const pending = capture.frame("hyprland:DP-1", true, false);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledOnce());
    expect(deps.spawn).toHaveBeenCalledWith("/trusted/capture", ["video", "2", "80", "DP-1"]);
    expect(native.stdin.read()?.toString()).toBe("f");
    native.stdout.write(`${jpeg().toString("base64")}\n`);
    await expect(pending).resolves.toEqual({ jpeg: jpeg().toString("base64"), width: 100, height: 80, cursor: null });
    expect(deps.grim).not.toHaveBeenCalled(); capture.stop(); native.process.emit("close", 0, null);
  });
  it("keeps ordinary locked owned native viewing but never dispatches unknown/prelogin pixels", async () => {
    const native = child(), deps = runtime(native); vi.mocked(deps.session).mockResolvedValue("locked-logged-in");
    const capture = new DesktopRemoteDesktopLinuxCapture(deps); const pending = capture.frame("hyprland:DP-1", true, true);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledOnce());
    native.stdout.write(`${JSON.stringify({ jpeg: jpeg().toString("base64"), cursor: null })}\n`);
    await expect(pending).resolves.toMatchObject({ cursor: null });
    capture.stop(); native.process.emit("close", 0, null);
    vi.mocked(deps.session).mockResolvedValue("unknown");
    await expect(capture.frame("hyprland:DP-1", true, true)).resolves.toBeNull();
    expect(deps.spawn).toHaveBeenCalledOnce();
  });
  it("adopts only a bounded real cursor-free frame and clears the overlay on the next baked frame", async () => {
    const native = child(), deps = runtime(native), capture = new DesktopRemoteDesktopLinuxCapture(deps);
    const png = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12, "ascii"); png.writeUInt32BE(32, 16); png.writeUInt32BE(48, 20);
    const cursor = { visible: true, x: 0.5, y: 0.25, width: 16, height: 24, hotX: 2, hotY: 4, png: png.toString("base64") };
    const first = capture.frame("hyprland:DP-1", true, true); await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledOnce());
    native.stdin.read(); native.stdout.write(`${JSON.stringify({ jpeg: jpeg().toString("base64"), cursor })}\n`);
    await expect(first).resolves.toMatchObject({ cursor });
    const next = capture.frame("hyprland:DP-1", true, true); await vi.waitFor(() => expect(native.stdin.read()?.toString()).toBe("f"));
    native.stdout.write(`${JSON.stringify({ jpeg: jpeg().toString("base64"), cursor: null })}\n`);
    await expect(next).resolves.toMatchObject({ cursor: null }); expect(deps.grim).not.toHaveBeenCalled();
    capture.stop(); native.process.emit("close", 0, null);
  });
  it("does not fall back or replace after a failed stream until its actual close", async () => {
    const native = child(), deps = runtime(native); const capture = new DesktopRemoteDesktopLinuxCapture(deps);
    let settled = false; const pending = capture.frame("hyprland:DP-1", true, true).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledOnce());
    native.stdout.write("invalid\n");
    await vi.waitFor(() => expect(native.process.kill).toHaveBeenCalledOnce());
    expect(deps.grim).not.toHaveBeenCalled(); expect(settled).toBe(false);
    await expect(capture.frame("hyprland:DP-1", true, true)).resolves.toBeNull();
    native.process.emit("close", 2, null);
    await expect(pending).resolves.toMatchObject({ cursor: null, width: 100 });
    expect(deps.grim).toHaveBeenCalledWith(["-t", "jpeg", "-q", "80", "-s", "1", "-o", "DP-1", "-"], expect.any(AbortSignal));
    const next = capture.frame("hyprland:DP-1", true, true); await expect(next).resolves.toMatchObject({ cursor: null });
    expect(deps.spawn).toHaveBeenCalledOnce(); capture.stop();
  });
  it("retires a canceled old pull and drops its late frame before a replacement starts", async () => {
    const first = child(), second = child(), deps = runtime(first); vi.mocked(deps.spawn).mockReturnValueOnce(first.process).mockReturnValueOnce(second.process);
    const capture = new DesktopRemoteDesktopLinuxCapture(deps); const signal = new AbortController();
    const previous = capture.frame("hyprland:DP-1", true, true, undefined, signal.signal);
    await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledOnce()); signal.abort();
    first.stdout.write(`${JSON.stringify({ jpeg: jpeg().toString("base64"), cursor: null })}\n`);
    await expect(capture.frame("hyprland:DP-1", true, true)).resolves.toBeNull();
    first.process.emit("close", 0, null); await expect(previous).resolves.toBeNull();
    const next = capture.frame("hyprland:DP-1", true, false); await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledTimes(2));
    second.stdout.write(`${jpeg().toString("base64")}\n`); await expect(next).resolves.toMatchObject({ width: 100 });
    expect(deps.grim).not.toHaveBeenCalled(); capture.stop(); second.process.emit("close", 0, null);
  });
  it("discards a pre-lock frame when the fresh owned session changes and closes its exact source", async () => {
    const native = child(), deps = runtime(native); const capture = new DesktopRemoteDesktopLinuxCapture(deps);
    const pending = capture.frame("hyprland:DP-1", true, false); await vi.waitFor(() => expect(deps.spawn).toHaveBeenCalledOnce());
    vi.mocked(deps.session).mockResolvedValue("locked-logged-in"); native.stdout.write(`${jpeg().toString("base64")}\n`);
    await vi.waitFor(() => expect(native.process.kill).toHaveBeenCalledOnce()); native.process.emit("close", 0, null);
    await expect(pending).resolves.toBeNull(); expect(deps.grim).not.toHaveBeenCalled();
  });
  it("keeps a canceled grim effect in the single active slot until its actual receipt", async () => {
    const deps = runtime(); vi.mocked(deps.resolveBinary).mockRejectedValue(new Error("unavailable"));
    let finish!: (bytes: Buffer) => void; vi.mocked(deps.grim).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const capture = new DesktopRemoteDesktopLinuxCapture(deps); const pending = capture.frame("wayland-portal", true, false);
    await vi.waitFor(() => expect(deps.grim).toHaveBeenCalledOnce()); capture.stop();
    await expect(capture.frame("wayland-portal", true, false)).resolves.toBeNull();
    finish(jpeg()); await expect(pending).resolves.toBeNull();
  });
  it("bounds JPEG raster metadata before native decoding and rejects mismatched decoded dimensions", async () => {
    expect(desktopRemoteDesktopLinuxJpegSize(jpeg(8192, 8192))).toBeNull();
    expect(desktopRemoteDesktopLinuxJpegSize(Buffer.alloc(20))).toBeNull();
    expect(desktopRemoteDesktopLinuxJpegSize(jpeg())).toEqual({ width: 100, height: 80 });
    const deps = runtime(); vi.mocked(deps.resolveBinary).mockRejectedValue(new Error("unavailable"));
    deps.image = () => ({ jpeg: jpeg(), width: 101, height: 80 });
    await expect(new DesktopRemoteDesktopLinuxCapture(deps).frame("hyprland:DP-1", true, false)).resolves.toBeNull();
  });
});
