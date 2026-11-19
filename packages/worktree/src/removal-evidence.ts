import type { BigIntStats } from "node:fs";
import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { WorktreeServiceError } from "./errors.js";
import type { WorktreeOperationControl } from "./operation.js";

export interface WorktreeRemovalEvidence {
  readonly root: string;
  readonly members: readonly (readonly [path: string, identity: string])[];
}

const DIRECTORY_IDENTITY = /^d(?::[0-9]+){5}$/u;
const FILE_IDENTITY = /^f(?::[0-9]+){6}(?::-?[0-9]+){2}$/u;

export function validateWorktreeRemovalEvidence(value: unknown): WorktreeRemovalEvidence | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new WorktreeServiceError("STATE_CORRUPT", "The worktree removal evidence is invalid.");
  if (value === null || typeof value !== "object" || !("root" in value) || !("members" in value) ||
    Object.keys(value).length !== 2 || typeof value.root !== "string" || !DIRECTORY_IDENTITY.test(value.root) ||
    !Array.isArray(value.members)) throw invalid();
  const seen = new Set<string>();
  const members = value.members.map((entry: unknown) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
      !entry[0].split("/").every(safeName) || seen.has(entry[0]) || typeof entry[1] !== "string" ||
      (!DIRECTORY_IDENTITY.test(entry[1]) && !FILE_IDENTITY.test(entry[1]))) throw invalid();
    seen.add(entry[0]);
    return Object.freeze([entry[0], entry[1]] as const);
  });
  return Object.freeze({ root: value.root, members: Object.freeze(members) });
}

function safeName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\:\0]/u.test(name);
}

function directoryIdentity(info: BigIntStats): string {
  return `d:${info.dev}:${info.ino}:${info.birthtimeNs}:${info.uid}:${info.mode}`;
}

function fileIdentity(info: BigIntStats): string {
  return `f:${info.dev}:${info.ino}:${info.birthtimeNs}:${info.uid}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** Records regular files without opening them, including files with a Windows sharing lock. */
export async function captureWorktreeRemovalEvidence(
  root: string, control: WorktreeOperationControl
): Promise<WorktreeRemovalEvidence | undefined> {
  const location = await lstat(root, { bigint: true });
  if (!location.isDirectory() || location.ino === 0n) return undefined;
  const members: Array<readonly [string, string]> = [];
  const collect = async (directory: string, prefix: string): Promise<boolean> => {
    for (const name of await readdir(directory)) {
      control.check();
      if (!safeName(name)) return false;
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const info = await lstat(path, { bigint: true });
      if (info.dev !== location.dev || info.ino === 0n) return false;
      if (info.isFile()) members.push([relative, fileIdentity(info)]);
      else if (info.isDirectory()) {
        members.push([relative, directoryIdentity(info)]);
        if (!await collect(path, `${relative}/`)) return false;
      } else return false;
    }
    return true;
  };
  return await collect(root, "") ? { root: directoryIdentity(location), members } : undefined;
}

export async function removeCoveredWorktreeFiles(
  root: string, evidence: WorktreeRemovalEvidence, control: WorktreeOperationControl, assertCanRecycle: () => Promise<void>
): Promise<void> {
  const changed = () => new WorktreeServiceError("SESSION_CONFLICT", "The partially removed worktree no longer matches the original checkout.");
  const residual = await captureWorktreeRemovalEvidence(root, control);
  const originals = new Map(evidence.members);
  if (residual?.root !== evidence.root || residual.members.some(([path, identity]) => originals.get(path) !== identity)) {
    throw changed();
  }
  await assertCanRecycle();
  const assertRoot = async () => {
    control.check();
    const info = await lstat(root, { bigint: true });
    if (!info.isDirectory() || directoryIdentity(info) !== evidence.root || !sameCanonicalPath(root, await realpath(root))) throw changed();
  };
  for (const [relative, identity] of [...residual.members].reverse()) {
    await assertRoot();
    const path = join(root, ...relative.split("/"));
    const info = await lstat(path, { bigint: true });
    if (!sameCanonicalPath(path, await realpath(path))) throw changed();
    control.check();
    if (info.isFile() && fileIdentity(info) === identity) await unlink(path);
    else if (info.isDirectory() && directoryIdentity(info) === identity) await rmdir(path);
    else throw changed();
  }
  await assertRoot();
  await rmdir(root);
}

function sameCanonicalPath(expected: string, actual: string): boolean {
  return process.platform === "win32" ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
}
