import { spawn } from "node:child_process";
import { isAbsolute, basename } from "node:path";
import { createWriteStream } from "node:fs";

const control = createWriteStream("", { fd: 3 });
let input = "", nonce = "", request: Record<string, unknown> | undefined, running = false;
function retire(): never { try { process.kill(-process.pid, "SIGKILL"); } catch { /* Missing group never becomes a proof. */ } process.exit(2); }
const emit = (value: object) => control.write(`${JSON.stringify({ protocol: 1, nonce, ...value })}\n`);
process.stdin.setEncoding("utf8"); process.stdin.on("end", retire); process.stdin.on("error", retire); control.on("error", retire);
process.stdin.on("data", (chunk: string) => {
  input += chunk; if (Buffer.byteLength(input) > 262_144) retire();
  let end: number;
  while ((end = input.indexOf("\n")) >= 0) {
    const raw = input.slice(0, end); input = input.slice(end + 1);
    let value: Record<string, unknown>; try { value = JSON.parse(raw) as Record<string, unknown>; } catch { retire(); }
    if (request) {
      if (running || value.protocol !== 1 || value.nonce !== nonce || value.action !== "run" || Object.keys(value).length !== 3) retire();
      running = true;
      const child = spawn(request.executable as string, request.args as string[], { cwd: request.cwd as string,
        env: request.environment as NodeJS.ProcessEnv, detached: false, stdio: ["ignore", "inherit", "inherit"] });
      child.once("error", retire); child.once("exit", code => emit({ event: "root-exit", exitCode: code ?? 1 })); continue;
    }
    if (value.protocol !== 1 || typeof value.nonce !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(value.nonce)
      || typeof value.executable !== "string" || !isAbsolute(value.executable) || typeof value.cwd !== "string" || !isAbsolute(value.cwd)
      || !Array.isArray(value.args) || value.args.length > 1024 || value.args.some(arg => typeof arg !== "string" || arg.length > 32_768 || arg.includes("\0"))
      || !value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)
      || !Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 3_600_000) retire();
    for (const [key, entry] of Object.entries(value.environment)) if (!key || /[=\0]/u.test(key) || typeof entry !== "string" || entry.includes("\0")) retire();
    const name = basename(value.executable), args = value.args as string[];
    const nodeHost = ["electron", "Electron", "joko", "Joko"].includes(name) && (value.environment as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE === "1";
    const compiler = name === "xcode-select" && value.executable === "/usr/bin/xcode-select" && args.length === 1 && args[0] === "-p"
      || name === "xcrun" && value.executable === "/usr/bin/xcrun" && (JSON.stringify(args) === '["--find","clang++"]' || JSON.stringify(args) === '["--show-sdk-path"]')
      || ["clang++", "g++", "make"].includes(name) && args.length === 1 && args[0] === "--version";
    if (!nodeHost && !compiler && !["git", "git-lfs", "node", "pnpm", "pnpm.cjs", "python", "python3", "python3.13"].includes(name)) retire();
    request = value; nonce = value.nonce; emit({ event: "reserved", pid: process.pid });
  }
});
setInterval(() => { /* Reserve the group identity until the monitor's exact group kill. */ }, 1000);
