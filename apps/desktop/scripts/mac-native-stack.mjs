import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The isolated, stdlib-only supervisor inherits Node's bounded output pipes.
// It owns and reaps exactly the child it spawned, even on TERM from sudo.
export const MAC_STACK_SUPERVISOR = `import os, signal, subprocess, sys
child = None
stopping = False
def retire(code):
    global stopping
    if stopping: return
    stopping = True
    if child is not None and child.poll() is None:
        child.kill()
        try: child.wait(timeout=0.75)
        except subprocess.TimeoutExpired:
            os.write(2, b"JOKO_STACK_CHILD_CLEANUP_UNCONFIRMED\\n")
            os._exit(126)
    os.write(2, b"JOKO_STACK_CHILD_RETIRED\\n")
    os._exit(code)
signal.signal(signal.SIGTERM, lambda signum, frame: retire(143))
try:
    # Defer TERM across the spawn/assignment gap; otherwise the handler could
    # see None after fork and leave an unowned privileged sampler behind.
    masking = hasattr(signal, "pthread_sigmask")
    oldmask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM}) if masking else None
    try:
        child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL,
            preexec_fn=(lambda: signal.pthread_sigmask(signal.SIG_SETMASK, oldmask)) if masking else None)
    finally:
        if masking: signal.pthread_sigmask(signal.SIG_SETMASK, oldmask)
    try: code = child.wait(timeout=10)
    except subprocess.TimeoutExpired: retire(124)
    os.write(2, b"JOKO_STACK_CHILD_RETIRED\\n")
    sys.exit(code)
except BaseException:
    if child is not None and child.poll() is None: retire(125)
    raise
`;
export const MAC_STACK_SUPERVISOR_SHA256 = createHash("sha256").update(MAC_STACK_SUPERVISOR).digest("hex");

const token = (text, flag) => new RegExp(`(?:^|[\\s[(])${flag}(?=$|[\\s\\]),;])`, "u").test(text);
const plainManual = text => text.replace(/.\x08/gu, "").replace(/\x1b\[[0-9;]*m/gu, "");
export function selectMacNativeStackArguments(help, pid) {
  if (typeof help !== "string" || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (!["-onlyTarget", "-noBinary", "-stdout", "-o", "-noSymbolicate"].every(flag => token(help, flag))) return undefined;
  if (!/-onlyTarget\b[\s\S]{0,240}?Only\s+sample\s+the\s+target\s+process/iu.test(help)) return undefined;
  return [String(pid), "1", "10", "-onlyTarget", "-noSymbolicate", "-noBinary", "-stdout", "-o", "/dev/null"];
}

export async function discoverMacNativeStackTool(runTool = readTool) {
  const result = { version: 1, platform: process.platform, tool: "/usr/sbin/spindump", status: "unavailable",
    sampleSeconds: 1, intervalMs: 10, toolDeadlineMs: 12_000, supervisorDeadlineMs: 10_000,
    supervisorSha256: MAC_STACK_SUPERVISOR_SHA256 };
  if (process.platform !== "darwin") return { ...result, reason: "platform_unavailable" };
  try {
    for (const path of ["/usr/bin/man", "/bin/cat", "/usr/sbin/spindump", "/usr/bin/sudo", "/usr/bin/python3"]) {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path) return { ...result, reason: "tool_not_canonical" };
    }
    const manual = await runTool("/usr/bin/man", ["-P", "/bin/cat", "spindump"], 1_500, 64 * 1024, true);
    const manText = plainManual(manual.output);
    // -i is checked against the installed manual before running the parser on
    // an empty file. This is an offline parse, never a default system profile.
    if (manual.reason !== undefined || !token(manText, "-i") ||
      !/-i\b[\s\S]{0,400}?Read\s+in\s+the\s+file/iu.test(manText)) {
      return { ...result, reason: "offline_parser_not_documented", manual: manText };
    }
    let usage = await runTool("/usr/sbin/spindump", ["-i", "/dev/null"], 1_500, 64 * 1024, true);
    let offlineArguments = ["-i", "/dev/null"];
    if (selectMacNativeStackArguments(`${usage.output}\n${manText}`, process.pid) === undefined) {
      // Even when -h is unsupported, the verified -i offline mode prevents
      // this usage query from sampling any live or default system process.
      offlineArguments = ["-i", "/dev/null", "-h"];
      usage = await runTool("/usr/sbin/spindump", offlineArguments, 1_500, 64 * 1024, true);
    }
    const toolHelp = `${usage.output}\n${manText}`.slice(0, 64 * 1024);
    const argumentsTemplate = selectMacNativeStackArguments(toolHelp, process.pid);
    return { ...result, status: argumentsTemplate === undefined ? "unavailable" : "available",
      ...(argumentsTemplate === undefined ? { reason: "target_only_symbol_less_arguments_unavailable" } : {}),
      toolHelp, toolHelpSource: "installed_manual_and_offline_empty_input_parser",
      offlineProbe: { arguments: offlineArguments, reason: usage.reason ?? "completed" },
      ...(argumentsTemplate === undefined ? {} : { argumentsTemplate: ["<proof-owned-pid>", ...argumentsTemplate.slice(1)] }),
      launcher: "/usr/bin/sudo -n /usr/bin/python3 -I", symbolicationMode: "disabled" };
  } catch { return { ...result, reason: "tool_discovery_failed" }; }
}

function readTool(path, args, timeout, maxBuffer, includeHelp) {
  return new Promise(resolve => execFile(path, args, { timeout, killSignal: "SIGKILL", maxBuffer,
    env: { LC_ALL: "C", TZ: "UTC0", MANPAGER: "/bin/cat", PAGER: "/bin/cat" } }, (error, stdout, stderr) => {
    resolve({ reason: error === null ? undefined : "tool_failed", output: includeHelp ? `${stdout}\n${stderr}` : stdout });
  }));
}

/** At most one privileged tool; stop uses TERM forwarding, never kills only sudo. */
export function runMacNativeStack({ arguments: args, capture, onDone, launcher = "/usr/bin/sudo", launcherArguments }) {
  let child, exited = false, exitCode, exitSignal, requestedReason, finished = false, stopTimer, finalTimer;
  let cleanupReceipt = false, stderrTail = "";
  const sizes = { stdout: 0, stderr: 0 };
  const output = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = reason => {
    if (finished) return;
    finished = true; clearTimeout(stopTimer); clearTimeout(finalTimer);
    const cleanup = { wrapperExited: exited, wrapperExitCode: exitCode ?? null, wrapperSignal: exitSignal ?? null,
      samplerExitConfirmed: exited && cleanupReceipt && exitCode !== 126 };
    const finalReason = reason ?? (cleanup.samplerExitConfirmed ? undefined : "sampler_cleanup_unconfirmed");
    try { capture.finish(finalReason, cleanup); } catch { /* Diagnostic-only output. */ }
    child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    const result = { reason: finalReason, ...cleanup, output: Buffer.concat(output).toString("utf8") }; onDone?.(result); resolveDone(result);
  };
  const stop = (reason = "primary_lifetime_ended") => {
    requestedReason ??= reason;
    if (!finished && !exited) { try { child?.kill("SIGTERM"); } catch { /* Final receipt remains unconfirmed. */ } }
    return done;
  };
  try {
    child = spawn(launcher, launcherArguments ?? ["-n", "/usr/bin/python3", "-I", "-c", MAC_STACK_SUPERVISOR, "/usr/sbin/spindump", ...args], {
      stdio: ["ignore", "pipe", "pipe"], env: { LC_ALL: "C", TZ: "UTC0" }, windowsHide: true
    });
    for (const name of ["stdout", "stderr"]) child[name].on("data", chunk => {
      if (name === "stderr") {
        stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-256);
        if (stderrTail.includes("JOKO_STACK_CHILD_RETIRED\n")) cleanupReceipt = true;
      }
      if (name === "stdout" && sizes.stdout < 1024 * 1024) output.push(Buffer.from(chunk.subarray(0, 1024 * 1024 - sizes.stdout)));
      sizes[name] += chunk.length; capture[name](chunk);
      if (sizes[name] > (name === "stdout" ? 1024 * 1024 : 16 * 1024)) void stop("output_limit");
    });
    child.once("error", () => finish("tool_unavailable"));
    child.once("exit", (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
    child.once("close", (code, signal) => finish(requestedReason ?? (code === 0 && signal === null ? undefined
      : code === 124 ? "tool_timeout" : code === 126 ? "sampler_cleanup_unconfirmed" : "tool_failed")));
    stopTimer = setTimeout(() => { void stop("tool_timeout"); }, 11_000);
    finalTimer = setTimeout(() => { void stop("tool_deadline_cleanup_unconfirmed"); finish("tool_deadline_cleanup_unconfirmed"); }, 12_000);
  } catch { finish("tool_unavailable"); }
  return { done, stop };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const capabilities = await discoverMacNativeStackTool();
  let preparationControl;
  if (capabilities.status === "available") {
    let control;
    control = runMacNativeStack({ arguments: [], launcherArguments: ["-n", "/usr/bin/python3", "-I", "-c", MAC_STACK_SUPERVISOR,
      "/usr/bin/python3", "-I", "-c", "import time; print('JOKO_STACK_PREPARATION_READY', flush=True); time.sleep(20)"], capture: {
      stdout: chunk => { if (chunk.toString("utf8").includes("JOKO_STACK_PREPARATION_READY")) void control.stop("preparation_cancel"); },
      stderr: () => {}, finish: () => {}
    } });
    const observed = await control.done;
    preparationControl = { status: observed.reason === "preparation_cancel" && observed.samplerExitConfirmed ? "passed" : "unavailable",
      reason: observed.reason, wrapperExited: observed.wrapperExited, wrapperExitCode: observed.wrapperExitCode,
      wrapperSignal: observed.wrapperSignal, samplerExitConfirmed: observed.samplerExitConfirmed };
  }
  process.stdout.write(`${JSON.stringify({ event: "JOKO_MAC_NATIVE_STACK_CAPABILITIES", ...capabilities,
    ...(preparationControl === undefined ? {} : { preparationControl }) })}\n`);
}
