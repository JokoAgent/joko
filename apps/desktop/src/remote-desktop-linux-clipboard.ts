import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import type { DesktopRemoteDesktopClipboardContent } from "./remote-desktop-clipboard.js";
import {
  isDesktopRemoteDesktopWayland, readDesktopRemoteDesktopLinuxSessionState
} from "./remote-desktop-linux.js";
import type { DesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";
import { verifyPackagedDesktopRemoteDesktopBinary } from "./remote-desktop-native-manifest.js";

const exec = promisify(execFile);
const HELPER = "joko-linux-remote-desktop-clipboard";
const MAXIMUM_IMAGE_BYTES = 8 * 1_024 * 1_024;
const MAXIMUM_TEXT_BYTES = 2 * 1_024 * 1_024;
const MAXIMUM_TEXT_CHARS = 512_000;
const MAXIMUM_PAYLOAD_BYTES = 16_000_000;
export interface DesktopRemoteDesktopLinuxClipboardSnapshot {
  readonly formats: readonly string[];
  readonly content: DesktopRemoteDesktopClipboardContent;
}
export interface DesktopRemoteDesktopLinuxClipboardRuntime {
  supported(): boolean;
  session(signal: AbortSignal): Promise<DesktopRemoteDesktopSessionState>;
  execute(arguments_: readonly string[], maximumBytes: number, signal: AbortSignal): Promise<Buffer>;
  resolveBinary(): Promise<string>;
  spawn(binary: string): ChildProcessWithoutNullStreams;
}

/** Finite local metadata only; no helper output or clipboard body is retained. */
export class DesktopRemoteDesktopLinuxClipboardWriteError extends Error {
  constructor(readonly outcomeUnknown: boolean) {
    super(outcomeUnknown ? "REMOTE_DESKTOP_CLIPBOARD_OUTCOME_UNKNOWN" : "REMOTE_DESKTOP_CLIPBOARD_WRITE_FAILED");
    this.name = "DesktopRemoteDesktopLinuxClipboardWriteError";
  }
}
interface Writer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  readonly stop: () => void;
  actualClosed: boolean;
}

/** One regular selection owner shared by the host and all local viewers. */
export class DesktopRemoteDesktopLinuxClipboard {
  readonly #runtime: DesktopRemoteDesktopLinuxClipboardRuntime;
  #published: Writer | undefined;
  #candidate: Writer | undefined;
  #writing: Promise<void> | undefined;
  #closing = false;
  #closingPromise: Promise<void> | undefined;
  constructor(runtime: DesktopRemoteDesktopLinuxClipboardRuntime = clipboardRuntime()) { this.#runtime = runtime; }
  supports(): boolean { return !this.#closing && this.#runtime.supported(); }

  async snapshot(primary: boolean, current: () => boolean, signal: AbortSignal): Promise<DesktopRemoteDesktopLinuxClipboardSnapshot> {
    await this.#proof(current, signal);
    const selection = primary ? ["--primary"] : [];
    const formats = (await this.#read([...selection, "--list-types"], 16_384, current, signal))
      .toString("utf8").trim().split("\n").filter(Boolean);
    if (formats.length > 64 || formats.some(format => format.length > 256)) throw finite("UNSUPPORTED");
    const fileBacked = formats.some(format => /file-url|filenames|hdrop|filecontents|filegroupdescriptor|uri-list/iu.test(format));
    if (primary && formats.length > 0 && (fileBacked
      || !formats.some(format => ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"].includes(format)))) throw finite("UNSUPPORTED");
    const content: { text?: string; html?: string; rtf?: string; png?: string } = {};
    if (!fileBacked) {
      const types = [["text", ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"]],
        ["html", ["text/html"]], ["rtf", ["text/rtf", "application/rtf"]]] as const;
      for (const [key, alternatives] of types) {
        if (primary && key !== "text") continue;
        const mime = alternatives.find(type => formats.includes(type)); if (mime === undefined) continue;
        const value = (await this.#read([...selection, "--no-newline", "--type", mime], MAXIMUM_TEXT_BYTES, current, signal)).toString("utf8");
        if (value.length > (primary ? 16_384 : MAXIMUM_TEXT_CHARS)) throw finite("TOO_LARGE");
        if (primary && value.includes("\u0000")) throw finite("UNSUPPORTED");
        if (value) content[key] = value;
      }
    }
    if (!primary && formats.includes("image/png")) {
      const png = await this.#read(["--no-newline", "--type", "image/png"], MAXIMUM_IMAGE_BYTES, current, signal);
      assertPng(png); content.png = png.toString("base64");
    }
    await this.#proof(current, signal);
    return Object.freeze({ formats: Object.freeze(formats), content: Object.freeze(content) });
  }

  /** Content fingerprint, not a system generation counter or atomic OS CAS. */
  async version(current: () => boolean, signal: AbortSignal): Promise<string> {
    const snapshot = await this.snapshot(false, current, signal);
    this.#check(current, signal);
    return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  }

  async write(content: DesktopRemoteDesktopClipboardContent, current: () => boolean, signal: AbortSignal): Promise<void> {
    this.#check(current, signal);
    if (this.#writing !== undefined) throw finite("UNAVAILABLE");
    const value = portableValue(content);
    const pending = this.#write(value, current, signal);
    this.#writing = pending;
    try { await pending; } finally { if (this.#writing === pending) this.#writing = undefined; }
  }

  async #write(value: DesktopRemoteDesktopClipboardContent, current: () => boolean, signal: AbortSignal): Promise<void> {
    let writer: Writer | undefined;
    try {
      await this.#proof(current, signal);
      let binary: string;
      try { binary = await this.#runtime.resolveBinary(); } catch { throw finite("UNAVAILABLE"); }
      await this.#proof(current, signal);
      const child = this.#runtime.spawn(binary);
      let resolveClosed!: () => void;
      writer = { child, actualClosed: false, closed: new Promise(resolve => { resolveClosed = resolve; }),
        stop: () => { try { child.stdin.destroy(); child.kill("SIGKILL"); } catch { /* Actual close owns settlement. */ } } };
      const captured = writer; this.#candidate = captured;
      child.stderr.resume();
      child.stdin.on("error", () => { /* Readiness owns pending failures; published lifetime owns actual close. */ });
      child.on("error", () => { /* Keep asynchronous native failures out of diagnostics and wait for actual close. */ });
      child.once("close", () => {
        captured.actualClosed = true; resolveClosed();
        if (this.#published === captured) this.#published = undefined;
      });
      await this.#ready(captured, `${JSON.stringify(value)}\n`, current, signal);
      await this.#proof(current, signal);
      if (captured.actualClosed || this.#candidate !== captured) throw new DesktopRemoteDesktopLinuxClipboardWriteError(false);
      const actual = (await this.snapshot(false, current, signal)).content;
      if (!samePortableContent(value, actual)) throw finite("WRITE_FAILED");
      await this.#proof(current, signal);
      if (captured.actualClosed || this.#candidate !== captured) throw new DesktopRemoteDesktopLinuxClipboardWriteError(false);
      const previous = this.#published;
      this.#published = captured; this.#candidate = undefined;
      if (previous !== undefined && previous !== captured) { previous.stop(); await previous.closed; }
      // Ownership was confirmed before publication. A later lease end leaves this literal offer intact.
    } catch (error) {
      if (writer !== undefined && this.#published !== writer) { writer.stop(); await writer.closed; }
      throw error;
    } finally { if (this.#candidate === writer) this.#candidate = undefined; }
  }

  #ready(writer: Writer, payload: string, current: () => boolean, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolveReady, rejectReady) => {
      let output = ""; let stopped = false; let dispatched = false; let ready = false;
      let undispatchedFailure: Error | undefined;
      const stop = (): void => { stopped = true; writer.stop(); };
      const finish = (error?: Error): void => {
        clearTimeout(timer); signal.removeEventListener("abort", stop);
        writer.child.stdout.off("data", receive); writer.child.off("error", stop); writer.child.off("exit", stop);
        writer.child.stdin.off("error", stop);
        if (error === undefined) resolveReady(); else rejectReady(error);
      };
      const receive = (chunk: Buffer): void => {
        if (ready || stopped) return;
        output += chunk.toString("ascii");
        if (output.length > 32 || (output.includes("\n") && output !== "ready\n")) { stop(); return; }
        if (output === "ready\n") { ready = true; finish(); }
      };
      const timer = setTimeout(stop, 5_000); timer.unref?.();
      signal.addEventListener("abort", stop, { once: true });
      writer.child.stdout.on("data", receive); writer.child.once("error", stop); writer.child.once("exit", stop);
      writer.child.stdin.on("error", stop);
      void writer.closed.then(() => { if (!ready) finish(undispatchedFailure ?? new DesktopRemoteDesktopLinuxClipboardWriteError(dispatched)); });
      try {
        this.#check(current, signal);
        // Dispatch means the body may have reached the helper. Kill/timeout alone cannot prove otherwise.
        dispatched = writer.child.pid !== undefined;
        writer.child.stdin.write(payload, error => { if (error !== undefined && error !== null) stop(); });
      } catch { undispatchedFailure = finite("EXPIRED"); stop(); }
    });
  }

  /** App quit only: retiring a lease/counter must preserve the last approved selection. */
  closePublishedWriter(): Promise<void> {
    if (this.#closingPromise !== undefined) return this.#closingPromise;
    this.#closing = true;
    const published = this.#published; this.#published = undefined;
    this.#candidate?.stop(); published?.stop();
    const pending = Promise.all([this.#writing?.catch(() => undefined), published?.closed]).then(() => undefined)
      .finally(() => {
        if (this.#closingPromise === pending) { this.#closingPromise = undefined; this.#closing = false; }
      });
    this.#closingPromise = pending;
    return pending;
  }
  #check(current: () => boolean, signal: AbortSignal): void {
    if (this.#closing || signal.aborted || !current()) throw finite("EXPIRED");
  }
  async #proof(current: () => boolean, signal: AbortSignal): Promise<void> {
    this.#check(current, signal);
    if (!this.supports()) throw finite("UNAVAILABLE");
    let state: DesktopRemoteDesktopSessionState;
    try { state = await this.#runtime.session(signal); } catch { this.#check(current, signal); throw finite("UNAVAILABLE"); }
    this.#check(current, signal);
    if (state !== "unlocked") throw finite("UNAVAILABLE");
  }
  async #read(arguments_: readonly string[], maximumBytes: number, current: () => boolean, signal: AbortSignal): Promise<Buffer> {
    await this.#proof(current, signal);
    let value: Buffer;
    try { value = await this.#runtime.execute(arguments_, maximumBytes, signal); }
    catch (error) {
      await this.#proof(current, signal);
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw finite("TOO_LARGE");
      if (typeof error === "object" && error !== null && "stderr" in error && Buffer.isBuffer(error.stderr)
        && /^(?:Nothing is copied|No selection)/u.test(error.stderr.toString("utf8"))) return Buffer.alloc(0);
      throw finite("UNAVAILABLE");
    }
    await this.#proof(current, signal);
    if (value.byteLength > maximumBytes) throw finite("TOO_LARGE");
    return value;
  }
}

function samePortableContent(expected: DesktopRemoteDesktopClipboardContent, actual: DesktopRemoteDesktopClipboardContent): boolean {
  return expected.text === actual.text && expected.html === actual.html && expected.rtf === actual.rtf && expected.png === actual.png;
}
function portableValue(raw: DesktopRemoteDesktopClipboardContent): DesktopRemoteDesktopClipboardContent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw finite("UNSUPPORTED");
  if (Object.keys(raw).some(key => !["text", "html", "rtf", "url", "png"].includes(key))) throw finite("UNSUPPORTED");
  for (const value of Object.values(raw)) if (typeof value !== "string" || value.length === 0) throw finite("UNSUPPORTED");
  if (raw.url !== undefined && !/^https?:\/\//iu.test(raw.url)) throw finite("UNSUPPORTED");
  const value = { ...(raw.text ?? raw.url ? { text: raw.text ?? raw.url } : {}),
    ...(raw.html === undefined ? {} : { html: raw.html }), ...(raw.rtf === undefined ? {} : { rtf: raw.rtf }),
    ...(raw.png === undefined ? {} : { png: raw.png }) };
  if (!Object.keys(value).length) throw finite("EMPTY");
  for (const text of [value.text, value.html, value.rtf]) {
    if (text !== undefined && (text.length > MAXIMUM_TEXT_CHARS || Buffer.byteLength(text, "utf8") > MAXIMUM_TEXT_BYTES)) throw finite("TOO_LARGE");
  }
  if (value.png !== undefined) {
    if (value.png.length > Math.ceil(MAXIMUM_IMAGE_BYTES / 3) * 4) throw finite("TOO_LARGE");
    if (value.png.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.png)) throw finite("UNSUPPORTED");
    const bytes = Buffer.from(value.png, "base64");
    if (bytes.toString("base64") !== value.png) throw finite("UNSUPPORTED");
    assertPng(bytes);
  }
  if (Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8") > MAXIMUM_PAYLOAD_BYTES) throw finite("TOO_LARGE");
  return Object.freeze(value);
}
function assertPng(bytes: Buffer): void {
  if (bytes.length > MAXIMUM_IMAGE_BYTES) throw finite("TOO_LARGE");
  if (bytes.length < 33 || !bytes.subarray(0, 16).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]))) throw finite("UNSUPPORTED");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width * height > 4_000_000) throw finite("TOO_LARGE");
}
function finite(reason: "UNAVAILABLE" | "UNSUPPORTED" | "TOO_LARGE" | "WRITE_FAILED" | "EXPIRED" | "EMPTY"): Error {
  return new Error(`REMOTE_DESKTOP_CLIPBOARD_${reason}`);
}

let building: Promise<string> | undefined;
async function resolveClipboardBinary(): Promise<string> {
  if (process.platform !== "linux") throw finite("UNAVAILABLE");
  if (app.isPackaged) return verifyPackagedDesktopRemoteDesktopBinary(join(process.resourcesPath, "native-remote-desktop"),
    "clipboard", HELPER, "linux", process.arch);
  building ??= (async () => {
    const source = join(app.getAppPath(), "native", "remote-desktop", "linux-clipboard");
    const digest = createHash("sha256").update(process.arch);
    for (const name of ["main.c", "build.mjs", "wlr-data-control-unstable-v1.xml"]) digest.update(await readFile(join(source, name)));
    const directory = join(app.getPath("userData"), "remote-desktop", "native", digest.digest("hex"));
    const target = join(directory, HELPER);
    try { await access(target, constants.X_OK); return target; } catch { /* Build this exact source snapshot. */ }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await exec(process.execPath, [join(source, "build.mjs"), directory], { timeout: 60_000, maxBuffer: 64_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    await access(target, constants.X_OK); return target;
  })().finally(() => { building = undefined; });
  return building;
}
function clipboardRuntime(): DesktopRemoteDesktopLinuxClipboardRuntime {
  return {
    supported: () => {
      if (!isDesktopRemoteDesktopWayland() || !process.env["HYPRLAND_INSTANCE_SIGNATURE"]) return false;
      try { accessSync("/usr/bin/wl-paste", constants.X_OK); return true; } catch { return false; }
    },
    session: readDesktopRemoteDesktopLinuxSessionState,
    execute: async (arguments_, maximumBytes, signal) => (await exec("/usr/bin/wl-paste", [...arguments_], {
      timeout: 2_000, maxBuffer: maximumBytes, encoding: "buffer", signal
    })).stdout,
    resolveBinary: resolveClipboardBinary,
    spawn: binary => spawn(binary, [], { stdio: "pipe" })
  };
}

export const desktopRemoteDesktopLinuxClipboard = new DesktopRemoteDesktopLinuxClipboard();
export function supportsDesktopRemoteDesktopLinuxClipboard(): boolean { return desktopRemoteDesktopLinuxClipboard.supports(); }
