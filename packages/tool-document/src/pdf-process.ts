import { fork, type ForkOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PdfParserRequest } from "./inspectPdf-worker.js";

/** An isolated parser occurrence. A termination receipt always means OS exit. */
export interface PdfParserProcess {
  once(event: "message", listener: (value: unknown) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export function createPdfParserProcess(request: PdfParserRequest): PdfParserProcess {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const entry = fileURLToPath(new URL(sourceMode ? "./inspectPdf-worker.ts" : "./inspectPdf-worker.js", import.meta.url));
  const options: ForkOptions & { readonly windowsHide: boolean } = {
    // V8's young generation is three semi-spaces: 4 MiB caps it at 12 MiB,
    // below the former worker's 16 MiB ceiling. Neither parser uses tsx.
    execArgv: ["--max-old-space-size=128", "--max-semi-space-size=4"],
    serialization: "advanced", windowsHide: true,
    env: {
      PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], WINDIR: process.env["WINDIR"],
      TEMP: process.env["TEMP"], TMP: process.env["TMP"],
      JOKO_PARENT_PROCESS_ID: String(process.pid),
      ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {})
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  };
  const child = fork(entry, [], options);
  let exited = false, exitCode = -1, requested = false, killAccepted = false;
  let retirement: Promise<number> | undefined;
  const normalizedExit = (code: number | null, signal: NodeJS.Signals | null): number => code === 0 ? 0
    : requested && killAccepted && (signal === "SIGTERM" || signal === "SIGKILL" || code === 1) ? 1 : -1;
  // Keep a harmless listener after a consumer's once(error) has been consumed;
  // a late IPC send failure must never become a host's unhandled error event.
  child.on("error", () => undefined);
  child.once("exit", (code, signal) => { exited = true; exitCode = normalizedExit(code, signal); });
  child.send(request, error => { if (error) child.emit("error", error); });
  return {
    once(event: "message" | "error" | "exit", listener: ((value: unknown) => void) | ((error: Error) => void) | ((code: number) => void)): unknown {
      if (event === "exit") return child.once("exit", () => (listener as (code: number) => void)(exitCode));
      if (event === "error") return child.once("error", error => (listener as (error: Error) => void)(error));
      return child.once("message", value => (listener as (value: unknown) => void)(value));
    },
    terminate(): Promise<number> {
      if (exited) return Promise.resolve(exitCode);
      if (retirement) return retirement;
      requested = true;
      retirement = new Promise<number>((accept, reject) => {
        let hardStop: ReturnType<typeof setTimeout>, deadline: ReturnType<typeof setTimeout>;
        const clear = (): void => { clearTimeout(hardStop); clearTimeout(deadline); child.removeListener("exit", confirmed); };
        const confirmed = (): void => { clear(); accept(exitCode); };
        child.once("exit", confirmed);
        try { killAccepted = child.kill("SIGTERM"); } catch { /* OS exit is still required. */ }
        hardStop = setTimeout(() => { try { killAccepted = child.kill("SIGKILL") || killAccepted; } catch { /* No exit receipt means unknown. */ } }, 250);
        deadline = setTimeout(() => { clear(); reject(new Error("PDF parser exit could not be confirmed.")); }, 1000);
      });
      return retirement;
    }
  };
}
