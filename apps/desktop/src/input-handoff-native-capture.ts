import { spawn } from "node:child_process";
import { resolveDesktopRemoteDesktopCaptureBinary } from "./remote-desktop-native-capture.js";
import { readDesktopRemoteDesktopSessionState } from "./remote-desktop-input.js";

/** A private in-memory photograph of one exact native window. No display
 * fallback and no Artifact/filesystem image path exists. */
export async function photographInputHandoffWindow(displayId: string, windowId: number, signal?: AbortSignal): Promise<Buffer | null> {
  const lifetime = signal ?? new AbortController().signal;
  if (process.platform !== "darwin" || !/^[0-9]{1,10}$/u.test(displayId) || !Number.isSafeInteger(windowId) || windowId <= 0 || windowId > 0xffff_ffff
    || signal?.aborted || await readDesktopRemoteDesktopSessionState(lifetime) !== "unlocked") return null;
  const executable = await resolveDesktopRemoteDesktopCaptureBinary();
  if (signal?.aborted) return null;
  const result = await new Promise<Buffer | null>(resolve => {
    const child = spawn(executable, [displayId, "cursor-overlay", "30", "0.9", "2800", "3000000", `window:${windowId}`], { stdio: "pipe", windowsHide: true });
    let text = "", done = false;
    const finish = (jpeg: Buffer | null) => {
      if (done) { jpeg?.fill(0); return; } done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); child.kill(); resolve(jpeg);
    };
    const abort = () => finish(null), timer = setTimeout(abort, 5_000); signal?.addEventListener("abort", abort, { once: true });
    child.stderr.resume(); child.stdin.on("error", () => undefined); child.on("error", abort); child.on("exit", abort);
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("ascii"); if (text.length > 4_200_000) return finish(null);
      const end = text.indexOf("\n"); if (end < 0) return;
      try { const frame = JSON.parse(text.slice(0, end)) as { jpeg?: unknown };
        const jpeg = typeof frame.jpeg === "string" && /^[A-Za-z0-9+/]+={0,2}$/u.test(frame.jpeg) ? Buffer.from(frame.jpeg, "base64") : undefined;
        finish(jpeg && jpeg.length > 0 && jpeg.length <= 3_000_000 ? jpeg : null);
      } catch { finish(null); }
    });
    child.stdin.write("f");
  });
  if (signal?.aborted || await readDesktopRemoteDesktopSessionState(lifetime) !== "unlocked") { result?.fill(0); return null; } return result;
}
