import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTrustedWindowsPowerShellExecutable } from "./managed-subagent-process-inspector.js";

const execFileAsync = promisify(execFile);
type InventoryQuery = (executable: string, args: readonly string[], limits: {
  readonly encoding: "utf8"; readonly timeout: number; readonly maxBuffer: number; readonly windowsHide?: boolean;
}) => Promise<{ readonly stdout: string }>;

/** Read-only, uncached current-account inventory. Empty, partial or unreadable
 * observations never prove absence. No discovered PID is termination authority. */
export async function readManagedSubagentRecoveryInventory(deadline: number, options: {
  readonly platform?: NodeJS.Platform;
  readonly userId?: number;
  readonly windowsPowerShellExecutable?: string;
  readonly execute?: InventoryQuery;
} = {}): Promise<readonly string[] | undefined> {
  const platform = options.platform ?? process.platform;
  const query: InventoryQuery = options.execute ?? ((executable, args, limits) => execFileAsync(executable, [...args], limits));
  try {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0) return undefined;
    if (platform === 'win32') {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
        // tasklist reports itself, then exits before CIM runs. Track only our
        // own probe PID so that its expected exit cannot block every recovery.
        '$probe = [System.Diagnostics.Process]::new()',
        '$probe.StartInfo.FileName = "$env:SystemRoot\\System32\\tasklist.exe"',
        '$probe.StartInfo.Arguments = \'/V /FO CSV /NH /FI "USERNAME eq \' + $user + \'"\'',
        '$probe.StartInfo.UseShellExecute = $false',
        '$probe.StartInfo.CreateNoWindow = $true',
        '$probe.StartInfo.RedirectStandardOutput = $true',
        'if (-not $probe.Start()) { throw "tasklist did not start" }',
        '$probeId = $probe.Id',
        '$csv = $probe.StandardOutput.ReadToEnd()',
        '$probe.WaitForExit()',
        '$probeExitCode = $probe.ExitCode',
        '$probe.Dispose()',
        'if ($probeExitCode -ne 0) { throw "tasklist failed" }',
        '$owned = @($csv | ConvertFrom-Csv -Header Name,ProcessId,SessionName,SessionNumber,Memory,Status,UserName,CPUTime,WindowTitle)',
        '$processIds = @{}',
        'foreach ($row in $owned) {',
        '  $number = 0',
        '  if (-not [int]::TryParse($row.ProcessId, [ref]$number) -or $number -le 0) { throw "invalid process inventory" }',
        '  if ($number -eq $probeId) { continue }',
        '  $processIds[$number] = $true',
        '}',
        '$count = $processIds.Count',
        '$commands = [System.Collections.Generic.List[string]]::new()',
        '$complete = $true',
        '$items = @(Get-CimInstance Win32_Process -ErrorAction Stop)',
        'foreach ($item in $items) {',
        '  $number = [int]$item.ProcessId',
        '  if (-not $processIds.ContainsKey($number)) { continue }',
        '  if ([string]::IsNullOrWhiteSpace($item.CommandLine)) { continue }',
        '  $commands.Add($item.CommandLine)',
        '  $processIds.Remove($number)',
        '}',
        // DefenderSessionHelper can belong to this user but hide its command
        // line. Never exempt an image name: query the OS protection level with
        // minimum read-only rights. Only ANTIMALWARE_LIGHT is excluded; NONE,
        // third-party PPL_APP, unknown levels and query failures remain unknown.
        // https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessinformation
        'if ($processIds.Count -gt 0) {',
        "Add-Type -TypeDefinition @'",
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class JokoRecoveryProcessProtection {',
        '  [DllImport("kernel32.dll", SetLastError = true)]',
        '  private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);',
        '  [DllImport("kernel32.dll", SetLastError = true)]',
        '  private static extern bool GetProcessInformation(IntPtr handle, int kind, out uint level, uint size);',
        '  [DllImport("kernel32.dll")]',
        '  private static extern bool CloseHandle(IntPtr handle);',
        '  public static bool IsAntimalware(uint pid) {',
        '    IntPtr handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION',
        '    if (handle == IntPtr.Zero) return false;',
        '    try {',
        '      uint level;',
        '      return GetProcessInformation(handle, 7, out level, 4) && level == 3; // ProcessProtectionLevelInfo / ANTIMALWARE_LIGHT',
        '    } finally { CloseHandle(handle); }',
        '  }',
        '}',
        "'@",
        '}',
        // Other short-lived processes can exit between tasklist and CIM too.
        // Missing command lines alone are not exit evidence; independently
        // check each remaining PID. Retire only confirmed exits or the OS
        // antimalware role above, never an arbitrary unreadable live process.
        'foreach ($number in @($processIds.Keys)) {',
        '  $unreadable = $null',
        '  try {',
        '    $unreadable = [System.Diagnostics.Process]::GetProcessById($number)',
        '    if ($unreadable.HasExited -or [JokoRecoveryProcessProtection]::IsAntimalware($number)) { $count-- } else { $complete = $false }',
        '  } catch [System.ArgumentException] {',
        '    $count--',
        '  } finally {',
        '    if ($null -ne $unreadable) { $unreadable.Dispose() }',
        '  }',
        '}',
        '@{ complete = $complete; commands = @($commands.ToArray()); count = $count } | ConvertTo-Json -Compress',
      ].join('\n');
      const powershell = options.windowsPowerShellExecutable ?? await resolveTrustedWindowsPowerShellExecutable();
      if (powershell === undefined) return undefined;
      const { stdout } = await query(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: Math.min(8_000, remaining), maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });
      const value = JSON.parse(stdout);
      if (value?.complete !== true || !Number.isSafeInteger(value.count) || value.count <= 0
        || !Array.isArray(value.commands) || value.commands.length !== value.count
        || value.commands.some((command: unknown) => typeof command !== 'string' || !command.trim())) return undefined;
      return value.commands;
    }
    const uid = options.userId ?? process.geteuid?.();
    if (!Number.isSafeInteger(uid)) return undefined;
    const { stdout } = await query('/bin/ps', ['-ww', '-u', String(uid), '-o', 'pid=,args='], {
      encoding: 'utf8', timeout: Math.min(1_000, remaining), maxBuffer: 4 * 1024 * 1024,
    });
    const lines = stdout.trim().split('\n');
    const commands: string[] = [];
    for (const line of lines) {
      const match = /^\s*([1-9]\d*)\s+(.+)$/.exec(line);
      if (!match || !match[2]!.trim()) return undefined;
      commands.push(match[2]!);
    }
    return commands.length > 0 ? commands : undefined;
  } catch {
    return undefined;
  }
}
