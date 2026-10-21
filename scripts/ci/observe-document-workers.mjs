import childProcess from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const parserTraceDirectory = process.env.JOKO_PDF_PROCESS_OBSERVATION_DIR;
if (parserTraceDirectory && process.send && process.env.JOKO_PARENT_PROCESS_ID === String(process.ppid)) {
  // Persist only fixed phase names: Windows termination does not run exit hooks.
  // Observing newListener avoids consuming or changing Node's queued IPC input.
  let records = 0;
  const record = phase => {
    if (records++ >= 8) return;
    try {
      appendFileSync(join(parserTraceDirectory, `pdf-parser-${process.pid}.jsonl`), `${JSON.stringify({
        pid: process.pid, phase, elapsedMs: Math.round(performance.now())
      })}\n`, { mode: 0o600 });
    } catch { /* A diagnostic must not change the parser result. */ }
  };
  record("preload");
  let listening = false;
  process.on("newListener", event => {
    if (event === "message" && !listening) { listening = true; record("listening"); }
  });
  const send = process.send;
  process.send = function (...parameters) {
    record("response");
    return Reflect.apply(send, this, parameters);
  };
  process.once("exit", () => record("exit"));
} else {
  if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
    throw new Error("Document worker observations require the Windows Actions test runner.");
  }
  const directory = join(process.env.RUNNER_TEMP, "joko-ci-logs", "document-processes");
  mkdirSync(directory, { recursive: true });
  const preload = import.meta.url;

  const fork = childProcess.fork;
  let occurrence = 0;
  childProcess.fork = function (...parameters) {
    const options = parameters[2];
    const parser = typeof parameters[0] === "string" && /[/\\]inspectPdf-worker\.(?:ts|js)$/u.test(parameters[0])
      && options?.env?.JOKO_PARENT_PROCESS_ID === String(process.pid);
    if (parser) {
      parameters[2] = { ...options,
        execArgv: [...options.execArgv, "--import", preload],
        env: { ...options.env, JOKO_PDF_PROCESS_OBSERVATION_DIR: directory }
      };
    }
    const started = performance.now();
    const child = Reflect.apply(fork, this, parameters);
    const worker = ++occurrence;
    const record = (phase, details = {}) => process.stderr.write(`Document process observation: ${JSON.stringify({
      kind: parser ? "parser" : "test-worker", worker, pid: child.pid, phase,
      elapsedMs: Math.round(performance.now() - started), ...details
    })}\n`);
    child.once("spawn", () => record("spawn"));
    if (parser) child.once("message", () => record("response"));
    child.once("exit", (exitCode, signal) => record("exit", { exitCode, signal }));
    return child;
  };
  syncBuiltinESMExports();
}
