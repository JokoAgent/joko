import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentImportError, MAX_SNAPSHOT_BYTES, createEnvironmentRedactor, createImportBudget, createImportSourceReader,
  deserializeImportSnapshotAsync, discoverImportSources, inspectImportSource, previewImportRedactions, fingerprint,
  reserveSnapshotItems, retainedImportRedactions, selectedImportRedactions, serializeImportSnapshotAsync, emptyImportedEnvironment, importSubmissionFingerprint,
  transferPartnerImport, validateImportRequestIdentity, validateImportSelection, importFailureCode, changeSourceAutomationState,
  type AgentImportPreview, type AgentImportResult, type AgentImportSelection, type AgentImportSource,
  type ImportItem, type ImportReceipt, type ImportSnapshot, type ImportSource, type TransferDeps,
} from "@joko/agent-import";
import { parseRoutineInput } from "./partner-routine-definition.js";
import { readOpenClawCronDatabase } from "@joko/agent-import";
import type { PartnerImportStorage } from "./partner-import-storage.js";

/** Controller identity is authenticated by the service, independent of model-supplied arguments. */
export interface PartnerImportController {
  readonly ownerKey: string;
  assertCurrent(): void;
}
export interface PartnerImportEffectContext {
  readonly snapshot: ImportSnapshot;
  readonly selection: AgentImportSelection;
  readonly creationJson: string;
  readonly publicationRedactions: Record<string, string>;
  readonly assertOwner: () => void;
}
type ImportEffects = Pick<TransferDeps, "partnerId" | "createPartner" | "importItem" | "saveEnvironment" | "createConversation" | "createRoutine" | "verifyAutomation" | "pauseSource" | "resumeSource" | "enableRoutine"> & {
  validateItems?(items: ImportItem[]): void | Promise<void>;
};
interface OwnedValue<T> { readonly owner: string; readonly expires: number; readonly value: T; readonly bytes: number; readonly sourceId?: string; }
const PREVIEW_TTL_MS = 30 * 60_000;

/** Service-owned immutable previews and same-intent work outlive the creation sheet. */
export class PartnerImportManager {
  readonly #sources = new Map<string, OwnedValue<ImportSource>>();
  readonly #previews = new Map<string, OwnedValue<ImportSnapshot>>();
  readonly #jobs = new Map<string, { promise: Promise<AgentImportResult>; submissionHash: string }>();
  readonly #deletedPartners = new Set<string>();
  #retired = false;
  constructor(private readonly options: {
    readonly storage: PartnerImportStorage;
    readonly home: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly prepareCreation: (selection: AgentImportSelection) => string;
    readonly adoptSettings: (partnerId: string, assertOwner: () => void) => Promise<void>;
    readonly effects: (context: PartnerImportEffectContext) => ImportEffects | Promise<ImportEffects>;
    readonly runPass: <T>(partnerId: string, action: () => Promise<T>) => Promise<T>;
    readonly assertServiceOwner: () => void;
    readonly now?: () => number;
    readonly onSaved?: (result: AgentImportResult) => void | Promise<void>;
  }) {}
  #now(): number { return (this.options.now ?? Date.now)(); }
  #assert(): void { this.options.assertServiceOwner(); if (this.#retired) throw new AgentImportError("OWNER_CHANGED"); }
  #readers(assertOwner: () => void) {
    return { home: this.options.home, env: this.options.environment, assertOwner, parseRoutineInput,
      readCronDatabase: (input: Parameters<typeof readOpenClawCronDatabase>[0]) => readOpenClawCronDatabase(input, assertOwner) };
  }
  #controller(scope: PartnerImportController): () => void {
    return () => { this.#assert(); scope.assertCurrent(); if (!scope.ownerKey) throw new AgentImportError("OWNER_CHANGED"); };
  }
  #prune(): void {
    for (const map of [this.#sources, this.#previews]) for (const [id, item] of map) if (item.expires <= this.#now()) map.delete(id);
  }
  #owned<T>(map: ReadonlyMap<string, OwnedValue<T>>, id: string, ownerKey: string): T {
    const entry = map.get(id);
    if (!entry || entry.expires <= this.#now() || entry.owner !== ownerKey) throw new AgentImportError("PREVIEW_EXPIRED"); return entry.value;
  }

  async sources(scope: PartnerImportController): Promise<readonly AgentImportSource[]> {
    const assertOwner = this.#controller(scope); assertOwner(); this.#prune();
    const deps = this.#readers(assertOwner); const reader = createImportSourceReader(deps);
    const sources = await discoverImportSources(deps, reader); assertOwner();
    const result: AgentImportSource[] = [];
    for (const [id, source] of this.#sources) if (source.owner === scope.ownerKey) this.#sources.delete(id);
    for (const source of sources) {
      const name = await reader.readName(source); assertOwner(); const id = randomUUID();
      this.#sources.set(id, { owner: scope.ownerKey, expires: this.#now() + PREVIEW_TTL_MS, value: source, bytes: 0 });
      result.push({ id, kind: source.kind, name: name || `${source.kind} ${result.length + 1}` });
    }
    return result;
  }

  async preview(sourceId: string, scope: PartnerImportController): Promise<AgentImportPreview> {
    const assertOwner = this.#controller(scope); assertOwner(); this.#prune();
    const source = this.#owned(this.#sources, sourceId, scope.ownerKey);
    const snapshot = await inspectImportSource(source, this.#readers(assertOwner)); assertOwner();
    for (const [id, previous] of this.#previews) if (previous.owner === scope.ownerKey) this.#previews.delete(id);
    let bytes = 0;
    await reserveSnapshotItems(snapshot.items, { reserve: count => { bytes += count; if (bytes > MAX_SNAPSHOT_BYTES) throw new AgentImportError("SOURCE_SNAPSHOT_TOO_LARGE"); }, reserveFile: count => { bytes += count + 256; if (bytes > MAX_SNAPSHOT_BYTES) throw new AgentImportError("SOURCE_SNAPSHOT_TOO_LARGE"); } }, assertOwner);
    const retained = [...this.#previews.values()];
    if (retained.length >= 4 || retained.reduce((total, value) => total + value.bytes, bytes) > MAX_SNAPSHOT_BYTES) throw new AgentImportError("SOURCE_SNAPSHOT_TOO_LARGE");
    const id = randomUUID(); this.#previews.set(id, { owner: scope.ownerKey, expires: this.#now() + PREVIEW_TTL_MS, value: snapshot, bytes, sourceId });
    const redact = createEnvironmentRedactor(previewImportRedactions(snapshot.items));
    return { id, source: { id: sourceId, kind: source.kind, name: redact(source.name) }, name: redact(source.name),
      ...(snapshot.avatarImageBase64 ? { avatarImageBase64: snapshot.avatarImageBase64 } : {}),
      entries: snapshot.items.map(item => ({ ...item.view, name: redact(item.view.name),
        ...(item.view.description !== undefined ? { description: redact(item.view.description) } : {}) })) };
  }

  readPreview(previewId: string, scope: PartnerImportController): AgentImportPreview {
    const assertOwner = this.#controller(scope); assertOwner();
    const snapshot = this.#owned(this.#previews, previewId, scope.ownerKey);
    const redact = createEnvironmentRedactor(snapshot.publicationRedactions ?? previewImportRedactions(snapshot.items));
    return { id: previewId, source: { id: this.#previews.get(previewId)!.sourceId!, kind: snapshot.source.kind, name: redact(snapshot.source.name) }, name: redact(snapshot.source.name),
      ...(snapshot.avatarImageBase64 ? { avatarImageBase64: snapshot.avatarImageBase64 } : {}),
      entries: snapshot.items.map(item => ({ ...item.view, name: redact(item.view.name), ...(item.view.description !== undefined ? { description: redact(item.view.description) } : {}) })) };
  }

  status(requestId: string, scope: PartnerImportController): AgentImportResult | undefined {
    const assertOwner = this.#controller(scope); assertOwner(); const receipt = this.options.storage.readReceipt(requestId); assertOwner();
    return receipt?.result ?? (this.#jobs.has(requestId) ? { requestId, partnerId: `agent_import_${fingerprint(requestId).slice(0, 32)}`, status: "running", checks: [], saved: false, savedEntryIds: [] } : undefined);
  }
  entryNames(requestId: string): Readonly<Record<string, string>> { this.#assert(); return this.options.storage.readReceipt(requestId)?.entryNames ?? {}; }

  /** The accepted job uses service/Partner fences; closing a transport does not cancel saved work. */
  async start(selection: AgentImportSelection, scope: PartnerImportController): Promise<AgentImportResult> {
    const assertController = this.#controller(scope); assertController();
    const submissionHash = importSubmissionFingerprint(selection);
    const prior = this.options.storage.readReceipt(selection.requestId);
    if (prior && prior.submissionHash !== submissionHash) throw new AgentImportError("REQUEST_ALREADY_USED");
    if (prior?.cancelled || prior?.result.status === "complete") { assertController(); return prior.result; }
    let snapshot: ImportSnapshot; let creationJson: string;
    if (prior?.checkpointSaved) {
      const pending = (await this.options.storage.environment.read(prior.result.partnerId, assertController))?.pendingImport;
      assertController();
      if (!pending || importSubmissionFingerprint(pending.selection) !== submissionHash) throw new AgentImportError("REQUEST_ALREADY_USED");
      snapshot = await deserializeImportSnapshotAsync(pending.snapshotJson, assertController);
      creationJson = pending.creationJson;
    } else {
      snapshot = this.#owned(this.#previews, selection.previewId, scope.ownerKey);
      creationJson = this.options.prepareCreation({ ...selection, name: createEnvironmentRedactor(snapshot.publicationRedactions ?? previewImportRedactions(snapshot.items))(selection.name) });
    }
    validateImportSelection(selection, snapshot); await validateImportRequestIdentity(snapshot, selection, prior); assertController();
    const result = await this.#dispatch(snapshot, selection, creationJson); assertController(); return result;
  }

  async retry(requestId: string, scope: PartnerImportController, resumeSetup = false): Promise<AgentImportResult> {
    const assertController = this.#controller(scope); assertController();
    const receipt = this.options.storage.readReceipt(requestId);
    if (!receipt) throw new AgentImportError("IMPORT_RECEIPT_MISSING");
    if (receipt.cancelled || receipt.result.status === "complete") return receipt.result;
    const pending = (await this.options.storage.environment.read(receipt.result.partnerId, assertController))?.pendingImport;
    if (!pending) throw new AgentImportError("PREVIEW_EXPIRED");
    const snapshot = await deserializeImportSnapshotAsync(pending.snapshotJson, assertController); assertController();
    const result = await this.#dispatch(snapshot, pending.selection, pending.creationJson, false, resumeSetup); assertController(); return result;
  }

  async useCurrentSettings(partnerId: string, entryIds: readonly string[], scope: PartnerImportController): Promise<void> {
    const assertOwner = this.#controller(scope); assertOwner();
    if (!entryIds.length || entryIds.some(id => typeof id !== "string")) throw new AgentImportError("INVALID_SELECTION");
    await this.options.runPass(partnerId, async () => {
      assertOwner();
      const pending = (await this.options.storage.environment.read(partnerId, assertOwner))?.pendingImport;
      if (!pending || `agent_import_${fingerprint(pending.selection.requestId).slice(0, 32)}` !== partnerId) throw new AgentImportError("INVALID_SELECTION");
      const snapshot = await deserializeImportSnapshotAsync(pending.snapshotJson, assertOwner);
      const selected = new Set(entryIds);
      const admitted = new Set(validateImportSelection(pending.selection, snapshot).map(item => item.view.id));
      const items = snapshot.items.filter(item => selected.has(item.view.id));
      if (items.length !== selected.size || items.some(item => !admitted.has(item.view.id)
        || !item.automation && !["source-model", "source-tools"].includes(item.credential?.format ?? ""))) throw new AgentImportError("INVALID_SELECTION");
      const mappings = new Set(["SOURCE_TOOL_POLICY_NEEDS_MAPPING", "AUTOMATION_MODEL_NEEDS_MAPPING"]);
      for (const item of items) item.view.issues = item.view.issues?.filter(issue => !mappings.has(issue));
      const snapshotJson = await serializeImportSnapshotAsync(snapshot, assertOwner);
      const receipt = this.options.storage.readReceipt(pending.selection.requestId);
      if (!receipt || receipt.cancelled) throw new AgentImportError("IMPORT_CANCELLED");
      await this.options.adoptSettings(partnerId, assertOwner); assertOwner();
      await this.options.storage.environment.update(partnerId, assertOwner, current => {
        if (current.pendingImport?.selection.requestId !== pending.selection.requestId) throw new AgentImportError("SELECTION_CHANGED");
        current.pendingImport.snapshotJson = snapshotJson;
        for (const item of items) {
          const id = receipt.routines[item.view.id]?.id;
          const binding = id && current.automations[id];
          if (binding) binding.issues = binding.issues.filter(issue => !mappings.has(issue));
        }
      });
      assertOwner();
      receipt.result.checks = receipt.result.checks.map(check => selected.has(check.entryId) && mappings.has(check.message ?? "")
        ? { ...check, status: items.find(item => item.view.id === check.entryId)?.automation ? "needs-attention" : "copied", message: "IMPORT_SETUP_DEFERRED" } : check);
      this.options.storage.saveReceipt(receipt);
    });
    assertOwner();
  }

  async waitForRequest(requestId: string): Promise<AgentImportResult> {
    const job = this.#jobs.get(requestId);
    if (job) return job.promise;
    this.#assert(); const receipt = this.options.storage.readReceipt(requestId);
    if (!receipt) throw new AgentImportError("IMPORT_RECEIPT_MISSING"); return receipt.result;
  }

  async #dispatch(snapshot: ImportSnapshot, selection: AgentImportSelection, creationJson: string, reconcileOnly = false, resumeSetup = false): Promise<AgentImportResult> {
    this.#assert();
    const submissionHash = importSubmissionFingerprint(selection);
    const running = this.#jobs.get(selection.requestId);
    if (running) {
      if (running.submissionHash !== submissionHash) throw new AgentImportError("REQUEST_ALREADY_USED");
      return this.#accepted(selection.requestId, running.promise);
    }
    const partnerId = `agent_import_${fingerprint(selection.requestId).slice(0, 32)}`;
    const assertOwner = () => { this.#assert(); if (this.#deletedPartners.has(partnerId)) throw new AgentImportError("IMPORT_CANCELLED"); };
    const selected = validateImportSelection(selection, snapshot);
    const recapturing = selected.some(item => item.captureIssue || item.filesComplete === false);
    const masks: Record<string, string> = {};
    extendRedactions(masks, snapshot.publicationRedactions ?? previewImportRedactions(snapshot.items));
    extendRedactions(masks, selectedImportRedactions(selected));
    const context: PartnerImportEffectContext = { snapshot, selection, creationJson, publicationRedactions: masks, assertOwner };
    const redact = () => createEnvironmentRedactor(masks);
    const pass = async (reconcile: boolean) => this.options.runPass(partnerId, async () => {
    assertOwner(); const effects = await this.options.effects(context); assertOwner();
    const deps: TransferDeps = {
      ...effects, assertOwner,
      readReceipt: async requestId => { assertOwner(); return this.options.storage.readReceipt(requestId); },
      readSkillConfig: async (source, budget) => createImportSourceReader(this.#readers(assertOwner), budget).readConfig(path.dirname(source.configFile), source.configFile),
      saveReceipt: async receipt => {
        assertOwner(); receipt.entryNames = Object.fromEntries(selected.map(item => [item.view.id, redact()(item.view.name)]));
        return this.options.storage.saveReceipt(receipt);
      },
      validateItems: async items => {
        if (recapturing) extendRedactions(masks, await createImportSourceReader(this.#readers(assertOwner)).readRedactions(snapshot.source));
        extendRedactions(masks, selectedImportRedactions(items));
        await reserveSnapshotItems(items, createImportBudget(undefined, assertOwner), assertOwner);
        await effects.validateItems?.(items); assertOwner();
      },
      saveCheckpoint: async (partnerId, items) => {
        const publicationRedactions = retainedImportRedactions(items, masks);
        const checkpoint = { ...snapshot, items, publicationRedactions };
        const snapshotJson = await serializeImportSnapshotAsync(checkpoint, assertOwner); assertOwner();
        const existing = await this.options.storage.environment.read(partnerId, assertOwner);
        if (existing) await this.options.storage.environment.update(partnerId, assertOwner, value => { value.pendingImport = { selection, snapshotJson, creationJson }; value.contentRedactions = publicationRedactions; });
        else {
          const environment = emptyImportedEnvironment(snapshot.source);
          environment.pendingImport = { selection, snapshotJson, creationJson }; environment.contentRedactions = publicationRedactions;
          await this.options.storage.environment.write(partnerId, environment, assertOwner);
        }
      },
    };
    const result = await transferPartnerImport(snapshot, selection, deps, reconcile, resumeSetup);
      assertOwner();
      if (result.status === "complete") {
        await this.#clearCheckpoint(this.options.storage.readReceipt(selection.requestId)!);
      }
      await this.options.onSaved?.(result); assertOwner(); return result;
    });
    const job = (async () => {
      for (let attempt = 0; ; attempt++) {
        const result = await pass(reconcileOnly || attempt > 0);
        if (result.status !== "running") return result;
        if (attempt >= 2) {
          const receipt = this.options.storage.readReceipt(selection.requestId)!; receipt.result.status = "needs-attention";
          this.options.storage.saveReceipt(receipt); return receipt.result;
        }
        await delay(5_000); assertOwner();
      }
    })().catch(error => {
      assertOwner(); if (error instanceof AgentImportError && error.code === "REQUEST_ALREADY_USED") throw error;
      const receipt = this.options.storage.readReceipt(selection.requestId); if (!receipt || receipt.cancelled) throw error;
      receipt.result.status = "needs-attention";
      receipt.result.checks = [...receipt.result.checks.filter(check => check.entryId !== "import"), { entryId: "import", status: "needs-attention", message: importFailureCode(error) }];
      this.options.storage.saveReceipt(receipt); return receipt.result;
    }).finally(() => { if (this.#jobs.get(selection.requestId)?.promise === job) this.#jobs.delete(selection.requestId); });
    this.#jobs.set(selection.requestId, { promise: job, submissionHash }); void job.catch(() => {});
    return this.#accepted(selection.requestId, job);
  }

  async #accepted(requestId: string, job: Promise<AgentImportResult>): Promise<AgentImportResult> {
    const early = await Promise.race([job.then(result => ({ result })), new Promise<{ result?: undefined }>(resolve => setTimeout(() => resolve({}), 25))]);
    this.#assert(); const result = early.result ?? this.options.storage.readReceipt(requestId)?.result;
    if (!result) return job; return result;
  }

  /** Startup repairs interrupted transitions while leaving definitive failed checks for explicit retry. */
  async recover(): Promise<void> {
    this.#assert();
    for (const receipt of this.options.storage.listReceipts()) {
      this.#assert(); if (receipt.cancelled || receipt.creationRejected || !receipt.checkpointSaved) continue;
      if (receipt.result.status === "complete" && !receipt.checkpointCleared) { await this.#clearCheckpoint(receipt); continue; }
      if (receipt.result.status !== "running") continue;
      const pending = (await this.options.storage.environment.read(receipt.result.partnerId, () => this.#assert()))?.pendingImport;
      if (!pending) {
        receipt.result.status = "needs-attention";
        receipt.result.checks = [...receipt.result.checks.filter(check => check.entryId !== "import"), { entryId: "import", status: "needs-attention", message: "IMPORT_INTERRUPTED" }];
        this.options.storage.saveReceipt(receipt); continue;
      }
      const snapshot = await deserializeImportSnapshotAsync(pending.snapshotJson, () => this.#assert());
      await this.#dispatch(snapshot, pending.selection, pending.creationJson, true);
    }
  }

  async #clearCheckpoint(receipt: ImportReceipt): Promise<void> {
    const assertOwner = () => this.#assert(); assertOwner();
    const environment = await this.options.storage.environment.read(receipt.result.partnerId, assertOwner);
    if (environment?.pendingImport) await this.options.storage.environment.update(receipt.result.partnerId, assertOwner, value => { delete value.pendingImport; });
    assertOwner(); receipt.checkpointCleared = true; this.options.storage.saveReceipt(receipt);
  }

  /** The lifecycle Owner calls this inside its profile lane after target routines have stopped. */
  async prepareDeletion(partnerId: string): Promise<void> {
    this.#assert(); this.#deletedPartners.add(partnerId);
    const assertOwner = () => this.#assert();
    for (const receipt of this.options.storage.listReceipts().filter(row => row.result.partnerId === partnerId)) {
      receipt.cancelled = true; receipt.result.status = "needs-attention";
      receipt.result.checks = [...receipt.result.checks.filter(check => check.entryId !== "import"), { entryId: "import", status: "needs-attention", message: "IMPORT_CANCELLED" }];
      this.options.storage.saveReceipt(receipt);
      const environment = await this.options.storage.environment.read(partnerId, assertOwner);
      for (const [entryId, milestone] of Object.entries(receipt.routines)) {
        if (milestone.sourceRestored || !["pausing-source", "source-paused", "complete"].includes(milestone.phase)) continue;
        if (milestone.phase === "complete" && !receipt.result.checks.some(check => check.entryId === entryId && check.status === "taken-over")) continue;
        const binding = environment?.automations[milestone.id]; if (!environment || !binding) throw new AgentImportError("CREDENTIAL_STORAGE_UNAVAILABLE");
        await this.options.storage.environment.update(partnerId, assertOwner, value => { value.automations[milestone.id]!.handover = "pending"; });
        await changeSourceAutomationState(environment.source, { automation: { sourceId: binding.sourceId, original: binding.original } }, true,
          this.#readers(assertOwner), assertOwner, false, environment.env);
        milestone.sourceRestored = true; this.options.storage.saveReceipt(receipt); assertOwner();
      }
    }
    await this.options.storage.environment.remove(partnerId, assertOwner);
  }

  async close(): Promise<void> {
    this.#retired = true; this.#sources.clear(); this.#previews.clear(); await Promise.allSettled([...this.#jobs.values()].map(job => job.promise));
  }
}

function extendRedactions(target: Record<string, string>, source: Readonly<Record<string, string>>): void {
  const values = new Set(Object.values(target)); let ordinal = Object.keys(target).length;
  for (const value of Object.values(source)) {
    if (!value || values.has(value)) continue;
    while (Object.hasOwn(target, `import_content_${ordinal}`)) ordinal++;
    target[`import_content_${ordinal++}`] = value; values.add(value);
  }
}
