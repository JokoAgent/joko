import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isWithin } from "@joko/core/policy";

export interface SnapshotFile {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly modifiedAt: number;
  readonly blobPath: string;
}

export interface WorkspaceBaseline {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly files: Readonly<Record<string, SnapshotFile>>;
  readonly complete: boolean;
  readonly gaps: readonly string[];
  readonly capturedAt: number;
  /** Native conversation leaf active immediately before the captured Run. */
  readonly dialogueEntryId?: string;
}

export interface WorkspaceChange {
  readonly path: string;
  readonly kind: "created" | "updated" | "deleted";
  readonly before?: SnapshotFile;
  readonly after?: SnapshotFile;
}

export interface WorkspaceChangeSetRecord {
  readonly id: string;
  readonly baselineId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly changes: readonly WorkspaceChange[];
  readonly complete: boolean;
  readonly gaps: readonly string[];
  readonly capturedAt: number;
  /** Native conversation leaf to restore without touching workspace files. */
  readonly dialogueEntryId?: string;
}

export interface RewindPreviewRecord {
  readonly id: string;
  readonly changeSetId: string;
  readonly conflicts: readonly string[];
  readonly gaps: readonly string[];
  readonly safe: boolean;
  readonly expiresAt: number;
}

export interface WorkspaceSnapshotRepository {
  putBaseline(value: WorkspaceBaseline): Promise<void>;
  getBaseline(id: string): Promise<WorkspaceBaseline | undefined>;
  listBaselines?(): Promise<readonly WorkspaceBaseline[]>;
  putChangeSet(value: WorkspaceChangeSetRecord): Promise<void>;
  getChangeSet(id: string): Promise<WorkspaceChangeSetRecord | undefined>;
  listChangeSets(): Promise<readonly WorkspaceChangeSetRecord[]>;
  putRewindPreview(value: RewindPreviewRecord): Promise<void>;
  getRewindPreview(id: string): Promise<RewindPreviewRecord | undefined>;
  consumeRewindPreview(id: string, now: number): Promise<boolean>;
}

export interface WorkspaceChangeSetOptions {
  readonly snapshotDirectory: string;
  readonly repository: WorkspaceSnapshotRepository;
  readonly maximumFiles?: number;
  readonly maximumFileBytes?: number;
  readonly maximumTotalBytes?: number;
  readonly previewTtlMs?: number;
  readonly excludedRoots?: readonly string[];
  readonly now?: () => number;
}

type RewindJournalStatus = "claiming" | "applying" | "partial" | "failed" | "outcome_unknown" | "succeeded";
type RewindJournalEntryState = "pending" | "applying" | "applied" | "outcome_unknown";

interface RewindJournalEntry {
  readonly path: string;
  readonly kind: WorkspaceChange["kind"];
  readonly expectedHash?: string;
  readonly desiredHash?: string;
  state: RewindJournalEntryState;
  error?: string;
}

interface RewindApplyJournal {
  readonly format: 1;
  readonly id: string;
  readonly previewId: string;
  readonly changeSetId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly createdAt: number;
  updatedAt: number;
  status: RewindJournalStatus;
  readonly entries: RewindJournalEntry[];
  error?: string;
}

interface SecurePathInspection {
  readonly destination: string;
  readonly parent: string;
  readonly parentIdentity?: FileIdentity;
  readonly ancestors: readonly PathIdentity[];
  readonly leaf?: Stats;
  readonly missingAncestor: boolean;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

interface PathIdentity {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface RewindEntryObservation {
  readonly hash?: string;
  readonly disposition: "expected" | "desired" | "recoverable" | "unknown";
}

interface RewindPreviewSealEntry {
  readonly path: string;
  readonly hash?: string;
  readonly ancestors: readonly PathIdentity[];
  readonly leafIdentity?: FileIdentity;
  readonly missingAncestor: boolean;
}

interface RewindPreviewSeal {
  readonly format: 1;
  readonly previewId: string;
  readonly changeSetId: string;
  readonly workspaceRoot: string;
  readonly entries: readonly RewindPreviewSealEntry[];
}

export class WorkspaceChangeSetService {
  readonly #options: WorkspaceChangeSetOptions;
  readonly #maximumFiles: number;
  readonly #maximumFileBytes: number;
  readonly #maximumTotalBytes: number;
  readonly #previewTtlMs: number;
  readonly #now: () => number;
  readonly #locks = new Map<string, Promise<void>>();
  #snapshotRoot: string | undefined;

  constructor(options: WorkspaceChangeSetOptions) {
    this.#options = options;
    this.#maximumFiles = options.maximumFiles ?? 20_000;
    this.#maximumFileBytes = options.maximumFileBytes ?? 32 * 1024 * 1024;
    this.#maximumTotalBytes = options.maximumTotalBytes ?? 2 * 1024 * 1024 * 1024;
    this.#previewTtlMs = options.previewTtlMs ?? 10 * 60 * 1_000;
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#options.snapshotDirectory, { recursive: true, mode: 0o700 });
    this.#snapshotRoot = await validateRoot(this.#options.snapshotDirectory);
    await ensureDirectChildDirectory(this.#snapshotRoot, "blobs");
    await ensureDirectChildDirectory(this.#snapshotRoot, "rewind-journals");
    await ensureDirectChildDirectory(this.#snapshotRoot, "rewind-previews");
    await this.reconcileIncompleteJournals();
  }

  async captureBaseline(workspaceId: string, workspaceRoot: string, dialogueEntryId?: string): Promise<WorkspaceBaseline> {
    return this.withLock(workspaceId, async () => {
      const root = await validateRoot(workspaceRoot);
      const snapshot = await this.scan(root);
      const baseline: WorkspaceBaseline = {
        id: randomUUID(),
        workspaceId,
        workspaceRoot: root,
        files: snapshot.files,
        complete: snapshot.gaps.length === 0,
        gaps: snapshot.gaps,
        capturedAt: this.#now(),
        ...(dialogueEntryId === undefined ? {} : { dialogueEntryId })
      };
      await this.#options.repository.putBaseline(baseline);
      return baseline;
    });
  }

  async captureChangeSet(baselineId: string, sessionId: string, runId: string, changeSetId: string = randomUUID()): Promise<WorkspaceChangeSetRecord> {
    const baseline = await this.#options.repository.getBaseline(baselineId);
    if (baseline === undefined) throw new Error("Workspace baseline does not exist.");
    return this.withLock(baseline.workspaceId, async () => {
      const current = await this.scan(await validateRoot(baseline.workspaceRoot));
      const paths = new Set([...Object.keys(baseline.files), ...Object.keys(current.files)]);
      const changes: WorkspaceChange[] = [];
      for (const path of [...paths].sort()) {
        const before = baseline.files[path];
        const after = current.files[path];
        if (before?.sha256 === after?.sha256) continue;
        if (before === undefined && after !== undefined) changes.push({ path, kind: "created", after });
        else if (before !== undefined && after === undefined) changes.push({ path, kind: "deleted", before });
        else if (before !== undefined && after !== undefined) changes.push({ path, kind: "updated", before, after });
      }
      const gaps = [...baseline.gaps, ...current.gaps];
      const changeSet: WorkspaceChangeSetRecord = {
        id: changeSetId,
        baselineId,
        workspaceId: baseline.workspaceId,
        workspaceRoot: baseline.workspaceRoot,
        sessionId,
        runId,
        changes,
        complete: baseline.complete && gaps.length === 0,
        gaps,
        capturedAt: this.#now(),
        ...(baseline.dialogueEntryId === undefined ? {} : { dialogueEntryId: baseline.dialogueEntryId })
      };
      await this.#options.repository.putChangeSet(changeSet);
      return changeSet;
    });
  }

  async getChangeSet(id: string): Promise<WorkspaceChangeSetRecord | undefined> {
    return this.#options.repository.getChangeSet(id);
  }

  async getRewindPreview(id: string): Promise<RewindPreviewRecord | undefined> {
    return this.#options.repository.getRewindPreview(id);
  }

  async listChangeSets(filter: { readonly workspaceId?: string; readonly sessionId?: string } = {}): Promise<readonly WorkspaceChangeSetRecord[]> {
    return (await this.#options.repository.listChangeSets())
      .filter((item) => filter.workspaceId === undefined || item.workspaceId === filter.workspaceId)
      .filter((item) => filter.sessionId === undefined || item.sessionId === filter.sessionId)
      .sort((left, right) => right.capturedAt - left.capturedAt);
  }

  /**
   * Removes only snapshot blobs that no surviving baseline or change set can
   * reach. Database history maintenance calls this after its verified commit;
   * user workspace files and Artifact storage are never traversed.
   */
  async removeSessionHistory(_sessionIds: readonly string[]): Promise<void> {
    const listBaselines = this.#options.repository.listBaselines;
    if (listBaselines === undefined) return;
    const [baselines, changeSets] = await Promise.all([
      listBaselines.call(this.#options.repository),
      this.#options.repository.listChangeSets()
    ]);
    const retained = new Set<string>();
    const retainFile = (file: SnapshotFile | undefined): void => {
      if (file !== undefined && /^[a-f0-9]{64}$/u.test(file.sha256)) retained.add(file.sha256);
    };
    for (const baseline of baselines) for (const file of Object.values(baseline.files)) retainFile(file);
    for (const changeSet of changeSets) {
      for (const change of changeSet.changes) {
        retainFile(change.before);
        retainFile(change.after);
      }
    }

    const blobRoot = join(this.snapshotRoot(), "blobs");
    for (const prefix of await readdir(blobRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/u.test(prefix.name)) continue;
      const prefixPath = join(blobRoot, prefix.name);
      for (const entry of await readdir(prefixPath, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}$/u.test(entry.name) || retained.has(entry.name)) continue;
        await unlink(join(prefixPath, entry.name)).catch(() => undefined);
      }
    }
  }

  async previewRewind(changeSetId: string): Promise<RewindPreviewRecord> {
    const changeSet = await this.#options.repository.getChangeSet(changeSetId);
    if (changeSet === undefined) throw new Error("Workspace change set does not exist.");
    return this.withLock(changeSet.workspaceId, async () => {
      let conflicts = [...await this.findConflicts(changeSet)];
      const previewId = randomUUID();
      let seal: RewindPreviewSeal | undefined;
      if (changeSet.complete && conflicts.length === 0 && changeSet.gaps.length === 0) {
        try {
          seal = await this.capturePreviewSeal(previewId, changeSet);
        } catch {
          conflicts = changeSet.changes.map((change) => change.path);
        }
      }
      const preview: RewindPreviewRecord = {
        id: previewId,
        changeSetId,
        conflicts,
        gaps: changeSet.gaps,
        safe: changeSet.complete && conflicts.length === 0 && changeSet.gaps.length === 0,
        expiresAt: this.#now() + this.#previewTtlMs
      };
      if (preview.safe && seal !== undefined) await this.createPreviewSealExclusive(seal);
      await this.#options.repository.putRewindPreview(preview);
      return preview;
    });
  }

  async applyRewind(previewId: string): Promise<void> {
    this.snapshotRoot();
    const existing = await this.loadJournal(previewId);
    if (existing !== undefined) {
      const changeSet = await this.#options.repository.getChangeSet(existing.changeSetId);
      if (changeSet === undefined) throw new Error("Workspace rewind change set is missing.");
      await this.withLock(existing.workspaceId, async () => {
        const current = await this.loadJournal(previewId);
        if (current === undefined) throw new Error("Workspace rewind journal disappeared.");
        await this.resumeRewind(current, changeSet);
      });
      return;
    }

    const preview = await this.#options.repository.getRewindPreview(previewId);
    if (preview === undefined || preview.expiresAt <= this.#now()) throw new Error("Workspace rewind preview is missing or expired.");
    const changeSet = await this.#options.repository.getChangeSet(preview.changeSetId);
    if (changeSet === undefined) throw new Error("Workspace rewind change set is missing.");
    await this.withLock(changeSet.workspaceId, async () => {
      const racedJournal = await this.loadJournal(previewId);
      if (racedJournal !== undefined) {
        await this.resumeRewind(racedJournal, changeSet);
        return;
      }
      if (!preview.safe) throw new Error("Workspace rewind is blocked by incomplete capture or conflicts.");
      await requireCanonicalRoot(changeSet.workspaceRoot);
      const conflicts = await this.findConflicts(changeSet);
      if (conflicts.length > 0) throw new Error(`Workspace changed after preview: ${conflicts.join(", ")}`);
      await this.assertPreviewSeal(previewId, changeSet);

      const journal = this.createJournal(preview, changeSet);
      const created = await this.createJournalExclusive(journal);
      if (!created) {
        const concurrent = await this.loadJournal(previewId);
        if (concurrent === undefined) throw new Error("Workspace rewind journal could not be claimed.");
        await this.resumeRewind(concurrent, changeSet);
        return;
      }
      let previewClaimed: boolean;
      try {
        previewClaimed = await this.#options.repository.consumeRewindPreview(previewId, this.#now());
      } catch {
        journal.status = "outcome_unknown";
        journal.error = "Preview claim failed without a confirmed outcome.";
        await this.persistJournal(journal);
        throw new Error("Workspace rewind preview claim has an unknown outcome; refusing to replay it.");
      }
      if (!previewClaimed) {
        journal.status = "outcome_unknown";
        journal.error = "Preview claim could not be confirmed.";
        await this.persistJournal(journal);
        throw new Error("Workspace rewind preview claim has an unknown outcome; refusing to replay it.");
      }
      journal.status = "applying";
      journal.error = undefined;
      await this.persistJournal(journal);
      await this.resumeRewind(journal, changeSet);
    });
  }

  /** One-shot claim used before an external native-tree navigation effect. */
  async consumeDialogueOnlyRewind(previewId: string): Promise<WorkspaceChangeSetRecord> {
    const preview = await this.#options.repository.getRewindPreview(previewId);
    if (preview === undefined || preview.expiresAt <= this.#now()) throw new Error("Workspace rewind preview is missing or expired.");
    const changeSet = await this.#options.repository.getChangeSet(preview.changeSetId);
    if (changeSet?.dialogueEntryId === undefined) throw new Error("Dialogue-only rewind is unavailable for this change set.");
    return this.withLock(changeSet.workspaceId, async () => {
      if (await this.loadJournal(previewId)) throw new Error("Workspace rewind already has a file apply journal.");
      if (!(await this.#options.repository.consumeRewindPreview(previewId, this.#now()))) {
        throw new Error("Workspace rewind preview was already consumed.");
      }
      return changeSet;
    });
  }

  private snapshotRoot(): string {
    if (this.#snapshotRoot === undefined) throw new Error("Workspace change set service is not initialized.");
    return this.#snapshotRoot;
  }

  private journalDirectory(): string {
    return join(this.snapshotRoot(), "rewind-journals");
  }

  private previewSealDirectory(): string {
    return join(this.snapshotRoot(), "rewind-previews");
  }

  private journalFile(previewId: string): string {
    return join(this.journalDirectory(), `${createHash("sha256").update(previewId).digest("hex")}.json`);
  }

  private previewSealFile(previewId: string): string {
    return join(this.previewSealDirectory(), `${createHash("sha256").update(previewId).digest("hex")}.json`);
  }

  private async capturePreviewSeal(previewId: string, changeSet: WorkspaceChangeSetRecord): Promise<RewindPreviewSeal> {
    await requireCanonicalRoot(changeSet.workspaceRoot);
    const entries: RewindPreviewSealEntry[] = [];
    for (const change of changeSet.changes) {
      const inspection = await inspectWorkspaceFile(changeSet.workspaceRoot, change.path);
      const hash = await hashFromInspection(changeSet.workspaceRoot, change.path, inspection);
      if (hash !== change.after?.sha256) throw new Error(`Workspace changed while sealing ${change.path}.`);
      entries.push({
        path: change.path,
        ...(hash === undefined ? {} : { hash }),
        ancestors: inspection.ancestors,
        ...(inspection.leaf === undefined ? {} : { leafIdentity: fileIdentity(inspection.leaf) }),
        missingAncestor: inspection.missingAncestor
      });
    }
    return { format: 1, previewId, changeSetId: changeSet.id, workspaceRoot: changeSet.workspaceRoot, entries };
  }

  private async createPreviewSealExclusive(seal: RewindPreviewSeal): Promise<void> {
    const directoryIdentity = await validateDirectChildDirectory(this.snapshotRoot(), "rewind-previews");
    const file = this.previewSealFile(seal.previewId);
    let handle;
    let created = false;
    try {
      handle = await open(file, "wx", 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(seal)}\n`, "utf8");
      await handle.sync();
      await assertDirectoryIdentity(this.previewSealDirectory(), directoryIdentity);
    } catch (error) {
      await handle?.close();
      handle = undefined;
      if (created) await safeUnlinkInUnchangedDirectory(this.previewSealDirectory(), directoryIdentity, file);
      throw error;
    } finally {
      await handle?.close();
    }
    await syncDirectoryBestEffort(this.previewSealDirectory());
  }

  private async loadPreviewSeal(previewId: string): Promise<RewindPreviewSeal> {
    await validateDirectChildDirectory(this.snapshotRoot(), "rewind-previews");
    const content = await readRegularFileNoFollow(this.previewSealFile(previewId));
    const seal = parsePreviewSeal(content.toString("utf8"));
    if (seal.previewId !== previewId) throw new Error("Workspace rewind preview seal identity is invalid.");
    return seal;
  }

  private async assertPreviewSeal(previewId: string, changeSet: WorkspaceChangeSetRecord): Promise<RewindPreviewSeal> {
    const seal = await this.loadPreviewSeal(previewId);
    this.validatePreviewSeal(seal, changeSet);
    for (const sealed of seal.entries) await assertSealedWorkspaceBoundary(changeSet.workspaceRoot, sealed, false);
    return seal;
  }

  private validatePreviewSeal(seal: RewindPreviewSeal, changeSet: WorkspaceChangeSetRecord): void {
    if (
      seal.changeSetId !== changeSet.id
      || !samePath(seal.workspaceRoot, changeSet.workspaceRoot)
      || seal.entries.length !== changeSet.changes.length
    ) {
      throw new Error("Workspace rewind preview seal does not match its change set.");
    }
    for (let index = 0; index < seal.entries.length; index += 1) {
      const sealed = seal.entries[index];
      const change = changeSet.changes[index];
      if (sealed === undefined || change === undefined || sealed.path !== change.path || sealed.hash !== change.after?.sha256) {
        throw new Error("Workspace rewind preview seal entries do not match their change set.");
      }
    }
  }

  private createJournal(preview: RewindPreviewRecord, changeSet: WorkspaceChangeSetRecord): RewindApplyJournal {
    const now = this.#now();
    return {
      format: 1,
      id: randomUUID(),
      previewId: preview.id,
      changeSetId: changeSet.id,
      workspaceId: changeSet.workspaceId,
      workspaceRoot: changeSet.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      status: "claiming",
      entries: changeSet.changes.map((change) => ({
        path: change.path,
        kind: change.kind,
        ...(change.after === undefined ? {} : { expectedHash: change.after.sha256 }),
        ...(change.before === undefined ? {} : { desiredHash: change.before.sha256 }),
        state: "pending"
      }))
    };
  }

  private async createJournalExclusive(journal: RewindApplyJournal): Promise<boolean> {
    const directoryIdentity = await validateDirectChildDirectory(this.snapshotRoot(), "rewind-journals");
    const file = this.journalFile(journal.previewId);
    let handle;
    let created = false;
    try {
      handle = await open(file, "wx", 0o600);
      created = true;
      await handle.writeFile(serializeJournal(journal), "utf8");
      await handle.sync();
      await assertDirectoryIdentity(this.journalDirectory(), directoryIdentity);
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      await handle?.close();
      handle = undefined;
      if (created) await safeUnlinkInUnchangedDirectory(this.journalDirectory(), directoryIdentity, file);
      throw error;
    } finally {
      await handle?.close();
    }
    await syncDirectoryBestEffort(this.journalDirectory());
    return true;
  }

  private async persistJournal(journal: RewindApplyJournal): Promise<void> {
    journal.updatedAt = this.#now();
    const directory = this.journalDirectory();
    const directoryIdentity = await validateDirectChildDirectory(this.snapshotRoot(), "rewind-journals");
    const destination = this.journalFile(journal.previewId);
    const temporary = join(directory, `.${journal.id}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(serializeJournal(journal), "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await assertDirectoryIdentity(directory, directoryIdentity);
      await rename(temporary, destination);
      await syncDirectoryBestEffort(directory);
    } catch (error) {
      await handle?.close();
      await safeUnlinkInUnchangedDirectory(directory, directoryIdentity, temporary);
      throw error;
    }
  }

  private async loadJournal(previewId: string): Promise<RewindApplyJournal | undefined> {
    await validateDirectChildDirectory(this.snapshotRoot(), "rewind-journals");
    const file = this.journalFile(previewId);
    let content: Buffer;
    try {
      content = await readRegularFileNoFollow(file);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    const journal = parseJournal(content.toString("utf8"));
    if (journal.previewId !== previewId) throw new Error("Workspace rewind journal identity does not match its file name.");
    return journal;
  }

  private async reconcileIncompleteJournals(): Promise<void> {
    const directory = this.journalDirectory();
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (!child.name.endsWith(".json")) continue;
      if (!child.isFile() || child.isSymbolicLink()) throw new Error("Workspace rewind journal directory contains an unsafe entry.");
      const content = await readRegularFileNoFollow(join(directory, child.name));
      const journal = parseJournal(content.toString("utf8"));
      if (this.journalFile(journal.previewId) !== join(directory, child.name)) {
        throw new Error("Workspace rewind journal file name is invalid.");
      }
      if (journal.status === "succeeded" || journal.status === "outcome_unknown") continue;
      if (journal.status === "claiming") {
        journal.status = "outcome_unknown";
        journal.error = "Service stopped while claiming the preview.";
        await this.persistJournal(journal);
        continue;
      }
      const changeSet = await this.#options.repository.getChangeSet(journal.changeSetId);
      if (changeSet === undefined) {
        journal.status = "outcome_unknown";
        journal.error = "Change set is unavailable during recovery.";
        await this.persistJournal(journal);
        continue;
      }
      try {
        this.validateJournal(journal, changeSet);
        const seal = await this.loadPreviewSeal(journal.previewId);
        this.validatePreviewSeal(seal, changeSet);
        await this.reconcileJournal(journal, changeSet);
      } catch {
        journal.status = "outcome_unknown";
        journal.error = "Journal recovery could not prove the workspace outcome.";
      }
      await this.persistJournal(journal);
    }
  }

  private validateJournal(journal: RewindApplyJournal, changeSet: WorkspaceChangeSetRecord): void {
    if (
      journal.changeSetId !== changeSet.id
      || journal.workspaceId !== changeSet.workspaceId
      || !samePath(journal.workspaceRoot, changeSet.workspaceRoot)
      || journal.entries.length !== changeSet.changes.length
    ) {
      throw new Error("Workspace rewind journal does not match its change set.");
    }
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      const change = changeSet.changes[index];
      if (
        entry === undefined
        || change === undefined
        || entry.path !== change.path
        || entry.kind !== change.kind
        || entry.expectedHash !== change.after?.sha256
        || entry.desiredHash !== change.before?.sha256
      ) {
        throw new Error("Workspace rewind journal entries do not match their change set.");
      }
      validateRelativeFilePath(entry.path);
    }
  }

  private async resumeRewind(journal: RewindApplyJournal, changeSet: WorkspaceChangeSetRecord): Promise<void> {
    this.validateJournal(journal, changeSet);
    if (journal.status === "succeeded") return;
    if (journal.status === "outcome_unknown") {
      throw new Error("Workspace rewind has an unknown prior outcome; refusing to replay it.");
    }
    if (journal.status === "claiming") {
      throw new Error("Workspace rewind preview claim is still in progress; refusing a concurrent replay.");
    }
    let seal: RewindPreviewSeal;
    try {
      await requireCanonicalRoot(changeSet.workspaceRoot);
      seal = await this.loadPreviewSeal(journal.previewId);
      this.validatePreviewSeal(seal, changeSet);
    } catch (error) {
      journal.status = "outcome_unknown";
      journal.error = boundedErrorMessage(error);
      await this.persistJournal(journal);
      throw error;
    }
    await this.reconcileJournal(journal, changeSet);
    const reconciledStatus = journal.status as RewindJournalStatus;
    if (reconciledStatus === "outcome_unknown") {
      await this.persistJournal(journal);
      throw new Error("Workspace rewind has an unknown filesystem outcome; refusing to replay it.");
    }
    if (reconciledStatus === "succeeded") {
      await this.persistJournal(journal);
      return;
    }

    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      const change = changeSet.changes[index];
      if (entry === undefined || change === undefined || entry.state === "applied") continue;
      const sealed = seal.entries[index];
      if (sealed === undefined) throw new Error("Workspace rewind preview seal entry is missing.");
      const boundaryObservation = await this.observeEntry(journal, entry, index);
      try {
        await assertSealedWorkspaceBoundary(
          journal.workspaceRoot,
          sealed,
          boundaryObservation.disposition === "recoverable"
            || (
              entry.kind === "deleted"
              && sealed.missingAncestor
              && (entry.state === "applying" || wasMissingAncestorCreatedByAppliedEntry(journal, seal, index))
            )
        );
      } catch (error) {
        entry.state = "outcome_unknown";
        entry.error = boundedErrorMessage(error);
        journal.status = "outcome_unknown";
        journal.error = entry.error;
        await this.persistJournal(journal);
        throw error;
      }
      entry.state = "applying";
      entry.error = undefined;
      journal.status = journal.entries.some((candidate) => candidate.state === "applied") ? "partial" : "applying";
      journal.error = undefined;
      await this.persistJournal(journal);
      try {
        await this.applyJournalEntry(journal, entry, change, index);
        const observation = await this.observeEntry(journal, entry, index);
        if (observation.disposition !== "desired") throw new Error("Workspace rewind mutation could not be verified.");
        entry.state = "applied";
        entry.error = undefined;
        await this.cleanupEntryArtifacts(journal, entry, index);
        journal.status = journal.entries.every((candidate) => candidate.state === "applied") ? "succeeded" : "partial";
        await this.persistJournal(journal);
      } catch (error) {
        const observation = await this.observeEntrySafely(journal, entry, index);
        if (observation.disposition === "desired") {
          entry.state = "applied";
          entry.error = undefined;
        } else if (observation.disposition === "expected" || observation.disposition === "recoverable") {
          entry.state = "applying";
          entry.error = boundedErrorMessage(error);
        } else {
          entry.state = "outcome_unknown";
          entry.error = "Filesystem outcome could not be proven.";
        }
        journal.status = entry.state === "outcome_unknown"
          ? "outcome_unknown"
          : journal.entries.some((candidate) => candidate.state === "applied") ? "partial" : "failed";
        journal.error = entry.error;
        await this.persistJournal(journal);
        if (entry.state === "applied") continue;
        if (entry.state === "outcome_unknown") {
          throw new Error(`Workspace rewind outcome is unknown for ${entry.path}; refusing to replay it.`);
        }
        throw error;
      }
    }

    journal.status = "succeeded";
    journal.error = undefined;
    await this.persistJournal(journal);
  }

  private async reconcileJournal(journal: RewindApplyJournal, changeSet: WorkspaceChangeSetRecord): Promise<void> {
    let unknown = false;
    for (let index = 0; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      if (entry === undefined) continue;
      const observation = await this.observeEntrySafely(journal, entry, index);
      if (observation.disposition === "desired") {
        entry.state = "applied";
        entry.error = undefined;
      } else if (observation.disposition === "expected") {
        if (entry.state === "applied") {
          entry.state = "outcome_unknown";
          entry.error = "An already applied file no longer has its restored content.";
          unknown = true;
        } else {
          entry.state = entry.state === "applying" ? "applying" : "pending";
        }
      } else if (observation.disposition === "recoverable") {
        entry.state = "applying";
      } else {
        entry.state = "outcome_unknown";
        entry.error = "Filesystem state matches neither the initial nor restored state.";
        unknown = true;
      }
    }
    if (unknown) journal.status = "outcome_unknown";
    else if (journal.entries.every((entry) => entry.state === "applied")) journal.status = "succeeded";
    else if (journal.entries.some((entry) => entry.state === "applied")) journal.status = "partial";
    else journal.status = "failed";
    if (!unknown) journal.error = undefined;
    this.validateJournal(journal, changeSet);
  }

  private async observeEntrySafely(journal: RewindApplyJournal, entry: RewindJournalEntry, index: number): Promise<RewindEntryObservation> {
    try {
      return await this.observeEntry(journal, entry, index);
    } catch {
      return { disposition: "unknown" };
    }
  }

  private async observeEntry(journal: RewindApplyJournal, entry: RewindJournalEntry, index: number): Promise<RewindEntryObservation> {
    const hash = await hashSecureWorkspaceFile(journal.workspaceRoot, entry.path);
    if (hash === entry.desiredHash) return { hash, disposition: "desired" };
    if (hash === entry.expectedHash) {
      if (entry.kind === "updated") {
        const backup = await hashSecureWorkspaceFile(journal.workspaceRoot, this.entryArtifactPath(journal, entry, index, "bak"));
        if (backup !== undefined) return { hash, disposition: "unknown" };
      }
      return { hash, disposition: "expected" };
    }
    if (entry.kind === "updated" && hash === undefined) {
      const backup = await hashSecureWorkspaceFile(journal.workspaceRoot, this.entryArtifactPath(journal, entry, index, "bak"));
      const temporary = await hashSecureWorkspaceFile(journal.workspaceRoot, this.entryArtifactPath(journal, entry, index, "tmp"));
      if (backup === entry.expectedHash && temporary === entry.desiredHash) return { hash, disposition: "recoverable" };
    }
    return { hash, disposition: "unknown" };
  }

  private entryArtifactPath(journal: RewindApplyJournal, entry: RewindJournalEntry, index: number, suffix: "tmp" | "bak"): string {
    const segments = validateRelativeFilePath(entry.path);
    const leaf = segments.at(-1);
    if (leaf === undefined) throw new Error("Workspace rewind path has no file name.");
    segments[segments.length - 1] = `.${leaf}.joko-rewind-${journal.id.slice(0, 20)}-${index}.${suffix}`;
    return segments.join("/");
  }

  private async applyJournalEntry(
    journal: RewindApplyJournal,
    entry: RewindJournalEntry,
    change: WorkspaceChange,
    index: number
  ): Promise<void> {
    if (entry.kind === "created") {
      const inspection = await inspectWorkspaceFile(journal.workspaceRoot, entry.path);
      const current = await hashFromInspection(journal.workspaceRoot, entry.path, inspection);
      if (current !== entry.expectedHash) throw new Error(`Workspace changed while rewinding ${entry.path}.`);
      await assertInspectionUnchanged(journal.workspaceRoot, entry.path, inspection, entry.expectedHash);
      await unlink(inspection.destination);
      if ((await hashSecureWorkspaceFile(journal.workspaceRoot, entry.path)) !== undefined) {
        throw new Error(`Workspace rewind deletion could not be verified for ${entry.path}.`);
      }
      return;
    }

    const before = change.before;
    if (before === undefined || before.sha256 !== entry.desiredHash) {
      throw new Error(`Workspace rewind has no valid baseline for ${entry.path}.`);
    }
    const content = await this.readBaselineBlob(before);
    const temporaryPath = this.entryArtifactPath(journal, entry, index, "tmp");
    const backupPath = this.entryArtifactPath(journal, entry, index, "bak");
    await ensureSecureWorkspaceParent(journal.workspaceRoot, entry.path);
    await this.ensureTemporaryFile(journal.workspaceRoot, temporaryPath, entry.desiredHash, content);

    if (entry.kind === "deleted") {
      const destination = await inspectWorkspaceFile(journal.workspaceRoot, entry.path);
      if (destination.leaf !== undefined) throw new Error(`Workspace changed while rewinding ${entry.path}.`);
      const temporary = await inspectWorkspaceFile(journal.workspaceRoot, temporaryPath);
      await assertInspectionUnchanged(journal.workspaceRoot, temporaryPath, temporary, entry.desiredHash);
      await assertInspectionUnchanged(journal.workspaceRoot, entry.path, destination, undefined);
      await rename(temporary.destination, destination.destination);
      return;
    }

    const observation = await this.observeEntry(journal, entry, index);
    if (observation.disposition === "recoverable") {
      const destination = await inspectWorkspaceFile(journal.workspaceRoot, entry.path);
      const temporary = await inspectWorkspaceFile(journal.workspaceRoot, temporaryPath);
      await assertInspectionUnchanged(journal.workspaceRoot, temporaryPath, temporary, entry.desiredHash);
      await assertInspectionUnchanged(journal.workspaceRoot, entry.path, destination, undefined);
      await rename(temporary.destination, destination.destination);
      return;
    }
    if (observation.disposition !== "expected") throw new Error(`Workspace changed while rewinding ${entry.path}.`);
    if ((await hashSecureWorkspaceFile(journal.workspaceRoot, backupPath)) !== undefined) {
      throw new Error(`Workspace rewind backup path is unexpectedly occupied for ${entry.path}.`);
    }
    const destination = await inspectWorkspaceFile(journal.workspaceRoot, entry.path);
    const temporary = await inspectWorkspaceFile(journal.workspaceRoot, temporaryPath);
    const emptyBackup = await inspectWorkspaceFile(journal.workspaceRoot, backupPath);
    await assertInspectionUnchanged(journal.workspaceRoot, temporaryPath, temporary, entry.desiredHash);
    await assertInspectionUnchanged(journal.workspaceRoot, backupPath, emptyBackup, undefined);
    await assertInspectionUnchanged(journal.workspaceRoot, entry.path, destination, entry.expectedHash);
    await rename(destination.destination, emptyBackup.destination);
    const movedDestination = await inspectWorkspaceFile(journal.workspaceRoot, entry.path);
    const backup = await inspectWorkspaceFile(journal.workspaceRoot, backupPath);
    await assertInspectionUnchanged(journal.workspaceRoot, backupPath, backup, entry.expectedHash);
    await assertInspectionUnchanged(journal.workspaceRoot, temporaryPath, temporary, entry.desiredHash);
    await assertInspectionUnchanged(journal.workspaceRoot, entry.path, movedDestination, undefined);
    await rename(temporary.destination, destination.destination);
  }

  private async ensureTemporaryFile(root: string, path: string, desiredHash: string | undefined, content: Buffer): Promise<void> {
    if (desiredHash === undefined) throw new Error("Workspace rewind temporary file has no desired hash.");
    const existingHash = await hashSecureWorkspaceFile(root, path);
    if (existingHash !== undefined) {
      if (existingHash !== desiredHash) throw new Error("Workspace rewind temporary path is unexpectedly occupied.");
      return;
    }
    const inspection = await inspectWorkspaceFile(root, path);
    const handle = await open(inspection.destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
      const written = await handle.stat();
      if (!written.isFile() || written.isSymbolicLink()) throw new Error("Workspace rewind temporary file is unsafe.");
    } finally {
      await handle.close();
    }
    await assertInspectionAncestorsUnchanged(root, inspection);
    if ((await hashSecureWorkspaceFile(root, path)) !== desiredHash) {
      throw new Error("Workspace rewind temporary file could not be verified.");
    }
  }

  private async cleanupEntryArtifacts(journal: RewindApplyJournal, entry: RewindJournalEntry, index: number): Promise<void> {
    for (const [suffix, expected] of [["tmp", entry.desiredHash], ["bak", entry.expectedHash]] as const) {
      const path = this.entryArtifactPath(journal, entry, index, suffix);
      const hash = await hashSecureWorkspaceFile(journal.workspaceRoot, path);
      if (hash === undefined) continue;
      if (hash !== expected) throw new Error(`Workspace rewind ${suffix} artifact has unexpected content.`);
      const inspection = await inspectWorkspaceFile(journal.workspaceRoot, path);
      await assertInspectionUnchanged(journal.workspaceRoot, path, inspection, expected);
      await unlink(inspection.destination);
    }
  }

  private async readBaselineBlob(file: SnapshotFile): Promise<Buffer> {
    const expected = join(this.snapshotRoot(), "blobs", file.sha256.slice(0, 2), file.sha256);
    if (!samePath(resolve(file.blobPath), expected)) throw new Error("Workspace rewind baseline blob path is invalid.");
    const content = await readSecureFileWithinRoot(this.snapshotRoot(), toSlash(relative(this.snapshotRoot(), expected)));
    const hash = createHash("sha256").update(content).digest("hex");
    if (hash !== file.sha256 || content.byteLength !== file.byteLength) throw new Error("Workspace rewind baseline blob is corrupt.");
    return content;
  }

  private async scan(root: string): Promise<{ files: Readonly<Record<string, SnapshotFile>>; gaps: readonly string[] }> {
    const files: Record<string, SnapshotFile> = {};
    const gaps: string[] = [];
    let totalBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      let children: Dirent[];
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        gaps.push(`${toSlash(relative(root, directory)) || "."}: directory capture failed (${errorMessage(error)})`);
        return;
      }
      for (const child of children) {
        if (child.name === ".git" || child.name === ".joko" || child.name === "node_modules") continue;
        const absolute = resolve(directory, child.name);
        const path = toSlash(relative(root, absolute));
        if ((this.#options.excludedRoots ?? []).some((excluded) => isWithin(absolute, excluded))) continue;
        if (child.isSymbolicLink()) {
          gaps.push(`${path}: symbolic link`);
          continue;
        }
        if (child.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!child.isFile()) {
          gaps.push(`${path}: special file`);
          continue;
        }
        if (Object.keys(files).length >= this.#maximumFiles) {
          gaps.push("workspace: file count limit exceeded");
          return;
        }
        let before;
        try {
          before = await stat(absolute);
        } catch (error) {
          gaps.push(`${path}: metadata capture failed (${errorMessage(error)})`);
          continue;
        }
        if (before.size > this.#maximumFileBytes || totalBytes + before.size > this.#maximumTotalBytes) {
          gaps.push(`${path}: capture size limit exceeded`);
          continue;
        }
        let content: Buffer;
        try {
          content = await readStableFile(absolute, before.size, before.mtimeMs);
        } catch (error) {
          gaps.push(`${path}: stable capture failed (${errorMessage(error)})`);
          continue;
        }
        const sha256 = createHash("sha256").update(content).digest("hex");
        const blobPath = join(this.snapshotRoot(), "blobs", sha256.slice(0, 2), sha256);
        await ensureDirectChildDirectory(join(this.snapshotRoot(), "blobs"), sha256.slice(0, 2));
        try {
          await writeFile(blobPath, content, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        totalBytes += content.byteLength;
        files[path] = { path, sha256, byteLength: content.byteLength, modifiedAt: before.mtimeMs, blobPath };
      }
    };
    await visit(root);
    return { files, gaps };
  }

  private async findConflicts(changeSet: WorkspaceChangeSetRecord): Promise<readonly string[]> {
    const conflicts: string[] = [];
    for (const change of changeSet.changes) {
      try {
        validateRelativeFilePath(change.path);
        await requireCanonicalRoot(changeSet.workspaceRoot);
        const currentHash = await hashSecureWorkspaceFile(changeSet.workspaceRoot, change.path);
        const expected = change.after?.sha256;
        if (currentHash !== expected) conflicts.push(change.path);
      } catch {
        conflicts.push(change.path);
      }
    }
    return conflicts;
  }

  private async withLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(workspaceId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const chained = prior.then(() => current);
    this.#locks.set(workspaceId, chained);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(workspaceId) === chained) this.#locks.delete(workspaceId);
    }
  }
}

async function validateRoot(path: string): Promise<string> {
  const root = await realpath(resolve(path));
  await validateDirectoryChain(root);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workspace root is not a real directory.");
  return root;
}

async function requireCanonicalRoot(path: string): Promise<string> {
  const requested = resolve(path);
  const canonical = await validateRoot(requested);
  if (!samePath(requested, canonical)) throw new Error("Workspace root is no longer its canonical directory.");
  return canonical;
}

async function validateDirectoryChain(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const remainder = relative(parsed.root, absolute);
  const components = remainder === "" ? [] : remainder.split(sep);
  let current = parsed.root;
  await assertRealDirectory(current);
  for (const component of components) {
    current = join(current, component);
    await assertRealDirectory(current);
  }
}

async function assertRealDirectory(path: string): Promise<Stats> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory in workspace path: ${path}`);
  const canonical = await realpath(path);
  if (!samePath(path, canonical)) throw new Error(`Reparse or aliased directory in workspace path: ${path}`);
  return info;
}

async function ensureDirectChildDirectory(root: string, name: string): Promise<FileIdentity> {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("Managed directory name is invalid.");
  }
  const canonicalRoot = await requireCanonicalRoot(root);
  const parent = await lstat(canonicalRoot);
  const parentIdentity = fileIdentity(parent);
  const child = join(canonicalRoot, name);
  try {
    await mkdir(child, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await assertDirectoryIdentity(canonicalRoot, parentIdentity);
  return fileIdentity(await assertRealDirectory(child));
}

async function validateDirectChildDirectory(root: string, name: string): Promise<FileIdentity> {
  const canonicalRoot = await requireCanonicalRoot(root);
  return fileIdentity(await assertRealDirectory(join(canonicalRoot, name)));
}

async function assertDirectoryIdentity(path: string, expected: FileIdentity): Promise<void> {
  const actual = await assertRealDirectory(path);
  if (!sameIdentity(fileIdentity(actual), expected)) throw new Error(`Directory identity changed during workspace operation: ${path}`);
}

function validateRelativeFilePath(path: string): string[] {
  if (
    path === ""
    || path.includes("\0")
    || path.includes("\\")
    || (process.platform === "win32" && path.includes(":"))
    || isAbsolute(path)
  ) {
    throw new Error("Workspace rewind path is not a canonical relative file path.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Workspace rewind path contains an unsafe component.");
  }
  if (process.platform === "win32") {
    const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
    if (segments.some((segment) => segment.endsWith(".") || segment.endsWith(" ") || reserved.test(segment))) {
      throw new Error("Workspace rewind path is not a canonical Windows file path.");
    }
  }
  return segments;
}

function resolveWorkspaceFile(root: string, path: string): string {
  const segments = validateRelativeFilePath(path);
  const destination = resolve(root, ...segments);
  if (!isWithin(destination, root) || samePath(destination, root)) throw new Error("Workspace rewind path escaped its root.");
  return destination;
}

async function inspectWorkspaceFile(root: string, path: string): Promise<SecurePathInspection> {
  const canonicalRoot = await requireCanonicalRoot(root);
  const segments = validateRelativeFilePath(path);
  const destination = resolveWorkspaceFile(canonicalRoot, path);
  const parent = resolve(canonicalRoot, ...segments.slice(0, -1));
  const rootInfo = await lstat(canonicalRoot);
  const ancestors: PathIdentity[] = [{ path: canonicalRoot, identity: fileIdentity(rootInfo) }];
  let current = canonicalRoot;
  let missingAncestor = false;
  for (const component of segments.slice(0, -1)) {
    current = join(current, component);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      missingAncestor = true;
      break;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe workspace ancestor for ${path}.`);
    const canonical = await realpath(current);
    if (!samePath(canonical, current)) throw new Error(`Reparse workspace ancestor for ${path}.`);
    ancestors.push({ path: current, identity: fileIdentity(info) });
  }
  if (missingAncestor) {
    return { destination, parent, ancestors, missingAncestor: true };
  }
  const parentIdentity = ancestors.at(-1)?.identity;
  let leaf: Stats | undefined;
  try {
    leaf = await lstat(destination);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (leaf !== undefined && (!leaf.isFile() || leaf.isSymbolicLink())) {
    throw new Error(`Unsafe workspace file for ${path}.`);
  }
  return { destination, parent, parentIdentity, ancestors, leaf, missingAncestor: false };
}

async function ensureSecureWorkspaceParent(root: string, path: string): Promise<SecurePathInspection> {
  const canonicalRoot = await requireCanonicalRoot(root);
  const segments = validateRelativeFilePath(path);
  let current = canonicalRoot;
  let currentIdentity = fileIdentity(await lstat(current));
  for (const component of segments.slice(0, -1)) {
    const next = join(current, component);
    try {
      await lstat(next);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      await assertDirectoryIdentity(current, currentIdentity);
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
      }
      await assertDirectoryIdentity(current, currentIdentity);
    }
    const nextInfo = await assertRealDirectory(next);
    current = next;
    currentIdentity = fileIdentity(nextInfo);
  }
  return inspectWorkspaceFile(canonicalRoot, path);
}

async function assertInspectionAncestorsUnchanged(root: string, inspection: SecurePathInspection): Promise<void> {
  await requireCanonicalRoot(root);
  for (const ancestor of inspection.ancestors) {
    await assertDirectoryIdentity(ancestor.path, ancestor.identity);
  }
}

async function assertInspectionUnchanged(
  root: string,
  path: string,
  inspection: SecurePathInspection,
  expectedHash: string | undefined
): Promise<void> {
  await assertInspectionAncestorsUnchanged(root, inspection);
  const fresh = await inspectWorkspaceFile(root, path);
  if (!sameAncestorIdentities(inspection.ancestors, fresh.ancestors)) {
    throw new Error(`Workspace ancestor changed during rewind for ${path}.`);
  }
  if (inspection.leaf === undefined) {
    if (fresh.leaf !== undefined) throw new Error(`Workspace file appeared during rewind for ${path}.`);
  } else if (fresh.leaf === undefined || !sameIdentity(fileIdentity(inspection.leaf), fileIdentity(fresh.leaf))) {
    throw new Error(`Workspace file identity changed during rewind for ${path}.`);
  }
  const actualHash = await hashFromInspection(root, path, fresh);
  if (actualHash !== expectedHash) throw new Error(`Workspace content changed during rewind for ${path}.`);
}

async function hashSecureWorkspaceFile(root: string, path: string): Promise<string | undefined> {
  const inspection = await inspectWorkspaceFile(root, path);
  return hashFromInspection(root, path, inspection);
}

async function hashFromInspection(root: string, path: string, inspection: SecurePathInspection): Promise<string | undefined> {
  if (inspection.missingAncestor || inspection.leaf === undefined) return undefined;
  const content = await readRegularFileNoFollow(inspection.destination, inspection.leaf);
  await assertInspectionAncestorsUnchanged(root, inspection);
  const fresh = await inspectWorkspaceFile(root, path);
  if (
    fresh.leaf === undefined
    || !sameAncestorIdentities(inspection.ancestors, fresh.ancestors)
    || !sameIdentity(fileIdentity(inspection.leaf), fileIdentity(fresh.leaf))
  ) {
    throw new Error(`Workspace path changed while reading ${path}.`);
  }
  return createHash("sha256").update(content).digest("hex");
}

async function readSecureFileWithinRoot(root: string, path: string): Promise<Buffer> {
  const inspection = await inspectWorkspaceFile(root, path);
  if (inspection.missingAncestor || inspection.leaf === undefined) throw new Error("Managed snapshot file is missing.");
  const content = await readRegularFileNoFollow(inspection.destination, inspection.leaf);
  await assertInspectionAncestorsUnchanged(root, inspection);
  const fresh = await inspectWorkspaceFile(root, path);
  if (
    fresh.leaf === undefined
    || !sameAncestorIdentities(inspection.ancestors, fresh.ancestors)
    || !sameIdentity(fileIdentity(inspection.leaf), fileIdentity(fresh.leaf))
  ) {
    throw new Error("Managed snapshot file changed while it was read.");
  }
  return content;
}

async function readStableFile(path: string, expectedSize: number, expectedMtime: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Workspace file is unsafe: ${path}`);
  const content = await readRegularFileNoFollow(path, before);
  const after = await stat(path);
  if (
    !sameIdentity(fileIdentity(before), fileIdentity(after))
    || after.size !== expectedSize
    || after.mtimeMs !== expectedMtime
    || content.byteLength !== after.size
  ) {
    throw new Error(`Workspace file changed during capture: ${path}`);
  }
  return content;
}

async function readRegularFileNoFollow(path: string, expected?: Stats): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | noFollowFlag());
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`File is not a regular no-follow file: ${path}`);
    if (expected !== undefined && !sameIdentity(fileIdentity(before), fileIdentity(expected))) {
      throw new Error(`File identity changed before it was opened: ${path}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      !sameIdentity(fileIdentity(before), fileIdentity(after))
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || content.byteLength !== after.size
    ) {
      throw new Error(`File changed while it was read: ${path}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

function fileIdentity(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function sameAncestorIdentities(left: readonly PathIdentity[], right: readonly PathIdentity[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && samePath(item.path, other.path) && sameIdentity(item.identity, other.identity);
  });
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

async function safeUnlinkKnownFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return;
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function safeUnlinkInUnchangedDirectory(directory: string, identity: FileIdentity, path: string): Promise<void> {
  try {
    await assertDirectoryIdentity(directory, identity);
  } catch {
    return;
  }
  await safeUnlinkKnownFile(path);
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let handle;
  try {
    const directoryFlag = typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
    handle = await open(path, constants.O_RDONLY | directoryFlag);
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported Windows filesystems.
  } finally {
    await handle?.close();
  }
}

function serializeJournal(journal: RewindApplyJournal): string {
  return `${JSON.stringify(journal)}\n`;
}

function parseJournal(content: string): RewindApplyJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Workspace rewind journal is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new Error("Workspace rewind journal has an invalid shape.");
  const statuses: readonly RewindJournalStatus[] = ["claiming", "applying", "partial", "failed", "outcome_unknown", "succeeded"];
  const states: readonly RewindJournalEntryState[] = ["pending", "applying", "applied", "outcome_unknown"];
  if (
    parsed.format !== 1
    || !isNonEmptyString(parsed.id)
    || !isNonEmptyString(parsed.previewId)
    || !isNonEmptyString(parsed.changeSetId)
    || !isNonEmptyString(parsed.workspaceId)
    || !isNonEmptyString(parsed.workspaceRoot)
    || !isFiniteNumber(parsed.createdAt)
    || !isFiniteNumber(parsed.updatedAt)
    || typeof parsed.status !== "string"
    || !statuses.includes(parsed.status as RewindJournalStatus)
    || !Array.isArray(parsed.entries)
    || (parsed.error !== undefined && typeof parsed.error !== "string")
  ) {
    throw new Error("Workspace rewind journal metadata is invalid.");
  }
  const entries: RewindJournalEntry[] = parsed.entries.map((candidate: unknown) => {
    if (!isRecord(candidate)) throw new Error("Workspace rewind journal entry is invalid.");
    const expectedHash = optionalHash(candidate.expectedHash);
    const desiredHash = optionalHash(candidate.desiredHash);
    if (
      !isNonEmptyString(candidate.path)
      || (candidate.kind !== "created" && candidate.kind !== "updated" && candidate.kind !== "deleted")
      || typeof candidate.state !== "string"
      || !states.includes(candidate.state as RewindJournalEntryState)
      || (candidate.error !== undefined && typeof candidate.error !== "string")
      || (candidate.kind === "created" && (expectedHash === undefined || desiredHash !== undefined))
      || (candidate.kind === "deleted" && (expectedHash !== undefined || desiredHash === undefined))
      || (candidate.kind === "updated" && (expectedHash === undefined || desiredHash === undefined))
    ) {
      throw new Error("Workspace rewind journal entry metadata is invalid.");
    }
    validateRelativeFilePath(candidate.path);
    return {
      path: candidate.path,
      kind: candidate.kind,
      ...(expectedHash === undefined ? {} : { expectedHash }),
      ...(desiredHash === undefined ? {} : { desiredHash }),
      state: candidate.state as RewindJournalEntryState,
      ...(candidate.error === undefined ? {} : { error: candidate.error })
    };
  });
  return {
    format: 1,
    id: parsed.id,
    previewId: parsed.previewId,
    changeSetId: parsed.changeSetId,
    workspaceId: parsed.workspaceId,
    workspaceRoot: parsed.workspaceRoot,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    status: parsed.status as RewindJournalStatus,
    entries,
    ...(parsed.error === undefined ? {} : { error: parsed.error })
  };
}

function parsePreviewSeal(content: string): RewindPreviewSeal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Workspace rewind preview seal is not valid JSON.");
  }
  if (
    !isRecord(parsed)
    || parsed.format !== 1
    || !isNonEmptyString(parsed.previewId)
    || !isNonEmptyString(parsed.changeSetId)
    || !isNonEmptyString(parsed.workspaceRoot)
    || !Array.isArray(parsed.entries)
  ) {
    throw new Error("Workspace rewind preview seal metadata is invalid.");
  }
  const entries: RewindPreviewSealEntry[] = parsed.entries.map((candidate: unknown) => {
    if (
      !isRecord(candidate)
      || !isNonEmptyString(candidate.path)
      || typeof candidate.missingAncestor !== "boolean"
      || !Array.isArray(candidate.ancestors)
    ) {
      throw new Error("Workspace rewind preview seal entry is invalid.");
    }
    validateRelativeFilePath(candidate.path);
    const hash = optionalHash(candidate.hash);
    const leafIdentity = candidate.leafIdentity === undefined ? undefined : parseFileIdentity(candidate.leafIdentity);
    const ancestors: PathIdentity[] = candidate.ancestors.map((ancestor: unknown) => {
      if (!isRecord(ancestor) || !isNonEmptyString(ancestor.path)) {
        throw new Error("Workspace rewind preview seal ancestor is invalid.");
      }
      return { path: ancestor.path, identity: parseFileIdentity(ancestor.identity) };
    });
    if (ancestors.length === 0) throw new Error("Workspace rewind preview seal has no root identity.");
    return {
      path: candidate.path,
      ...(hash === undefined ? {} : { hash }),
      ancestors,
      ...(leafIdentity === undefined ? {} : { leafIdentity }),
      missingAncestor: candidate.missingAncestor
    };
  });
  return {
    format: 1,
    previewId: parsed.previewId,
    changeSetId: parsed.changeSetId,
    workspaceRoot: parsed.workspaceRoot,
    entries
  };
}

function parseFileIdentity(value: unknown): FileIdentity {
  if (
    !isRecord(value)
    || !isFiniteNumber(value.dev)
    || !isFiniteNumber(value.ino)
    || !isFiniteNumber(value.birthtimeMs)
  ) {
    throw new Error("Workspace rewind filesystem identity is invalid.");
  }
  return { dev: value.dev, ino: value.ino, birthtimeMs: value.birthtimeMs };
}

async function assertSealedWorkspaceBoundary(
  root: string,
  sealed: RewindPreviewSealEntry,
  allowManagedIntermediate: boolean
): Promise<void> {
  const inspection = await inspectWorkspaceFile(root, sealed.path);
  const exactAncestors = sameAncestorIdentities(sealed.ancestors, inspection.ancestors);
  const sealedPrefix = inspection.ancestors.length >= sealed.ancestors.length
    && sameAncestorIdentities(sealed.ancestors, inspection.ancestors.slice(0, sealed.ancestors.length));
  if (
    (!allowManagedIntermediate && (!exactAncestors || inspection.missingAncestor !== sealed.missingAncestor))
    || (allowManagedIntermediate && (!sealedPrefix || (!sealed.missingAncestor && !exactAncestors)))
  ) {
    throw new Error(`Workspace ancestor identity changed after preview for ${sealed.path}.`);
  }
  if (!allowManagedIntermediate) {
    if (sealed.leafIdentity === undefined) {
      if (inspection.leaf !== undefined) throw new Error(`Workspace file appeared after preview for ${sealed.path}.`);
    } else if (inspection.leaf === undefined || !sameIdentity(sealed.leafIdentity, fileIdentity(inspection.leaf))) {
      throw new Error(`Workspace file identity changed after preview for ${sealed.path}.`);
    }
    const hash = await hashFromInspection(root, sealed.path, inspection);
    if (hash !== sealed.hash) throw new Error(`Workspace content changed after preview for ${sealed.path}.`);
  }
}

function wasMissingAncestorCreatedByAppliedEntry(
  journal: RewindApplyJournal,
  seal: RewindPreviewSeal,
  index: number
): boolean {
  const currentSeal = seal.entries[index];
  if (currentSeal === undefined || !currentSeal.missingAncestor) return false;
  const components = validateRelativeFilePath(currentSeal.path);
  const firstMissingPrefix = components.slice(0, currentSeal.ancestors.length).join("/");
  if (firstMissingPrefix === "") return false;
  return journal.entries.some((entry, candidateIndex) => {
    if (candidateIndex === index || entry.kind !== "deleted" || entry.state !== "applied") return false;
    const candidateSeal = seal.entries[candidateIndex];
    return candidateSeal?.missingAncestor === true
      && (entry.path === firstMissingPrefix || entry.path.startsWith(`${firstMissingPrefix}/`));
  });
}

function optionalHash(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Workspace rewind journal hash is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function boundedErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Workspace rewind failed.").replace(/[\r\n]+/g, " ").slice(0, 400);
}

function toSlash(value: string): string {
  return value.replace(/\\/g, "/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
