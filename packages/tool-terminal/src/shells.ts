import { access, constants, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import type { TerminalShell } from "./types.js";

const ENVIRONMENT_KEYS = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "OS",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "USER", "USERNAME", "LOGNAME", "TEMP", "TMP", "TMPDIR", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"
] as const;

/** Only operating-system, locale and shell profile paths cross the service/PTY boundary. */
export function terminalEnvironment(source: Readonly<NodeJS.ProcessEnv> = process.env): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ENVIRONMENT_KEYS) {
    const key = process.platform === "win32"
      ? Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
      : name;
    const value = key === undefined ? undefined : source[key];
    if (typeof value === "string" && !value.includes("\0")) result[name] = value;
  }
  result.TERM = "xterm-256color";
  result.COLORTERM = "truecolor";
  if (process.platform === "darwin" && !result.LC_ALL?.trim()
    && /^(?:C|POSIX)$/iu.test(result.LC_CTYPE?.trim() || result.LANG?.trim() || "C")) {
    result.LC_CTYPE = "UTF-8";
  }
  return result;
}

export async function discoverTerminalShells(source: Readonly<NodeJS.ProcessEnv> = process.env): Promise<TerminalShell[]> {
  const environment = terminalEnvironment(source);
  const pathDirectories = (environment.PATH ?? "").split(delimiter).filter((value) => isAbsolute(value));
  const definitions: { id: string; label: string; candidates: string[]; args: string[] }[] = [];
  const search = (file: string) => pathDirectories.map((directory) => join(directory, file));
  if (process.platform === "win32") {
    const windows = environment.SystemRoot ?? environment.WINDIR;
    const programFiles = source.ProgramFiles;
    const gitExecutables = await firstExecutable(search("git.exe"));
    definitions.push(
      { id: "pwsh", label: "PowerShell", candidates: [...search("pwsh.exe"), ...(programFiles === undefined ? [] : [join(programFiles, "PowerShell", "7", "pwsh.exe")])], args: ["-NoLogo"] },
      { id: "powershell", label: "Windows PowerShell", candidates: [...search("powershell.exe"), ...(windows === undefined ? [] : [join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")])], args: ["-NoLogo"] },
      { id: "cmd", label: "Command Prompt", candidates: [...(environment.COMSPEC === undefined ? [] : [environment.COMSPEC]), ...(windows === undefined ? [] : [join(windows, "System32", "cmd.exe")]), ...search("cmd.exe")], args: ["/d"] },
      { id: "gitbash", label: "Git Bash", candidates: [...(programFiles === undefined ? [] : [join(programFiles, "Git", "bin", "bash.exe")]), ...(gitExecutables === undefined ? [] : [join(dirname(gitExecutables), "bash.exe"), join(dirname(dirname(gitExecutables)), "bin", "bash.exe")])], args: ["--login", "-i"] },
      { id: "wsl", label: "WSL", candidates: [...search("wsl.exe"), ...(windows === undefined ? [] : [join(windows, "System32", "wsl.exe")])], args: [] }
    );
  } else {
    for (const id of ["zsh", "bash", "fish", "sh"]) {
      definitions.push({ id, label: id, candidates: [...search(id), `/bin/${id}`, `/usr/bin/${id}`], args: [] });
    }
  }
  const shells: TerminalShell[] = [];
  for (const definition of definitions) {
    const executable = await firstExecutable(definition.candidates);
    if (executable !== undefined) shells.push({
      id: definition.id, label: definition.label, executable, args: definition.args, isDefault: false
    });
  }
  const selected = process.platform === "win32" ? shells[0] : shells.find((shell) => {
    const preferred = source.SHELL;
    return preferred !== undefined && basename(preferred) === shell.id;
  }) ?? shells[0];
  return shells.map((shell) => ({ ...shell, isDefault: shell === selected }));
}

async function firstExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const path = await realpath(candidate);
      if (!(await stat(path)).isFile()) continue;
      if (process.platform !== "win32") await access(path, constants.X_OK);
      return path;
    } catch {
      // Unavailable candidates are omitted; explicit selection never silently changes shell.
    }
  }
  return undefined;
}
