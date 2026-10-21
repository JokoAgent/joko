import { spawn } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { spawnTerminalHost } from "./host-pty.js";
import { terminalEnvironment } from "./shells.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

test("distinguishes confirmed no-start from host loss without native exit and bounds cleanup", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "joko-terminal-host-"));
  let nativePid: number | undefined;
  try {
    const options = { cwd: await realpath(workspace), cols: 80, rows: 24, env: terminalEnvironment() };
    await expect(spawnTerminalHost(join(workspace, "missing-shell"), [], options)).rejects.toMatchObject({ code: "SPAWN_FAILED", stateMayHaveChanged: false });
    const pty = await spawnTerminalHost(process.execPath, ["-e", "process.stdout.write('HOST_READY');setTimeout(()=>process.exit(0),2500)"], options);
    nativePid = pty.pid;
    let output = "";
    pty.onData((data) => { output += data; });
    const exited = new Promise<unknown>((done) => pty.onExit(done));
    await vi.waitFor(() => expect(output).toContain("HOST_READY"), { timeout: 5000 });
    const ownedHost = vi.mocked(spawn).mock.results.at(-1)!.value!;
    ownedHost.kill();
    await expect(exited).resolves.toMatchObject({ failureCode: "HOST_EXITED", processExitConfirmed: false });
    await expect(pty.kill()).rejects.toMatchObject({ code: "CLEANUP_UNKNOWN", stateMayHaveChanged: true });
    await vi.waitFor(() => expect(isAlive(nativePid!)).toBe(false), { timeout: 6000, interval: 50 });
  } finally {
    // The test's only native child also has its own bounded lifetime if its host dies.
    if (nativePid !== undefined) await vi.waitFor(() => expect(isAlive(nativePid!)).toBe(false), { timeout: 6000, interval: 50 });
    await rm(workspace, { recursive: true, force: true });
  }
}, 15_000);

function isAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

test("rejects a directory executable before native dispatch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "joko-terminal-executable-"));
  try {
    const cwd = await realpath(workspace);
    await expect(spawnTerminalHost(cwd, [], { cwd, cols: 80, rows: 24, env: terminalEnvironment() }))
      .rejects.toMatchObject({ code: "SPAWN_FAILED", stateMayHaveChanged: false });
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test.runIf(process.platform !== "win32")("rejects non-executable files and permits an executable symlink", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "joko-terminal-executable-"));
  try {
    const cwd = await realpath(workspace);
    const options = { cwd, cols: 80, rows: 24, env: terminalEnvironment() };
    const unavailable = join(cwd, "non-executable-shell");
    await writeFile(unavailable, "#!/bin/sh\nexit 0\n");
    await chmod(unavailable, 0o644);
    await expect(spawnTerminalHost(unavailable, [], options))
      .rejects.toMatchObject({ code: "SPAWN_FAILED", stateMayHaveChanged: false });
    const executable = join(cwd, "executable-shell");
    await symlink(process.execPath, executable);
    const pty = await spawnTerminalHost(executable, ["-e", "process.exit(0)"], options);
    const exited = new Promise<unknown>((done) => pty.onExit(done));
    await expect(exited).resolves.toMatchObject({ exitCode: 0, processExitConfirmed: true });
    await pty.kill();
  } finally { await rm(workspace, { recursive: true, force: true }); }
}, 15_000);
