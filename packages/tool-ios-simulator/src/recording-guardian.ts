import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UDID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const STARTED_MARKER = "Recording started";
const MAX_RECORDING_BYTES = 128 * 1024 * 1024;

type GuardianMessage = { readonly type: "ready" | "finalized" | "failed";
  readonly code?: "RECORDING_FAILED" | "RECORDING_INVALID" };

function alive(group: number): boolean {
  try { process.kill(-group, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitGone(group: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!alive(group)) return true;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  } while (Date.now() < deadline);
  return !alive(group);
}

function signalGroup(group: number, signal: NodeJS.Signals): void {
  try { process.kill(-group, signal); } catch { /* Liveness is checked independently. */ }
}

async function terminate(group: number, finalize: boolean): Promise<"finalized" | "discarded" | "stuck"> {
  if (finalize) {
    signalGroup(group, "SIGINT");
    if (await waitGone(group, 5_000)) return "finalized";
    signalGroup(group, "SIGTERM");
    if (await waitGone(group, 1_000)) return "discarded";
  }
  signalGroup(group, "SIGKILL");
  return await waitGone(group, 1_000) ? "discarded" : "stuck";
}

/** Separate owner process: an IPC disconnect kills the exact recorder group and removes its private output. */
export async function runSimulatorRecordingGuardian(args: readonly string[]): Promise<void> {
  const [udid, root, recordingId] = args;
  if (!udid || !UDID.test(udid) || !root || !isAbsolute(root) ||
      !recordingId || !UUID.test(recordingId) || !process.send) process.exit(2);
  const directory = join(resolve(root), recordingId);
  if (resolve(directory) !== directory || directory === resolve(root)) process.exit(2);
  const output = join(directory, "recording.mov");
  let recorder: ChildProcess | undefined;
  let group: number | undefined;
  let phase: "starting" | "active" | "finalized" | "closing" = "starting";
  let closing: Promise<void> | undefined;
  let discardRequested = false;
  const send = (message: GuardianMessage): void => {
    try { if (process.connected) process.send?.(message); }
    catch { /* A closing parent pipe is handled by the disconnect cleanup. */ }
  };
  const close = (finalize: boolean): Promise<void> => {
    if (!finalize) discardRequested = true;
    if (closing) return closing;
    phase = "closing";
    closing = (async () => {
      const result = group === undefined ? "discarded" : await terminate(group, finalize);
      if (result === "stuck") {
        send({ type: "failed", code: "RECORDING_FAILED" });
        closing = undefined;
        return;
      }
      if (finalize && result === "finalized" && !discardRequested) {
        const info = await lstat(output).catch(() => undefined);
        if (info?.isFile() && !info.isSymbolicLink() && info.size > 0 &&
            info.size <= MAX_RECORDING_BYTES) {
          phase = "finalized";
          send({ type: "finalized" });
          closing = undefined;
          return;
        }
        send({ type: "failed", code: "RECORDING_INVALID" });
      } else if (finalize) send({ type: "failed", code: "RECORDING_FAILED" });
      await rm(directory, { recursive: true, force: true });
      process.exit(0);
    })();
    return closing;
  };
  process.on("disconnect", () => { void close(false); });
  process.on("SIGTERM", () => { void close(false); });
  process.on("SIGINT", () => { void close(false); });
  process.on("message", message => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "stop" && phase === "active") void close(true);
    if ((message.type === "release" && phase === "finalized") || message.type === "discard") {
      void close(false);
    }
  });
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
    if (discardRequested) { await close(false); return; }
    recorder = spawn("/usr/bin/xcrun", ["simctl", "io", udid, "recordVideo", "--codec=h264", output], {
      shell: false, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp",
        ...(process.env.DEVELOPER_DIR === undefined ? {} : { DEVELOPER_DIR: process.env.DEVELOPER_DIR }) }
    });
    if (!recorder.pid) throw new Error("Recorder did not start.");
    group = recorder.pid;
    let marker = "";
    recorder.stderr?.on("data", (chunk: Buffer) => {
      if (phase !== "starting") return;
      marker = `${marker}${chunk.toString("utf8")}`;
      if (marker.includes(STARTED_MARKER)) { phase = "active"; marker = ""; send({ type: "ready" }); }
      else marker = marker.slice(-(STARTED_MARKER.length - 1));
    });
    recorder.on("error", () => { if (phase !== "closing") void close(false); });
    recorder.on("close", () => { if (phase === "starting" || phase === "active") {
      send({ type: "failed", code: "RECORDING_FAILED" }); void close(false);
    } });
  } catch {
    send({ type: "failed", code: "RECORDING_FAILED" });
    await close(false);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--guardian") {
  void runSimulatorRecordingGuardian(process.argv.slice(3));
}
