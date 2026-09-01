import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { redactSecrets } from "@joko/core";

import {
  executeSchedulePreRunHook,
  type SchedulePreRunHookResult
} from "./schedule-pre-run-hook.js";

const MAXIMUM_SCRIPT_BYTES = 256 * 1024;
const MAXIMUM_DESCRIPTION_LENGTH = 16 * 1024;
const SELF_TEST_TIMEOUT_MS = 30_000;

export interface ScheduleHookScriptGenerationInput {
  readonly description: string;
  readonly scheduleName?: string;
  readonly workspaceRoot: string;
  readonly currentScript?: string;
  readonly providerId?: string;
  readonly modelId?: string;
}

export type ScheduleHookScriptGenerator = (
  input: ScheduleHookScriptGenerationInput,
  signal?: AbortSignal
) => Promise<string>;

export interface ScheduleHookScriptInstallInput {
  readonly workspaceRoot: string;
  readonly scheduleName?: string;
  readonly scheduleId?: string;
  readonly script?: string;
  readonly description?: string;
  readonly currentFilePath?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly signal?: AbortSignal;
}

export interface ScheduleHookScriptInstallResult {
  readonly command: string;
  readonly filePath: string;
  readonly content: string;
  readonly modified: boolean;
  readonly test: SchedulePreRunHookResult;
}

export interface ScheduleHookScriptInstallerOptions {
  readonly generate?: ScheduleHookScriptGenerator;
}

/** Single installation path shared by GUI and agent-created pre-run gates. */
export class ScheduleHookScriptInstaller {
  readonly #generate: ScheduleHookScriptGenerator | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: ScheduleHookScriptInstallerOptions = {}) {
    this.#generate = options.generate;
  }

  install(input: ScheduleHookScriptInstallInput): Promise<ScheduleHookScriptInstallResult> {
    const operation = this.#tail.then(
      () => this.#install(input),
      () => this.#install(input)
    );
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #install(input: ScheduleHookScriptInstallInput): Promise<ScheduleHookScriptInstallResult> {
    input.signal?.throwIfAborted();
    const workspace = await canonicalDirectory(input.workspaceRoot, "Schedule workspace");
    const installDirectory = await safeInstallDirectory(workspace);
    const currentFilePath = input.currentFilePath === undefined
      ? undefined
      : await reusableScriptPath(input.currentFilePath, installDirectory);
    const content = await this.#resolveContent(input, workspace, currentFilePath);
    input.signal?.throwIfAborted();
    const filePath = currentFilePath ?? await availableScriptPath(
      installDirectory,
      scheduleHookScriptSlug(input.scheduleName, input.description)
    );
    await assertInstallDirectoryStable(workspace, installDirectory);
    await atomicWriteScript(filePath, content);
    const command = scheduleHookScriptCommand(filePath);
    const test = await executeSchedulePreRunHook({
      command,
      timeoutMs: SELF_TEST_TIMEOUT_MS,
      cwd: workspace,
      signal: input.signal,
      stdinPayload: {
        event: "schedule-pre-run",
        scheduleId: input.scheduleId ?? "self-test",
        scheduleName: input.scheduleName?.trim() || "Self test",
        runId: "self-test",
        firedAt: Date.now(),
        workingDir: workspace
      }
    });
    return {
      command,
      filePath,
      content,
      modified: currentFilePath !== undefined,
      test
    };
  }

  async #resolveContent(
    input: ScheduleHookScriptInstallInput,
    workspaceRoot: string,
    currentFilePath: string | undefined
  ): Promise<string> {
    const authored = normalizedScript(input.script);
    if (authored !== undefined) return authored;
    const description = input.description?.trim();
    if (description === undefined || description === "" || description.length > MAXIMUM_DESCRIPTION_LENGTH) {
      throw new Error("A bounded script or generation description is required.");
    }
    if (redactSecrets(description) !== description) {
      throw new Error("Pre-run hook descriptions cannot contain credential material.");
    }
    if (this.#generate === undefined) {
      throw new Error("Pre-run hook script generation is unavailable; provide script content instead.");
    }
    const currentScript = currentFilePath === undefined
      ? undefined
      : await boundedReadScript(currentFilePath);
    if (currentScript !== undefined) assertNoCredentialMaterial(currentScript);
    const generated = await this.#generate({
      description,
      ...(input.scheduleName === undefined ? {} : { scheduleName: input.scheduleName }),
      workspaceRoot,
      ...(currentScript === undefined ? {} : { currentScript }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId })
    }, input.signal);
    const extracted = extractScheduleHookScript(generated);
    if (extracted === undefined) throw new Error("Generated pre-run hook did not contain executable JavaScript.");
    return extracted;
  }
}

export function extractScheduleHookScript(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const fenced = /```(?:javascript|js|mjs)?\s*\r?\n([\s\S]*?)```/iu.exec(value)?.[1];
  const candidate = (fenced ?? value).trim();
  if (candidate === "" || byteLength(candidate) > MAXIMUM_SCRIPT_BYTES || candidate.includes("\0")) return undefined;
  if (fenced === undefined && !looksLikeJavaScript(candidate)) return undefined;
  assertNoCredentialMaterial(candidate);
  return candidate.endsWith("\n") ? candidate : `${candidate}\n`;
}

export function scheduleHookScriptSlug(name: string | undefined, description?: string): string {
  for (const source of [name, description]) {
    const slug = source?.toLocaleLowerCase("en")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64);
    if (slug !== undefined && slug !== "") return slug;
  }
  return "check";
}

export function scheduleHookScriptCommand(filePath: string, platform = process.platform): string {
  return `joko-node ${shellQuote(filePath, platform)}`;
}

export async function validateScheduleHookScriptBinding(input: {
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly command: string;
}): Promise<string> {
  const workspace = await canonicalDirectory(input.workspaceRoot, "Schedule workspace");
  const installDirectory = await safeInstallDirectory(workspace);
  const filePath = await reusableScriptPath(input.filePath, installDirectory);
  if (input.command !== scheduleHookScriptCommand(filePath)) {
    throw new Error("Pre-run hook command does not match its managed script path.");
  }
  return filePath;
}

function normalizedScript(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (byteLength(value) > MAXIMUM_SCRIPT_BYTES || value.includes("\0")) {
    throw new Error("Pre-run hook script is invalid or too large.");
  }
  assertNoCredentialMaterial(value);
  const trimmed = value.trim();
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

function assertNoCredentialMaterial(value: string): void {
  if (redactSecrets(value) !== value) {
    throw new Error("Pre-run hook scripts cannot contain credential material.");
  }
}

function looksLikeJavaScript(value: string): boolean {
  const first = value.trimStart().split(/\r?\n/u, 1)[0] ?? "";
  return /^(?:import\s|export\s|const\s|let\s|var\s|async\s|function\s|class\s|if\s*\(|try\s*\{|process\.|await\s|\/\/|\/\*)/u.test(first);
}

async function canonicalDirectory(value: string, label: string): Promise<string> {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error(`${label} must be an absolute directory.`);
  const canonical = await realpath(resolve(value));
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a regular directory.`);
  return canonical;
}

async function safeInstallDirectory(workspace: string): Promise<string> {
  const candidate = join(workspace, "scripts", "schedule-checks");
  await mkdir(candidate, { recursive: true });
  const canonical = await realpath(candidate);
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(workspace, canonical)) {
    throw new Error("Pre-run hook install directory escaped the schedule workspace.");
  }
  return canonical;
}

async function assertInstallDirectoryStable(workspace: string, installDirectory: string): Promise<void> {
  const canonical = await realpath(installDirectory);
  const info = await lstat(installDirectory);
  if (canonical !== installDirectory || !info.isDirectory() || info.isSymbolicLink() || !isWithin(workspace, canonical)) {
    throw new Error("Pre-run hook install directory changed during installation.");
  }
}

async function reusableScriptPath(value: string, installDirectory: string): Promise<string> {
  if (!isAbsolute(value) || value.includes("\0")) throw new Error("Existing pre-run hook path is invalid.");
  const canonical = await realpath(resolve(value));
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink() || !isWithin(installDirectory, canonical) || !canonical.endsWith(".mjs")) {
    throw new Error("Existing pre-run hook is outside the managed schedule-check directory.");
  }
  return canonical;
}

async function availableScriptPath(directory: string, slug: string): Promise<string> {
  for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
    const suffix = ordinal === 1 ? "" : `-${ordinal}`;
    const candidate = join(directory, `${slug}${suffix}.mjs`);
    try {
      await lstat(candidate);
    } catch (error) {
      if (isMissing(error)) return candidate;
      throw error;
    }
  }
  throw new Error("No available pre-run hook filename could be allocated.");
}

async function boundedReadScript(filePath: string): Promise<string> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAXIMUM_SCRIPT_BYTES) {
    throw new Error("Existing pre-run hook script is invalid or too large.");
  }
  return readFile(filePath, "utf8");
}

async function atomicWriteScript(filePath: string, content: string): Promise<void> {
  const directory = dirname(filePath);
  const temporary = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  const backup = join(directory, `.${basename(filePath)}.${randomUUID()}.bak`);
  let handle;
  let replaced = false;
  let backupPresent = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform === "win32" && await pathExists(filePath)) {
      const current = await lstat(filePath);
      if (!current.isFile() || current.isSymbolicLink()) throw new Error("Existing pre-run hook target is unsafe.");
      await rename(filePath, backup);
      backupPresent = true;
    }
    await rename(temporary, filePath);
    replaced = true;
    if (backupPresent) {
      await rm(backup, { force: true }).catch(() => undefined);
      backupPresent = false;
    }
  } catch (error) {
    if (backupPresent && !replaced) {
      await rename(backup, filePath).catch(() => undefined);
      backupPresent = false;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (backupPresent) await rm(backup, { force: true }).catch(() => undefined);
  }
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    if (value.includes('"')) throw new Error("Pre-run hook path cannot be represented safely by the Windows shell.");
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
