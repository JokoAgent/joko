import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

it("retires its loaded PDF process after owner death even when the main thread cannot handle IPC disconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-pdf-parent-exit-"));
  const blocker = join(directory, "blocked-parser.mjs"), owner = join(directory, "owner.mjs");
  await writeFile(blocker, `
    await import(${JSON.stringify(new URL("./inspectPdf-worker.ts", import.meta.url).href)});
    // Load the exact production parser and its independent watchdog, then use
    // a native blocking wait to make the main thread unable to process IPC.
    process.send({ kind: 'parser-main-thread-blocked', parserPid: process.pid }, () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    });
  `);
  await writeFile(owner, `
    import { fork } from 'node:child_process';
    const parser = fork(${JSON.stringify(blocker)}, [], { execArgv: ['--max-old-space-size=128', '--max-semi-space-size=4'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP, TMP: process.env.TMP, JOKO_PARENT_PROCESS_ID: String(process.pid),
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } });
    parser.once('message', value => setTimeout(() => process.send(value), 250));
    parser.once('error', () => process.send({ kind: 'startup-error' }));
    parser.once('exit', () => process.send({ kind: 'startup-error' }));
  `);
  const host = fork(owner, [], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], WINDIR: process.env["WINDIR"],
      TEMP: process.env["TEMP"], TMP: process.env["TMP"], ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}) } });
  let parserPid: number | undefined;
  const exists = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  try {
    const ready = await new Promise<{ kind: string; parserPid: number }>((accept, reject) => {
      const timer = setTimeout(() => reject(new Error("The isolated PDF host did not start.")), 15_000);
      host.once("error", error => { clearTimeout(timer); reject(error); });
      host.once("exit", () => { clearTimeout(timer); reject(new Error("The PDF fixture host exited before readiness.")); });
      host.once("message", value => { clearTimeout(timer); accept(value as { kind: string; parserPid: number }); });
    });
    expect(ready.kind).toBe("parser-main-thread-blocked");
    const candidatePid = ready.parserPid;
    expect(Number.isSafeInteger(candidatePid) && candidatePid > 1 && candidatePid !== process.pid && candidatePid !== host.pid).toBe(true);
    parserPid = candidatePid;
    expect(exists(parserPid)).toBe(true);
    const hostClosed = new Promise<void>((accept) => host.once("close", () => accept()));
    expect(host.kill("SIGKILL")).toBe(true);
    await hostClosed;
    await vi.waitFor(() => expect(exists(parserPid!)).toBe(false), { timeout: 5_000, interval: 25 });
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    if (parserPid !== undefined && exists(parserPid)) {
      process.kill(parserPid, "SIGKILL");
      await vi.waitFor(() => expect(exists(parserPid!)).toBe(false), { timeout: 2_000, interval: 25 });
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);
