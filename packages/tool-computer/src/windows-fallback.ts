import type { ComputerCommandRunner } from "./process-runner.js";

export type ComputerWindowsFallbackTool = "list_windows" | "list_apps";

interface WindowsFallbackWindow {
  readonly window_id: number;
  readonly pid: number;
  readonly title: string;
  readonly process_name: string;
  readonly executable_path?: string;
  readonly on_screen: boolean;
  readonly minimized: boolean;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

const WINDOWS_SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class JokoWindowSnapshot {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
$items = [System.Collections.Generic.List[object]]::new()
$callback = [JokoWindowSnapshot+EnumWindowsProc]{
  param([IntPtr]$hwnd, [IntPtr]$data)
  try {
    if (-not [JokoWindowSnapshot]::IsWindowVisible($hwnd)) { return $true }
    $processId = [uint32]0
    [void][JokoWindowSnapshot]::GetWindowThreadProcessId($hwnd, [ref]$processId)
    $rect = New-Object JokoWindowSnapshot+Rect
    [void][JokoWindowSnapshot]::GetWindowRect($hwnd, [ref]$rect)
    $width = [Math]::Max(0, $rect.Right - $rect.Left)
    $height = [Math]::Max(0, $rect.Bottom - $rect.Top)
    if ($processId -eq 0 -or $width -eq 0 -or $height -eq 0) { return $true }
    $title = New-Object System.Text.StringBuilder 2048
    [void][JokoWindowSnapshot]::GetWindowTextW($hwnd, $title, $title.Capacity)
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $executable = $null
    try { $executable = $process.MainModule.FileName } catch {}
    $minimized = [JokoWindowSnapshot]::IsIconic($hwnd)
    $items.Add([pscustomobject]@{
      window_id = $hwnd.ToInt64()
      pid = [int]$processId
      title = $title.ToString()
      process_name = if ($process) { $process.ProcessName } else { '' }
      executable_path = $executable
      on_screen = [bool](-not $minimized)
      minimized = [bool]$minimized
      bounds = [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = $width; height = $height }
    })
  } catch {}
  return $true
}
[void][JokoWindowSnapshot]::EnumWindows($callback, [IntPtr]::Zero)
$items | ConvertTo-Json -Compress -Depth 5
`;

export async function callWindowsComputerFallback(
  runner: ComputerCommandRunner,
  name: ComputerWindowsFallbackTool,
  arguments_: Readonly<Record<string, unknown>>,
  signal?: AbortSignal
): Promise<Readonly<Record<string, unknown>>> {
  const result = await runner.run({
    command: "powershell.exe",
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_SNAPSHOT_SCRIPT
    ],
    timeoutMs: 4_000,
    signal,
    maximumStdoutBytes: 2 * 1024 * 1024,
    maximumStderrBytes: 32 * 1024
  });
  if (result.exitCode !== 0) throw new Error("Windows computer automation fallback failed.");
  const windows = parseWindowsComputerSnapshot(result.stdout);
  if (name === "list_apps") return {
    ok: true,
    source: "win32_fallback",
    apps: applicationsFromWindows(windows)
  };
  return {
    ok: true,
    source: "win32_fallback",
    windows: filterWindows(windows, arguments_)
  };
}

export function parseWindowsComputerSnapshot(value: string): readonly WindowsFallbackWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim() || "[]");
  } catch {
    throw new Error("Windows computer automation fallback returned invalid data.");
  }
  const items = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  return items.flatMap((item) => {
    if (!isRecord(item) || !isRecord(item["bounds"])) return [];
    const windowId = positiveInteger(item["window_id"], true);
    const processId = positiveInteger(item["pid"], false);
    const x = finiteNumber(item["bounds"]["x"]);
    const y = finiteNumber(item["bounds"]["y"]);
    const width = finiteNumber(item["bounds"]["width"]);
    const height = finiteNumber(item["bounds"]["height"]);
    if (windowId === undefined || processId === undefined || x === undefined || y === undefined || width === undefined || height === undefined) return [];
    return [{
      window_id: windowId,
      pid: processId,
      title: boundedString(item["title"]),
      process_name: boundedString(item["process_name"]),
      ...(typeof item["executable_path"] === "string" ? { executable_path: boundedString(item["executable_path"], 32_768) } : {}),
      on_screen: item["on_screen"] === true,
      minimized: item["minimized"] === true,
      bounds: { x, y, width, height }
    }];
  });
}

function filterWindows(
  windows: readonly WindowsFallbackWindow[],
  arguments_: Readonly<Record<string, unknown>>
): readonly WindowsFallbackWindow[] {
  const processId = typeof arguments_["pid"] === "number" ? arguments_["pid"] : undefined;
  const processName = normalizedFilter(arguments_["process_name"]);
  const query = normalizedFilter(arguments_["query"]);
  const workspaceRoot = normalizedPathFilter(arguments_["workspace_root"]);
  return windows.filter((window) => {
    if (arguments_["on_screen_only"] === true && !window.on_screen) return false;
    if (processId !== undefined && window.pid !== processId) return false;
    if (processName !== undefined && !window.process_name.toLowerCase().includes(processName)) return false;
    if (query !== undefined && !`${window.title}\n${window.process_name}\n${window.executable_path ?? ""}`.toLowerCase().includes(query)) return false;
    if (workspaceRoot !== undefined) {
      const executable = window.executable_path?.replaceAll("\\", "/").toLowerCase();
      if (executable === undefined || (!executable.startsWith(`${workspaceRoot}/`) && executable !== workspaceRoot)) return false;
    }
    return true;
  });
}

function applicationsFromWindows(windows: readonly WindowsFallbackWindow[]): readonly Readonly<Record<string, unknown>>[] {
  const applications = new Map<number, Readonly<Record<string, unknown>>>();
  for (const window of windows) {
    if (applications.has(window.pid)) continue;
    applications.set(window.pid, {
      pid: window.pid,
      name: window.process_name,
      running: true,
      ...(window.executable_path === undefined ? {} : { executable_path: window.executable_path })
    });
  }
  return [...applications.values()];
}

function positiveInteger(value: unknown, allowZero: boolean): number | undefined {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < (allowZero ? 0 : 1)) return undefined;
  return value;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedString(value: unknown, maximum = 4_096): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum) : "";
}

function normalizedFilter(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim().toLowerCase();
}

function normalizedPathFilter(value: unknown): string | undefined {
  return normalizedFilter(typeof value === "string" ? value.replaceAll("\\", "/").replace(/\/$/u, "") : value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
