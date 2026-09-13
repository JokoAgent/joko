import { createRequire } from "node:module";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

// This process is the lifetime owner of exactly one native PTY and its native workers.
// Shell input/output stays in bounded IPC memory and never reaches host stdio or files.
const native = createRequire(import.meta.url)("node-pty");
const MAXIMUM_PENDING_BYTES = 1024 * 1024;
const MAXIMUM_CHUNK_BYTES = 64 * 1024;
const subscriptions = [];
let pty;
let started = false;
let paused = false;
let stopping = false;
let finishing = false;
let pendingBytes = 0;
let bufferedBytes = 0;
const buffered = [];
let nativeExit;
let lastCommand = 0;
let stopTimer;
const startupTimer = setTimeout(() => finish(1), 8000);

function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value, keys) { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function integer(value, minimum, maximum) { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function string(value, maximum) { return typeof value === "string" && !value.includes("\0") && value.length <= maximum; }
function validEnvironment(value) {
  return object(value) && Object.keys(value).length <= 64 && Object.entries(value).every(([key, item]) => string(key, 128) && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && string(item, 32768)) && Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024;
}

function send(message, callback) {
  if (!process.connected) { stop(); return; }
  try { process.send(message, (error) => { if (error) stop(); else callback?.(); }); }
  catch { stop(); }
}

function flow() {
  if (!pty || nativeExit || finishing) return;
  try { if (paused || pendingBytes + bufferedBytes >= 128 * 1024) pty.pause(); else if (pendingBytes + bufferedBytes < 32 * 1024) pty.resume(); }
  catch { fail(); }
}

function output(data) {
  if (finishing || typeof data !== "string") return;
  if (Buffer.byteLength(data) + pendingBytes + bufferedBytes > MAXIMUM_PENDING_BYTES) { fail(); return; }
  // Native strings are UTF-8 decoded; split only between Unicode code points.
  let chunk = "";
  let bytes = 0;
  for (const point of data) {
    const size = Buffer.byteLength(point);
    if (bytes + size > MAXIMUM_CHUNK_BYTES) { emit(chunk, bytes); chunk = ""; bytes = 0; }
    chunk += point; bytes += size;
  }
  if (chunk) emit(chunk, bytes);
  flow();
}

function emit(data, bytes) {
  if (!started) { buffered.push({ data, bytes }); bufferedBytes += bytes; return; }
  pendingBytes += bytes;
  send({ type: "data", data }, () => { pendingBytes -= bytes; flow(); finishExited(); });
}

function finishExited() {
  if (!nativeExit || (!started && !stopping) || pendingBytes > 0 || bufferedBytes > 0 || finishing) return;
  finishing = true;
  for (const subscription of subscriptions.splice(0)) subscription.dispose();
  send({ type: "exit", exitCode: nativeExit.exitCode, signal: nativeExit.signal ?? null }, () => finish(0));
}

function finish(code) {
  clearTimeout(startupTimer);
  clearTimeout(stopTimer);
  process.removeAllListeners("message");
  process.removeAllListeners("disconnect");
  for (const subscription of subscriptions.splice(0)) subscription.dispose();
  if (process.connected) process.disconnect();
  // Native onExit has ended the PTY. Ending its dedicated host also releases native
  // workers whose published API provides no separate post-exit disposal operation.
  process.exit(code);
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(startupTimer);
  buffered.length = 0; bufferedBytes = 0;
  if (!pty) {
    if (process.connected) send({ type: "not-started" }, () => finish(1));
    else finish(1);
    return;
  }
  if (nativeExit) { finishExited(); return; }
  stopTimer = setTimeout(() => finish(1), 5000);
  try { pty.resume(); pty.kill(); } catch { fail(); }
}

function fail() { send({ type: "fatal" }); stop(); }

process.on("disconnect", () => {
  // The authority process disappeared. No connection can adopt this PTY.
  if (nativeExit) finish(0);
  else stop();
});
process.on("message", (message) => {
  if (!object(message) || !string(message.type, 32)) { fail(); return; }
  if (message.type === "init") {
    if (pty || stopping || !exact(message, ["type", "executable", "args", "cwd", "cols", "rows", "env"]) || !string(message.executable, 8192) || !isAbsolute(message.executable) || !Array.isArray(message.args) || message.args.length > 64 || !message.args.every((arg) => string(arg, 8192)) || !string(message.cwd, 8192) || !isAbsolute(message.cwd) || !integer(message.cols, 2, 500) || !integer(message.rows, 1, 200) || !validEnvironment(message.env)) { fail(); return; }
    try {
      // Recheck after IPC startup, immediately before the synchronous native spawn.
      const directory = lstatSync(message.cwd);
      if (!directory.isDirectory() || directory.isSymbolicLink() || relative(message.cwd, realpathSync.native(message.cwd)) !== "") throw new Error();
      pty = native.spawn(message.executable, message.args, {
        name: "xterm-256color", cwd: message.cwd, cols: message.cols, rows: message.rows,
        env: message.env,
        ...(process.platform === "win32" ? { useConpty: true, useConptyDll: true } : { encoding: "utf8" })
      });
      subscriptions.push(pty.onData(output));
      subscriptions.push(pty.onExit((event) => { nativeExit = event; finishExited(); }));
      clearTimeout(startupTimer);
      send({ type: "ready", pid: pty.pid });
      flow();
    } catch { fail(); }
    return;
  }
  if (message.type === "kill" && exact(message, ["type"])) { stop(); return; }
  if (!pty || finishing || stopping) { fail(); return; }
  if (message.type === "start" && exact(message, ["type"]) && !started) {
    started = true;
    for (const chunk of buffered.splice(0)) { bufferedBytes -= chunk.bytes; emit(chunk.data, chunk.bytes); }
    flow(); finishExited(); return;
  }
  if ((message.type === "pause" || message.type === "resume") && exact(message, ["type"])) { paused = message.type === "pause"; flow(); return; }
  const write = message.type === "write" && exact(message, ["type", "id", "data"]) && typeof message.data === "string" && message.data.length > 0 && Buffer.byteLength(message.data) <= 64 * 1024;
  const resize = message.type === "resize" && exact(message, ["type", "id", "cols", "rows"]) && integer(message.cols, 2, 500) && integer(message.rows, 1, 200);
  if ((!write && !resize) || !integer(message.id, 1, Number.MAX_SAFE_INTEGER) || message.id !== lastCommand + 1) { fail(); return; }
  lastCommand = message.id;
  try {
    if (nativeExit) throw new Error();
    if (write) pty.write(message.data);
    else pty.resize(message.cols, message.rows);
    send({ type: "ack", id: message.id, ok: true });
  } catch { send({ type: "ack", id: message.id, ok: false }); }
});
