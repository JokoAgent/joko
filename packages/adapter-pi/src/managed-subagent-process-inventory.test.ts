import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { readManagedSubagentRecoveryInventory } from "./managed-subagent-process-inventory.js";

describe("terminal receipt process-exit proof", () => {
  it("does not mistake a live native child for the runner having exited", async () => {
    const nativeSessionId = randomUUID();
    const child = spawn(process.execPath, ["-e", "console.log('ready'); process.stdin.resume()", nativeSessionId],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
      const inventory = await readManagedSubagentRecoveryInventory(Date.now() + 8_000);
      expect(inventory).toBeDefined();
      expect(inventory?.some(command => command.includes(nativeSessionId))).toBe(true);
    } finally {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.stdin.end();
      child.kill();
      await closed;
    }
  }, 15_000);

  it.each([
    { complete: false, count: 1, commands: ["node child"] },
    { complete: true, count: 2, commands: ["node child"] },
    { complete: true, count: 0, commands: [] },
    { complete: true, count: 1, commands: [""] }
  ])("refuses incomplete or unreadable Windows observations", async value => {
    const execute = vi.fn(async () => ({ stdout: JSON.stringify(value) }));
    expect(await readManagedSubagentRecoveryInventory(Date.now() + 1000, { platform: "win32",
      windowsPowerShellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", execute })).toBeUndefined();
  });

  it("preserves a complete current-account inventory and one original deadline", async () => {
    const execute = vi.fn(async (_executable: string, _args: readonly string[], _limits: { readonly timeout: number }) =>
      ({ stdout: JSON.stringify({ complete: true, count: 1, commands: ["node child"] }) }));
    const deadline = Date.now() + 500;
    expect(await readManagedSubagentRecoveryInventory(deadline, { platform: "win32",
      windowsPowerShellExecutable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", execute })).toEqual(["node child"]);
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    expect(execute.mock.calls[0]?.[2].timeout).toBeLessThanOrEqual(500);
    const expired = vi.fn();
    expect(await readManagedSubagentRecoveryInventory(Date.now() - 1, { execute: expired })).toBeUndefined();
    expect(expired).not.toHaveBeenCalled();
  });
});
