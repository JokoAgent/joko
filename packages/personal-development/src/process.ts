import { spawn } from "node:child_process";
import type { DevelopmentProcessAuthority, DevelopmentProcessInput, DevelopmentProcessSupervisor } from "./types.js";
import { PersonalDevelopmentError } from "./types.js";
import { developmentCommandProgress } from "./command-progress.js";

const ENVIRONMENT = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "SHELL", "USER", "USERNAME", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]);
/** Select OS/toolchain inputs; model/service credentials and runtime injection never enter build children. */
export function developmentEnvironment(source: Readonly<NodeJS.ProcessEnv> = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(source).filter(([name, value]) => typeof value === "string" && ENVIRONMENT.has(name.toUpperCase()))
    .map(([name, value]) => [process.platform === "win32" ? name.toUpperCase() : name, value])),
    LC_ALL: "C", LANG: "C", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", CI: "1" };
}
/** A usable native runner with exact process ownership supplied by the existing runtime supervisor. */
export function createDevelopmentProcessAuthority(supervisor: DevelopmentProcessSupervisor): DevelopmentProcessAuthority {
  return { run: (input: DevelopmentProcessInput) => new Promise((resolve, reject) => {
    input.signal.throwIfAborted();
    const child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: { ...input.environment }, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let claim: unknown; let claimFailed = false; let settled = false; let cancelled = false;
    let output = ""; let overflow = false; let tail = ""; let retirement: Promise<"retired" | "unknown"> | undefined;
    try { if (!child.pid) throw new Error(); claim = supervisor.claim(child.pid); }
    catch { claimFailed = true; try { child.kill("SIGKILL"); } catch { /* The child may have already exited. */ } }
    const retire = (): Promise<"retired" | "unknown"> => retirement ??= claimFailed ? Promise.resolve("unknown") : supervisor.retire(claim).catch(() => "unknown");
    const abort = (): void => { cancelled = true; void retire().then(outcome => { if (outcome === "unknown") void finish(null); }); };
    const timeout = setTimeout(abort, input.timeoutMs);
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      const maximum = input.maxOutputBytes ?? 512 * 1024;
      if (Buffer.byteLength(output) + chunk.length > maximum) {
        if (input.outputMode === "tail") { output = Buffer.from(output + chunk.toString("utf8")).subarray(-maximum).toString("utf8"); return; }
        overflow = true; void retire().then(outcome => { if (outcome === "unknown") void finish(null); }); return;
      }
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const lines = (tail + chunk.toString("utf8")).split(/[\r\n]/u); tail = (lines.pop() ?? "").slice(-1024);
      for (const line of lines) {
        const progress = developmentCommandProgress(line); if (progress) input.onProgress?.(progress);
      }
    });
    const finish = async (code: number | null): Promise<void> => {
      if (settled) return; settled = true; clearTimeout(timeout); input.signal.removeEventListener("abort", abort);
      // Even an exited root can have descendants writing the checkout.
      if (await retire() !== "retired") { reject(new PersonalDevelopmentError("PROCESS_UNKNOWN")); return; }
      try { await supervisor.release(claim); } catch { reject(new PersonalDevelopmentError("PROCESS_UNKNOWN")); return; }
      if (cancelled || input.signal.aborted) reject(new PersonalDevelopmentError("CANCELLED"));
      else if (overflow || code === null) reject(new PersonalDevelopmentError("COMMAND_FAILED"));
      else resolve({ stdout: output, exitCode: code });
    };
    child.once("error", () => { void finish(null); }); child.once("close", code => { void finish(code); });
  }) };
}
