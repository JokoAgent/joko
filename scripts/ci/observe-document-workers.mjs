import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// This preload observes the test runner's forks, never document contents or
// the arguments/environment inherited by those processes.
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Document worker observations require the Windows Actions test runner.");
}

const fork = childProcess.fork;
let occurrence = 0;
childProcess.fork = function (...parameters) {
  const child = Reflect.apply(fork, this, parameters);
  const worker = ++occurrence;
  const started = performance.now();
  child.once("exit", (exitCode, signal) => {
    process.stderr.write(`Document test worker exit: ${JSON.stringify({
      worker, exitCode, signal, elapsedMs: Math.round(performance.now() - started)
    })}\n`);
  });
  return child;
};
syncBuiltinESMExports();
