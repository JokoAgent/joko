import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "playwright-core";

export interface OwnedWindowsDesktopProcess {
  readonly pid: number;
  readonly executablePath: string;
  readonly startedAt: string;
}

export async function readLaunchedWindowsDesktopProcess(launcherPid: number, executablePath: string): Promise<OwnedWindowsDesktopProcess> {
  if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0) throw new Error("Invalid Desktop launcher PID.");
  const script = "$ErrorActionPreference = 'Stop'; $ownedCandidates = @(Get-CimInstance Win32_Process -Filter 'ProcessId = "
    + launcherPid + " OR ParentProcessId = " + launcherPid
    + "' | Where-Object { $_.ExecutablePath -eq $env:JOKO_E2E_DESKTOP_EXECUTABLE }); "
    + "if ($ownedCandidates.Count -ne 1) { throw 'Expected one Desktop main process under its launcher.' }; "
    + "$ownedProcess = $ownedCandidates[0]; [pscustomobject]@{ pid = $ownedProcess.ProcessId; executablePath = $ownedProcess.ExecutablePath; startedAt = $ownedProcess.CreationDate.ToUniversalTime().ToString('O') } | ConvertTo-Json -Compress";
  const output = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 10_000,
      env: { ...process.env, JOKO_E2E_DESKTOP_EXECUTABLE: executablePath }
    }, (error, stdout) => error ? rejectOutput(error) : resolveOutput(stdout));
  });
  return JSON.parse(output) as OwnedWindowsDesktopProcess;
}

export function createPackagedDesktopStartupEvidence() {
  let resultPath: string | undefined;
  return {
    environment(directory: string) {
      resultPath = join(directory, `launch-${randomUUID()}`);
      return { JOKO_DESKTOP_SMOKE_RESULT: resultPath };
    },
    async snapshot(application: ElectronApplication | undefined) {
      const progress = resultPath === undefined ? ""
        : await readFile(`${resultPath}.progress`, "utf8").catch(() => "");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const nativeState = application === undefined ? undefined : await Promise.race([
        application.evaluate(({ app, BrowserWindow }) => ({
          ready: app.isReady(), windows: BrowserWindow.getAllWindows().map(window => ({
            visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized()
          }))
        })).catch(() => undefined),
        new Promise<undefined>((resolveObservation) => { timer = setTimeout(() => resolveObservation(undefined), 1_000); })
      ]).finally(() => clearTimeout(timer));
      return {
        launcherExitCode: application?.process().exitCode ?? null,
        launcherSignal: application?.process().signalCode ?? null,
        nativeState: nativeState ?? null,
        stages: progress.split(/\r?\n/u).filter(Boolean).slice(0, 16).map((line) => line.split(" ", 1)[0])
      };
    },
    reset() { resultPath = undefined; }
  };
}
