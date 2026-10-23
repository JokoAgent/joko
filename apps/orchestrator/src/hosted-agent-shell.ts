
import fs from 'node:fs';

import path from 'node:path';


/** PATH 上的可执行文件(Windows)。 */
function findOnWindowsPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? env.Path ?? '').split(';')) {
    if (!dir) continue;
    const candidate = path.win32.join(dir.replace(/^"|"$/g, ''), name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}


/**
 * Windows 上的 Git Bash(Agent 的命令都是 bash 写法；与 Claude Code 在 Windows 上的要求一致)：
 * CLAUDE_CODE_GIT_BASH_PATH → PATH 上 git.exe 旁的 bin\bash.exe → 常见安装位置。找不到返回 null。
 */
export function findWindowsGitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  // 只接受名为 bash.exe 的现存文件，避免环境变量里的任意字符串被当成可执行体。
  const valid = (value: string | undefined): string | null =>
    value && /[/\\]bash\.exe$/i.test(value) && fs.existsSync(value) ? value : null;
  const explicit = valid(env.CLAUDE_CODE_GIT_BASH_PATH);
  if (explicit) return explicit;
  const git = findOnWindowsPath('git.exe', env);
  if (git) {
    const gitDir = path.win32.dirname(git);
    for (const candidate of [
      path.win32.join(path.win32.dirname(gitDir), 'bin', 'bash.exe'),
      path.win32.join(gitDir, 'bash.exe'),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs')]
    .filter((root): root is string => !!root);
  for (const root of roots) {
    const candidate = path.win32.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}


/** 脚本方言：bash 系与 cmd 的包装语法完全不同，按方言生成脚本。 */
export type ExecutorShellDialect = 'bash' | 'cmd';


export interface ExecutorShell {
  file: string;
  dialect: ExecutorShellDialect;
  /** 脚本文件名(固定值；执行目录即脚本所在目录)。 */
  scriptName: string;
  /** 执行脚本文件的命令行参数(只放固定字符串，脚本内容与路径都不进命令行)。 */
  args: string[];
}


/** 本机用于执行命令的 shell。 */
export function resolveExecutorShell(): ExecutorShell {
  if (process.platform === 'win32') {
    const gitBash = findWindowsGitBash();
    if (gitBash) return { file: gitBash, dialect: 'bash', scriptName: 'script.sh', args: ['script.sh'] };
    return {
      file: process.env.ComSpec || 'cmd.exe',
      dialect: 'cmd',
      scriptName: 'script.cmd',
      args: ['/d', '/s', '/c', 'script.cmd'],
    };
  }
  const preferred = process.env.SHELL;
  const file = preferred && /\/(zsh|bash)$/.test(preferred) && fs.existsSync(preferred)
    ? preferred
    : fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return { file, dialect: 'bash', scriptName: 'script.sh', args: ['script.sh'] };
}
