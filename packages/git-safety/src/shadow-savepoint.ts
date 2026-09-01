import { mkdtemp, mkdir, lstat, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  buildSnapshotFilePlan,
  collectSkippedPathFingerprints,
  resolveRepositoryPath,
  SnapshotStatusUnavailableError,
  type SnapshotFileFilterOptions,
  type SnapshotSkippedReason
} from "./file-filter.js";
import { GitCommandError, type GitCommandRunner } from "./git-command.js";
import { enqueueRepositoryWrite } from "./repository-queue.js";
import { SAVEPOINT_REF_NAMESPACE, type GitSafetyGapReason, type SkippedPathFingerprint } from "./types.js";

const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;
const IDENTITY_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: "Joko",
  GIT_AUTHOR_EMAIL: "savepoint@joko.local",
  GIT_COMMITTER_NAME: "Joko",
  GIT_COMMITTER_EMAIL: "savepoint@joko.local"
});

export type BlockedRepositoryReason =
  | "merge"
  | "rebase"
  | "cherry_pick"
  | "revert"
  | "conflict"
  | "status_unavailable";

export class InvalidSavepointIdentifierError extends Error {
  constructor() {
    super("Savepoint identifier is invalid.");
    this.name = "InvalidSavepointIdentifierError";
  }
}

export class SnapshotBlockedError extends Error {
  readonly reason: BlockedRepositoryReason;

  constructor(reason: BlockedRepositoryReason) {
    super("Repository state does not permit a safe workspace savepoint.");
    this.name = "SnapshotBlockedError";
    this.reason = reason;
  }
}

export interface CreateShadowSavepointInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly kind: "turn_start" | "after_edit";
  readonly baselineCommit?: string;
  readonly skipIfTreeEquals?: string;
  readonly fileFilter?: SnapshotFileFilterOptions;
}

export interface ShadowSavepointResult {
  readonly commit: string | null;
  readonly tree: string;
  readonly includedPaths: readonly string[];
  readonly skippedPaths: readonly {
    readonly relativePath: string;
    readonly reason: SnapshotSkippedReason;
  }[];
  readonly skippedFingerprints: readonly SkippedPathFingerprint[];
}

export interface AppendGapMarkerInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly reason: GitSafetyGapReason;
}

export interface ShadowSavepointEntry {
  readonly commit: string;
  readonly parent?: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly kind: "turn_start" | "after_edit" | "rewind_gap";
  readonly baselineCommit?: string;
  readonly gapReason?: GitSafetyGapReason;
}

export class ShadowSavepointService {
  readonly #runner: GitCommandRunner;

  constructor(runner: GitCommandRunner) {
    this.#runner = runner;
  }

  create(repositoryRoot: string, input: CreateShadowSavepointInput): Promise<ShadowSavepointResult> {
    return enqueueRepositoryWrite(repositoryRoot, () => this.#create(repositoryRoot, input));
  }

  appendGap(repositoryRoot: string, input: AppendGapMarkerInput): Promise<string | null> {
    return enqueueRepositoryWrite(repositoryRoot, () => this.#appendGap(repositoryRoot, input));
  }

  deleteSessionChain(repositoryRoot: string, sessionId: string): Promise<void> {
    return enqueueRepositoryWrite(repositoryRoot, async () => {
      let ref: string;
      try {
        ref = savepointRefForSession(sessionId);
      } catch {
        return;
      }
      await this.#runner.run(repositoryRoot, ["update-ref", "-d", ref]).catch(() => undefined);
    });
  }

  deleteRepositoryNamespace(repositoryRoot: string): Promise<number> {
    return enqueueRepositoryWrite(repositoryRoot, async () => {
      const output = (await this.#runner.run(repositoryRoot, [
        "for-each-ref",
        "--format=%(refname)",
        SAVEPOINT_REF_NAMESPACE
      ])).stdout;
      const refs = output.split(/\r?\n/u)
        .map((value) => value.trim())
        .filter((value) => value.startsWith(SAVEPOINT_REF_NAMESPACE))
        .filter((value) => {
          const sessionId = value.slice(SAVEPOINT_REF_NAMESPACE.length);
          return SAFE_IDENTIFIER.test(sessionId) && !sessionId.includes("/");
        });
      for (const ref of refs) await this.#runner.run(repositoryRoot, ["update-ref", "-d", ref]);
      return refs.length;
    });
  }

  async list(repositoryRoot: string, sessionId: string, maximumCount = 2_000): Promise<readonly ShadowSavepointEntry[]> {
    const ref = savepointRefForSession(sessionId);
    const count = Number.isSafeInteger(maximumCount) && maximumCount > 0 ? maximumCount : 2_000;
    let output: string;
    try {
      ({ stdout: output } = await this.#runner.run(repositoryRoot, [
        "log",
        `--max-count=${count}`,
        "--format=%H%x1f%P%x1f%B%x1e",
        ref
      ]));
    } catch (error) {
      if (error instanceof GitCommandError) return [];
      throw error;
    }
    return parseSavepointLog(output, sessionId);
  }

  async #create(repositoryRoot: string, input: CreateShadowSavepointInput): Promise<ShadowSavepointResult> {
    validateIdentifier(input.sessionId);
    validateIdentifier(input.runId);
    const root = await realpath(repositoryRoot);
    const blocked = await detectBlockedRepositoryState(root, this.#runner);
    if (blocked !== null) throw new SnapshotBlockedError(blocked);

    let plan;
    try {
      plan = await buildSnapshotFilePlan(root, this.#runner, input.fileFilter);
    } catch (error) {
      if (error instanceof SnapshotStatusUnavailableError) throw new SnapshotBlockedError("status_unavailable");
      throw error;
    }
    if (plan.skipped.some((item) => item.reason === "conflict")) throw new SnapshotBlockedError("conflict");
    const skippedFingerprints = await collectSkippedPathFingerprints(root, plan.skipped);

    return withTemporaryIndex(root, this.#runner, async (environment, temporaryRoot) => {
      const removals = new Set<string>();
      const additions: string[] = [];
      const rootReal = await realpath(root);
      for (const item of plan.included) {
        if (item.oldRelativePath !== undefined && item.oldRelativePath !== item.relativePath) {
          removals.add(item.oldRelativePath);
        }
        const absolute = resolveRepositoryPath(root, item.relativePath);
        const stats = absolute === null ? undefined : await lstat(absolute).catch(() => undefined);
        if (absolute === null || stats === undefined || stats.isDirectory()) {
          removals.add(item.relativePath);
          continue;
        }
        const parentReal = await realpath(dirname(absolute)).catch(() => undefined);
        if (parentReal === undefined || !isWithinRoot(parentReal, rootReal)) {
          removals.add(item.relativePath);
          continue;
        }
        additions.push(item.relativePath);
      }

      for (const chunk of chunks([...removals], 80)) {
        await this.#runner.run(root, ["update-index", "--force-remove", "--", ...chunk], { environment });
      }
      if (additions.length > 0) {
        const pathspecFile = join(temporaryRoot, "pathspec");
        const literalPathspecs = additions.map((pathValue) => `:(literal)${pathValue}`);
        await writeFile(pathspecFile, `${literalPathspecs.join("\0")}\0`, { encoding: "utf8", mode: 0o600 });
        await this.#runner.run(root, [
          "add",
          "-A",
          `--pathspec-from-file=${pathspecFile}`,
          "--pathspec-file-nul"
        ], { environment });
      }

      const tree = (await this.#runner.run(root, ["write-tree"], { environment })).stdout.trim();
      if (input.skipIfTreeEquals !== undefined) {
        const comparisonTree = await resolveTree(root, input.skipIfTreeEquals, this.#runner);
        if (comparisonTree === null) throw new Error("Savepoint comparison tree is unavailable.");
        if (comparisonTree === tree) {
          return {
            commit: null,
            tree,
            includedPaths: plan.included.map((item) => item.relativePath),
            skippedPaths: plan.skipped.map((item) => ({ relativePath: item.relativePath, reason: item.reason })),
            skippedFingerprints
          };
        }
      }

      const parent = await readSavepointTip(root, input.sessionId, this.#runner);
      const head = await readHead(root, this.#runner);
      const message = buildCommitMessage({
        sessionId: input.sessionId,
        runId: input.runId,
        kind: input.kind,
        ...(input.baselineCommit === undefined ? {} : { baselineCommit: input.baselineCommit }),
        ...(head === null ? {} : { baseHead: head })
      });
      const commit = await commitTree(root, this.#runner, {
        sessionId: input.sessionId,
        tree,
        parent,
        message
      });
      return {
        commit,
        tree,
        includedPaths: plan.included.map((item) => item.relativePath),
        skippedPaths: plan.skipped.map((item) => ({ relativePath: item.relativePath, reason: item.reason })),
        skippedFingerprints
      };
    });
  }

  async #appendGap(repositoryRoot: string, input: AppendGapMarkerInput): Promise<string | null> {
    validateIdentifier(input.sessionId);
    validateIdentifier(input.runId);
    const root = await realpath(repositoryRoot).catch(() => undefined);
    if (root === undefined) return null;
    const parent = await readSavepointTip(root, input.sessionId, this.#runner);
    const tree = parent === null
      ? await writeEmptyTree(root, this.#runner)
      : await resolveTree(root, parent, this.#runner);
    if (tree === null) return null;
    const message = buildCommitMessage({
      sessionId: input.sessionId,
      runId: input.runId,
      kind: "rewind_gap",
      gapReason: input.reason
    });
    return commitTree(root, this.#runner, {
      sessionId: input.sessionId,
      tree,
      parent,
      message
    });
  }
}

export function savepointRefForSession(sessionId: string): string {
  validateIdentifier(sessionId);
  return `${SAVEPOINT_REF_NAMESPACE}${sessionId}`;
}

export async function detectBlockedRepositoryState(
  repositoryRoot: string,
  runner: GitCommandRunner
): Promise<BlockedRepositoryReason | null> {
  const markers: readonly { readonly marker: string; readonly reason: BlockedRepositoryReason }[] = [
    { marker: "MERGE_HEAD", reason: "merge" },
    { marker: "rebase-merge", reason: "rebase" },
    { marker: "rebase-apply", reason: "rebase" },
    { marker: "CHERRY_PICK_HEAD", reason: "cherry_pick" },
    { marker: "REVERT_HEAD", reason: "revert" }
  ];
  for (const item of markers) {
    const internalPath = (await runner.run(repositoryRoot, ["rev-parse", "--git-path", item.marker])).stdout.trim();
    if (internalPath === "") continue;
    const absolute = isAbsolute(internalPath) ? internalPath : resolve(repositoryRoot, internalPath);
    if (await lstat(absolute).then(() => true, () => false)) return item.reason;
  }
  return null;
}

async function withTemporaryIndex<T>(
  repositoryRoot: string,
  runner: GitCommandRunner,
  task: (environment: Readonly<Record<string, string>>, temporaryRoot: string) => Promise<T>
): Promise<T> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "joko-savepoint-index-"));
  const hooksPath = join(temporaryRoot, "hooks");
  await mkdir(hooksPath, { mode: 0o700 });
  const environment = {
    GIT_INDEX_FILE: join(temporaryRoot, "index")
  };
  try {
    const head = await readHead(repositoryRoot, runner);
    await runner.run(repositoryRoot, head === null ? ["read-tree", "--empty"] : ["read-tree", head], { environment });
    return await task(environment, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function commitTree(
  repositoryRoot: string,
  runner: GitCommandRunner,
  input: {
    readonly sessionId: string;
    readonly tree: string;
    readonly parent: string | null;
    readonly message: string;
  }
): Promise<string> {
  const result = await runner.run(repositoryRoot, [
    "-c",
    "commit.gpgsign=false",
    "commit-tree",
    input.tree,
    ...(input.parent === null ? [] : ["-p", input.parent]),
    "-m",
    input.message
  ], { environment: IDENTITY_ENVIRONMENT });
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) throw new Error("Git returned an invalid savepoint object identifier.");
  await runner.run(repositoryRoot, [
    "update-ref",
    savepointRefForSession(input.sessionId),
    commit,
    input.parent ?? ""
  ]);
  return commit;
}

async function readHead(repositoryRoot: string, runner: GitCommandRunner): Promise<string | null> {
  try {
    const value = (await runner.run(repositoryRoot, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    return value === "" ? null : value;
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
}

async function readSavepointTip(
  repositoryRoot: string,
  sessionId: string,
  runner: GitCommandRunner
): Promise<string | null> {
  try {
    const value = (await runner.run(repositoryRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      savepointRefForSession(sessionId)
    ])).stdout.trim();
    return value === "" ? null : value;
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
}

async function resolveTree(
  repositoryRoot: string,
  commit: string,
  runner: GitCommandRunner
): Promise<string | null> {
  try {
    const value = (await runner.run(repositoryRoot, ["rev-parse", `${commit}^{tree}`])).stdout.trim();
    return value === "" ? null : value;
  } catch (error) {
    if (error instanceof GitCommandError) return null;
    throw error;
  }
}

async function writeEmptyTree(repositoryRoot: string, runner: GitCommandRunner): Promise<string | null> {
  try {
    return await withTemporaryIndex(repositoryRoot, runner, async (environment) => {
      await runner.run(repositoryRoot, ["read-tree", "--empty"], { environment });
      return (await runner.run(repositoryRoot, ["write-tree"], { environment })).stdout.trim();
    });
  } catch {
    return null;
  }
}

function buildCommitMessage(input: {
  readonly sessionId: string;
  readonly runId: string;
  readonly kind: "turn_start" | "after_edit" | "rewind_gap";
  readonly baselineCommit?: string;
  readonly baseHead?: string;
  readonly gapReason?: GitSafetyGapReason;
}): string {
  const trailers = [
    `X-Joko-Session: ${input.sessionId}`,
    `X-Joko-Run: ${input.runId}`,
    `X-Joko-Kind: ${input.kind}`
  ];
  if (input.baselineCommit !== undefined) trailers.push(`X-Joko-Baseline: ${input.baselineCommit}`);
  if (input.baseHead !== undefined) trailers.push(`X-Joko-BaseHead: ${input.baseHead}`);
  if (input.gapReason !== undefined) trailers.push(`X-Joko-Gap: ${input.gapReason}`);
  const label = input.kind === "turn_start"
    ? "Joko workspace savepoint: turn start"
    : input.kind === "after_edit"
      ? "Joko workspace savepoint: turn settled"
      : "Joko workspace savepoint: rewind gap";
  return `${label}\n\n${trailers.join("\n")}`;
}

function parseSavepointLog(output: string, expectedSessionId: string): readonly ShadowSavepointEntry[] {
  const entries: ShadowSavepointEntry[] = [];
  for (const rawRecord of output.split("\x1e")) {
    const record = rawRecord.trim();
    if (record === "") continue;
    const [commit, parents, ...messageParts] = record.split("\x1f");
    if (commit === undefined || parents === undefined) continue;
    const fields = new Map<string, string>();
    for (const line of messageParts.join("\x1f").split(/\r?\n/u)) {
      const match = /^X-Joko-([A-Za-z]+):\s*(.*)$/u.exec(line);
      if (match?.[1] !== undefined && match[2] !== undefined) fields.set(match[1], match[2]);
    }
    const sessionId = fields.get("Session");
    const runId = fields.get("Run");
    const kind = fields.get("Kind");
    if (sessionId !== expectedSessionId || runId === undefined || !isSavepointKind(kind)) continue;
    const firstParent = parents.trim().split(/\s+/u).filter(Boolean)[0];
    entries.push({
      commit: commit.trim(),
      ...(firstParent === undefined ? {} : { parent: firstParent }),
      sessionId,
      runId,
      kind,
      ...(fields.get("Baseline") === undefined ? {} : { baselineCommit: fields.get("Baseline")! }),
      ...(fields.get("Gap") === undefined ? {} : { gapReason: fields.get("Gap") as GitSafetyGapReason })
    });
  }
  return entries;
}

function validateIdentifier(value: string): void {
  if (!SAFE_IDENTIFIER.test(value)) throw new InvalidSavepointIdentifierError();
}

function isSavepointKind(value: string | undefined): value is ShadowSavepointEntry["kind"] {
  return value === "turn_start" || value === "after_edit" || value === "rewind_gap";
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relativeValue = relative(root, candidate);
  return relativeValue === "" || !isAbsolute(relativeValue) && relativeValue !== ".." && !relativeValue.startsWith(`..${sep}`);
}

function chunks<T>(values: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
