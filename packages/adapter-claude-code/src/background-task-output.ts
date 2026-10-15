import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, normalize, resolve, sep } from "node:path";
import type { BackgroundTaskOutputResult } from "@joko/core";

const systemRoots = process.platform === "win32"
  ? [process.env["SystemRoot"] ?? "C:\\Windows", process.env["ProgramFiles"] ?? "C:\\Program Files",
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", process.env["ProgramData"] ?? "C:\\ProgramData"]
  : ["/etc", "/proc", "/sys", "/dev", "/root", "/var/log"];

function allowed(value: string): boolean {
  const canonical = process.platform === "win32" && (value.startsWith("\\\\?\\") || value.startsWith("\\\\.\\"))
    ? value.slice(4).replace(/^UNC\\/iu, "\\\\") : value;
  if (!isAbsolute(canonical) || extname(canonical) !== ".output") return false;
  const key = (value: string) => { const result = resolve(normalize(value)); return process.platform === "win32" ? result.toLowerCase() : result; };
  const target = key(canonical);
  return !systemRoots.some(root => target === key(root) || target.startsWith(`${key(root).replace(/[\\/]$/u, "")}${sep}`));
}
function absent(status: "unavailable" | "failed"): BackgroundTaskOutputResult {
  return { status, text: "", totalBytes: 0, truncated: false, capturedAtMs: Date.now() };
}

/** Only Adapter-private SDK task registrations supply this path. */
export async function readRegisteredBackgroundTaskOutput(filePath: string, maximumBytes: number): Promise<BackgroundTaskOutputResult> {
  if (!allowed(filePath) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 256 * 1024) return absent("unavailable");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const actual = await realpath(filePath);
    if (!allowed(actual)) return absent("unavailable");
    const expected = await stat(actual, { bigint: true });
    handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || expected.ino === 0n || opened.dev !== expected.dev || opened.ino !== expected.ino) return absent("unavailable");
    const totalBytes = Number(opened.size);
    if (!Number.isSafeInteger(totalBytes)) return absent("failed");
    const start = Math.max(0, totalBytes - maximumBytes), buffer = Buffer.alloc(totalBytes - start);
    const bytesRead = buffer.length ? (await handle.read(buffer, 0, buffer.length, start)).bytesRead : 0;
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n"), remainder = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
      text = remainder.trim() ? remainder : text.replace(/^\uFFFD+/u, "");
    }
    return { status: "available", text, totalBytes, truncated: start > 0, modifiedAtMs: Number(opened.mtimeMs), capturedAtMs: Date.now() };
  } catch (error) {
    return absent(["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "") ? "unavailable" : "failed");
  } finally { await handle?.close().catch(() => undefined); }
}
