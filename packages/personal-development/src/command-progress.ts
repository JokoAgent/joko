import type { DevelopmentProgress } from "./types.js";

/** Publish only recognized numeric tool progress; package/script output is never a diagnostic log. */
export function developmentCommandProgress(raw: string): DevelopmentProgress | undefined {
  if (raw.length > 4096) return;
  const line = raw.replace(/\u001b\[[0-9;]*m/gu, "").trim();
  const git = /(?:^|\b)(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%/u.exec(line);
  if (git && Number(git[2]) <= 100) return { stage: git[1]!, percent: Number(git[2]) };
  const pnpm = /^Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)(?:, done)?$/u.exec(line);
  if (!pnpm) return;
  const values = pnpm.slice(1).map(Number);
  if (values.some(value => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)) return;
  return { stage: "dependency-progress", dependencyProgress: { resolved: values[0]!, reused: values[1]!, downloaded: values[2]!, added: values[3]! } };
}
