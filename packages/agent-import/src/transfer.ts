import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentImportResult, AgentImportSelection, ImportedRoutineInput } from './types.js';
import { createImportBudget, fingerprint, readImportFile, readImportTree, reserveSnapshotItems, type ImportReadBudget } from './files.js';
import { AgentImportError, importFailureCode, object, type ImportItem, type ImportSnapshot, type ImportSource } from './types.js';
import { normalizeImportSkill, readImportSkillTree } from './skills.js';
import { memoryFileContent } from './memoryFiles.js';
import { resolveImportEnvironmentDependencies, selectedImportEnvironment } from './environmentSelection.js';

export interface ImportReceipt {
  version: 1;
  selectionHash: string;
  submissionHash: string;
  deferSetup: boolean;
  result: { -readonly [Key in keyof AgentImportResult]: AgentImportResult[Key] } & { checks: Array<AgentImportResult['checks'][number]>; savedEntryIds: string[] };
  /** Already-redacted names: status reads never decrypt the pending snapshot. */
  entryNames: Record<string, string>;
  copied: string[];
  environmentSaved: boolean;
  checkpointSaved: boolean;
  checkpointCleared: boolean;
  partnerCreated: boolean;
  creationRejected?: 'IMPORT_NAME_EXISTS';
  cancelled: boolean;
  routines: Record<string, { id: string; phase: 'created' | 'verified' | 'pausing-source' | 'source-paused' | 'complete'; sourceRestored?: boolean }>;
}

export interface TransferDeps {
  assertOwner(): void;
  partnerId(requestId: string): string;
  readReceipt(requestId: string): Promise<ImportReceipt | undefined>;
  readSkillConfig(source: ImportSource, budget: ImportReadBudget): Promise<Record<string, unknown>>;
  /** Return serialized UTF-8 bytes when available, avoiding a second full serialization. */
  saveReceipt(receipt: ImportReceipt): Promise<number | void>;
  createPartner(partnerId: string, selection: AgentImportSelection): Promise<void>;
  validateItems(items: ImportItem[]): void | Promise<void>;
  importItem(partnerId: string, item: ImportItem, snapshot: ImportSnapshot): Promise<void>;
  saveEnvironment(partnerId: string, items: ImportItem[]): Promise<void>;
  saveCheckpoint(partnerId: string, items: ImportItem[]): Promise<void>;
  createConversation(partnerId: string): Promise<string>;
  createRoutine(partnerId: string, input: ImportedRoutineInput, creationId: string, item: ImportItem): Promise<string>;
  /** Success requires actual read evidence from the target environment, not just presence of keys. */
  verifyAutomation(partnerId: string, item: ImportItem): Promise<{ verified: boolean; reason?: string }>;
  pauseSource(item: ImportItem, snapshot: ImportSnapshot, resumeInterruptedPause: boolean): Promise<void>;
  resumeSource(item: ImportItem, snapshot: ImportSnapshot): Promise<void>;
  enableRoutine(partnerId: string, routineId: string, item: ImportItem): Promise<void>;
}

/** Recovered subtree documents have stable bounded memory identities. */
function recoveredDocumentId(id: string): string {
  return id.length <= 40 ? id : `memory-${fingerprint(id).slice(0, 32)}`;
}

function validateSelectionShape(value: AgentImportSelection): void {
  if (!value || typeof value.previewId !== 'string' || !value.previewId || value.previewId.length > 200 || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value.requestId) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || typeof value.takeover !== 'boolean' || typeof value.deferSetup !== 'boolean'
    || !Array.isArray(value.entryIds) || value.entryIds.some(id => typeof id !== 'string') || new Set(value.entryIds).size !== value.entryIds.length
    || value.avatarImageBase64 !== undefined && (typeof value.avatarImageBase64 !== 'string' || !value.avatarImageBase64.length || value.avatarImageBase64.length > 2_000_000))
    throw new AgentImportError('INVALID_SELECTION');
  if (value.entryRanges !== undefined) {
    if (value.entryIds.length || !Array.isArray(value.entryRanges)) throw new AgentImportError('INVALID_SELECTION');
    let previous = -1;
    for (const range of value.entryRanges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] <= previous || range[1] < range[0]) throw new AgentImportError('INVALID_SELECTION');
      previous = range[1];
    }
  }
}

/** Safe intent binding remains available after private checkpoints have been removed. */
export function importSubmissionFingerprint(value: AgentImportSelection): string {
  validateSelectionShape(value);
  return fingerprint([value.requestId, value.previewId, value.name, value.avatarImageBase64, [...value.entryIds].toSorted(), value.entryRanges, value.takeover, value.deferSetup]);
}

export function validateImportSelection(value: AgentImportSelection, snapshot: ImportSnapshot): ImportItem[] {
  validateSelectionShape(value);
  const selected = new Set(value.entryIds);
  let ranges: ReadonlyArray<readonly [number, number]> | undefined;
  if (value.entryRanges !== undefined) {
    ranges = value.entryRanges;
  }
  const count = ranges ? ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0) : selected.size;
  // Bound expansion by the actual snapshot before allocating indexes. This also
  // supports selected-only checkpoints without assuming their storage order.
  if (!Number.isSafeInteger(count) || count > snapshot.items.length) throw new AgentImportError('SELECTION_CHANGED');
  const remaining = new Set<number>();
  if (ranges) for (const [first, last] of ranges) for (let index = first; index <= last; index++) remaining.add(index);
  const items = snapshot.items.filter(item => ranges ? item.sourceIndex !== undefined && remaining.delete(item.sourceIndex) : selected.has(item.view.id));
  if (items.length !== count || remaining.size) throw new AgentImportError('SELECTION_CHANGED');
  selectedImportEnvironment(items);
  return resolveImportEnvironmentDependencies(items);
}

/** The durable request always binds the original current-v1 setup and source intent. */
export async function validateImportRequestIdentity(snapshot: ImportSnapshot, selection: AgentImportSelection, existing: ImportReceipt | undefined): Promise<string> {
  const items = validateImportSelection(selection, snapshot);
  const selectionHash = fingerprint([selection.name, selection.avatarImageBase64, items.map(item => item.view.id).toSorted(),
    selection.takeover, snapshot.source.kind, snapshot.source.agentId, snapshot.source.root, selection.deferSetup]);
  if (existing && (existing.selectionHash !== selectionHash || existing.submissionHash !== importSubmissionFingerprint(selection) || existing.deferSetup !== selection.deferSetup))
    throw new AgentImportError('REQUEST_ALREADY_USED');
  return selectionHash;
}

/** One receipt is shared by GUI, remote actions and command callers. Writes are serialized by the host. */
export async function transferPartnerImport(snapshot: ImportSnapshot, selection: AgentImportSelection, deps: TransferDeps, reconcileOnly = false, resumeSetup = false): Promise<AgentImportResult> {
  const items = validateImportSelection(selection, snapshot);
  deps.assertOwner();
  const selectedIds = items.map(item => item.view.id);
  const existing = await deps.readReceipt(selection.requestId);
  const selectionHash = await validateImportRequestIdentity(snapshot, selection, existing);
  deps.assertOwner();
  if (existing?.creationRejected) throw new AgentImportError(existing.creationRejected);
  if (existing?.cancelled) return existing.result;
  if (existing?.result.status === 'complete') return existing.result;
  // A prior attempt may already have captured the repaired subtree in its
  // checkpoint. Normalize that case too, without requiring another source read.
  for (const item of items) for (const document of item.documents ?? []) document.id = recoveredDocumentId(document.id);
  const receipt: ImportReceipt = existing ?? { version: 1, selectionHash, submissionHash: importSubmissionFingerprint(selection), entryNames: {}, copied: [], routines: {}, deferSetup: selection.deferSetup,
    environmentSaved: false, checkpointSaved: false, checkpointCleared: false, partnerCreated: false, cancelled: false, result: {
    requestId: selection.requestId, partnerId: deps.partnerId(selection.requestId), status: 'running', checks: [], saved: false, savedEntryIds: [],
  } };
  receipt.selectionHash = selectionHash;
  receipt.deferSetup = selection.deferSetup === true;
  const partnerId = receipt.result.partnerId;
  receipt.result.status = 'running';
  receipt.result.checks = receipt.result.checks.filter(item => item.entryId !== 'import');
  const copied = new Set(receipt.copied);
  let repairedCapture = false;
  const checkIndexes = new Map(receipt.result.checks.map((item, index) => [item.entryId, index]));
  const selected = new Set(selectedIds);
  // Charge changed records against the last serialized receipt (including the
  // immutable name index). As the receipt grows, ordinary snapshots get farther
  // apart instead of rewriting the full catalog ~100 times. Lost batches replay
  // idempotently; source handover milestones still save before/after mutations.
  let progressBatchBytes = 64 * 1024, pendingProgressBytes = 0;
  const save = async () => {
    deps.assertOwner();
    const bytes = await deps.saveReceipt(receipt);
    deps.assertOwner();
    progressBatchBytes = Math.max(64 * 1024, bytes ?? Buffer.byteLength(JSON.stringify(receipt)));
    pendingProgressBytes = 0;
  };
  const saveProgress = async (entryId: string) => {
    const index = checkIndexes.get(entryId);
    pendingProgressBytes += Buffer.byteLength(JSON.stringify([entryId, index === undefined ? null : receipt.result.checks[index], receipt.routines[entryId]]));
    if (pendingProgressBytes >= progressBatchBytes) await save();
  };
  const check = (entryId: string, status: AgentImportResult['checks'][number]['status'], message?: string, progress?: { saved: number; total: number }) => {
    const index = checkIndexes.get(entryId) ?? receipt.result.checks.length;
    checkIndexes.set(entryId, index);
    receipt.result.checks[index] = { entryId, status, ...(message ? { message } : {}), ...(progress ? { progress } : {}) };
  };
  const needsAttention = (id: string) => {
    const index = checkIndexes.get(id);
    return index !== undefined && receipt.result.checks[index]?.status === 'needs-attention';
  };
  // Capture only selected resources, then publish a non-secret request index
  // before storing credentials. Acceptance still waits for the full checkpoint.
  if (!receipt.checkpointSaved || items.some(item => item.captureIssue)) {
    const budget = createImportBudget(undefined, deps.assertOwner);
    await reserveSnapshotItems(snapshot.items, budget, deps.assertOwner);
    for (const item of items) {
      if (item.captureIssue && item.sourceDirectory && item.filesComplete && !copied.has(item.view.id)) {
        item.files = undefined; item.filesComplete = false;
      }
      if (item.captureIssue && item.sourceFile) {
        try {
          const source = item.sourceFile;
          const sharedDocumentRoots = source.sharedDocumentRoots ?? [];
          const prefix = source.logicalPrefix;
          const logicalName = (name: string) => prefix ? `${prefix}/${name}` : name;
          const directory = source.kind === 'directory' || source.kind !== 'file' && (await fs.stat(source.file)).isDirectory();
          if (directory) {
            const files = await readImportTree(source.root, undefined, budget, undefined, source.file, sharedDocumentRoots);
            item.files = []; item.documents = [];
            for (const captured of files) {
              const file = { ...captured, name: logicalName(captured.name) };
              const content = memoryFileContent(file);
              if (content.kind !== 'text') item.files.push(file);
              else if (content.kind === 'text') item.documents.push({
                id: recoveredDocumentId(`${item.view.id}-${fingerprint(file.name).slice(0, 20)}`), name: file.name, text: content.text,
                ...(/(^|\/)USER\.md$/i.test(file.name) ? { role: 'user' as const } : {}),
              });
            }
          } else {
            const captured = await readImportFile(source.root, source.file, budget, sharedDocumentRoots);
            const file = { ...captured, name: logicalName(captured.name) };
            const content = memoryFileContent(file);
            if (content.kind === 'text') {
              item.text = content.text;
              // A failed individual USER.md has no role from initial discovery.
              if (!item.role && /(^|\/)USER\.md$/i.test(file.name)) item.role = 'user';
            }
            else item.asset = { name: file.name, bytes: file.bytes };
          }
          delete item.captureIssue; repairedCapture = true;
        } catch (error) { item.captureIssue = importFailureCode(error); }
        deps.assertOwner();
      }
      if (item.sourceDirectory && !item.filesComplete) {
        // Failed native discovery uses a directory-based identity until its manifest can be captured.
        const metadataPending = item.view.category === 'skills' && !!item.captureIssue && !item.sourceAlias
          && item.view.id === `skill-${fingerprint(item.sourceDirectory).slice(0, 20)}`;
        const captured = item.files ?? [];
        const names = new Set(captured.map(file => file.name));
        try {
          item.files = [...captured, ...await readImportSkillTree(item.sourceDirectory, name => !names.has(name), budget)];
          if (metadataPending) {
            const manifest = item.files.find(file => file.name === 'SKILL.md')?.bytes.toString('utf8');
            if (!manifest?.trim() || !deps.readSkillConfig) throw new AgentImportError('SOURCE_CONFIG_INVALID');
            const config = await deps.readSkillConfig(snapshot.source, budget);
            deps.assertOwner();
            const metadata = normalizeImportSkill(snapshot.source.kind, item.view.name, manifest, object(config.skills));
            const restored = { ...item, ...metadata, view: { ...item.view, ...metadata.view, id: item.view.id } };
            // A newly readable credential must not silently choose a conflicting account.
            selectedImportEnvironment(items.map(candidate => candidate === item ? restored : candidate));
            Object.assign(item, restored);
          }
          item.filesComplete = true;
          delete item.captureIssue; repairedCapture = true;
        } catch (error) {
          deps.assertOwner();
          item.captureIssue = importFailureCode(error);
        }
        deps.assertOwner();
      }
    }
    await deps.validateItems(items);
    await save();
    await deps.saveCheckpoint(partnerId, items);
    deps.assertOwner();
    receipt.checkpointSaved = true;
  }
  await save();
  await deps.createPartner(partnerId, selection);
  deps.assertOwner();
  receipt.partnerCreated = true;
  await save();
  // Retry only selected resources; saved batches skip completed idempotent copies.
  for (const item of items.filter(item => item.view.category !== 'automations' && item.view.category !== 'connections')) {
    if (copied.has(item.view.id)) continue;
    deps.assertOwner();
    try {
      if (item.captureIssue) throw new AgentImportError(item.captureIssue);
      await deps.importItem(partnerId, item, snapshot);
      deps.assertOwner();
      receipt.copied.push(item.view.id); copied.add(item.view.id);
      check(item.view.id, item.view.issues?.length ? 'needs-attention' : 'copied', item.view.issues?.[0]);
    } catch (error) {
      deps.assertOwner();
      check(item.view.id, 'needs-attention', importFailureCode(error), (error as { importProgress?: { saved: number; total: number } })?.importProgress);
    }
    await saveProgress(item.view.id);
  }
  await save();
  if (!receipt.environmentSaved || repairedCapture) {
    await deps.saveEnvironment(partnerId, items);
    deps.assertOwner();
    receipt.environmentSaved = true;
    await save();
  }
  for (const item of items.filter(item => item.view.category === 'connections')) {
    const issue = item.view.dependsOn?.some(id => !selected.has(id)) ? 'AUTOMATION_DEPENDENCY_NOT_SELECTED' : item.view.issues?.[0];
    check(item.view.id, issue ? 'needs-attention' : 'copied', issue);
  }
  receipt.result.canonicalSessionId = await deps.createConversation(partnerId);
  await save();
  const byId = new Map(items.map(item => [item.view.id, item]));
  const missingDependency = (id: string, visited = new Set<string>()): boolean => {
    if (!selected.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const item = byId.get(id);
    return !!item?.captureIssue || item?.view.enabled === false && (item.view.category === 'skills' || !!item.mcp) || needsAttention(id) || !!item?.view.issues?.length || !!item?.view.dependsOn?.some(child => missingDependency(child, visited));
  };
  for (const item of items.filter(item => item.automation)) {
    // Background reconciliation repairs only interrupted work. A definitive
    // failed verification needs an explicit retry, never another model/Ask call.
    const prior = receipt.routines[item.view.id];
    if (reconcileOnly && needsAttention(item.view.id)
      && prior?.phase !== 'pausing-source' && prior?.phase !== 'source-paused') continue;
    const automation = item.automation!;
    let record = receipt.routines[item.view.id];
    if (!record) {
      try {
        const id = await deps.createRoutine(partnerId, { ...automation.input!, enabled: false }, fingerprint([selection.requestId, item.view.id]), item);
        deps.assertOwner();
        record = receipt.routines[item.view.id] = { id, phase: 'created' };
        // createOnce is idempotent if this progress batch is interrupted.
      } catch (error) {
        deps.assertOwner();
        check(item.view.id, 'needs-attention', importFailureCode(error));
        await saveProgress(item.view.id); continue;
      }
    }
    if (record.phase === 'complete') { check(item.view.id, item.view.enabled && selection.takeover ? 'taken-over' : 'paused'); continue; }
    if (item.view.issues?.length) {
      check(item.view.id, 'needs-attention', item.view.issues[0]); await saveProgress(item.view.id); continue;
    }
    if (!item.view.enabled || !selection.takeover) {
      record.phase = 'complete'; check(item.view.id, 'paused'); await saveProgress(item.view.id); continue;
    }
    if (selection.deferSetup && !resumeSetup && record.phase === 'created') {
      check(item.view.id, 'needs-attention', 'IMPORT_SETUP_DEFERRED'); await saveProgress(item.view.id); continue;
    }
    if (item.view.dependsOn?.some(id => missingDependency(id))) {
      check(item.view.id, 'needs-attention', 'AUTOMATION_DEPENDENCY_NOT_SELECTED'); await saveProgress(item.view.id); continue;
    }
    if (record.phase === 'created') {
      try {
        const verification = await deps.verifyAutomation(partnerId, item);
        deps.assertOwner();
        if (!verification.verified) { check(item.view.id, 'needs-attention', verification.reason ?? 'AUTOMATION_READ_NOT_VERIFIED'); await save(); continue; }
        record.phase = 'verified'; check(item.view.id, 'verified'); await save();
      } catch (error) {
        deps.assertOwner();
        check(item.view.id, 'needs-attention', error instanceof AgentImportError ? error.code : 'AUTOMATION_READ_NOT_VERIFIED');
        await save(); continue;
      }
    }
    try {
      if (record.phase === 'verified' || record.phase === 'pausing-source') {
        const resumeInterruptedPause = record.phase === 'pausing-source';
        // Persist intent before the native mutation. Its adapter can reconcile an interrupted pause.
        record.phase = 'pausing-source'; await save();
        await deps.pauseSource(item, snapshot, resumeInterruptedPause);
        deps.assertOwner();
        record.phase = 'source-paused'; await save();
      }
      await deps.enableRoutine(partnerId, record.id, item);
      deps.assertOwner();
      record.phase = 'complete'; check(item.view.id, 'taken-over'); await save();
    } catch (error) {
      deps.assertOwner();
      if (record.phase === 'pausing-source' && error instanceof AgentImportError && !['SOURCE_HANDOVER_UNCERTAIN', 'SOURCE_HANDOVER_PENDING'].includes(error.code)) record.phase = 'verified';
      if (record.phase === 'source-paused' && !(error instanceof AgentImportError && error.code === 'TARGET_HANDOVER_UNCERTAIN')) {
        // Only restore a source task this transaction actually paused; never alter other tasks.
        await deps.resumeSource(item, snapshot);
        deps.assertOwner();
        record.phase = 'verified';
      }
      check(item.view.id, 'needs-attention', error instanceof AgentImportError ? error.code : 'AUTOMATION_HANDOVER_FAILED');
      await save();
    }
  }
  receipt.result.savedEntryIds = [...new Set([...receipt.copied,
    ...items.filter(item => item.view.category === 'connections' && receipt.environmentSaved).map(item => item.view.id),
    ...Object.keys(receipt.routines),
  ])];
  receipt.result.saved = true;
  receipt.result.status = Object.values(receipt.routines).some(item => item.phase === 'pausing-source' || item.phase === 'source-paused') ? 'running'
    : receipt.result.checks.some(check => check.status === 'needs-attention') ? 'needs-attention' : 'complete';
  await save();
  return receipt.result;
}
