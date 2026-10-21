import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./storage.js";
import type { CommandJournal } from "./command-journal.js";
import { waitForDevelopmentProcessGroupExit } from "./process.js";

// The monitor is outside the command's reserved group and survives its caller's EOF.
const control = createWriteStream("", { fd: 3 });
let input = "", received = false, nonce = "", stopping = false, broken = false, cancelled = false;
let sentinel: ChildProcessWithoutNullStreams | undefined, groupPid: number | undefined, groupBirth: string | undefined;
let journal: CommandJournal | undefined, started: Record<string, unknown> | undefined;
let rootExit: number | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
const emit = (value: object) => { if (!broken) control.write(`${JSON.stringify({ protocol: 1, nonce, ...value })}\n`); };
const fail = () => {
  broken = true;
  if (!started) { stopping = true; clearTimeout(timeout); sentinel?.stdin.destroy(); process.stdin.destroy(); control.end(); process.exitCode = 2; }
  else void retire(true);
};
control.on("error", fail); process.stdout.on("error", fail); process.stderr.on("error", fail);
process.stdin.setEncoding("utf8"); process.stdin.on("end", () => { void retire(true); }); process.stdin.on("error", fail);
process.stdin.on("data", (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 262_144) { fail(); return; }
  let end: number;
  while ((end = input.indexOf("\n")) >= 0) {
    const raw = input.slice(0, end); input = input.slice(end + 1);
    let value: Record<string, unknown>;
    try { value = JSON.parse(raw) as Record<string, unknown>; } catch { fail(); return; }
    if (received) {
      if (value.protocol !== 1 || value.nonce !== nonce || value.action !== "cancel" || Object.keys(value).length !== 3) fail();
      else void retire(true);
    } else { received = true; void begin(value).catch(fail); }
  }
});

async function begin(value: Record<string, unknown>) {
  const fields = ["protocol", "nonce", "commandId", "journalDirectory", "operationId", "helperSha256", "helperSourceDigest", "executable", "args", "cwd", "environment", "timeoutMs"];
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field)) || value.protocol !== 1 || typeof value.nonce !== "string" || typeof value.commandId !== "string" || typeof value.operationId !== "string"
    || typeof value.journalDirectory !== "string" || typeof value.helperSha256 !== "string" || typeof value.helperSourceDigest !== "string") throw new Error();
  nonce = value.nonce;
  const request = await readJson(join(value.journalDirectory, "request.json")) as CommandJournal;
  if (request.format !== 1 || request.nonce !== nonce || request.commandId !== value.commandId || request.operationId !== value.operationId || request.directory !== value.journalDirectory
    || request.helperSha256 !== value.helperSha256 || request.helperSourceDigest !== value.helperSourceDigest || request.platform !== process.platform) throw new Error();
  const script = fileURLToPath(import.meta.url), sentinelPath = join(dirname(script), "posix-command-sentinel.js");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  if (digest(await readFile(script)) !== request.helperSha256 || digest(await readFile(sentinelPath)) !== request.helperSourceDigest) throw new Error();
  journal = request;
  if (stopping) { process.exitCode = 2; return; }
  sentinel = spawn(process.execPath, [sentinelPath], { detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }) as ChildProcessWithoutNullStreams;
  const child = sentinel;
  child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false });
  let line = "", initializing = Promise.resolve();
  const channel = child.stdio[3]! as import("node:stream").Readable;
  channel.setEncoding("utf8"); channel.on("data", (chunk: string) => {
    line += chunk; if (Buffer.byteLength(line) > 8192) { fail(); return; }
    let end: number;
    while ((end = line.indexOf("\n")) >= 0) {
      const raw = line.slice(0, end); line = line.slice(end + 1);
      initializing = initializing.then(async () => {
        const message = JSON.parse(raw) as Record<string, unknown>;
        if (message.nonce !== nonce || message.protocol !== 1 || Object.keys(message).length !== 4) throw new Error();
        if (message.event === "reserved" && groupPid === undefined && message.pid === child.pid) {
          groupPid = child.pid!; groupBirth = await birth(groupPid);
          started = { ...request, pid: groupPid, identity: groupBirth, helperPid: process.pid, helperBirth: await birth(process.pid) };
          await writeJson(join(request.directory, "started.json"), started);
          emit({ event: "started", pid: groupPid, identity: groupBirth });
          child.stdin.write(`${JSON.stringify({ protocol: 1, nonce, action: "run" })}\n`);
          if (cancelled) void retire(true);
        } else if (message.event === "root-exit" && started && Number.isSafeInteger(message.exitCode)) {
          rootExit = message.exitCode as number; void retire(false);
        } else throw new Error();
      }).catch(fail);
    }
  });
  child.once("error", fail);
  child.once("exit", () => { if (!stopping) fail(); });
  child.stdin.on("error", () => { if (!stopping) fail(); });
  child.stdin.write(`${JSON.stringify(value)}\n`);
  timeout = setTimeout(() => { void retire(true); }, Number(value.timeoutMs));
}

async function retire(cancel: boolean) {
  cancelled ||= cancel;
  if (!started || !journal || !sentinel || !groupPid || !groupBirth) {
    if (!received) { process.exitCode = 2; return; }
    cancelled = true; return;
  }
  if (stopping) return; stopping = true; clearTimeout(timeout);
  let stage = "leader";
  try {
    if (sentinel.exitCode !== null || sentinel.signalCode !== null) throw new Error();
    stage = "birth";
    if (await birth(groupPid) !== groupBirth) throw new Error();
    stage = "terminate";
    process.kill(-groupPid, "SIGKILL");
    stage = "quiescence";
    await waitForDevelopmentProcessGroupExit(groupPid);
    stage = "drain";
    await new Promise<void>(resolve => { if (sentinel!.exitCode !== null || sentinel!.signalCode !== null) resolve(); else sentinel!.once("close", () => resolve()); });
    stage = "receipt";
    const receipt = { ...started, activeProcesses: 0, exitCode: rootExit ?? 1, cancelled, forcedDescendants: false };
    await writeJson(join(journal.directory, "retired.json"), receipt);
    emit({ event: "retired", pid: groupPid, identity: groupBirth, activeProcesses: 0, exitCode: receipt.exitCode, cancelled, forcedDescendants: false });
    process.stdin.destroy(); control.end(); process.exitCode = broken ? 2 : 0;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    emit({ event: "failed", stage, systemCode: ["ESRCH", "EPERM", "EACCES", "EIO", "ENOENT", "ENOSPC"].includes(String(code)) ? code : "unknown" });
    sentinel.stdin.destroy(); process.stdin.destroy(); control.end(); process.exitCode = 2;
  }
}
async function birth(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8"); const value = stat.slice(stat.lastIndexOf(")") + 2).split(/\s/u)[19];
    if (!value || !/^\d+$/u.test(value)) throw new Error(); return `linux:${value}`;
  }
  if (process.platform === "darwin") {
    const value = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000 }).trim();
    if (!value || /[\r\n]/u.test(value)) throw new Error(); return `darwin:${value}`;
  }
  throw new Error();
}
