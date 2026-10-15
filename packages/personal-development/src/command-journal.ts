import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DIGEST, exists, identity, managedPath, ordinaryDirectory, readJson, safeRoot, writeJson } from "./storage.js";
import { PersonalDevelopmentError } from "./types.js";

export interface CommandJournal {
  readonly format: 1; readonly commandId: string; readonly nonce: string; readonly operationId: string;
  readonly platform: string; readonly helperSha256: string; readonly helperSourceDigest: string;
  readonly directory: string;
}
export interface CommandRetirement {
  readonly pid: number; readonly identity: string; readonly helperPid: number; readonly helperBirth: string;
  readonly exitCode: number; readonly cancelled: boolean; readonly forcedDescendants: boolean;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (value: Record<string, unknown>, expected: CommandJournal) => value.format === 1 && value.commandId === expected.commandId && value.nonce === expected.nonce
  && value.operationId === expected.operationId && value.platform === expected.platform && value.helperSha256 === expected.helperSha256 && value.helperSourceDigest === expected.helperSourceDigest;

export async function createCommandJournal(root: string, data: { readonly operationId?: string; readonly helperSha256: string; readonly helperSourceDigest: string }): Promise<CommandJournal> {
  await safeRoot(root);
  const commandId = randomUUID(), operationId = identity(data.operationId ?? commandId);
  const operationRoot = join(root, operationId); await mkdir(operationRoot, { recursive: true, mode: 0o700 }); await ordinaryDirectory(operationRoot);
  if (!DIGEST.test(data.helperSha256) || !DIGEST.test(data.helperSourceDigest) || (await readdir(operationRoot)).length >= 10_000) throw new PersonalDevelopmentError("STATE_INVALID");
  const directory = join(operationRoot, commandId); await mkdir(directory, { mode: 0o700 });
  const journal: CommandJournal = { format: 1, commandId, nonce: randomUUID(), operationId,
    platform: process.platform, helperSha256: data.helperSha256, helperSourceDigest: data.helperSourceDigest, directory };
  await writeJson(join(directory, "request.json"), journal); return journal;
}

export async function readCommandRetirement(journal: CommandJournal): Promise<CommandRetirement | undefined> {
  try {
    const started = await readJson(join(journal.directory, "started.json")); const retired = await readJson(join(journal.directory, "retired.json"));
    if (!record(started) || !record(retired) || Object.keys(started).length !== 12 || Object.keys(retired).length !== 16 || !same(started, journal) || !same(retired, journal) || retired.activeProcesses !== 0
      || !Number.isSafeInteger(started.pid) || Number(started.pid) < 1 || typeof started.identity !== "string" || !started.identity || started.identity.length > 256
      || !Number.isSafeInteger(started.helperPid) || Number(started.helperPid) < 1 || typeof started.helperBirth !== "string" || !started.helperBirth || started.helperBirth.length > 256
      || retired.pid !== started.pid || retired.identity !== started.identity || retired.helperPid !== started.helperPid || retired.helperBirth !== started.helperBirth
      || !Number.isSafeInteger(retired.exitCode) || typeof retired.cancelled !== "boolean" || typeof retired.forcedDescendants !== "boolean") return;
    return { pid: Number(started.pid), identity: started.identity, helperPid: Number(started.helperPid), helperBirth: started.helperBirth,
      exitCode: Number(retired.exitCode), cancelled: retired.cancelled, forcedDescendants: retired.forcedDescendants };
  } catch { return; }
}

export async function recoverCommandJournals(input: { readonly operationId: string; readonly journalDirectory: string }): Promise<{ readonly status: "retired" | "unknown"; readonly commandIds: readonly string[] }> {
  const commandIds: string[] = []; identity(input.operationId);
  try {
    const operationRoot = join(input.journalDirectory, input.operationId);
    if (!await exists(operationRoot)) return { status: "unknown", commandIds };
    await ordinaryDirectory(input.journalDirectory); await managedPath(input.journalDirectory, operationRoot); await ordinaryDirectory(operationRoot);
    const children = await readdir(operationRoot);
    if (children.length > 10_000) return { status: "unknown", commandIds };
    let unknown = false;
    for (const name of children) {
      identity(name); const directory = await managedPath(operationRoot, join(operationRoot, name));
      const value = await readJson(join(directory, "request.json"));
      if (!record(value) || Object.keys(value).length !== 8 || value.format !== 1 || value.commandId !== name || value.directory !== directory || value.operationId !== input.operationId
        || typeof value.nonce !== "string" || !DIGEST.test(String(value.helperSha256)) || !DIGEST.test(String(value.helperSourceDigest)) || value.platform !== process.platform) {
        return { status: "unknown", commandIds };
      }
      if (value.operationId !== input.operationId) continue;
      commandIds.push(name); if (!await readCommandRetirement(value as unknown as CommandJournal)) unknown = true;
    }
    return { status: commandIds.length > 0 && !unknown ? "retired" : "unknown", commandIds };
  } catch { return { status: "unknown", commandIds }; }
}
