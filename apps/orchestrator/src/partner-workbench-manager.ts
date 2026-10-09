import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import { buildPartnerWorkbenchDigest, boundNativeSessionPreview, derivePartnerWorkbenchTaskState, derivePartnerWorkbenchAutomationState,
  partnerWorkbenchGroup, PARTNER_WORKBENCH_RECENT_WINDOW_MS, redactSecrets,
  type NativeSessionCatalogEntry, type PartnerWorkbenchState, type SessionDescriptor, type TargetDescriptor,
  type PartnerWorkbenchTask, type PartnerWorkbenchDetail, type PartnerWorkbenchJudgment, type PartnerWorkbenchProjectBrief,
  type PartnerWorkbenchProjectOption, type PartnerWorkbenchTranscriptItem, type PartnerWorkbenchArtifact, type PromptInput } from "@joko/core";
import type { OperationalStore, PartnerProfileRecord, PartnerWorkbenchStore, PartnerStore, PersistedEvent } from "@joko/store";
import type { WorkspaceService } from "./workspace-service.js";

import type { PartnerManager } from "./partner-manager.js";
import type { SessionHost } from "./session-host.js";
import type { PartnerWorkbenchBriefReader } from "./partner-workbench-brief.js";
import {
  checkPartnerWorkbenchProject,
  findPartnerWorkbenchProject,
  partnerWorkbenchProjectForDirectory,
  validatePartnerWorkbenchReference,
  type PartnerWorkbenchProjectEnvironment
} from "./partner-workbench-project.js";

export interface PartnerWorkbenchOwner {
  readonly partnerId: string;
  readonly profileVersion: PartnerProfileRecord["profileVersion"];
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly targetId: string;
}

export class PartnerWorkbenchError extends Error {
  constructor(readonly code: "WORKBENCH_UNAVAILABLE" | "WORKBENCH_OWNER_CHANGED" | "WORKBENCH_PROJECT_NOT_FOUND" | "WORKBENCH_TASK_NOT_FOUND" | "WORKBENCH_INVALID" | "WORKBENCH_DISPATCH_UNKNOWN", message: string) {
    super(message);
    this.name = "PartnerWorkbenchError";
  }
}

export interface PartnerWorkbenchProjectView {
  readonly path: string;
  readonly name: string;
  readonly addedAt: number;
  readonly exists: boolean;
}

export interface PartnerWorkbenchStateView {
  readonly owner: PartnerWorkbenchOwner;
  readonly state: PartnerWorkbenchState;
  readonly projects: readonly PartnerWorkbenchProjectView[];
  readonly projectOptions: readonly PartnerWorkbenchProjectOption[];
  readonly tasks: readonly PartnerWorkbenchTask[];
  readonly candidates: readonly PartnerWorkbenchTask[];
  readonly briefs: readonly PartnerWorkbenchProjectBrief[];
  readonly olderCount: number;
  readonly truncated: boolean;
  readonly unavailableSources: readonly string[];
  readonly outputs: readonly PartnerWorkbenchArtifact[];
}

interface TaskSource {
  readonly project: string;
  readonly sessionId?: string;
  readonly delegationId?: string;
  readonly scheduleId?: string;
  readonly native?: { readonly backendId: string; readonly entry: NativeSessionCatalogEntry; readonly snapshotToken?: string };
  readonly item?: PartnerWorkbenchJudgment;
}
interface BackgroundRecord {
  readonly version: 1;
  readonly operationId: string;
  readonly partnerId: string;
  readonly profileVersion: number;
  readonly parentSessionId: string;
  readonly parentSessionGeneration: number;
  readonly project: string;
  readonly sourceTaskId: string;
  readonly title: string;
  readonly objective: string;
  readonly requestedMessage: string;
  readonly createdAt: number;
  readonly mode: "adopt" | "background";
  readonly status: "preparing" | "ready" | "queued" | "unknown" | "failed";
  readonly sessionId?: string;
  readonly runId?: string;
}
const BACKGROUND_SCOPE = "partner.workbench.background";

interface OwnedPartnerWorkbench {
  readonly profile: PartnerProfileRecord;
  readonly session: SessionDescriptor;
  readonly target: TargetDescriptor;
  readonly stamp: PartnerWorkbenchOwner;
}

/** Partner identity and its durable grant are shared by the user surface and
 * runtime tools. A selected client row cannot confer project access. */
export class PartnerWorkbenchManager {
  readonly #partners: Pick<PartnerManager, "getPartner" | "canonicalCaller" | "listPartners" | "listDelegations" | "getDelegation">;
  readonly #partnerStore: Pick<PartnerStore, "getSessionLink">;
  readonly #store: OperationalStore;
  readonly #host: Pick<SessionHost, "extraDirectories" | "refreshTargetExtraDirectories" | "scanNativeSessionPreviews" | "readNativeSessionPreview"
    | "createServiceSession" | "registerTarget" | "enqueueServiceInput" | "reconcileServiceNativeCatalogAdoption">;
  readonly #workspaces: Pick<WorkspaceService, "register" | "unregister">;
  readonly #briefs: Pick<PartnerWorkbenchBriefReader, "read">;
  readonly #now: () => number;
  readonly #workbenches: PartnerWorkbenchStore;
  readonly #environment: PartnerWorkbenchProjectEnvironment;
  readonly #grants = new Map<string, PartnerWorkbenchState>();
  readonly #resolvedGrants = new Map<string, readonly { readonly project: string; readonly path: string; readonly addedAt: number }[]>();
  readonly #referenceWorkspaces = new Map<string, { readonly partnerId: string; readonly project: string }>();
  readonly #sources = new Map<string, ReadonlyMap<string, TaskSource>>();
  readonly #continuations = new Map<string, { readonly operationId: string; readonly message: string; readonly result: Promise<{ readonly sessionId: string; readonly runId: string; readonly status: "queued" | "started" }> }>();

  constructor(options: {
    readonly partners: Pick<PartnerManager, "getPartner" | "canonicalCaller" | "listPartners" | "listDelegations" | "getDelegation">;
    readonly partnerStore: Pick<PartnerStore, "getSessionLink">;
    readonly store: OperationalStore;
    readonly host: Pick<SessionHost, "extraDirectories" | "refreshTargetExtraDirectories" | "scanNativeSessionPreviews" | "readNativeSessionPreview"
      | "createServiceSession" | "registerTarget" | "enqueueServiceInput" | "reconcileServiceNativeCatalogAdoption">;
    readonly workspaces: Pick<WorkspaceService, "register" | "unregister">;
    readonly briefs: Pick<PartnerWorkbenchBriefReader, "read">;
    readonly workbenches: PartnerWorkbenchStore;
    readonly managedDataDirectory: string;
    readonly homeDirectory?: string;
    readonly caseInsensitive?: boolean;
    readonly now?: () => number;
  }) {
    this.#partners = options.partners;
    this.#partnerStore = options.partnerStore;
    this.#store = options.store;
    this.#host = options.host;
    this.#workspaces = options.workspaces;
    this.#briefs = options.briefs;
    this.#now = options.now ?? Date.now;
    this.#workbenches = options.workbenches;
    this.#environment = {
      homeDirectory: options.homeDirectory ?? homedir(), managedDataDirectory: resolve(options.managedDataDirectory),
      caseInsensitive: options.caseInsensitive ?? (process.platform === "win32" || process.platform === "darwin")
    };
  }

  /** Install the sole durable grant before the Host can recover queued work. */
  async initialize(): Promise<void> {
    for (const partner of this.#partners.listPartners("active")) {
      if (partner.initializationState !== "ready" || partner.canonicalSessionId === undefined) continue;
      const owner = this.#owner(partner.id).stamp;
      await this.#installGrant(owner, await this.#workbenches.read(partner.id), false);
    }
  }

  ownerForCaller(sessionId: string): PartnerWorkbenchOwner {
    const partner = this.#partners.canonicalCaller(sessionId);
    return this.#owner(partner.id).stamp;
  }

  async readState(partnerId: string): Promise<PartnerWorkbenchStateView> {
    const owner = this.#owner(partnerId);
    let state = await this.#workbenches.read(partnerId);
    this.#assertOwner(owner.stamp);
    await this.#installGrant(owner.stamp, state, false);
    state = await this.#reconcileBackgrounds(owner.stamp, state);
    await this.#installGrant(owner.stamp, state, false);
    return this.#view(owner.stamp, state);
  }

  async addProject(owner: PartnerWorkbenchOwner, expectedRevision: bigint, rawPath: string): Promise<PartnerWorkbenchStateView & { readonly acceptedProject: string }> {
    this.#assertOwner(owner);
    const path = await checkPartnerWorkbenchProject(rawPath, this.#environment);
    const previous = await this.#workbenches.read(owner.partnerId);
    const existing = await findPartnerWorkbenchProject(path, previous.projects.map((project) => project.path), this.#environment);
    this.#assertOwner(owner);
    const state = await this.#workbenches.addProject(owner.partnerId, expectedRevision, existing ?? path);
    this.#assertOwner(owner);
    await this.#installGrant(owner, state, true);
    this.#publish(owner);
    return { ...await this.#view(owner, state), acceptedProject: existing ?? path };
  }

  async removeProject(owner: PartnerWorkbenchOwner, expectedRevision: bigint, rawPath: string): Promise<PartnerWorkbenchStateView> {
    this.#assertOwner(owner);
    const previous = await this.#workbenches.read(owner.partnerId);
    const path = await findPartnerWorkbenchProject(rawPath, previous.projects.map((project) => project.path), this.#environment);
    this.#assertOwner(owner);
    if (path === undefined) throw new PartnerWorkbenchError("WORKBENCH_PROJECT_NOT_FOUND", "The project is no longer in this workbench.");
    const state = await this.#workbenches.removeProject(owner.partnerId, expectedRevision, path);
    this.#assertOwner(owner);
    await this.#installGrant(owner, state, true);
    this.#publish(owner);
    return this.#view(owner, state);
  }

  async setJudgment(owner: PartnerWorkbenchOwner, expectedRevision: bigint, input: Omit<PartnerWorkbenchJudgment, "updatedAt">): Promise<PartnerWorkbenchStateView> {
    const before = await this.#stateFor(owner);
    const project = await this.#requireProject(owner, before, input.project);
    const title = input.title.replace(/\s+/gu, " ").trim();
    const next = input.next?.replace(/\s+/gu, " ").trim() || null;
    if (title.length < 1 || title.length > 40 || (next?.length ?? 0) > 120 || input.verdict !== "done" && next === null) throw invalid("A bounded title and a next step for unfinished work are required.");
    const ref = input.ref === undefined ? undefined : validatePartnerWorkbenchReference(input.ref, [project], this.#environment.caseInsensitive);
    if (input.ref !== undefined && ref === undefined) throw invalid("A reference must be HTTPS without credentials or a path inside this project.");
    const view = await this.#view(owner, before);
    const source = this.#sources.get(owner.partnerId)?.get(input.taskId);
    const previous = before.judgments.find((item) => item.taskId === input.taskId);
    if (source === undefined && previous === undefined && !/^item:[A-Za-z0-9._:-]{1,240}$/u.test(input.taskId)) throw taskMissing();
    if (source !== undefined && source.project !== "" && source.project !== project || previous !== undefined && previous.project !== project) throw invalid("The task belongs to another granted project.");
    this.#assertScope(owner, project);
    const state = await this.#workbenches.setJudgment(owner.partnerId, expectedRevision, { taskId: input.taskId, project, title, verdict: input.verdict, next, ...(ref === undefined ? {} : { ref }) });
    this.#assertOwner(owner);
    this.#publish(owner);
    // A judgment changes presentation only; durable runtime signals own state.
    return { ...view, state, ...await this.#collect(owner, state, view.projects) };
  }

  async setManyJudgments(owner: PartnerWorkbenchOwner, inputs: readonly Omit<PartnerWorkbenchJudgment, "updatedAt">[]): Promise<{
    readonly results: readonly { readonly taskId: string; readonly ok: boolean; readonly error?: string }[];
  }> {
    if (inputs.length < 1 || inputs.length > 30) throw invalid("Provide between one and 30 workbench judgments.");
    const results: Array<{ taskId: string; ok: boolean; error?: string }> = [];
    for (const input of inputs) {
      this.#assertOwner(owner);
      try {
        const state = await this.#stateFor(owner);
        await this.setJudgment(owner, state.revision, input);
        results.push({ taskId: input.taskId, ok: true });
      } catch (error) {
        this.#assertOwner(owner);
        results.push({ taskId: input.taskId, ok: false, error: error instanceof Error ? redactSecrets(error.message).slice(0, 300) : "The judgment could not be saved." });
      }
    }
    return { results };
  }

  async readDetail(owner: PartnerWorkbenchOwner, taskId: string): Promise<PartnerWorkbenchDetail> {
    const state = await this.#stateFor(owner);
    const view = await this.#view(owner, state);
    const task = [...view.tasks, ...view.candidates].find((item) => item.id === taskId);
    const source = this.#sources.get(owner.partnerId)?.get(taskId);
    if (task === undefined || source === undefined) throw taskMissing();
    if (source.project !== "") await this.#requireProject(owner, state, source.project);
    if (source.delegationId !== undefined) await this.#partners.getDelegation(source.delegationId, owner.partnerId);
    const preview = source.native !== undefined ? await this.#host.readNativeSessionPreview(source.native.backendId, source.native.entry)
      : source.sessionId === undefined ? { messages: [], truncated: false } : this.#transcript(source.sessionId);
    await this.#assertScopeAfter(owner, source.project);
    const artifacts = source.sessionId === undefined ? [] : this.#store.listArtifacts({ sessionId: source.sessionId, limit: 100 })
      .filter((item) => item.deletedAt === undefined).map((item) => ({ id: item.blob.id, title: item.blob.fileName ?? "Artifact", mimeType: item.blob.mimeType, byteSize: item.blob.byteLength, sessionId: source.sessionId! }));
    return { task, transcript: preview.messages, truncated: preview.truncated, artifacts };
  }

  async readProjectFile(owner: PartnerWorkbenchOwner, path: string): Promise<{ readonly path: string; readonly text: string; readonly truncated: boolean }> {
    const reference = await this.resolveReference(owner, path);
    if (reference.kind !== "file" || ![".md", ".mdx", ".txt"].includes(extname(reference.value).toLowerCase())) throw invalid("Select a text document in a handed-over project.");
    const handle = await open(reference.value, "r");
    try {
      const metadata = await handle.stat();
      const before = await lstat(reference.value);
      if (!metadata.isFile() || !before.isFile() || before.isSymbolicLink() || metadata.dev !== before.dev || metadata.ino !== before.ino) throw invalid("The document is unavailable.");
      const bytes = Buffer.alloc(Math.min(metadata.size, 16_384));
      const read = await handle.read(bytes, 0, bytes.length, 0);
      await this.resolveReference(owner, path);
      const after = await lstat(reference.value);
      const observed = await handle.stat();
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== metadata.dev || after.ino !== metadata.ino
        || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || observed.size !== metadata.size || observed.mtimeMs !== metadata.mtimeMs) throw invalid("The document changed while it was being read.");
      const source = bytes.subarray(0, read.bytesRead).toString("utf8");
      const text = redactSecrets(source).slice(0, 4_000);
      return { path: reference.value, text, truncated: metadata.size > read.bytesRead || source.length > 4_000 };
    } finally { await handle.close(); }
  }

  async resolveReference(owner: PartnerWorkbenchOwner, ref: string): Promise<{ readonly kind: "https" | "file"; readonly value: string; readonly workspaceId?: string; readonly relativePath?: string; readonly directory?: boolean }> {
    const state = await this.#stateFor(owner);
    const validated = validatePartnerWorkbenchReference(ref, state.projects.map((project) => project.path), this.#environment.caseInsensitive);
    if (validated === undefined) throw invalid("The reference is outside the current project scope.");
    if (validated.startsWith("https://")) return { kind: "https", value: validated };
    const project = partnerWorkbenchProjectForDirectory(validated, state.projects.map((item) => item.path), this.#environment.caseInsensitive)!;
    await this.#requireProject(owner, state, project);
    const [actual, actualProject] = await Promise.all([realpath(validated), realpath(project)]);
    if (partnerWorkbenchProjectForDirectory(actual, [actualProject], this.#environment.caseInsensitive) === undefined) throw invalid("The reference resolves outside the handed-over project.");
    await this.#assertScopeAfter(owner, project);
    const metadata = await lstat(actual);
    if (!metadata.isFile() && !metadata.isDirectory() || metadata.isSymbolicLink()) throw invalid("The reference is not a regular project file or directory.");
    const workspaceId = `partner-workbench-read:${createHash("sha256").update(owner.partnerId).update("\0").update(actualProject).digest("hex").slice(0, 32)}`;
    await this.#workspaces.register({ id: workspaceId, root: actualProject, displayName: basename(project), trusted: true });
    const referenceScope = { partnerId: owner.partnerId, project };
    this.#referenceWorkspaces.set(workspaceId, referenceScope);
    try { await this.#assertScopeAfter(owner, project); }
    catch (error) {
      if (this.#referenceWorkspaces.get(workspaceId) === referenceScope) { this.#workspaces.unregister(workspaceId); this.#referenceWorkspaces.delete(workspaceId); }
      throw error;
    }
    return { kind: "file", value: actual, workspaceId, relativePath: relative(actualProject, actual).replaceAll("\\", "/"), directory: metadata.isDirectory() };
  }

  /** One durable effect identity owns creation and dispatch. An ambiguous
   * outcome remains visible and blocks a fresh blind continuation. */
  async continueTask(owner: PartnerWorkbenchOwner, taskId: string, message: string, operationId: string): Promise<{
    readonly sessionId: string; readonly runId: string; readonly status: "queued" | "started";
  }> {
    this.#assertOwner(owner);
    const key = JSON.stringify([owner.partnerId, owner.profileVersion, owner.sessionGeneration, taskId]);
    const current = this.#continuations.get(key);
    if (current !== undefined) {
      if (current.operationId === operationId && current.message === message) return current.result;
      throw new PartnerWorkbenchError("WORKBENCH_UNAVAILABLE", "This task's continuation is already being confirmed.");
    }
    const result = this.#continueTask(owner, taskId, message, operationId);
    const flight = { operationId, message, result };
    this.#continuations.set(key, flight);
    try { return await result; } finally { if (this.#continuations.get(key) === flight) this.#continuations.delete(key); }
  }

  async #continueTask(owner: PartnerWorkbenchOwner, taskId: string, message: string, operationId: string): Promise<{
    readonly sessionId: string; readonly runId: string; readonly status: "queued" | "started";
  }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,230}$/u.test(operationId) || message.trim().length > 12_000) throw invalid("A valid bounded continuation identity and message are required.");
    const state = await this.#stateFor(owner);
    const previous = this.#store.findSetting("service", BACKGROUND_SCOPE, operationId)?.value;
    if (previous !== undefined) {
      const record = this.#backgroundReceipt(parseBackground(previous));
      if (record.partnerId !== owner.partnerId || record.sourceTaskId !== taskId || record.parentSessionId !== owner.sessionId
        || record.profileVersion !== owner.profileVersion || record.requestedMessage !== message.trim()) throw invalid("This effect identity belongs to different work.");
      await this.#requireProject(owner, state, record.project);
      if (record.status === "queued" && record.sessionId !== undefined && record.runId !== undefined) {
        return { sessionId: record.sessionId, runId: record.runId, status: this.#dispatchState(record.runId) };
      }
      throw new PartnerWorkbenchError(record.status === "unknown" || record.status === "preparing" ? "WORKBENCH_DISPATCH_UNKNOWN" : "WORKBENCH_UNAVAILABLE",
        "This task effect has already been attempted. Inspect its result before sending a new direction.");
    }
    const view = await this.#view(owner, state);
    const task = [...view.tasks, ...view.candidates].find((item) => item.id === taskId);
    const source = this.#sources.get(owner.partnerId)?.get(taskId);
    if (task === undefined || source === undefined || task.kind === "automation") throw taskMissing();
    if (source.project === "" && source.delegationId === undefined) throw invalid("Hand over this task's project before continuing it.");
    if (source.project !== "") await this.#requireProject(owner, state, source.project);
    if (source.delegationId !== undefined) await this.#partners.getDelegation(source.delegationId, owner.partnerId);
    let objective = message.trim() || source.item?.next || task.judgment?.next || "";
    if (!objective) throw invalid("A continuation message or a saved next step is required.");
    if (source.item?.ref !== undefined) objective += `\n\nReference: ${(await this.resolveReference(owner, source.item.ref)).value}`;
    const records = this.#backgrounds(owner.partnerId);
    const uncertain = records.find((item) => (item.sourceTaskId === taskId || source.sessionId !== undefined && item.sessionId === source.sessionId)
      && (item.status === "unknown" || item.status === "preparing"));
    if (uncertain !== undefined) throw new PartnerWorkbenchError("WORKBENCH_DISPATCH_UNKNOWN", "The previous task effect is unconfirmed. Inspect that task before sending new work.");
    let sessionId = source.sessionId ?? records.find((item) => item.sourceTaskId === taskId && item.sessionId !== undefined && ["ready", "failed"].includes(item.status))?.sessionId;
    let background: BackgroundRecord | undefined;
    if (sessionId === undefined) {
      const mode = source.native?.snapshotToken === undefined ? "background" : "adopt";
      if (source.native !== undefined && mode === "background") {
        const preview = await this.#host.readNativeSessionPreview(source.native.backendId, source.native.entry);
        await this.#assertScopeAfter(owner, source.project);
        objective += `\n\nRead-only source context:\n${preview.messages.map((item) => `${item.role}: ${item.text}`).join("\n").slice(0, 4_000)}`;
      }
      background = { version: 1, mode, operationId, partnerId: owner.partnerId, profileVersion: owner.profileVersion,
        parentSessionId: owner.sessionId, parentSessionGeneration: owner.sessionGeneration, project: source.project, sourceTaskId: taskId,
        title: task.title.slice(0, 200), objective, requestedMessage: message.trim(), createdAt: this.#now(), status: "preparing" };
      this.#store.setSetting("service", BACKGROUND_SCOPE, operationId, background);
      this.#publish(owner);
    }
    try {
      if (background !== undefined) {
        const currentOwner = this.#assertOwner(owner);
        if (background.mode === "adopt") {
          const native = source.native!;
          const entry = native.entry;
          const projectRoot = entry.projectDirectory ?? entry.workingDirectory;
          if (projectRoot === undefined || entry.workingDirectory === undefined) throw taskMissing();
          const targetId = await this.#targetForProject(owner, entry.workingDirectory, native.backendId, source.project);
          const projectId = entry.placement === "project" ? await this.#targetForProject(owner, projectRoot, native.backendId, source.project) : undefined;
          await this.#assertScopeAfter(owner, source.project);
          const execution = await this.#host.createServiceSession({ operationId: `${operationId}:import`, serviceKind: "partner", targetId,
            title: entry.title ?? task.title, permissionMode: "ask", planMode: false, fastMode: false,
            nativeStart: { kind: "attach", nativeReference: entry.nativeReference }, catalogImport: {
              ...(projectId === undefined ? {} : { projectId }), archived: false, createdAt: entry.createdAt, modifiedAt: entry.modifiedAt, snapshotToken: native.snapshotToken!
            }, initialPlacement: entry.placement, originSessionId: owner.sessionId, originSessionGeneration: owner.sessionGeneration,
            assertServiceScope: () => this.#assertScope(owner, source.project) });
          sessionId = execution.value.sessionId;
        } else {
          const route = currentOwner.profile.capabilities.modelChain[0]!;
          const targetId = await this.#targetForProject(owner, source.project, route.backendId, source.project);
          await this.#assertScopeAfter(owner, source.project);
          const execution = await this.#host.createServiceSession({ operationId: `${operationId}:create`, serviceKind: "partner", targetId,
            title: background.title, providerId: route.providerId, modelId: route.modelId, ...(route.effort === undefined ? {} : { effort: route.effort }),
            fastMode: route.fastMode, permissionMode: currentOwner.profile.capabilities.permissionMode, planMode: currentOwner.profile.capabilities.planMode,
            appendSystemPrompt: currentOwner.profile.identitySource, originSessionId: owner.sessionId, originSessionGeneration: owner.sessionGeneration,
            assertServiceScope: () => this.#assertScope(owner, source.project) });
          sessionId = execution.value.sessionId;
        }
        background = { ...background, sessionId, status: "ready" };
        this.#store.setSetting("service", BACKGROUND_SCOPE, operationId, background);
        await this.#assertScopeAfter(owner, source.project);
        if (background.mode === "adopt") {
          const current = await this.#workbenches.read(owner.partnerId);
          this.#assertScope(owner, source.project);
          if (current.judgments.some((item) => item.taskId === taskId)) await this.#workbenches.rekeyJudgment(owner.partnerId, current.revision, taskId, `task:${sessionId}`);
        }
      }
      await this.#assertScopeAfter(owner, source.project);
      const session = this.#store.getSession(sessionId!).descriptor;
      if (session.archived || session.deletedAt !== undefined || session.remoteWorkspace !== undefined) throw taskMissing();
      const latest = this.#store.listRuns({ sessionId: session.id, limit: 1 })[0]?.descriptor;
      if (latest?.state === "dispatch_unknown") throw new PartnerWorkbenchError("WORKBENCH_DISPATCH_UNKNOWN", "The task's latest dispatch is unconfirmed. Inspect it before sending more work.");
      this.#assertScope(owner, source.project);
      const dispatch = this.#host.enqueueServiceInput({ operationId: `${operationId}:send`, sessionId: session.id, prompt: prompt(objective), source: "system", originSessionId: owner.sessionId });
      const status = this.#dispatchState(dispatch.value.runId);
      const owned = background ?? records.find((item) => item.sessionId === session.id);
      if (owned !== undefined) this.#store.setSetting("service", BACKGROUND_SCOPE, owned.operationId, { ...owned, sessionId: session.id, runId: dispatch.value.runId, status: "queued" });
      if (background?.mode === "background") {
        const current = await this.#workbenches.read(owner.partnerId);
        this.#assertScope(owner, source.project);
        if (current.judgments.some((item) => item.taskId === taskId)) await this.#workbenches.deleteJudgment(owner.partnerId, current.revision, taskId);
      }
      this.#publish(owner);
      return { sessionId: session.id, runId: dispatch.value.runId, status };
    } catch (error) {
      if (background !== undefined) this.#store.setSetting("service", BACKGROUND_SCOPE, operationId, this.#backgroundReceipt(background));
      this.#publishIfCurrent(owner);
      throw error;
    }
  }

  #backgroundReceipt(record: BackgroundRecord): BackgroundRecord {
    const creation = this.#store.findOperation<{ readonly sessionId: string }>(`${record.operationId}:${record.mode === "adopt" ? "import" : "create"}`);
    const adoption = record.mode === "adopt" ? this.#store.findNativeCatalogAdoption(`${record.operationId}:import`) : undefined;
    if (creation?.status === "started" || adoption?.state === "claimed" || adoption?.state === "unknown") return { ...record, status: "unknown" };
    const changed = (error: unknown): boolean => typeof error === "object" && error !== null && "stateMayHaveChanged" in error && error.stateMayHaveChanged === true;
    if (creation === undefined || creation.status === "failed") return { ...record, status: changed(creation?.error) && adoption?.state !== "absent" ? "unknown" : "failed" };
    const sessionId = record.sessionId ?? creation.response?.sessionId;
    if (sessionId === undefined) return { ...record, status: "unknown" };
    const dispatch = this.#store.findOperation<{ readonly runId: string }>(`${record.operationId}:send`);
    const runId = record.runId ?? (dispatch?.status === "completed" ? dispatch.response?.runId : undefined);
    if (runId !== undefined) {
      try { return { ...record, sessionId, runId, status: this.#store.getRun(runId).descriptor.state === "dispatch_unknown" ? "unknown" : "queued" }; }
      catch { return { ...record, sessionId, status: "unknown" }; }
    }
    return { ...record, sessionId, status: dispatch?.status === "started" || changed(dispatch?.error) ? "unknown" : dispatch?.status === "failed" ? "failed" : "ready" };
  }

  async #reconcileBackgrounds(owner: PartnerWorkbenchOwner, state: PartnerWorkbenchState): Promise<PartnerWorkbenchState> {
    let currentState = state;
    for (const record of this.#backgrounds(owner.partnerId).filter((item) => currentState.projects.some((project) => project.path === item.project)).slice(0, 20)) {
      if ([...this.#continuations.values()].some((flight) => flight.operationId === record.operationId)) continue;
      let next = this.#backgroundReceipt(record);
      if (next.status === "unknown" && record.mode === "adopt" && this.#store.findNativeCatalogAdoption(`${record.operationId}:import`) !== undefined) {
        try {
          await this.#host.reconcileServiceNativeCatalogAdoption({ operationId: `${record.operationId}:import`,
            originSessionId: record.parentSessionId, originSessionGeneration: record.parentSessionGeneration,
            assertServiceScope: () => this.#assertScope(owner, record.project) });
          await this.#assertScopeAfter(owner, record.project);
          next = this.#backgroundReceipt(record);
        } catch { this.#assertOwner(owner); }
      }
      if (JSON.stringify(next) !== JSON.stringify(record)) this.#store.setSetting("service", BACKGROUND_SCOPE, record.operationId, next);
      if (next.mode === "adopt" && next.sessionId !== undefined && currentState.judgments.some((item) => item.taskId === next.sourceTaskId)) {
        this.#assertScope(owner, next.project);
        currentState = await this.#workbenches.rekeyJudgment(owner.partnerId, currentState.revision, next.sourceTaskId, `task:${next.sessionId}`);
        this.#publish(owner);
      }
    }
    return currentState;
  }

  async #targetForProject(owner: PartnerWorkbenchOwner, directory: string, backendId: string, project: string): Promise<string> {
    const path = await checkPartnerWorkbenchProject(directory, this.#environment);
    if (partnerWorkbenchProjectForDirectory(path, [project], this.#environment.caseInsensitive) === undefined) throw invalid("The native task's directory is outside this project.");
    const [actualPath, actualProject] = await Promise.all([realpath(path), realpath(project)]);
    if (partnerWorkbenchProjectForDirectory(actualPath, [actualProject], this.#environment.caseInsensitive) === undefined) throw invalid("The native task's directory resolves outside this project.");
    this.#assertScope(owner, project);
    const existing = this.#store.listTargets(backendId).find((target) => target.descriptor.remoteWorkspace === undefined && target.descriptor.trusted
      && target.descriptor.workspaceRoot === path && (typeof target.metadata !== "object" || target.metadata === null || !("deletedAt" in target.metadata)));
    if (existing !== undefined) return existing.descriptor.id;
    const id = `partner-project:${createHash("sha256").update(owner.partnerId).update("\0").update(backendId).update("\0").update(path).digest("hex").slice(0, 32)}`;
    await this.#workspaces.register({ id, root: path, displayName: basename(path), trusted: true });
    this.#assertScope(owner, project);
    await this.#host.registerTarget({ id, backendId, displayName: basename(path), workspaceRoot: path, managed: false, trusted: true }, { workspaceId: id, kind: "partner_workbench", partnerId: owner.partnerId });
    this.#assertScope(owner, project);
    return id;
  }

  async #stateFor(owner: PartnerWorkbenchOwner): Promise<PartnerWorkbenchState> {
    this.#assertOwner(owner);
    let state = await this.#workbenches.read(owner.partnerId);
    this.#assertOwner(owner);
    await this.#installGrant(owner, state, false);
    state = await this.#reconcileBackgrounds(owner, state);
    await this.#installGrant(owner, state, false);
    return state;
  }

  async #requireProject(owner: PartnerWorkbenchOwner, state: PartnerWorkbenchState, raw: string): Promise<string> {
    const project = await findPartnerWorkbenchProject(raw, state.projects.map((item) => item.path), this.#environment);
    if (project === undefined) throw new PartnerWorkbenchError("WORKBENCH_PROJECT_NOT_FOUND", "The project grant was withdrawn. Reload this workbench.");
    await checkPartnerWorkbenchProject(project, this.#environment);
    this.#assertScope(owner, project);
    return project;
  }

  #assertScope(owner: PartnerWorkbenchOwner, project: string): void {
    this.#assertOwner(owner);
    if (project !== "" && !this.#grants.get(owner.partnerId)?.projects.some((item) => item.path === project)) throw new PartnerWorkbenchError("WORKBENCH_PROJECT_NOT_FOUND", "The project grant was withdrawn. Reload this workbench.");
  }
  async #assertScopeAfter(owner: PartnerWorkbenchOwner, project: string): Promise<void> {
    const current = await this.#workbenches.read(owner.partnerId);
    this.#assertOwner(owner);
    if (project !== "" && !current.projects.some((item) => item.path === project)) throw new PartnerWorkbenchError("WORKBENCH_PROJECT_NOT_FOUND", "The project grant was withdrawn. Reload this workbench.");
    if (this.#grants.get(owner.partnerId)?.revision !== current.revision) await this.#installGrant(owner, current, false);
  }

  async #installGrant(owner: PartnerWorkbenchOwner, state: PartnerWorkbenchState, refresh: boolean): Promise<void> {
    this.#assertOwner(owner);
    const previous = this.#grants.get(owner.partnerId);
    if (previous !== undefined && previous.revision > state.revision) return;
    this.#grants.set(owner.partnerId, state);
    for (const [id, reference] of this.#referenceWorkspaces) {
      if (reference.partnerId === owner.partnerId && !state.projects.some((project) => project.path === reference.project)) {
        this.#workspaces.unregister(id); this.#referenceWorkspaces.delete(id);
      }
    }
    // Revoke synchronously before path probes; the runtime sees only those
    // previously resolved directories still present in the new durable state.
    const previousDirectories = (this.#resolvedGrants.get(owner.partnerId) ?? []).filter((entry) => state.projects.some((project) => project.path === entry.project));
    const current = (): boolean => {
      try { const profile = this.#partners.getPartner(owner.partnerId); return profile.lifecycle === "active" && profile.initializationState === "ready" && profile.homeTargetId === owner.targetId; } catch { return false; }
    };
    this.#host.extraDirectories.replaceWorkbenchGrant({ targetId: owner.targetId, revision: state.revision,
      directories: previousDirectories.map((entry) => ({ path: entry.path, addedAt: entry.addedAt })), current });
    const directories = await Promise.all(state.projects.map(async (project) => {
      try { await checkPartnerWorkbenchProject(project.path, this.#environment); return { project: project.path, path: await realpath(project.path), addedAt: project.addedAt }; } catch { return undefined; }
    }));
    this.#assertOwner(owner);
    if (this.#grants.get(owner.partnerId) !== state) return;
    const resolved = directories.filter((item): item is { project: string; path: string; addedAt: number } => item !== undefined);
    this.#resolvedGrants.set(owner.partnerId, resolved);
    this.#host.extraDirectories.replaceWorkbenchGrant({ targetId: owner.targetId, revision: state.revision, directories: resolved, current });
    if (refresh) await this.#host.refreshTargetExtraDirectories(owner.targetId);
  }

  #sessionState(session: SessionDescriptor, delegationStatus?: Parameters<typeof derivePartnerWorkbenchTaskState>[0]["delegationStatus"]): PartnerWorkbenchTask["state"] {
    const active = this.#store.listRuns({ sessionId: session.id, activeOnly: true, limit: 20 }).map((item) => item.descriptor);
    const latest = this.#store.listRuns({ sessionId: session.id, limit: 1 })[0]?.descriptor;
    const waiting = this.#store.listInteractions({ sessionId: session.id, status: "open", limit: 1 }).length > 0 || active.some((run) => run.state === "waiting");
    const running = active.some((run) => run.state === "running" || run.state === "retrying");
    return derivePartnerWorkbenchTaskState({ waiting, running,
      queued: !waiting && !running && this.#store.listQueueItems({ sessionId: session.id, states: ["accepted", "dispatching"], limit: 1 }).length > 0,
      interrupted: latest?.state === "aborted" || latest?.state === "dispatch_unknown", errored: latest?.state === "failed", ...(delegationStatus === undefined ? {} : { delegationStatus }) });
  }

  #transcript(sessionId: string): { readonly messages: readonly PartnerWorkbenchTranscriptItem[]; readonly truncated: boolean } {
    const head = this.#store.listEvents({ sessionId, order: "asc", limit: 120, activeNativeTimeline: true });
    const tail = this.#store.listEvents({ sessionId, order: "desc", limit: 120, activeNativeTimeline: true }).reverse();
    const items = (events: readonly PersistedEvent[]): PartnerWorkbenchTranscriptItem[] => events.flatMap((event) => {
      const payload = event.payload;
      if (payload.type !== "message_complete" || payload.automaticContinuation !== undefined || payload.objectiveContinuation !== undefined
        || payload.role === "user" && (payload.partnerPrivateOrigin !== undefined || payload.automationOrigin !== undefined || payload.inputDelivery === "scheduler")) return [];
      if (payload.role === "user" && event.runId !== undefined) {
        try { if (this.#store.getRun(event.runId).descriptor.source === "system") return []; } catch { return []; }
      }
      const text = redactSecrets(payload.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n"));
      return [{ role: payload.role, text, at: event.emittedAt, ...(payload.partnerPrivateOrigin === undefined ? {} : { privateMessageOrigin: payload.partnerPrivateOrigin }) }];
    });
    const heads = items(head);
    const tails = items(tail);
    const whole = head.length < 120 || head.at(-1)?.globalCursor === tail.at(-1)?.globalCursor;
    const preview = boundNativeSessionPreview(heads, tails, whole);
    return { ...preview, messages: preview.messages.map((item) => {
      const privateMessageOrigin = [...heads, ...tails].find((row) => row.role === item.role && row.at === item.at)?.privateMessageOrigin;
      return { ...item, ...(privateMessageOrigin === undefined ? {} : { privateMessageOrigin }) };
    }) };
  }
  #backgrounds(partnerId: string): readonly BackgroundRecord[] {
    return this.#store.listSettings("service", BACKGROUND_SCOPE).map((setting) => parseBackground(setting.value)).filter((item) => item.partnerId === partnerId);
  }
  #dispatchState(runId: string): "queued" | "started" {
    const state = this.#store.getRun(runId).descriptor.state;
    if (state === "dispatch_unknown") throw new PartnerWorkbenchError("WORKBENCH_DISPATCH_UNKNOWN", "The dispatch is unconfirmed. Inspect the task before sending more work.");
    return state === "queued" ? "queued" : "started";
  }
  #publish(owner: PartnerWorkbenchOwner): void {
    const current = this.#assertOwner(owner);
    this.#store.appendEvent({ id: randomUUID(), sessionId: owner.sessionId, targetId: owner.targetId, backendId: current.session.backendId,
      generation: owner.sessionGeneration, emittedAt: this.#now(), traceId: `partner-workbench:${owner.partnerId}`, payload: { type: "session_changed" } });
  }
  #publishIfCurrent(owner: PartnerWorkbenchOwner): void { try { this.#publish(owner); } catch { /* The changed owner is not notified by an old effect. */ } }

  async #collect(owner: PartnerWorkbenchOwner, state: PartnerWorkbenchState, projects: readonly PartnerWorkbenchProjectView[]): Promise<Omit<PartnerWorkbenchStateView, "owner" | "state" | "projects">> {
    const available = projects.filter((project) => project.exists).map((project) => project.path);
    const since = this.#now() - PARTNER_WORKBENCH_RECENT_WINDOW_MS;
    const judgments = new Map(state.judgments.filter((item) => available.includes(item.project)).map((item) => [item.taskId, item]));
    const backgrounds = this.#backgrounds(owner.partnerId);
    const ownBySession = new Map(backgrounds.filter((item) => item.sessionId !== undefined).map((item) => [item.sessionId!, item]));
    const delegations = await this.#partners.listDelegations(owner.partnerId);
    this.#assertOwner(owner);
    const ownDelegations = new Map(delegations.filter((item) => item.delegation.childSessionId !== undefined).map((item) => [item.delegation.childSessionId!, item.delegation]));
    const sources = new Map<string, TaskSource>();
    const candidates: PartnerWorkbenchTask[] = [];
    const options = new Map<string, PartnerWorkbenchProjectOption>();
    const option = (path: string, key: "taskCount" | "nativeCount" | "automationCount", repository = false): void => {
      if (!isAbsolute(path) || partnerWorkbenchProjectForDirectory(path, [this.#environment.managedDataDirectory], this.#environment.caseInsensitive) !== undefined) return;
      const previous = options.get(path) ?? { path, name: basename(path) || path, taskCount: 0, nativeCount: 0, automationCount: 0, repository, granted: state.projects.some((item) => item.path === path) };
      options.set(path, { ...previous, [key]: previous[key] + 1, repository: previous.repository || repository });
    };
    let olderCount = 0;
    const allSessions = this.#store.listSessions();
    const nativeBindings = new Set(allSessions.flatMap((item) => item.descriptor.binding.nativeSessionId === undefined ? [] : [`${item.descriptor.backendId}:${item.descriptor.binding.nativeSessionId}`]));
    for (const stored of allSessions) {
      const session = stored.descriptor;
      const background = ownBySession.get(session.id);
      const delegation = ownDelegations.get(session.id);
      const target = this.#store.getTarget(session.targetId).descriptor;
      if (target.remoteWorkspace !== undefined || session.remoteWorkspace !== undefined || !target.trusted || session.archived || session.deletedAt !== undefined) continue;
      if (background === undefined && delegation === undefined && (this.#partnerStore.getSessionLink(session.id) !== undefined || this.#store.sessionCreationServiceKind(session.id) !== undefined)) continue;
      const directory = session.worktree?.repositoryRoot ?? target.workspaceRoot;
      if (background === undefined && delegation === undefined) option(directory, "taskCount", session.worktree !== undefined);
      const project = background?.project ?? partnerWorkbenchProjectForDirectory(directory, available, this.#environment.caseInsensitive) ?? (delegation === undefined ? undefined : "");
      if (project === undefined || project !== "" && !available.includes(project)) continue;
      if (session.updatedAt < since && background === undefined && delegation === undefined) { olderCount += 1; continue; }
      const id = `task:${session.id}`;
      const judgment = judgments.get(id);
      const actualState = this.#sessionState(session, delegation?.status);
      const taskState = background !== undefined && ["unknown", "ready", "failed", "preparing"].includes(background.status)
        && actualState === "done" ? background.status === "preparing" ? "queued" : "stopped" : actualState;
      const startedAt = this.#store.listRuns({ sessionId: session.id, activeOnly: true, limit: 1 })[0]?.descriptor.startedAt;
      const preview = this.#transcript(session.id);
      const digest = buildPartnerWorkbenchDigest(preview.messages, preview.messages);
      const withPurpose = digest.purpose === null && background !== undefined ? { ...digest, purpose: background.objective.slice(0, 200) }
        : digest.purpose === null && delegation !== undefined ? { ...digest, purpose: delegation.objective.slice(0, 200) } : digest;
      candidates.push({ id, kind: "session", project, title: judgment?.title ?? session.title, state: taskState,
        group: partnerWorkbenchGroup(taskState, "session", judgment?.verdict), updatedAt: session.updatedAt, sessionId: session.id,
        sourceLabel: background === undefined && delegation === undefined ? "Task" : "Background task", ownedBackground: background !== undefined || delegation !== undefined,
        unread: session.attention?.unread === true, ...(startedAt === undefined ? {} : { startedAt }), ...(judgment === undefined ? {} : { judgment }), digest: withPurpose });
      sources.set(id, { project, sessionId: session.id, ...(delegation === undefined ? {} : { delegationId: delegation.id }) });
    }
    const unavailableSources: string[] = [];
    const backends = this.#store.listBackends().filter((item) => item.descriptor.capabilities.get("session.preview")?.supported === true);
    const scans = await Promise.all(backends.map(async (backend) => {
      try { return { backend: backend.descriptor, scan: await this.#host.scanNativeSessionPreviews(backend.descriptor.id, available) }; }
      catch { return { backend: backend.descriptor, scan: undefined }; }
    }));
    await this.#assertScopeAfter(owner, "");
    for (const { backend, scan } of scans) {
      if (scan === undefined) { unavailableSources.push(backend.displayName); continue; }
      for (const entry of scan.entries) {
        if (entry.archived || entry.workingDirectory === undefined || entry.nativeSessionId !== undefined && nativeBindings.has(`${backend.id}:${entry.nativeSessionId}`)) continue;
        const directory = entry.projectDirectory ?? entry.workingDirectory;
        option(directory, "nativeCount");
        const project = partnerWorkbenchProjectForDirectory(directory, available, this.#environment.caseInsensitive);
        if (project === undefined) continue;
        if (entry.modifiedAt < since) { olderCount += 1; continue; }
        const id = `native:${createHash("sha256").update(backend.id).update("\0").update(entry.nativeReference).digest("hex")}`;
        const judgment = judgments.get(id);
        candidates.push({ id, kind: "external", project, title: judgment?.title ?? entry.title ?? "Native task", state: "done",
          group: partnerWorkbenchGroup("done", "external", judgment?.verdict), updatedAt: entry.modifiedAt, sourceLabel: backend.displayName,
          ownedBackground: false, unread: false, ...(judgment === undefined ? {} : { judgment }), digest: { purpose: null, recent: [] } });
        sources.set(id, { project, native: { backendId: backend.id, entry, ...(scan.snapshotToken === undefined ? {} : { snapshotToken: scan.snapshotToken }) } });
      }
    }
    for (const schedule of this.#store.listSchedules()) {
      const target = this.#store.getTarget(schedule.targetId).descriptor;
      if (target.remoteWorkspace !== undefined || !target.trusted) continue;
      option(target.workspaceRoot, "automationCount");
      const project = partnerWorkbenchProjectForDirectory(target.workspaceRoot, available, this.#environment.caseInsensitive)
        ?? (schedule.sessionId === owner.sessionId || schedule.targetId === owner.targetId ? "" : undefined);
      if (project === undefined) continue;
      const occurrences = this.#store.listScheduleRuns(schedule.id, 20);
      const liveRuns = occurrences.flatMap((item) => { try { return [this.#store.getRun(item.runId).descriptor]; } catch { return []; } });
      const taskState = derivePartnerWorkbenchAutomationState({ enabled: schedule.enabled, running: liveRuns.some((run) => ["running", "waiting", "retrying"].includes(run.state)), queued: liveRuns.some((run) => run.state === "queued") });
      const id = `schedule:${schedule.id}`;
      candidates.push({ id, kind: "automation", project, title: schedule.name, state: taskState, group: partnerWorkbenchGroup(taskState, "automation"),
        updatedAt: schedule.lastRunAt ?? schedule.updatedAt, scheduleId: schedule.id, sourceLabel: schedule.kind === "interval" ? "Routine" : "Automation", ownedBackground: false,
        ...(schedule.expression === undefined ? {} : { scheduleSummary: `${schedule.expression} · ${schedule.timezone}` }),
        unread: occurrences.some((item) => item.finishedAt !== undefined && item.readAt === undefined), digest: { purpose: null, recent: [] } });
      sources.set(id, { project, scheduleId: schedule.id });
    }
    for (const judgment of judgments.values()) {
      if (sources.has(judgment.taskId)) continue;
      const isItem = judgment.taskId.startsWith("item:");
      const taskState = isItem && judgment.verdict === "done" ? "done" : "stopped";
      candidates.push({ id: judgment.taskId, kind: isItem ? "item" : "external", project: judgment.project, title: judgment.title,
        state: taskState, group: isItem ? partnerWorkbenchGroup(taskState, "item", judgment.verdict) : "waiting", updatedAt: judgment.updatedAt,
        sourceLabel: isItem ? "Note" : "Source unavailable", ownedBackground: false, unread: false, judgment, digest: { purpose: null, recent: [] } });
      if (isItem) sources.set(judgment.taskId, { project: judgment.project, item: judgment });
    }
    for (const background of backgrounds.filter((item) => item.sessionId === undefined && available.includes(item.project))) {
      candidates.push({ id: `background:${background.operationId}`, kind: "session", project: background.project, title: background.title,
        state: background.status === "preparing" ? "queued" : "stopped", group: background.status === "preparing" ? "todo" : "waiting", updatedAt: background.createdAt,
        sourceLabel: "Background task", ownedBackground: true, unread: false, digest: { purpose: background.objective.slice(0, 200), recent: [] } });
      sources.set(`background:${background.operationId}`, { project: background.project });
    }
    candidates.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    // Candidate reads use the same project authority; only bounded recent text
    // for visible cards/tool candidates is read, never full native histories.
    const nativeReads = candidates.filter((task) => task.kind === "external" && sources.get(task.id)?.native !== undefined).slice(0, 40);
    await Promise.all(nativeReads.map(async (task) => {
      const native = sources.get(task.id)!.native!;
      try {
        this.#assertScope(owner, task.project);
        const preview = await this.#host.readNativeSessionPreview(native.backendId, native.entry);
        this.#assertScope(owner, task.project);
        const index = candidates.findIndex((item) => item.id === task.id);
        candidates[index] = { ...task, digest: buildPartnerWorkbenchDigest(preview.messages, preview.messages) };
      } catch { this.#assertOwner(owner); unavailableSources.push(task.sourceLabel); }
    }));
    const briefs = await Promise.all(available.slice(0, 8).map(async (project) => {
      try { return await this.#briefs.read(project, () => this.#assertScope(owner, project)); }
      catch { this.#assertOwner(owner); unavailableSources.push(basename(project)); return undefined; }
    }));
    await this.#assertScopeAfter(owner, "");
    if (this.#grants.get(owner.partnerId)?.revision !== state.revision) throw new PartnerWorkbenchError("WORKBENCH_OWNER_CHANGED", "The workbench changed while loading. Reload its current state.");
    this.#sources.set(owner.partnerId, sources);
    for (const target of this.#store.listTargets().slice(0, 500)) {
      if (!target.descriptor.trusted || target.descriptor.remoteWorkspace !== undefined || target.descriptor.managed
        || typeof target.metadata === "object" && target.metadata !== null && "deletedAt" in target.metadata) continue;
      const path = target.descriptor.workspaceRoot;
      if (!isAbsolute(path) || partnerWorkbenchProjectForDirectory(path, [this.#environment.managedDataDirectory], this.#environment.caseInsensitive) !== undefined) continue;
      let repository = false;
      try { const git = await lstat(resolve(path, ".git")); repository = git.isDirectory() || git.isFile(); } catch { /* A configured project need not contain Git. */ }
      const previous = options.get(path);
      options.set(path, { ...(previous ?? { path, name: basename(path), taskCount: 0, nativeCount: 0, automationCount: 0, granted: state.projects.some((item) => item.path === path) }), repository: previous?.repository === true || repository });
    }
    for (const project of state.projects) if (!options.has(project.path)) options.set(project.path, { path: project.path, name: basename(project.path), taskCount: 0, nativeCount: 0, automationCount: 0, repository: false, granted: true });
    const outputOwners = [...backgrounds.filter((item) => item.sessionId !== undefined && available.includes(item.project)).sort((left, right) => right.createdAt - left.createdAt).map((item) => item.sessionId!),
      ...ownDelegations.keys(), owner.sessionId];
    const seenOutputs = new Set<string>();
    const outputs: PartnerWorkbenchArtifact[] = [];
    for (const sessionId of [...new Set(outputOwners)].slice(0, 41)) {
      for (const item of this.#store.listArtifacts({ sessionId, limit: 20 })) {
        if (item.deletedAt !== undefined || seenOutputs.has(item.blob.id)) continue;
        seenOutputs.add(item.blob.id);
        outputs.push({ id: item.blob.id, title: item.blob.fileName ?? "Artifact", mimeType: item.blob.mimeType, byteSize: item.blob.byteLength, sessionId });
        if (outputs.length === 4) break;
      }
      if (outputs.length === 4) break;
    }
    await this.#assertScopeAfter(owner, "");
    if (this.#grants.get(owner.partnerId)?.revision !== state.revision) throw new PartnerWorkbenchError("WORKBENCH_OWNER_CHANGED", "The workbench changed while loading. Reload its current state.");
    return { projectOptions: [...options.values()].slice(0, 500), tasks: candidates.filter((item) => item.kind !== "external" || item.judgment !== undefined).slice(0, 200),
      candidates: candidates.filter((item) => item.kind === "session" || item.kind === "external").slice(0, 40), briefs: briefs.filter((brief): brief is PartnerWorkbenchProjectBrief => brief !== undefined),
      outputs, olderCount, truncated: candidates.length > 200 || options.size > 500 || available.length > 8, unavailableSources: [...new Set(unavailableSources)] };
  }

  async #view(owner: PartnerWorkbenchOwner, state: PartnerWorkbenchState): Promise<PartnerWorkbenchStateView> {
    const projects = await Promise.all(state.projects.map(async (project): Promise<PartnerWorkbenchProjectView> => ({
      ...project, name: basename(project.path) || project.path,
      exists: await checkPartnerWorkbenchProject(project.path, this.#environment).then(() => true).catch(() => false)
    })));
    this.#assertOwner(owner);
    return { owner, state, projects, ...await this.#collect(owner, state, projects) };
  }

  #owner(partnerId: string): OwnedPartnerWorkbench {
    const profile = this.#partners.getPartner(partnerId);
    if (profile.canonicalSessionId === undefined) throw unavailable();
    this.#partners.canonicalCaller(profile.canonicalSessionId);
    const session = this.#store.getSession(profile.canonicalSessionId).descriptor;
    const target = this.#store.getTarget(profile.homeTargetId).descriptor;
    if (session.targetId !== target.id || !target.trusted || target.remoteWorkspace !== undefined || session.remoteWorkspace !== undefined) throw unavailable();
    return { profile, session, target, stamp: {
      partnerId: profile.id, profileVersion: profile.profileVersion, sessionId: session.id,
      sessionGeneration: session.binding.generation, targetId: target.id
    } };
  }

  #assertOwner(expected: PartnerWorkbenchOwner): OwnedPartnerWorkbench {
    const current = this.#owner(expected.partnerId);
    if (current.stamp.partnerId !== expected.partnerId || current.stamp.profileVersion !== expected.profileVersion
      || current.stamp.sessionId !== expected.sessionId || current.stamp.sessionGeneration !== expected.sessionGeneration
      || current.stamp.targetId !== expected.targetId) {
      throw new PartnerWorkbenchError("WORKBENCH_OWNER_CHANGED", "The partner workbench owner changed. Reload its current state.");
    }
    return current;
  }
}

function unavailable(): PartnerWorkbenchError { return new PartnerWorkbenchError("WORKBENCH_UNAVAILABLE", "An active local partner canonical task is required."); }
function invalid(message: string): PartnerWorkbenchError { return new PartnerWorkbenchError("WORKBENCH_INVALID", message); }
function taskMissing(): PartnerWorkbenchError { return new PartnerWorkbenchError("WORKBENCH_TASK_NOT_FOUND", "The task is no longer available in this workbench scope."); }
function prompt(text: string): PromptInput { return { text, images: [], files: [], mentions: [], disposition: "prompt" }; }
function parseBackground(value: unknown): BackgroundRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid("The background task owner is invalid.");
  const row = value as Record<string, unknown>;
  if (row["version"] !== 1 || ["operationId", "partnerId", "parentSessionId", "project", "sourceTaskId", "title", "objective"].some((key) => typeof row[key] !== "string")
    || typeof row["requestedMessage"] !== "string" || !Number.isSafeInteger(row["parentSessionGeneration"])
    || !["adopt", "background"].includes(String(row["mode"])) || !Number.isSafeInteger(row["profileVersion"]) || !Number.isSafeInteger(row["createdAt"]) || !["preparing", "ready", "queued", "unknown", "failed"].includes(String(row["status"]))
    || row["sessionId"] !== undefined && typeof row["sessionId"] !== "string" || row["runId"] !== undefined && typeof row["runId"] !== "string") throw invalid("The background task owner is invalid.");
  return value as BackgroundRecord;
}
