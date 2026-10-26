import { stat, readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';

const exists = async path => { try { return (await stat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
export async function pnpmInvocation() {
  const active = process.env.npm_execpath;
  if (typeof active === 'string' && isAbsolute(active) && await exists(active)) {
    return /\.[cm]?js$/i.test(active) ? { executable: process.execPath, arguments: [active] } : { executable: active, arguments: [] };
  }
  if (process.platform !== 'win32') return { executable: 'pnpm', arguments: [] };
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)) {
    const direct = resolve(directory, 'pnpm.exe');
    if (await exists(direct)) return { executable: direct, arguments: [] };
    const entry = resolve(directory, '..', 'pnpm', 'bin', 'pnpm.cjs');
    if (await exists(entry)) return { executable: process.execPath, arguments: [entry] };
    const wrapper = resolve(directory, 'pnpm.cmd');
    if (!await exists(wrapper)) continue;
    const text = await readFile(wrapper, 'utf8'), lower = text.toLowerCase();
    const first = lower.indexOf('"%~dp0'), last = lower.indexOf('pnpm.exe"', first + 6);
    if (first < 0 || last < 0) continue;
    const suffix = text.slice(first + 6, last + 'pnpm.exe'.length);
    if (/["\r\n]/.test(suffix)) continue;
    const executable = resolve(`${directory}${suffix.replaceAll('\\', '/')}`);
    if (await exists(executable)) return { executable, arguments: [] };
  }
  throw new Error('A directly executable pnpm installation is required.');
}
