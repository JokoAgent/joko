import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Dir } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { BackgroundTaskOutputResult, BackgroundWorkflowAgent, BackgroundWorkflowPhase, BackgroundWorkflowProgress } from "@joko/core";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * MAX_RECORD_BYTES;
const MAX_FILES = 256;
const MAX_ENTRIES = 1024;
const MAX_ROWS = 512;
type ProjectText = (value: unknown, maximum: number) => string;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const count = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined => typeof value === "number"
  && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;

export function extractBackgroundWorkflowProgress(value: unknown, maximumBytes: number, project: ProjectText): { workflow: BackgroundWorkflowProgress; truncated: boolean } | undefined {
  const source = record(value);
  if (!source || typeof source["runId"] !== "string" || !source["runId"] || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return undefined;
  const text = (value: unknown, maximum: number): string | undefined => typeof value === "string" && value ? project(value, maximum) || undefined : undefined;
  const phases: BackgroundWorkflowPhase[] = [], agents: BackgroundWorkflowAgent[] = [], logs: string[] = [];
  const workflow: BackgroundWorkflowProgress = { runId: text(source["runId"], 512)!, status: text(source["status"], 128) ?? "running",
    ...(text(source["workflowName"], 512) ? { workflowName: text(source["workflowName"], 512) } : {}),
    ...(count(source["agentCount"]) === undefined ? {} : { agentCount: count(source["agentCount"]) }),
    ...(count(source["totalTokens"]) === undefined ? {} : { totalTokens: count(source["totalTokens"]) }),
    ...(count(source["totalToolCalls"]) === undefined ? {} : { totalToolCalls: count(source["totalToolCalls"]) }),
    ...(count(source["durationMs"]) === undefined ? {} : { durationMs: count(source["durationMs"]) }), phases, agents, logs };
  const fits = (): boolean => Buffer.byteLength(JSON.stringify(workflow), "utf8") <= maximumBytes;
  if (!workflow.runId || !fits()) return undefined;
  let truncated = false;
  const details = new Map<string, string>();
  const declaredPhases = Array.isArray(source["phases"]) ? source["phases"] : [];
  for (const value of declaredPhases.slice(0, MAX_ROWS)) {
    const phase = record(value), title = text(phase?.["title"], 512), detail = text(phase?.["detail"], 200);
    if (title && detail && !details.has(title)) details.set(title, detail);
  }
  const append = <T>(rows: T[], value: T): boolean => {
    if (rows.length >= MAX_ROWS) { truncated = true; return false; }
    rows.push(value);
    if (fits()) return true;
    rows.pop(); truncated = true; return false;
  };
  const progress = Array.isArray(source["workflowProgress"]) ? source["workflowProgress"] : [];
  for (const value of progress.slice(0, MAX_ROWS * 2)) {
    const entry = record(value);
    if (!entry) continue;
    if (entry["type"] === "workflow_phase") {
      const index = count(entry["index"], 1_000_000), title = text(entry["title"], 512);
      if (index !== undefined && title) append(phases, { index, title, ...(details.has(title) ? { detail: details.get(title)! } : {}) });
    } else if (entry["type"] === "workflow_agent") {
      const agentId = text(entry["agentId"], 512), label = text(entry["label"], 512) ?? agentId, state = text(entry["state"], 128);
      if (!label || !state) continue;
      const strings: Record<string, string> = {};
      for (const [key, maximum] of [["model", 512], ["phaseTitle", 512], ["lastToolName", 200], ["lastToolSummary", 160], ["resultPreview", 300], ["error", 300]] as const) {
        const value = text(entry[key], maximum); if (value !== undefined) strings[key] = value;
      }
      const numbers: Record<string, number> = {};
      for (const key of ["phaseIndex", "attempt", "durationMs"] as const) {
        const value = count(entry[key], key === "durationMs" ? Number.MAX_SAFE_INTEGER : 1_000_000);
        if (value !== undefined && (key !== "attempt" || value > 0)) numbers[key] = value;
      }
      append(agents, { label, state, ...(agentId ? { agentId } : {}), ...strings, ...numbers });
    }
  }
  if (progress.length > MAX_ROWS * 2) truncated = true;
  if (phases.length === 0) for (const [position, value] of declaredPhases.slice(0, MAX_ROWS).entries()) {
    const title = text(record(value)?.["title"], 512);
    if (title) append(phases, { index: position + 1, title, ...(details.has(title) ? { detail: details.get(title)! } : {}) });
  }
  if (declaredPhases.length > MAX_ROWS) truncated = true;
  const lines = Array.isArray(source["logs"]) ? source["logs"].filter(value => typeof value === "string" && value).slice(-50) : [];
  for (const value of lines) { const line = text(value, 300); if (line) append(logs, line); }
  return { workflow, truncated };
}

/** The caller enumerates adopted SDK identities, never neighbouring task directories. */
export async function readBackgroundWorkflowProgress(input: {
  readonly configurationDirectory: string;
  readonly workingDirectory: string;
  readonly projectDirectoryName?: string;
  readonly nativeSessionIds: readonly string[];
  readonly taskId: string;
  readonly maximumBytes: number;
  readonly project: ProjectText;
  assertCurrent(): void;
}): Promise<BackgroundTaskOutputResult> {
  const absent = (): BackgroundTaskOutputResult => ({ status: "unavailable", text: "", totalBytes: 0, truncated: false, capturedAtMs: Date.now() });
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 || input.maximumBytes > 256 * 1024
    || !isAbsolute(input.configurationDirectory) || !isAbsolute(input.workingDirectory) || !/^claude-task-[0-9a-f]{32}$/u.test(input.taskId)
    || input.nativeSessionIds.length > 200 || input.nativeSessionIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))
    || input.projectDirectoryName !== undefined && (!/^[a-zA-Z0-9._-]{1,1024}$/u.test(input.projectDirectoryName) || [".", ".."].includes(input.projectDirectoryName))) return absent();
  const root = resolve(input.configurationDirectory), projectDirectory = join(root, "projects", input.projectDirectoryName ?? input.workingDirectory.replace(/[^a-zA-Z0-9]/g, "-"));
  let filesRead = 0, bytesRead = 0, entriesRead = 0;
  for (const sessionId of input.nativeSessionIds) {
    input.assertCurrent();
    const directory = join(projectDirectory, sessionId, "workflows");
    let entries: Dir | undefined;
    let directoryIdentity: BigIntStats;
    try {
      const actual = await realpath(directory); input.assertCurrent();
      if (!samePath(actual, directory)) continue;
      directoryIdentity = await lstat(directory, { bigint: true }); input.assertCurrent();
      if (!directoryIdentity.isDirectory()) continue;
      entries = await opendir(actual, { bufferSize: 32 }); input.assertCurrent();
    } catch { await entries?.close().catch(() => undefined); input.assertCurrent(); continue; }
    for await (const entry of entries) {
      input.assertCurrent();
      if (++entriesRead > MAX_ENTRIES) return absent();
      if (!entry.isFile() || !entry.name.startsWith("wf_") || !entry.name.endsWith(".json")) continue;
      if (++filesRead > MAX_FILES || bytesRead >= MAX_TOTAL_BYTES) return absent();
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        input.assertCurrent();
        const file = join(directory, entry.name), expected = await lstat(file, { bigint: true }); input.assertCurrent();
        if (!expected.isFile() || expected.size < 1n || expected.size > BigInt(MAX_RECORD_BYTES)
          || bytesRead + Number(expected.size) > MAX_TOTAL_BYTES) continue;
        handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); input.assertCurrent();
        const opened = await handle.stat({ bigint: true }); input.assertCurrent();
        if (!opened.isFile() || opened.ino === 0n || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) continue;
        const currentDirectory = await lstat(directory, { bigint: true }), currentPath = await realpath(directory); input.assertCurrent();
        if (!currentDirectory.isDirectory() || currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino
          || !samePath(currentPath, directory)) continue;
        const bytes = Buffer.alloc(Number(opened.size));
        const read = await handle.read(bytes, 0, bytes.length, 0); input.assertCurrent(); bytesRead += read.bytesRead;
        const after = await handle.stat({ bigint: true }); input.assertCurrent();
        if (read.bytesRead !== bytes.length || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) continue;
        const value = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (typeof value?.["taskId"] !== "string" || `claude-task-${createHash("sha256").update(value["taskId"]).digest("hex").slice(0, 32)}` !== input.taskId) continue;
        const extracted = extractBackgroundWorkflowProgress(value, input.maximumBytes, input.project);
        input.assertCurrent();
        if (extracted) return { status: "available", text: "", totalBytes: bytes.length, modifiedAtMs: Number(opened.mtimeMs),
          capturedAtMs: Date.now(), ...extracted };
      } catch { input.assertCurrent(); }
      finally { await handle?.close().catch(() => undefined); }
    }
  }
  return absent();
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
}
