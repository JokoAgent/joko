import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import type { DevelopmentProcessAuthority, DevelopmentProcessInput, DevelopmentProcessResult } from "./types.js";
import { PersonalDevelopmentError } from "./types.js";
import { developmentEnvironment } from "./process.js";
import { developmentCommandProgress } from "./command-progress.js";
import { createCommandJournal, readCommandRetirement, recoverCommandJournals, type CommandJournal } from "./command-journal.js";
import { DIGEST, fileDigest, readJson } from "./storage.js";

export interface SupervisedDevelopmentProcessOptions {
  readonly windowsHelperPath?: string;
  readonly nodeExecutable?: string;
  readonly posixHelperPath?: string;
  readonly journalDirectory?: string;
}
interface Proof { readonly pid: number; readonly identity: string }
interface Retirement extends Proof { readonly exitCode: number; readonly cancelled: boolean; readonly forcedDescendants: boolean }
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** The only runner used by personal source/tool/build commands; never falls back to a root-PID-only success. */
export function createSupervisedDevelopmentProcessAuthority(options: SupervisedDevelopmentProcessOptions = {}): DevelopmentProcessAuthority {
  return { run: async input => {
    input.signal.throwIfAborted();
    if (!isAbsolute(input.executable) || !isAbsolute(input.cwd) || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 3_600_000) throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    const windows = process.platform === "win32";
    const helper = windows ? options.windowsHelperPath : options.posixHelperPath ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../dist/posix-command-host.js" : "./posix-command-host.js", import.meta.url));
    if (!helper || !isAbsolute(helper)) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY");
    const info = await lstat(helper).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink() || await realpath(helper) !== helper) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY");
    const journalDirectory = input.commandJournalDirectory ?? options.journalDirectory;
    if (!journalDirectory || !isAbsolute(journalDirectory)) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY");
    const helperSha256 = await fileDigest(helper);
    let helperSourceDigest = helperSha256;
    if (windows) {
      const manifest = await readJson(join(dirname(helper), "manifest.json")) as { format?: number; sourceDigest?: string; helper?: { sha256?: string } };
      if (manifest.format !== 1 || !DIGEST.test(manifest.sourceDigest ?? "") || manifest.helper?.sha256 !== helperSha256) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY");
      helperSourceDigest = manifest.sourceDigest!;
    } else {
      helperSourceDigest = await fileDigest(join(dirname(helper), "posix-command-sentinel.js"));
    }
    const journal = await createCommandJournal(journalDirectory, { operationId: input.operationId, helperSha256, helperSourceDigest });
    const child = spawn(windows ? helper : options.nodeExecutable ?? process.execPath, windows ? [] : [helper], {
      cwd: input.cwd, windowsHide: true, detached: true, stdio: windows ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
      // The helper receives the private command environment only through its stdin protocol.
      env: { ...developmentEnvironment(process.env), ...(!windows ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }
    }) as ChildProcessWithoutNullStreams;
    return observeCommand(child, journal, input, windows);
  }, recover: recoverCommandJournals };
}

function observeCommand(child: ChildProcessWithoutNullStreams, journal: CommandJournal, input: DevelopmentProcessInput, windows: boolean): Promise<DevelopmentProcessResult> {
  return new Promise((resolve, reject) => {
    const nonce = journal.nonce;
    let proof: Proof | undefined; let retirement: Retirement | undefined;
    let line = ""; let stdout = Buffer.alloc(0); let stderrTail = ""; let stdoutTail = "";
    let uncertain = false; let cancelled = false; let overflow = false; let settled = false;
    let forceDeadline: ReturnType<typeof setTimeout> | undefined;
    const maximum = input.maxOutputBytes ?? 512 * 1024;
    const finish = (error?: PersonalDevelopmentError): void => {
      if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(forceDeadline); input.signal.removeEventListener("abort", cancel);
      child.stdin.destroy();
      void (async () => {
        const durable = retirement && await readCommandRetirement(journal);
        if (error) reject(error);
        else if (uncertain || !retirement || !durable || durable.pid !== retirement.pid || durable.identity !== retirement.identity
          || durable.helperPid !== child.pid || durable.exitCode !== retirement.exitCode || durable.cancelled !== retirement.cancelled || durable.forcedDescendants !== retirement.forcedDescendants) reject(new PersonalDevelopmentError("PROCESS_UNKNOWN"));
        else if (overflow || retirement.forcedDescendants) reject(new PersonalDevelopmentError("COMMAND_FAILED"));
        else if (cancelled || retirement.cancelled) reject(new PersonalDevelopmentError("CANCELLED"));
        else resolve({ stdout: stdout.toString("utf8"), exitCode: retirement.exitCode });
      })().catch(() => reject(new PersonalDevelopmentError("PROCESS_UNKNOWN")));
    };
    const sendCancel = (): void => {
      try { child.stdin.write(`${JSON.stringify({ protocol: 1, nonce, action: "cancel" })}\n`); } catch { uncertain = true; }
      forceDeadline ??= setTimeout(() => { uncertain = true; finish(); }, 7000);
    };
    const cancel = (): void => { cancelled = true; sendCancel(); };
    const invalid = (): void => { uncertain = true; sendCancel(); };
    const timeout = setTimeout(cancel, input.timeoutMs + 1000);
    input.signal.addEventListener("abort", cancel, { once: true });
    child.stdin.on("error", () => { if (!retirement) invalid(); });
    const output = (bytes: Buffer): void => {
      if (input.outputMode !== "tail" && stdout.length + bytes.length > maximum) { overflow = true; sendCancel(); }
      stdout = Buffer.concat([stdout, bytes]).subarray(-maximum);
      const lines = (stdoutTail + bytes.toString("utf8")).split(/[\r\n]/u); stdoutTail = (lines.pop() ?? "").slice(-4096);
      for (const line of lines) { const progress = developmentCommandProgress(line); if (progress) input.onProgress?.(progress); }
    };
    const errorOutput = (bytes: Buffer): void => {
      const lines = (stderrTail + bytes.toString("utf8")).split(/[\r\n]/u); stderrTail = (lines.pop() ?? "").slice(-1024);
      for (const progress of lines) {
        const parsed = developmentCommandProgress(progress); if (parsed) input.onProgress?.(parsed);
      }
    };
    if (!windows) { child.stdout.on("data", output); child.stderr.on("data", errorOutput); }
    else child.stderr.on("data", () => { /* Helper diagnostics stay private. */ });
    const protocol = windows ? child.stdout : child.stdio[3] as Readable;
    protocol.setEncoding("utf8");
    protocol.on("data", (chunk: string) => {
      line += chunk; if (Buffer.byteLength(line) > 131_072) { invalid(); return; }
      let end: number;
      while ((end = line.indexOf("\n")) >= 0) {
        const raw = line.slice(0, end); line = line.slice(end + 1); let value: Record<string, unknown>;
        try { value = JSON.parse(raw) as Record<string, unknown>; } catch { invalid(); return; }
        if (!value || typeof value !== "object" || Array.isArray(value) || value.protocol !== 1 || value.nonce !== nonce || typeof value.event !== "string" || retirement) { invalid(); return; }
        if (value.event === "started") {
          const keys = ["protocol", "nonce", "event", "pid", "identity"];
          if (proof || !exact(value, keys) || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || typeof value.identity !== "string"
            || value.identity.length < 1 || value.identity.length > 256 || windows && !/^[0-9]{1,20}$/u.test(value.identity)) { invalid(); return; }
          proof = { pid: value.pid as number, identity: value.identity }; if (cancelled || uncertain) sendCancel();
        } else if (windows && (value.event === "stdout" || value.event === "stderr")) {
          if (!proof || !exact(value, ["protocol", "nonce", "event", "data"]) || typeof value.data !== "string" || value.data.length > 131_072 || value.data.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value.data)) { invalid(); return; }
          const bytes = Buffer.from(value.data, "hex");
          if (value.event === "stdout") output(bytes); else errorOutput(bytes);
        } else if (value.event === "retired") {
          if (!proof || !exact(value, ["protocol", "nonce", "event", "pid", "identity", "activeProcesses", "exitCode", "cancelled", "forcedDescendants"])
            || value.pid !== proof.pid || value.identity !== proof.identity || value.activeProcesses !== 0 || !Number.isSafeInteger(value.exitCode)
            || typeof value.cancelled !== "boolean" || typeof value.forcedDescendants !== "boolean") { invalid(); return; }
          retirement = { ...proof, exitCode: value.exitCode as number, cancelled: value.cancelled, forcedDescendants: value.forcedDescendants };
        } else { invalid(); return; }
      }
    });
    child.once("error", () => { uncertain = true; finish(); });
    child.once("close", code => {
      if (code !== 0 || line.length > 0 || !retirement) uncertain = true; finish();
    });
    try {
      child.stdin.write(`${JSON.stringify({ protocol: 1, nonce, commandId: journal.commandId, journalDirectory: journal.directory, operationId: journal.operationId,
        helperSha256: journal.helperSha256, helperSourceDigest: journal.helperSourceDigest, executable: input.executable, args: input.args, cwd: input.cwd,
        environment: Object.fromEntries(Object.entries(input.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string")), timeoutMs: input.timeoutMs })}\n`);
      if (input.signal.aborted) cancel();
    } catch { invalid(); }
  });
}
