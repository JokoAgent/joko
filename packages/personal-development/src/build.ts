import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readdir, rename } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { DevelopmentArtifact, DevelopmentHistoryEntry, DevelopmentOwnerOptions } from "./types.js";
import { PersonalDevelopmentError } from "./types.js";
import { DevelopmentRepository } from "./repository.js";
import { directoryDigest, exists, fileDigest, GIT_IDENTITY, HASH, inside, managedPath, ordinaryDirectory, PERSONAL_BRANCH,
  readJson, removeManaged, writeJson } from "./storage.js";

export interface DevelopmentBuildJournal {
  readonly format: 1; readonly id: string; readonly originalCommit: string; readonly originalTree: string;
  readonly candidateCommit: string; readonly candidateTree: string; readonly candidateDirectory: string;
  readonly stage: "adopting" | "building" | "published";
  readonly sourceRefUpdate?: { readonly mainBefore: string | null; readonly personalUpstreamBefore: string | null; readonly target: string };
  readonly preserveCandidate?: boolean;
}
export async function developmentRuntimeCompatibilityIdentity(runtime: string, platform: NodeJS.Platform): Promise<string> {
  const resources = platform === "darwin" ? join(runtime, "Contents", "Resources") : join(runtime, "resources");
  const schema = join(resources, "orchestrator-runtime", "node_modules", "@joko", "store", "dist", "schema.js");
  return createHash("sha256").update(`joko-personal-runtime-v1\0${await fileDigest(schema)}`).digest("hex");
}
export async function resolveDevelopmentRuntime(release: string, platform: NodeJS.Platform, arch: string): Promise<{ runtimeDirectory: string; executable: string }> {
  await ordinaryDirectory(release);
  const candidates = platform === "win32" ? [join(release, "win-unpacked"), join(release, `win-${arch}-unpacked`)]
    : platform === "linux" ? [join(release, "linux-unpacked"), join(release, `linux-${arch}-unpacked`)]
    : [join(release, "mac", "Joko.app"), join(release, `mac-${arch}`, "Joko.app")];
  const runtimes: string[] = []; for (const candidate of new Set(candidates)) if (await exists(candidate)) runtimes.push(candidate);
  if (runtimes.length !== 1) throw new PersonalDevelopmentError("BUILD_FAILED");
  const runtimeDirectory = runtimes[0]!; await ordinaryDirectory(runtimeDirectory);
  const executable = platform === "darwin" ? join(runtimeDirectory, "Contents", "MacOS", "Joko") : join(runtimeDirectory, platform === "win32" ? "Joko.exe" : "joko");
  if (!(await lstat(executable)).isFile() || (await lstat(executable)).isSymbolicLink()) throw new PersonalDevelopmentError("BUILD_FAILED");
  return { runtimeDirectory, executable };
}
export async function inspectDevelopmentArtifact(artifact: DevelopmentArtifact, root: string): Promise<void> {
  await managedPath(root, artifact.directory); await managedPath(root, artifact.runtimeDirectory);
  if (basename(artifact.installer) !== artifact.installer || await fileDigest(join(artifact.directory, artifact.installer)) !== artifact.sha256
    || await directoryDigest(artifact.runtimeDirectory) !== artifact.runtimeDigest || !inside(artifact.runtimeDirectory, artifact.executable)) throw new PersonalDevelopmentError("ARTIFACT_CHANGED");
  const executable = await lstat(artifact.executable);
  if (!executable.isFile() || executable.isSymbolicLink()) throw new PersonalDevelopmentError("ARTIFACT_CHANGED");
}
export async function restoreDevelopmentBuild(repository: DevelopmentRepository, signal: AbortSignal): Promise<boolean> {
  const file = join(repository.root, "build-journal.json"); if (!await exists(file)) return false;
  const journal = await readJson(file) as DevelopmentBuildJournal;
  if (journal.format !== 1 || ![journal.originalCommit, journal.originalTree, journal.candidateCommit, journal.candidateTree].every(value => HASH.test(value))) throw new PersonalDevelopmentError("STATE_INVALID");
  if (journal.stage === "published") return false;
  await repository.assertSource(signal);
  const referenceChanges: { ref: "refs/heads/main" | "refs/joko-personal/personal-upstream"; before: string | null; current: string | undefined }[] = [];
  if (journal.sourceRefUpdate) {
    const update = journal.sourceRefUpdate;
    if (!HASH.test(update.target) || [update.mainBefore, update.personalUpstreamBefore].some(value => value !== null && !HASH.test(value))) throw new PersonalDevelopmentError("STATE_INVALID");
    for (const [ref, before] of [["refs/heads/main", update.mainBefore], ["refs/joko-personal/personal-upstream", update.personalUpstreamBefore]] as const) {
      const current = await repository.readRef(ref, signal);
      if (current !== (before ?? undefined) && current !== update.target) throw new PersonalDevelopmentError("SOURCE_CHANGED");
      referenceChanges.push({ ref, before, current });
    }
  }
  const head = await repository.head(repository.source, signal); const tree = await repository.snapshot(repository.source, signal);
  if (head !== journal.originalCommit && head !== journal.candidateCommit || tree !== journal.originalTree && tree !== journal.candidateTree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
  if (tree === journal.candidateTree && tree !== journal.originalTree) await repository.apply(repository.source, journal.candidateTree, journal.originalTree, signal);
  if (head === journal.candidateCommit && head !== journal.originalCommit) await repository.git(["update-ref", `refs/heads/${PERSONAL_BRANCH}`, journal.originalCommit, journal.candidateCommit], repository.source, signal);
  await repository.git(["reset", "--mixed", journal.originalCommit], repository.source, signal);
  for (const change of referenceChanges) {
    if (change.current === (change.before ?? undefined)) continue;
    if (change.before === null) await repository.git(["update-ref", "--no-deref", "-d", change.ref, change.current!], repository.source, signal);
    else await repository.git(["update-ref", change.ref, change.before, change.current!], repository.source, signal);
  }
  if (await repository.snapshot(repository.source, signal) !== journal.originalTree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
  await writeJson(file, { ...journal, stage: "published" });
  if (!journal.preserveCandidate && await exists(journal.candidateDirectory)) await repository.removeCandidate(journal.candidateDirectory, signal);
  return true;
}

/** Integrate immutable task deltas in a private candidate and publish a fully hashed asar:false runtime. */
export async function buildDevelopmentVersion(input: {
  readonly repository: DevelopmentRepository; readonly options: DevelopmentOwnerOptions; readonly operationId: string;
  readonly entries: readonly DevelopmentHistoryEntry[]; readonly signal: AbortSignal;
  readonly progress: (stage: string, details?: import("./types.js").DevelopmentProgress) => Promise<void>;
  readonly beforePublish: (artifact: DevelopmentArtifact, integrations: readonly { readonly entryId: string;
    readonly beforeCommit: string; readonly beforeTree: string; readonly afterCommit: string; readonly afterTree: string }[]) => Promise<void>;
}): Promise<DevelopmentArtifact> {
  const { repository: repo, signal } = input; const tools = repo.tools;
  await repo.assertSource(signal); await restoreDevelopmentBuild(repo, signal);
  const original = await repo.commit(repo.source, signal, "chore(personal): preserve local changes");
  const candidate = await repo.candidate(randomUUID(), original.commit, signal);
  let published = false; let unknown = false; let output: string | undefined; let previousRelease: string | undefined;
  let journal: DevelopmentBuildJournal | undefined;
  try {
    await input.progress("integrating");
    const integrations: { entryId: string; beforeCommit: string; beforeTree: string; afterCommit: string; afterTree: string }[] = [];
    for (const entry of input.entries) {
      const beforeCommit = await repo.head(candidate, signal); const beforeTree = await repo.snapshot(candidate, signal);
      const baseTree = await repo.git(["rev-parse", `${entry.baseCommit}^{tree}`], candidate, signal);
      await repo.apply(candidate, baseTree, entry.tree, signal, true);
      // Three-way apply stages resolved files in this disposable candidate.
      const unmerged = await repo.git(["ls-files", "--unmerged"], candidate, signal);
      if (unmerged) throw new PersonalDevelopmentError("CONFLICT");
      const integrated = await repo.commit(candidate, signal, "feat(personal): integrate selected changes");
      integrations.push({ entryId: entry.id, beforeCommit, beforeTree, afterCommit: integrated.commit, afterTree: integrated.tree });
    }
    const next = await repo.commit(candidate, signal, "feat(personal): integrate selected changes");
    if (await repo.head(repo.source, signal) !== original.commit || await repo.snapshot(repo.source, signal) !== original.tree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
    journal = { format: 1, id: input.operationId, originalCommit: original.commit, originalTree: original.tree,
      candidateCommit: next.commit, candidateTree: next.tree, candidateDirectory: candidate, stage: "adopting" };
    await writeJson(join(repo.root, "build-journal.json"), journal);
    await repo.apply(repo.source, original.tree, next.tree, signal);
    await repo.git(["update-ref", `refs/heads/${PERSONAL_BRANCH}`, next.commit, original.commit], repo.source, signal);
    await repo.git(["reset", "--mixed", next.commit], repo.source, signal);
    journal = { ...journal, stage: "building" }; await writeJson(join(repo.root, "build-journal.json"), journal);
    const assertSource = async (): Promise<void> => {
      signal.throwIfAborted(); await repo.assertSource(signal);
      if (await repo.head(repo.source, signal) !== next.commit || await repo.snapshot(repo.source, signal) !== next.tree) throw new PersonalDevelopmentError("SOURCE_CHANGED");
    };
    const step = async (stage: string, args: readonly string[]): Promise<void> => {
      await assertSource(); await input.progress(stage);
      await tools.run("pnpm", args, repo.source, signal, { timeoutMs: 60 * 60_000,
        onProgress: details => { void input.progress(stage, details).catch(() => undefined); } }); await assertSource();
    };
    await step("installing-dependencies", ["install", "--frozen-lockfile", "--prefer-offline", "--prod=false"]);
    await step("checking", ["check"]); await step("testing", ["test"]);
    const release = join(repo.source, "apps", "desktop", "release");
    if (await exists(release)) {
      await ordinaryDirectory(release);
      // Isolate all pre-existing outputs so a no-op packaging command cannot publish a stale build.
      previousRelease = join(repo.root, `previous-release-${randomUUID()}`); await rename(release, previousRelease);
    }
    await step("packaging", ["build:desktop:distribution"]);
    const platform = input.options.platform ?? process.platform; const arch = input.options.arch ?? process.arch;
    const { runtimeDirectory: sourceRuntime } = await resolveDevelopmentRuntime(release, platform, arch); await managedPath(repo.root, sourceRuntime);
    const installerExtension = platform === "win32" ? /\.exe$/iu : platform === "darwin" ? /\.dmg$/iu : /\.AppImage$/u;
    const installers = (await readdir(release)).filter(name => /^Joko-/u.test(name) && installerExtension.test(name));
    if (installers.length !== 1) throw new PersonalDevelopmentError("BUILD_FAILED");
    const originalRuntime = await input.options.nativeVersions.original();
    const compatibilityIdentity = await developmentRuntimeCompatibilityIdentity(sourceRuntime, platform);
    if (compatibilityIdentity !== originalRuntime.compatibilityIdentity) throw new PersonalDevelopmentError("VERSION_INCOMPATIBLE");
    const packages = join(repo.root, "packages"); await mkdir(packages, { recursive: true }); await ordinaryDirectory(packages);
    const id = randomUUID(); output = join(packages, id); await mkdir(output);
    const installer = installers[0]!; const installerSource = join(release, installer);
    await managedPath(repo.root, installerSource); const sha256 = await fileDigest(installerSource);
    await copyFile(installerSource, join(output, installer));
    const runtimeDirectory = join(output, "runtime"); const runtimeDigest = await directoryDigest(sourceRuntime);
    await cp(sourceRuntime, runtimeDirectory, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
    if (await directoryDigest(runtimeDirectory) !== runtimeDigest) throw new PersonalDevelopmentError("ARTIFACT_CHANGED");
    const executable = platform === "darwin" ? join(runtimeDirectory, "Contents", "MacOS", "Joko") : join(runtimeDirectory, platform === "win32" ? "Joko.exe" : "joko");
    const artifact: DevelopmentArtifact = { id, directory: output, installer, sha256, commit: next.commit, tree: next.tree,
      runtimeDirectory, runtimeDigest, executable, compatibilityIdentity, createdAt: (input.options.now ?? Date.now)() };
    await inspectDevelopmentArtifact(artifact, repo.root); await assertSource();
    await writeJson(join(output, "receipt.json"), { format: 1, artifact });
    await input.progress("publishing");
    // A crash before slot publication retains source identity without exposing partial runtime bytes.
    journal = { ...journal, stage: "published" }; await writeJson(join(repo.root, "build-journal.json"), journal);
    await input.beforePublish(artifact, integrations); published = true; return artifact;
  } catch (error) {
    unknown = error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN" || journal?.stage === "published" && !published;
    if (journal && !published && !unknown && journal.stage !== "published") await restoreDevelopmentBuild(repo, new AbortController().signal);
    if (unknown) throw new PersonalDevelopmentError("PROCESS_UNKNOWN"); throw error;
  } finally {
    // Unknown writers keep their candidate/output and rollback journal for explicit recovery.
    if (!unknown && await exists(candidate)) await repo.removeCandidate(candidate, new AbortController().signal).catch(() => undefined);
    if (!unknown && !published && output) await removeManaged(repo.root, output).catch(() => undefined);
    if (!unknown && previousRelease) {
      const release = join(repo.source, "apps", "desktop", "release");
      if (published) await removeManaged(repo.root, previousRelease).catch(() => undefined);
      else {
        if (await exists(release)) await removeManaged(repo.root, release).catch(() => undefined);
        if (!await exists(release)) await rename(previousRelease, release).catch(() => undefined);
      }
    }
  }
}
