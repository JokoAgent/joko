import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Compiler observations require the Windows Actions runner.");
}

const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
if (!systemRoot || !isAbsolute(systemRoot) || resolve(systemRoot) !== systemRoot) {
  throw new Error("The Windows system directory is unavailable.");
}
const source = readFileSync(new URL("../../packages/remote-ssh/src/key-permissions.ts", import.meta.url), "utf8");
const definition = /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/u.exec(source)?.[1];
if (!definition) throw new Error("The owned permission compiler definition was not found.");
// Compile the actual owned type without opening a directory, key or credential.
const command = `$ErrorActionPreference = 'Stop'
[Console]::Out.WriteLine('compiler-entry')
try {
Add-Type -TypeDefinition @'
${definition}
'@
[Console]::Out.WriteLine('compiler-complete')
} catch { [Console]::Out.WriteLine('compiler-failed'); exit 1 }
`;
const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const modules = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
const baseline = { SystemRoot: systemRoot, WINDIR: systemRoot };
for (const name of ["TEMP", "TMP"]) {
  if (process.env[name] !== undefined) baseline[name] = process.env[name];
}
const profileNames = ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH"];
const profile = Object.fromEntries(profileNames.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
const systemCommands = {
  Path: [join(systemRoot, "System32"), systemRoot, join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";"),
  ComSpec: join(systemRoot, "System32", "cmd.exe")
};

async function observe(label, environment, prefix = "") {
  const started = performance.now();
  const events = [];
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `${prefix}\n${command}`], {
    windowsHide: true, shell: false, env: environment, stdio: ["ignore", "pipe", "ignore"]
  });
  let buffered = "";
  let timedOut = false;
  let processClosed = false;
  let treeTerminationConfirmed = false;
  const record = phase => events.push({ phase, elapsedMs: Math.round(performance.now() - started) });
  child.stdout.on("data", bytes => {
    buffered = (buffered + bytes.toString("ascii")).slice(-256);
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (["command-discovery-start", "command-discovery-complete", "module-import-start", "module-import-complete", "compiler-entry", "compiler-complete", "compiler-failed"].includes(line)) record(line);
    }
  });
  const result = await new Promise(accept => {
    let finished = false;
    let retirement;
    const finish = (exitCode, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(retirement);
      child.stdout.destroy();
      child.unref();
      accept({ label, events, timedOut, exitCode, signal, processClosed,
        ...(timedOut ? { treeTerminationConfirmed } : {}), elapsedMs: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // This runner-only compiler process owns its compiler descendants. Retire
      // that exact live tree, never an image-name or a machine-wide process set.
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        const termination = spawnSync(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true, stdio: "ignore", timeout: 2000
        });
        treeTerminationConfirmed = termination.error === undefined && termination.status === 0;
        child.kill("SIGKILL");
      }
      retirement = setTimeout(() => finish(child.exitCode, child.signalCode), 2000);
    }, 10_000);
    child.once("error", () => { record("process-error"); finish(null, null); });
    child.once("close", (exitCode, signal) => { processClosed = true; finish(exitCode, signal); });
  });
  process.stdout.write(`Windows compiler observation: ${JSON.stringify(result)}\n`);
  if (result.timedOut && (!result.treeTerminationConfirmed || !result.processClosed)) {
    throw new Error("The owned compiler process tree did not confirm retirement; further controls were stopped.");
  }
  return !result.timedOut && result.exitCode === 0 && events.some(event => event.phase === "compiler-complete");
}

await observe("minimal-before-control", baseline);
await observe("inherited-control", { ...process.env });
await observe("minimal-after-control", baseline);
await observe("exact-command-discovery", baseline,
  "[Console]::Out.WriteLine('command-discovery-start'); Get-Command Add-Type -ErrorAction Stop | Out-Null; [Console]::Out.WriteLine('command-discovery-complete')");
await observe("system-module-path", { ...baseline, PSModulePath: modules });
const utility = join(modules, "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Utility.psd1").replaceAll("'", "''");
await observe("explicit-system-utility", baseline,
  `[Console]::Out.WriteLine('module-import-start'); Import-Module '${utility}' -ErrorAction Stop; [Console]::Out.WriteLine('module-import-complete')`);
const profilePassed = await observe("profile-group", { ...baseline, ...profile });
const commandsPassed = await observe("system-command-group", { ...baseline, ...systemCommands });
if (profilePassed) {
  for (const name of profileNames.filter(name => profile[name] !== undefined)) {
    await observe(`profile-${name.toLowerCase()}`, { ...baseline, [name]: profile[name] });
  }
}
if (commandsPassed) {
  await observe("system-path", { ...baseline, Path: systemCommands.Path });
  await observe("system-command-processor", { ...baseline, ComSpec: systemCommands.ComSpec });
}
process.stdout.write("Compiler observations completed; this is not an SSH permission acceptance result.\n");
