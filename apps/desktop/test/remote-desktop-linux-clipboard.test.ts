import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {} }));
import {
  DesktopRemoteDesktopLinuxClipboard, DesktopRemoteDesktopLinuxClipboardWriteError,
  type DesktopRemoteDesktopLinuxClipboardRuntime
} from "../src/remote-desktop-linux-clipboard.js";
import type { DesktopRemoteDesktopClipboardContent } from "../src/remote-desktop-clipboard.js";
import type { DesktopRemoteDesktopSessionState } from "../src/remote-desktop-input.js";

function child() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const stdio: [PassThrough, PassThrough, PassThrough] = [stdin, stdout, stderr];
  return { stdin, stdout, process: Object.assign(new ChildProcess(), { stdin, stdout, stderr, stdio, pid: 200, kill: vi.fn(() => true) }) };
}
function png(width = 20, height = 20) {
  const bytes = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return bytes;
}
function fixture() {
  const state: { formats: string[]; content: DesktopRemoteDesktopClipboardContent; session: DesktopRemoteDesktopSessionState } = {
    formats: ["text/plain;charset=utf-8"], content: { text: "local" }, session: "unlocked"
  };
  const children: ReturnType<typeof child>[] = [];
  const runtime: DesktopRemoteDesktopLinuxClipboardRuntime = {
    supported: vi.fn(() => true), session: vi.fn(async () => state.session),
    execute: vi.fn(async arguments_ => {
      if (arguments_.includes("--list-types")) return Buffer.from(state.formats.join("\n"));
      switch (arguments_.at(-1)) {
        case "text/plain;charset=utf-8": case "text/plain": case "UTF8_STRING": return Buffer.from(state.content.text ?? "");
        case "text/html": return Buffer.from(state.content.html ?? "");
        case "text/rtf": case "application/rtf": return Buffer.from(state.content.rtf ?? "");
        case "image/png": return Buffer.from(state.content.png ?? "", "base64");
        default: throw new Error("unexpected command");
      }
    }),
    resolveBinary: vi.fn(async () => "/trusted/clipboard"),
    spawn: vi.fn(() => { const native = child(); children.push(native); return native.process; })
  };
  return { state, runtime, children, clipboard: new DesktopRemoteDesktopLinuxClipboard(runtime) };
}
const current = () => true;
const signal = new AbortController().signal;
function accept(native: ReturnType<typeof child>, f: ReturnType<typeof fixture>, content: DesktopRemoteDesktopClipboardContent) {
  f.state.content = content;
  f.state.formats = [
    ...(content.text === undefined ? [] : ["text/plain;charset=utf-8"]),
    ...(content.html === undefined ? [] : ["text/html"]), ...(content.rtf === undefined ? [] : ["text/rtf"]),
    ...(content.png === undefined ? [] : ["image/png"])
  ];
  native.stdout.write("ready\n");
}
async function close(f: ReturnType<typeof fixture>) {
  const closing = f.clipboard.closePublishedWriter();
  for (const native of f.children) native.process.emit("close", 0, null);
  await closing;
}

describe("Linux clipboard portable snapshot and fingerprint", () => {
  it("reads only offered portable alternatives with fixed bounded MIME arguments", async () => {
    const f = fixture(); const content = { text: "literal", html: "<b>literal</b>", rtf: "{\\rtf1 literal}", png: png().toString("base64") };
    f.state.content = content; f.state.formats = ["text/plain;charset=utf-8", "text/html", "application/rtf", "image/png"];
    await expect(f.clipboard.snapshot(false, current, signal)).resolves.toEqual({ formats: f.state.formats, content });
    expect(f.runtime.execute).toHaveBeenNthCalledWith(1, ["--list-types"], 16384, signal);
    expect(f.runtime.execute).toHaveBeenNthCalledWith(4, ["--no-newline", "--type", "application/rtf"], 2097152, signal);
    expect(f.runtime.execute).toHaveBeenNthCalledWith(5, ["--no-newline", "--type", "image/png"], 8388608, signal);
  });
  it("uses PRIMARY only for explicit text and leaves HTML/image alternatives unread", async () => {
    const f = fixture(); f.state.formats = ["text/plain", "text/html", "image/png"]; f.state.content = { text: "selection", html: "ignored" };
    await expect(f.clipboard.snapshot(true, current, signal)).resolves.toMatchObject({ content: { text: "selection" } });
    expect(f.runtime.execute).toHaveBeenCalledTimes(2);
    expect(f.runtime.execute).toHaveBeenLastCalledWith(["--primary", "--no-newline", "--type", "text/plain"], 2097152, signal);
  });
  it("rejects unsupported/file-backed PRIMARY instead of pretending a confirmed empty selection", async () => {
    const f = fixture();
    for (const formats of [["text/html"], ["text/uri-list", "text/plain"]]) {
      f.state.formats = formats;
      await expect(f.clipboard.snapshot(true, current, signal)).rejects.toThrow("CLIPBOARD_UNSUPPORTED");
    }
    f.state.formats = []; await expect(f.clipboard.snapshot(true, current, signal)).resolves.toEqual({ formats: [], content: {} });
  });
  it("never dereferences file-backed text paths and preserves only an offered PNG alternative", async () => {
    const f = fixture(); f.state.formats = ["text/uri-list", "text/plain", "text/html", "image/png"];
    f.state.content = { text: "/private/file", html: "file:///private/file", png: png().toString("base64") };
    await expect(f.clipboard.snapshot(false, current, signal)).resolves.toMatchObject({ content: { png: png().toString("base64") } });
    expect(f.runtime.execute).toHaveBeenCalledTimes(2);
    expect(f.runtime.execute).toHaveBeenLastCalledWith(["--no-newline", "--type", "image/png"], 8388608, signal);
  });
  it.each([{ formats: Array.from({ length: 65 }, (_, i) => `mime/${i}`) }, { formats: ["x".repeat(257)] }])("bounds advertised MIME count/length", async ({ formats }) => {
    const f = fixture(); f.state.formats = formats;
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow("CLIPBOARD_UNSUPPORTED");
  });
  it("bounds text codeunits, PRIMARY size and PNG raster/bytes", async () => {
    const f = fixture(); f.state.content = { text: "x".repeat(512001) };
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow("TOO_LARGE");
    f.state.content = { text: "x".repeat(16385) };
    await expect(f.clipboard.snapshot(true, current, signal)).rejects.toThrow("TOO_LARGE");
    f.state.formats = ["image/png"]; f.state.content = { png: png(2001, 2000).toString("base64") };
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow("TOO_LARGE");
    f.state.content = { png: Buffer.alloc(8388609).toString("base64") };
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow("TOO_LARGE");
  });
  it("requires a real IHDR and rejects a NUL PRIMARY selection", async () => {
    const f = fixture(); const bytes = png(); bytes.write("IDAT", 12, "ascii");
    f.state.formats = ["image/png"]; f.state.content = { png: bytes.toString("base64") };
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow("UNSUPPORTED");
    f.state.formats = ["text/plain"]; f.state.content = { text: "a\u0000b" };
    await expect(f.clipboard.snapshot(true, current, signal)).rejects.toThrow("UNSUPPORTED");
  });
  it("uses stable opaque 64hex fingerprints while reading actual portable content", async () => {
    const f = fixture(); const first = await f.clipboard.version(current, signal);
    expect(first).toMatch(/^[a-f0-9]{64}$/u); expect(await f.clipboard.version(current, signal)).toBe(first);
    f.state.content = { text: "changed" }; expect(await f.clipboard.version(current, signal)).not.toBe(first);
    f.state.content = { text: "local" }; expect(await f.clipboard.version(current, signal)).toBe(first);
    expect(f.runtime.execute).toHaveBeenCalledTimes(8);
  });
  it("refuses locked/unknown sessions and drops a late read across actual LOCK or revocation", async () => {
    const f = fixture(); f.state.session = "locked-logged-in";
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow("UNAVAILABLE");
    expect(f.runtime.execute).not.toHaveBeenCalled();
    f.state.session = "unlocked";
    vi.mocked(f.runtime.execute).mockImplementationOnce(async () => { f.state.session = "locked-logged-in"; return Buffer.from("private read"); });
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow(/^REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE$/u);
    f.state.session = "unlocked"; let owned = true;
    vi.mocked(f.runtime.execute).mockImplementationOnce(async () => { owned = false; return Buffer.from("private read"); });
    await expect(f.clipboard.snapshot(false, () => owned, signal)).rejects.toThrow(/^REMOTE_DESKTOP_CLIPBOARD_EXPIRED$/u);
  });
  it("distinguishes confirmed empty from failed access without preserving native diagnostics", async () => {
    const f = fixture(); vi.mocked(f.runtime.execute).mockRejectedValueOnce({ stderr: Buffer.from("private diagnostics"), stdout: Buffer.from("private body") });
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow(/^REMOTE_DESKTOP_CLIPBOARD_UNAVAILABLE$/u);
    vi.mocked(f.runtime.execute).mockRejectedValueOnce({ stderr: Buffer.from("Nothing is copied") });
    await expect(f.clipboard.snapshot(false, current, signal)).resolves.toEqual({ formats: [], content: {} });
    vi.mocked(f.runtime.execute).mockImplementationOnce(async () => { f.state.session = "locked-logged-in"; throw { stderr: Buffer.from("Nothing is copied") }; });
    await expect(f.clipboard.snapshot(false, current, signal)).rejects.toThrow("UNAVAILABLE");
  });
});

describe("Linux clipboard actual writer settlement", () => {
  it("publishes one portable offer after ready/readback and preserves it across lease/control loss", async () => {
    const f = fixture(); let owned = true;
    const content = { text: "copied", html: "<b>copied</b>", rtf: "{\\rtf1 copied}", png: png().toString("base64") };
    const pending = f.clipboard.write(content, () => owned, signal);
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); const native = f.children[0]!;
    expect(JSON.parse(native.stdin.read()!.toString())).toEqual(content); accept(native, f, content); await pending;
    owned = false; await expect(f.clipboard.version(() => owned, signal)).rejects.toThrow("EXPIRED");
    expect(native.process.kill).not.toHaveBeenCalled(); await close(f);
  });
  it("normalizes only HTTP(S) URL-as-text and rejects extra/oversized portable fields before dispatch", async () => {
    const f = fixture(); const pending = f.clipboard.write({ url: "https://example.test/" }, current, signal);
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); const native = f.children[0]!;
    expect(JSON.parse(native.stdin.read()!.toString())).toEqual({ text: "https://example.test/" });
    accept(native, f, { text: "https://example.test/" }); await pending; await close(f);
    await expect(f.clipboard.write({ url: "file:///private/file" }, current, signal)).rejects.toThrow("UNSUPPORTED");
    await expect(f.clipboard.write({ text: "x".repeat(512001) }, current, signal)).rejects.toThrow("TOO_LARGE");
    await expect(f.clipboard.write({ text: "x", ...{ files: "/private/file" } }, current, signal)).rejects.toThrow("UNSUPPORTED");
    expect(f.runtime.spawn).toHaveBeenCalledOnce();
  });
  it("does not spawn after authority changes during binary preparation", async () => {
    const f = fixture(); let owned = true;
    vi.mocked(f.runtime.resolveBinary).mockImplementationOnce(async () => { owned = false; return "/trusted/clipboard"; });
    await expect(f.clipboard.write({ text: "literal" }, () => owned, signal)).rejects.toThrow("EXPIRED");
    expect(f.runtime.spawn).not.toHaveBeenCalled();
  });
  it("rejects readback mismatch only after the exact candidate actually closes", async () => {
    const f = fixture(); const pending = expect(f.clipboard.write({ text: "expected" }, current, signal)).rejects.toThrow("WRITE_FAILED");
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); const native = f.children[0]!;
    native.stdout.write("ready\n"); await vi.waitFor(() => expect(native.process.kill).toHaveBeenCalledOnce());
    await expect(f.clipboard.write({ text: "new" }, current, signal)).rejects.toThrow("UNAVAILABLE");
    native.process.emit("close", 0, null); await pending;
  });
  it("refuses a ready receipt after LOCK and retains the candidate until actual close", async () => {
    const f = fixture(); const pending = expect(f.clipboard.write({ text: "literal" }, current, signal)).rejects.toThrow("UNAVAILABLE");
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); const native = f.children[0]!;
    f.state.session = "locked-logged-in"; native.stdout.write("ready\n");
    await vi.waitFor(() => expect(native.process.kill).toHaveBeenCalledOnce()); native.process.emit("close", 0, null); await pending;
  });
  it("holds dispatched unknown effects through timeout/late ready/exit until actual close without replay", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const pending = f.clipboard.write({ text: "literal" }, current, signal);
      const failure = expect(pending).rejects.toMatchObject({ outcomeUnknown: true, message: "REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN" });
      await vi.advanceTimersByTimeAsync(0); expect(f.children).toHaveLength(1); const native = f.children[0]!;
      await vi.advanceTimersByTimeAsync(5000); expect(native.process.kill).toHaveBeenCalled();
      native.stdout.write("ready\n"); native.process.emit("exit", 0, null);
      await expect(f.clipboard.write({ text: "replacement" }, current, signal)).rejects.toThrow("UNAVAILABLE");
      expect(f.runtime.spawn).toHaveBeenCalledOnce(); native.process.emit("close", 0, null); await failure;
      expect(f.runtime.spawn).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("keeps an aborted dispatched writer occupied until actual close and marks the unknown effect", async () => {
    const f = fixture(), canceled = new AbortController();
    const pending = f.clipboard.write({ text: "literal" }, current, canceled.signal);
    const failure = expect(pending).rejects.toBeInstanceOf(DesktopRemoteDesktopLinuxClipboardWriteError);
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); const native = f.children[0]!;
    canceled.abort(); await expect(f.clipboard.write({ text: "replacement" }, current, signal)).rejects.toThrow("UNAVAILABLE");
    native.stdout.write("ready\n"); native.process.emit("close", 0, null); await failure;
  });
  it("replaces only an approved literal offer and waits for the exact previous owner close", async () => {
    const f = fixture(); const first = f.clipboard.write({ text: "first" }, current, signal);
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); const old = f.children[0]!; accept(old, f, { text: "first" }); await first;
    let settled = false; const next = f.clipboard.write({ text: "next" }, current, signal).then(() => { settled = true; });
    await vi.waitFor(() => expect(f.children).toHaveLength(2)); const replacement = f.children[1]!;
    accept(replacement, f, { text: "next" }); await vi.waitFor(() => expect(old.process.kill).toHaveBeenCalledOnce());
    expect(settled).toBe(false); expect(replacement.process.kill).not.toHaveBeenCalled();
    old.process.emit("close", 0, null); await next; await close(f);
  });
  it("joins actual appquit cleanup and permits a fresh offer after canceled-exit recovery", async () => {
    const f = fixture(); const written = f.clipboard.write({ text: "first" }, current, signal);
    await vi.waitFor(() => expect(f.children).toHaveLength(1)); const old = f.children[0]!; accept(old, f, { text: "first" }); await written;
    const closing = f.clipboard.closePublishedWriter(); expect(f.clipboard.closePublishedWriter()).toBe(closing); expect(f.clipboard.supports()).toBe(false);
    await expect(f.clipboard.write({ text: "new" }, current, signal)).rejects.toThrow("EXPIRED");
    old.process.emit("close", 0, null); await closing; expect(f.clipboard.supports()).toBe(true);
    const next = f.clipboard.write({ text: "new" }, current, signal); await vi.waitFor(() => expect(f.children).toHaveLength(2));
    accept(f.children[1]!, f, { text: "new" }); await next; await close(f);
  });
});
