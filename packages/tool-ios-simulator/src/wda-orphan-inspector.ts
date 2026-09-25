import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path/posix";
import { createWdaOwnerFingerprint } from "./wda-build-plan.js";
import { WDA_SOURCE_PIN } from "./wda-source-pin.js";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_BYTES = 64 * 1024;
const MAX_CANDIDATES = 128;
const INSPECTION_BATCH = 16;
const COMMAND_TIMEOUT_MS = 2_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export type WdaOrphanInspectionErrorCode = "UNSUPPORTED_PLATFORM" | "INVALID_CONFIGURATION" |
  "CANCELLED" | "INSPECTION_FAILED";

export class WdaOrphanInspectionError extends Error {
  constructor(readonly code: WdaOrphanInspectionErrorCode, message: string) { super(message); }
}

export interface WdaProcessInventoryReader {
  listExecutables(signal?: AbortSignal): Promise<string>;
  readCandidate(pid: number, includeEnvironment: boolean, signal?: AbortSignal): Promise<string | null>;
}

export interface WdaOrphanInspectionInput {
  readonly cacheRoot: string;
  readonly instanceId: string;
  readonly simulatorUdid: string;
  readonly signal?: AbortSignal;
  readonly coreSimulatorRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly reader?: WdaProcessInventoryReader;
}

export interface WdaOrphanInspection {
  readonly ownedGroupIds: readonly number[];
  readonly conflict: boolean;
}

interface ProcessRow { readonly pid: number; readonly pgid: number; readonly command: string }

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WdaOrphanInspectionError("CANCELLED", "Driver process inspection was cancelled.");
}

function fail(): WdaOrphanInspectionError {
  return new WdaOrphanInspectionError("INSPECTION_FAILED", "Driver process ownership could not be verified.");
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseRows(value: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    if (/[\0\r]/u.test(line)) throw fail();
    const match = /^([1-9][0-9]*)\s+([1-9][0-9]*)\s+(.+)$/u.exec(line.trim());
    if (!match) throw fail();
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(pgid)) throw fail();
    rows.push({ pid, pgid, command: match[3]! });
  }
  return rows;
}

function oneCandidate(value: string, candidate: ProcessRow): ProcessRow {
  const rows = parseRows(value);
  if (rows.length !== 1 || rows[0]?.pid !== candidate.pid || rows[0]?.pgid !== candidate.pgid) throw fail();
  return rows[0];
}

function isXcodebuildExecutable(value: string): boolean {
  return value === "/usr/bin/xcodebuild" ||
    /^\/(?:Applications\/[^/]+\.app|.+\/[^/]+\.app)\/Contents\/Developer\/usr\/bin\/xcodebuild$/u.test(value) ||
    value === "/Library/Developer/CommandLineTools/usr/bin/xcodebuild";
}

function runnerExecutable(value: string, root: string, udid: string): boolean {
  const prefix = `${join(root, "Devices", udid, "data", "Containers", "Bundle", "Application")}/`;
  if (!value.startsWith(prefix)) return false;
  const suffix = value.slice(prefix.length);
  const slash = suffix.indexOf("/");
  return slash > 0 && UUID.test(suffix.slice(0, slash)) &&
    suffix.slice(slash) === "/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner";
}

function controllerOwner(command: string, executable: string, project: string, builds: string,
  udid: string, fingerprint: string): boolean {
  const pattern = new RegExp(`^${escaped(executable)} -quiet -project ${escaped(project)}` +
    ` -scheme WebDriverAgentRunner -destination platform=iOS Simulator,id=${udid},arch=(?:arm64|x86_64)` +
    ` -derivedDataPath ${escaped(builds)}[/\\\\][0-9a-f]{64}` +
    ` (?:build-for-testing|test-without-building)` +
    ` CODE_SIGNING_ALLOWED=NO COMPILER_INDEX_STORE_ENABLE=NO` +
    ` JOKO_WDA_OWNER_FINGERPRINT=${fingerprint} UPGRADE_TIMESTAMP=${fingerprint}$`, "u");
  return pattern.test(command);
}

function sameDeviceController(command: string, udid: string): boolean {
  return command.includes(" -scheme WebDriverAgentRunner ") &&
    new RegExp(` -destination (?:platform=iOS Simulator,)?[^\\s]*id=${udid}(?=,|\\s|$)`, "iu")
      .test(command);
}

function runnerOwner(command: string, executable: string, fingerprint: string): boolean {
  if (!command.startsWith(`${executable} `)) return false;
  const markers = [...command.matchAll(/(?:^|\s)UPGRADE_TIMESTAMP=([^\s]*)(?=\s|$)/gu)];
  return markers.length === 1 && markers[0]?.[1] === fingerprint;
}

function runPs(args: readonly string[], maxBytes: number, signal?: AbortSignal): Promise<{ output: string; code: number | null }> {
  cancelled(signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn("/bin/ps", [...args], { env: { LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      shell: false, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: { output: string; code: number | null } | WdaOrphanInspectionError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (result instanceof WdaOrphanInspectionError) reject(result);
      else resolveResult(result);
    };
    const stop = (error: WdaOrphanInspectionError): void => {
      try { child.kill("SIGKILL"); } catch { /* Child already exited. */ }
      finish(error);
    };
    const onAbort = (): void => stop(new WdaOrphanInspectionError("CANCELLED", "Driver process inspection was cancelled."));
    const timer = setTimeout(() => stop(fail()), COMMAND_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) { stop(fail()); return; }
      chunks.push(chunk);
    });
    child.once("error", () => finish(fail()));
    child.once("close", code => finish({ output: Buffer.concat(chunks).toString("utf8"), code }));
    if (signal?.aborted) onAbort();
  });
}

function hostReader(): WdaProcessInventoryReader {
  return {
    async listExecutables(signal) {
      const result = await runPs(["-axo", "pid=,pgid=,comm="], MAX_SNAPSHOT_BYTES, signal);
      if (result.code !== 0) throw fail();
      return result.output;
    },
    async readCandidate(pid, includeEnvironment, signal) {
      const args = [...(includeEnvironment ? ["eww"] : []), "-ww", "-p", String(pid), "-o", "pid=,pgid=,command="];
      const result = await runPs(args, MAX_CANDIDATE_BYTES, signal);
      if (result.code === 1) return null;
      if (result.code !== 0) throw fail();
      return result.output;
    }
  };
}

/** Read-only proof for the exact current v1 driver. No process signal is authorized by this result alone. */
export async function inspectWdaOrphanProcesses(input: WdaOrphanInspectionInput): Promise<WdaOrphanInspection> {
  if ((input.platform ?? process.platform) !== "darwin") {
    throw new WdaOrphanInspectionError("UNSUPPORTED_PLATFORM", "Driver process inspection requires macOS.");
  }
  cancelled(input.signal);
  let root: string;
  let fingerprint: string;
  let coreRoot: string;
  try {
    if (!isAbsolute(input.cacheRoot) || !isAbsolute(input.coreSimulatorRoot ?? homedir()) ||
        /[\0\r\n]/u.test(input.cacheRoot) || /[\0\r\n]/u.test(input.coreSimulatorRoot ?? "")) throw new Error();
    root = resolve(input.cacheRoot);
    coreRoot = resolve(input.coreSimulatorRoot ?? join(homedir(), "Library", "Developer", "CoreSimulator"));
    fingerprint = createWdaOwnerFingerprint({ cacheRoot: input.cacheRoot, instanceId: input.instanceId,
      simulatorUdid: input.simulatorUdid });
  } catch { throw new WdaOrphanInspectionError("INVALID_CONFIGURATION", "Driver process identity is invalid."); }
  const udid = input.simulatorUdid.toUpperCase();
  const project = join(root, "sources", WDA_SOURCE_PIN.revision, "WebDriverAgent.xcodeproj");
  const builds = join(root, "builds");
  const reader = input.reader ?? hostReader();
  try {
    const snapshot = await reader.listExecutables(input.signal);
    cancelled(input.signal);
    if (Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) throw fail();
    const rows = parseRows(snapshot);
    const ownRows = rows.filter(row => row.pid === process.pid);
    if (ownRows.length !== 1 || new Set(rows.map(row => row.pid)).size !== rows.length) throw fail();
    const ownGroup = ownRows[0]!.pgid;
    const candidates = rows.filter(row => isXcodebuildExecutable(row.command) ||
      runnerExecutable(row.command, coreRoot, udid));
    if (candidates.length > MAX_CANDIDATES) throw fail();
    const owned = new Set<number>();
    let conflict = false;
    for (let offset = 0; offset < candidates.length; offset += INSPECTION_BATCH) {
      const outcomes = await Promise.all(candidates.slice(offset, offset + INSPECTION_BATCH).map(async candidate => {
        cancelled(input.signal);
        const isRunner = runnerExecutable(candidate.command, coreRoot, udid);
        const output = await reader.readCandidate(candidate.pid, isRunner, input.signal);
        cancelled(input.signal);
        if (output === null) return "gone" as const;
        if (Buffer.byteLength(output) > MAX_CANDIDATE_BYTES) throw fail();
        const current = oneCandidate(output, candidate);
        const belongs = isRunner
          ? runnerOwner(current.command, candidate.command, fingerprint)
          : controllerOwner(current.command, candidate.command, project, builds, udid, fingerprint);
        const related = isRunner || sameDeviceController(current.command, udid);
        if (!related) return "unrelated" as const;
        if (candidate.pid !== candidate.pgid || candidate.pgid <= 1 || candidate.pgid === ownGroup) {
          return "conflict" as const;
        }
        return belongs ? "owned" as const : "conflict" as const;
      }));
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome === "owned") owned.add(candidates[offset + index]!.pgid);
        if (outcome === "conflict") conflict = true;
      }
    }
    return { ownedGroupIds: [...owned].sort((a, b) => a - b), conflict };
  } catch (error) {
    if (error instanceof WdaOrphanInspectionError) throw error;
    throw fail();
  }
}

/** Re-read one group leader immediately before a caller considers a signal. */
export async function verifyWdaOrphanGroup(input: WdaOrphanInspectionInput, groupId: number): Promise<boolean> {
  if ((input.platform ?? process.platform) !== "darwin") {
    throw new WdaOrphanInspectionError("UNSUPPORTED_PLATFORM", "Driver process inspection requires macOS.");
  }
  if (!Number.isSafeInteger(groupId) || groupId <= 1) {
    throw new WdaOrphanInspectionError("INVALID_CONFIGURATION", "Driver process group is invalid.");
  }
  cancelled(input.signal);
  const reader = input.reader ?? hostReader();
  try {
    const snapshot = await reader.listExecutables(input.signal);
    cancelled(input.signal);
    if (Buffer.byteLength(snapshot) > MAX_SNAPSHOT_BYTES) throw fail();
    const rows = parseRows(snapshot);
    if (new Set(rows.map(row => row.pid)).size !== rows.length) throw fail();
    const ownRows = rows.filter(row => row.pid === process.pid);
    if (ownRows.length !== 1) throw fail();
    const candidate = rows.find(row => row.pid === groupId && row.pgid === groupId);
    if (!candidate || ownRows[0]!.pgid === groupId) return false;
    const scopedReader: WdaProcessInventoryReader = {
      listExecutables: async () => `${ownRows[0]!.pid} ${ownRows[0]!.pgid} ${ownRows[0]!.command}\n` +
        `${candidate.pid} ${candidate.pgid} ${candidate.command}`,
      readCandidate: (pid, includeEnvironment, signal) => reader.readCandidate(pid, includeEnvironment, signal)
    };
    const fresh = await inspectWdaOrphanProcesses({ ...input, reader: scopedReader });
    return !fresh.conflict && fresh.ownedGroupIds.includes(groupId);
  } catch (error) {
    if (error instanceof WdaOrphanInspectionError) throw error;
    throw fail();
  }
}
