import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
let owner, birth;

function processState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), end = stat.lastIndexOf(")"), fields = stat.slice(end + 2).trim().split(/\s+/u);
    if (end < 0 || fields.length < 22 || !fields.slice(11, 13).every(value => /^\d+$/u.test(value)) || !/^\d+$/u.test(fields[19])) return undefined;
    const comm = stat.slice(stat.indexOf("(") + 1, end), status = readFileSync(`/proc/${pid}/status`, "utf8");
    const numeric = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, "mu").exec(status)?.[1] ?? 0);
    let wait = "unavailable";
    try { const value = readFileSync(`/proc/${pid}/wchan`, "utf8").trim(); if (/^[a-zA-Z0-9_]{1,80}$/u.test(value)) wait = value; } catch { /* The child may settle during observation. */ }
    const confirmed = readFileSync(`/proc/${pid}/stat`, "utf8"), confirmedEnd = confirmed.lastIndexOf(")");
    if (confirmedEnd < 0 || confirmed.slice(confirmedEnd + 2).trim().split(/\s+/u)[19] !== fields[19]) return undefined;
    return { pid, parent: Number(fields[1]), started: fields[19], state: /^[A-Z]$/u.test(fields[0]) ? fields[0] : "?",
      kind: ["java", "node", "cmake", "ninja", "clang", "clang++", "cc1", "sh", "bash"].includes(comm) ? comm : "other",
      cpuTicks: Number(fields[11]) + Number(fields[12]), rssKb: numeric("VmRSS"), swapKb: numeric("VmSwap"), threads: numeric("Threads"), wait };
  } catch { return undefined; }
}

function ownerCurrent() {
  return process.ppid === owner && processState(owner)?.started === birth && process.ppid === owner;
}

function ownedChildren(deadline) {
  if (!ownerCurrent()) return [];
  const found = [], pending = [owner], seen = new Set([process.pid]);
  while (pending.length && found.length < 48 && Date.now() < deadline && ownerCurrent()) {
    const pid = pending.shift(); if (seen.has(pid)) continue; seen.add(pid);
    const state = processState(pid); if (!state) continue; found.push(state);
    try {
      for (const tid of readdirSync(`/proc/${pid}/task`).filter(value => /^\d+$/u.test(value)).slice(0, 256)) {
        try {
          for (const value of readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim().split(/\s+/u)) {
            if (/^\d+$/u.test(value) && pending.length < 192) pending.push(Number(value));
          }
        } catch { /* An owned thread may exit. */ }
      }
    } catch { /* An owned process may exit. */ }
  }
  return found;
}

function javaThreads(state, deadline) {
  if (processState(state.pid)?.started !== state.started || !ownerCurrent()) return { pid: state.pid, available: false };
  const tool = join(process.env.JAVA_HOME ?? "", "bin", "jcmd");
  if (!isAbsolute(tool)) return { pid: state.pid, available: false };
  const result = spawnSync(tool, [String(state.pid), "Thread.print"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: Math.max(1, Math.min(4_000, deadline - Date.now())), maxBuffer: 1024 * 1024, env: {}
  });
  if (!ownerCurrent() || processState(state.pid)?.started !== state.started) return { pid: state.pid, available: false };
  const parsed = parseAndroidBuildThreads(String(result.stdout ?? ""));
  return { pid: state.pid, available: parsed.totalThreads > 0, status: result.status,
    bounded: result.error?.code === "ENOBUFS" || parsed.truncated, timedOut: result.error?.code === "ETIMEDOUT", ...parsed };
}

/** Only fixed JVM states and framework method frames leave the private reader. */
export function parseAndroidBuildThreads(output) {
  const text = output.slice(0, 1024 * 1024);
  const threads = []; let current;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith('"')) { current = { state: "UNKNOWN", frames: [] }; threads.push(current); }
    if (!current) continue;
    const status = /^\s+java\.lang\.Thread\.State: (NEW|RUNNABLE|BLOCKED|WAITING|TIMED_WAITING|TERMINATED)\b/u.exec(line);
    if (status) current.state = status[1];
    const frame = /^\s+at ([a-zA-Z0-9_.$/<@>-]+)\((Native Method|Unknown Source|[a-zA-Z0-9_$.-]+\.(?:java|kt|kts|groovy|gradle|scala)(?::\d+)?)\)\s*$/u.exec(line);
    const method = frame?.[1].split("/").at(-1);
    if (method && /^(?:java\.(?:lang|util|net|io)|javax\.net|sun\.(?:nio|net)|jdk\.internal|org\.gradle|org\.jetbrains\.kotlin|com\.android|com\.google\.prefab|org\.apache\.http)\./u.test(method)
      && current.frames.length < 48) current.frames.push(`${method}(${frame[2]})`.slice(0, 240));
  }
  const states = {};
  for (const thread of threads) states[thread.state] = (states[thread.state] ?? 0) + 1;
  const score = thread => (thread.state === "BLOCKED" ? 4 : 0)
    + (thread.frames.some(frame => /(?:org\.gradle|com\.android|org\.jetbrains|java\.net|sun\.nio\.ch)/u.test(frame)) ? 2 : 0);
  return { totalThreads: threads.length, states, truncated: output.length !== text.length,
    deadlock: /Found (?:one|\d+) Java-level deadlock/u.test(text),
    threads: threads.sort((left, right) => score(right) - score(left)).slice(0, 12).map(thread => ({ state: thread.state,
      frames: [...new Set([...thread.frames.slice(0, 4), ...thread.frames.filter(frame => /^(?:org\.|com\.)/u.test(frame)).slice(0, 4)])] })) };
}

function cmakeState(deadline) {
  if (!ownerCurrent()) return [];
  const names = new Set(["CMakeOutput.log", "CMakeError.log", "CMakeConfigureLog.yaml", "configure_stdout.txt", "configure_stderr.txt"]);
  const files = [];
  for (const [label, candidate] of [["app", join(root, "apps/mobile/android/app/.cxx")], ["expo-modules-core", join(root, "apps/mobile/node_modules/expo-modules-core/android/.cxx")]]) {
    try {
      if (!ownerCurrent()) return [];
      const base = realpathSync(candidate), suffix = relative(root, base);
      if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) continue;
      const pending = [{ path: base, depth: 0 }]; let directories = 0;
      while (pending.length && directories++ < 128 && files.length < 24 && Date.now() < deadline && ownerCurrent()) {
        const directory = pending.shift();
        const directoryInfo = lstatSync(directory.path), canonical = realpathSync(directory.path), owned = relative(base, canonical);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || owned === ".." || owned.startsWith(`..${sep}`) || isAbsolute(owned)) continue;
        for (const entry of readdirSync(directory.path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).slice(0, 256)) {
          const path = join(directory.path, entry.name);
          if (entry.isDirectory() && directory.depth < 6) pending.push({ path, depth: directory.depth + 1 });
          else if (entry.isFile() && names.has(entry.name) && files.length < 24) {
            if (!ownerCurrent()) return [];
            const info = lstatSync(path), phases = [], actual = realpathSync(path), inside = relative(base, actual);
            if (!info.isFile() || info.isSymbolicLink() || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
            // Commands, cache values and raw logs may contain private inputs.
            // Retain only fixed CMake progress/error headings from a small tail.
            {
              if (!ownerCurrent()) return [];
              const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const opened = fstatSync(fd); if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) continue;
                if (!ownerCurrent()) return [];
                const bytes = Buffer.alloc(Math.min(8192, info.size)); readSync(fd, bytes, 0, bytes.length, Math.max(0, info.size - bytes.length));
                for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
                  const phase = /^-- (The (?:C|CXX|ASM) compiler identification|Detecting (?:C|CXX) compiler ABI info|Check for working (?:C|CXX) compiler|Configuring done|Generating done|Build files have been written)|^(CMake (?:Error|Warning))(?: at|:)/u.exec(line);
                  if (phase && phases.length < 16) phases.push(phase[1] ?? phase[2]);
                }
              } finally { closeSync(fd); }
            }
            files.push({ path: `${label}/${relative(base, path).split(sep).join("/")}`.slice(0, 256), bytes: info.size, modifiedAt: info.mtimeMs, phases });
          }
        }
      }
    } catch { /* This owned native build directory may not exist yet. */ }
  }
  return files;
}

let captured = false;
function capture(reason) {
  if (captured) return; captured = true;
  if (!ownerCurrent()) return;
  try {
    const at = Date.now(), deadline = at + 20_000, before = ownedChildren(deadline), threads = [];
    for (const state of before.filter(state => state.kind === "java").sort((left, right) => right.rssKb - left.rssKb).slice(0, 4)) {
      if (Date.now() >= deadline) break; threads.push(javaThreads(state, deadline));
    }
    const processes = before.map(state => { const after = processState(state.pid); return { ...state,
      ...(after?.started === state.started ? { cpuTicksDelta: after.cpuTicks - state.cpuTicks, observedMs: Date.now() - at } : { exited: true }) }; });
    const cmake = cmakeState(deadline);
    if (!ownerCurrent()) return;
    process.stderr.write(`[android-native-build-observation] ${JSON.stringify({ reason, processes, threads, cmake, bounded: Date.now() >= deadline })}\n`);
  } catch { if (ownerCurrent()) process.stderr.write('[android-native-build-observation] {"available":false}\n'); }
}

function observe() {
  owner = process.ppid; birth = processState(owner)?.started;
  if (process.platform !== "linux" || process.argv.length !== 2 || owner < 2 || birth === undefined) {
    throw new Error("The Android build observer requires its original Linux parent.");
  }
  const timer = setTimeout(() => capture("build-still-active-at-24-minutes"), 24 * 60_000);
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", value => { input = (input + value).slice(0, 6); if (input === "failed") capture("original-build-failed"); });
  process.stdin.on("end", () => clearTimeout(timer));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) observe();
