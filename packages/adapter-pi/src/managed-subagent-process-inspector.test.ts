import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectManagedSubagentRunnerProcess,
  resolveTrustedWindowsPowerShellExecutable
} from "./managed-subagent-process-inspector.js";
import { mkdtemp } from "./test-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
});

describe("managed subagent process inspector", () => {
  it("uses the absolute validated SystemRoot PowerShell instead of executable search", async () => {
    const systemRoot = await temporaryDirectory();
    const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await mkdir(join(executable, ".."), { recursive: true });
    await writeFile(executable, "trusted fixture", { encoding: "utf8", mode: 0o600 });
    const calls: string[] = [];

    const inspection = await inspectManagedSubagentRunnerProcess(4321, "win32", {
      windowsSystemRoot: systemRoot,
      windowsQueryExecutor: async (selected, arguments_) => {
        calls.push(selected, ...arguments_);
        return {
          stdout: JSON.stringify({
            ExecutablePath: process.execPath,
            CommandLine: `"${process.execPath}" "C:\\trusted\\runner.cjs" "C:\\trusted\\config.json"`,
            CreationDate: "638918783000000000"
          })
        };
      }
    });

    expect(calls[0]?.toLowerCase()).toBe(executable.toLowerCase());
    expect(calls[0]).not.toBe("powershell.exe");
    expect(inspection).toMatchObject({
      executablePath: process.execPath,
      argv: [process.execPath, "C:\\trusted\\runner.cjs", "C:\\trusted\\config.json"]
    });
    expect(inspection?.processIdentity).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an aliased PowerShell executable before querying process authority", async () => {
    const systemRoot = await temporaryDirectory();
    const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const outside = await temporaryDirectory();
    const aliasedExecutable = join(outside, "WindowsPowerShell", "v1.0", "powershell.exe");
    await mkdir(join(aliasedExecutable, ".."), { recursive: true });
    await writeFile(aliasedExecutable, "outside fixture", { encoding: "utf8", mode: 0o600 });
    await symlink(outside, join(systemRoot, "System32"), "junction");

    await expect(resolveTrustedWindowsPowerShellExecutable({ windowsSystemRoot: systemRoot }))
      .resolves.toBeUndefined();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "joko-process-inspector-"));
  temporaryDirectories.push(directory);
  return directory;
}
