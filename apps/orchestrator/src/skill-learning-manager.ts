import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { redactSecrets } from "@joko/core";
import { operationBodyHash, type ConnectionRecord, type OperationalStore } from "@joko/store";

import type { PiLearnedSkillPreview, PiMarketSkillDiffChange, PiResourceManager } from "./resource-manager.js";
import type { SessionHost } from "./session-host.js";
import {
  SkillMutationCoordinator,
  skillInstallSlotMutationKey,
  skillResourceMutationKey
} from "./skill-mutation-coordinator.js";
import type { SkillMarketEntryIdentity, SkillMarketManager } from "./skill-market-manager.js";

export type SkillLearningState = "collecting" | "distilling" | "awaiting_review" | "applied" | "discarded" | "failed" | "cancelled" | "expired";
export type SkillLearningSourceKind = "text" | "session" | "market";

export interface SkillLearningFile {
  readonly key: string;
  readonly content: string;
}

export interface SkillLearningProposal {
  readonly name: string;
  readonly description: string;
  readonly explanation: string;
  readonly revision: string;
  readonly files: readonly SkillLearningFile[];
  readonly resourceId: string;
  readonly currentResourceId?: string;
  readonly currentResourceVersion?: bigint;
  readonly currentObservedRevision?: string;
  readonly diffAvailable: boolean;
  readonly diffReason?: string;
  readonly changes: readonly PiMarketSkillDiffChange[];
  readonly diffTruncated: boolean;
}

export interface SkillLearningRun {
  readonly id: string;
  readonly revision: bigint;
  readonly state: SkillLearningState;
  readonly sourceKind: SkillLearningSourceKind;
  readonly backendId: string;
  readonly targetId: string;
  readonly sourceSessionId?: string;
  readonly distillationSessionId?: string;
  readonly summary: string;
  readonly error?: string;
  readonly proposal?: SkillLearningProposal;
  readonly appliedResourceId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
}

interface StoredProposal extends Omit<SkillLearningProposal, "files" | "currentResourceVersion"> {
  readonly currentResourceVersion?: string;
  readonly fileKeys: readonly string[];
  readonly generation: string;
}

interface StoredLearningRun extends Omit<SkillLearningRun, "revision" | "proposal"> {
  readonly format: 1;
  readonly revision: string;
  readonly requestDigest: string;
  readonly ownerConnectionId: string;
  readonly targetRevision: string;
  readonly modelRunId?: string;
  readonly processedRunId?: string;
  readonly proposal?: StoredProposal;
}

export interface StartSkillLearningInput {
  readonly requestId: string;
  readonly connection: ConnectionRecord;
  readonly targetId: string;
  readonly instruction: string;
  readonly sourceSessionId?: string;
  readonly marketIdentity?: SkillMarketEntryIdentity;
}

export interface ApplySkillLearningInput {
  readonly operationId: string;
  readonly connection: ConnectionRecord;
  readonly runId: string;
  readonly expectedRunRevision: bigint;
  readonly expectedProposalRevision: string;
  readonly expectedResourceId: string;
  readonly expectedCurrentResourceId?: string;
  readonly expectedCurrentResourceVersion?: bigint;
  readonly expectedCurrentObservedRevision?: string;
  readonly confirmReplace: boolean;
}

export interface SkillLearningManagerOptions {
  readonly store: OperationalStore;
  readonly sessions: SessionHost;
  readonly resources: PiResourceManager;
  readonly mutations: SkillMutationCoordinator;
  readonly market?: SkillMarketManager;
  readonly rootDirectory: string;
  readonly onResourceCommitted?: (backendId: string, resourceId: string, fence: symbol) => Promise<void>;
  readonly now?: () => number;
}

const SETTING_SCOPE = "skill-learning";
const RUN_ID = /^skill_learning_[a-f0-9]{32}$/u;
const REVISION = /^sha256:[a-f0-9]{64}$/u;
const MAX_INSTRUCTION = 4_000;
const MAX_EVIDENCE = 24_000;
const MAX_OUTPUT = 768 * 1024;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const REVIEW_TTL_MS = 7 * 24 * 60 * 60_000;
const SAFE_KEY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const DISTILLATION_INSTRUCTION = [
  "Create exactly one reusable Skill from the provided evidence.",
  "Return only a JSON object with name, description, explanation and files.",
  "files is an array of {path, content}; include SKILL.md with valid YAML frontmatter and any needed text references.",
  "Use portable relative file keys. Never include credentials, tokens, cookies, private keys, or machine-specific paths.",
  "On revision, return the complete revised JSON object, including every file. Do not install or modify any Skill yourself."
].join("\n");

/** Owns the independent durable learning run and its private, reviewable Skill proposal. */
export class SkillLearningManager {
  readonly #store: OperationalStore;
  readonly #sessions: SessionHost;
  readonly #resources: PiResourceManager;
  readonly #mutations: SkillMutationCoordinator;
  readonly #market?: SkillMarketManager;
  readonly #root: string;
  readonly #now: () => number;
  readonly #onResourceCommitted?: SkillLearningManagerOptions["onResourceCommitted"];
  #tail: Promise<void> = Promise.resolve();

  constructor(options: SkillLearningManagerOptions) {
    if (!isAbsolute(options.rootDirectory) || resolve(options.rootDirectory) !== options.rootDirectory) {
      throw new Error("Learning root must be a normalized absolute directory.");
    }
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#resources = options.resources;
    this.#mutations = options.mutations;
    this.#market = options.market;
    this.#root = options.rootDirectory;
    this.#now = options.now ?? Date.now;
    this.#onResourceCommitted = options.onResourceCommitted;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const retained = new Set<string>();
    for (const run of this.#storedRuns()) {
      if (run.state === "collecting" || run.state === "distilling") {
        this.#save(run, {
          state: "failed",
          error: "Learning was interrupted by a service restart. Return to the distillation task and revise the proposal.",
          processedRunId: run.modelRunId
        });
      } else if (run.state === "awaiting_review" && run.expiresAt <= this.#now()) {
        this.#save(run, { state: "expired", proposal: undefined });
      } else if (run.state === "awaiting_review" && run.proposal !== undefined) {
        retained.add(run.id);
      }
    }
    for (const name of await readdir(this.#root)) {
      if (!RUN_ID.test(name) || retained.has(name)) continue;
      await rm(join(this.#root, name), { recursive: true, force: true });
    }
  }

  async start(input: StartSkillLearningInput): Promise<SkillLearningRun> {
    return this.#serialize(async () => {
      const requestId = boundedRequestId(input.requestId);
      const target = this.#store.getTarget(input.targetId);
      const sourceKind: SkillLearningSourceKind = input.marketIdentity !== undefined ? "market"
        : input.sourceSessionId !== undefined ? "session" : "text";
      if (input.marketIdentity !== undefined && input.sourceSessionId !== undefined) {
        throw new Error("Learning may have only one evidence source.");
      }
      const instruction = safeEvidence(input.instruction, MAX_INSTRUCTION);
      if (sourceKind === "text" && instruction === "") throw new Error("A learning instruction is required.");
      const digest = sha(JSON.stringify({
        requestId, targetId: input.targetId, instruction,
        sourceSessionId: input.sourceSessionId ?? null,
        marketIdentity: input.marketIdentity === undefined ? null : {
          sourceId: input.marketIdentity.sourceId,
          sourceRevision: input.marketIdentity.sourceRevision.toString(10),
          entryId: input.marketIdentity.entryId,
          entryRevision: input.marketIdentity.entryRevision.toString(10),
          contentRevision: input.marketIdentity.contentRevision
        }
      }));
      const id = `skill_learning_${createHash("sha256").update(`${input.connection.id}\0${requestId}`).digest("hex").slice(0, 32)}`;
      const existing = this.#read(id);
      if (existing !== undefined) {
        if (existing.ownerConnectionId !== input.connection.id || existing.requestDigest !== digest) {
          throw new Error("Learning request ID was already used for a different request.");
        }
        return this.#public(existing);
      }
      if (this.#storedRuns().some((run) => run.state === "collecting" || run.state === "distilling")) {
        throw new Error("Another learning run is still collecting or distilling.");
      }
      if (target.descriptor.backendId.trim() === "") throw new Error("Learning Target has no Backend.");
      const now = this.#now();
      const summary = sourceKind === "text" ? instruction.slice(0, 160)
        : sourceKind === "session" ? "Learn from task" : "Learn from Skill catalog";
      const created: StoredLearningRun = {
        format: 1,
        id,
        revision: "1",
        requestDigest: digest,
        ownerConnectionId: input.connection.id,
        targetRevision: target.revision.toString(10),
        state: "collecting",
        sourceKind,
        backendId: target.descriptor.backendId,
        targetId: input.targetId,
        ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
        summary,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + REVIEW_TTL_MS
      };
      this.#store.transaction((store) => {
        store.authorizeConnection(input.connection.id, input.connection.authKeyDigest);
        store.setSetting("service", SETTING_SCOPE, id, created);
      });
      try {
        const evidence = await this.#collectEvidence(input, sourceKind, instruction);
        const createdSession = await this.#sessions.createServiceSession({
          operationId: `${id}_session`,
          serviceKind: "learning",
          targetId: input.targetId,
          title: `Learn Skill: ${summary.slice(0, 72)}`,
          fastMode: false,
          permissionMode: "ask",
          planMode: false,
          appendSystemPrompt: DISTILLATION_INSTRUCTION
        });
        const withSession = this.#save(created, {
          state: "distilling",
          distillationSessionId: createdSession.value.sessionId
        });
        const queued = this.#sessions.enqueueServiceInput({
          operationId: `${id}_input`,
          sessionId: createdSession.value.sessionId,
          source: "system",
          prompt: { text: learningPrompt(instruction, evidence), images: [], files: [], mentions: [], disposition: "prompt" }
        });
        return this.#public(this.#save(withSession, { modelRunId: queued.value.runId }));
      } catch {
        const current = this.#read(id)!;
        return this.#public(this.#save(current, {
          state: "failed",
          error: "Learning could not start. Check the Target and Backend, then start a new run."
        }));
      }
    });
  }

  async list(): Promise<readonly SkillLearningRun[]> {
    return this.#serialize(async () => {
      const runs = this.#storedRuns().sort((left, right) => right.createdAt - left.createdAt);
      const result: SkillLearningRun[] = [];
      for (const run of runs) result.push(await this.#public(await this.#reconcile(run)));
      return result;
    });
  }

  async get(runId: string): Promise<SkillLearningRun> {
    return this.#serialize(async () => this.#public(await this.#reconcile(this.#require(runId))));
  }

  async apply(input: ApplySkillLearningInput): Promise<SkillLearningRun> {
    return this.#serialize(async () => {
      const body = {
        runId: input.runId,
        expectedRunRevision: input.expectedRunRevision.toString(10),
        expectedProposalRevision: input.expectedProposalRevision,
        expectedResourceId: input.expectedResourceId,
        expectedCurrentResourceId: input.expectedCurrentResourceId ?? null,
        expectedCurrentResourceVersion: input.expectedCurrentResourceVersion?.toString(10) ?? null,
        expectedCurrentObservedRevision: input.expectedCurrentObservedRevision ?? null,
        confirmReplace: input.confirmReplace
      };
      const previous = this.#store.findOperation(input.operationId);
      if (previous !== undefined) {
        this.#store.authorizeConnection(input.connection.id, input.connection.authKeyDigest);
        if (previous.connectionId !== input.connection.id || previous.kind !== "apply_skill_learning"
          || previous.bodyHash !== operationBodyHash(body)) {
          throw new Error("Learning operation ID belongs to a different request.");
        }
        if (previous.status === "completed") return this.#public(this.#require(input.runId));
        throw new Error("The previous learning apply operation did not complete; inspect its Operation before retrying.");
      }
      const current = await this.#reconcile(this.#require(input.runId));
      assertReview(current, input.expectedRunRevision);
      const proposal = current.proposal!;
      if (proposal.revision !== input.expectedProposalRevision || proposal.resourceId !== input.expectedResourceId
        || proposal.currentResourceId !== input.expectedCurrentResourceId
        || (proposal.currentResourceVersion === undefined ? undefined : BigInt(proposal.currentResourceVersion)) !== input.expectedCurrentResourceVersion
        || proposal.currentObservedRevision !== input.expectedCurrentObservedRevision) {
        throw new Error("Learning proposal review fingerprint changed. Refresh before applying.");
      }
      const keys = [skillInstallSlotMutationKey({ backendId: current.backendId, scope: "global", name: proposal.name }),
        skillResourceMutationKey(proposal.resourceId),
        ...(proposal.currentResourceId === undefined || proposal.currentResourceId === proposal.resourceId
          ? [] : [skillResourceMutationKey(proposal.currentResourceId)])];
      const lease = this.#mutations.acquire(keys);
      if (lease === undefined) throw new Error("This Skill install slot is being changed by another operation.");
      let prepared: Awaited<ReturnType<PiResourceManager["prepareLearnedSkill"]>> | undefined;
      let fence: symbol | undefined;
      try {
        const execution = await this.#sessions.mutate<{ readonly runId: string; readonly resourceId: string }>({
          operationId: input.operationId,
          connection: input.connection,
          kind: "apply_skill_learning",
          body,
          precondition: (store) => {
            const live = this.#require(current.id, store);
            assertReview(live, input.expectedRunRevision);
            if (store.getTarget(live.targetId).revision.toString(10) !== live.targetRevision) {
              throw new Error("Learning Target changed after collection.");
            }
          },
          effect: async () => {
            lease.assertActive();
            prepared = await this.#resources.prepareLearnedSkill({
              runId: current.id,
              backendId: current.backendId,
              name: proposal.name,
              candidateRoot: this.#proposalRoot(current),
              approvedByConnectionId: input.connection.id,
              expectedCandidateRevision: proposal.revision,
              expectedResourceId: proposal.resourceId,
              ...(proposal.currentResourceId === undefined ? {} : { expectedCurrentResourceId: proposal.currentResourceId }),
              ...(proposal.currentResourceVersion === undefined ? {} : { expectedCurrentResourceVersion: BigInt(proposal.currentResourceVersion) }),
              ...(proposal.currentObservedRevision === undefined ? {} : { expectedCurrentObservedRevision: proposal.currentObservedRevision }),
              allowReplacement: input.confirmReplace
            });
          },
          complete: async (commit) => {
            if (prepared === undefined) throw new Error("Learning Resource preparation did not complete.");
            return this.#resources.completePreparedMutation(prepared.mutation, (finalize) => {
              lease.assertActive();
              const result = commit(finalize);
              fence = this.#sessions.fenceBackendResourceCatalogs(current.backendId);
              return result;
            });
          },
          commit: (store) => {
            const live = this.#require(current.id, store);
            const next = this.#save(live, {
              state: "applied",
              appliedResourceId: prepared!.mutation.value.id,
              proposal: undefined,
              error: undefined
            }, store);
            return { runId: next.id, resourceId: prepared!.mutation.value.id };
          }
        });
        if (!execution.replayed && fence !== undefined) {
          await this.#onResourceCommitted?.(current.backendId, execution.value.resourceId, fence).catch(() => undefined);
        }
        await this.#removeProposal(current).catch(() => undefined);
        return this.#public(this.#require(current.id));
      } finally {
        if (prepared !== undefined) await this.#resources.discardPreparedMutation(prepared.mutation).catch(() => undefined);
        lease.release();
      }
    });
  }

  async discard(connection: ConnectionRecord, operationId: string, runId: string, expectedRevision: bigint): Promise<SkillLearningRun> {
    return this.#serialize(async () => {
      const current = this.#require(runId);
      const execution = await this.#sessions.mutate({
        operationId,
        connection,
        kind: "discard_skill_learning",
        body: { runId, expectedRevision: expectedRevision.toString(10) },
        commit: (store) => {
          const live = this.#require(runId, store);
          assertReview(live, expectedRevision);
          return this.#save(live, { state: "discarded", proposal: undefined }, store).id;
        }
      });
      if (!execution.replayed) await this.#removeProposal(current).catch(() => undefined);
      return this.#public(this.#require(runId));
    });
  }

  async cancel(connection: ConnectionRecord, operationId: string, runId: string, expectedRevision: bigint): Promise<SkillLearningRun> {
    return this.#serialize(async () => {
      const execution = await this.#sessions.mutate({
        operationId,
        connection,
        kind: "cancel_skill_learning",
        body: { runId, expectedRevision: expectedRevision.toString(10) },
        commit: (store) => {
          const live = this.#require(runId, store);
          if (BigInt(live.revision) !== expectedRevision || (live.state !== "collecting" && live.state !== "distilling")) {
            throw new Error("Learning run is no longer cancellable.");
          }
          return this.#save(live, { state: "cancelled", proposal: undefined }, store).id;
        }
      });
      const current = this.#require(runId);
      if (!execution.replayed && current.distillationSessionId !== undefined && current.modelRunId !== undefined) {
        await this.#sessions.abort(current.distillationSessionId, current.modelRunId).catch(() => undefined);
      }
      return this.#public(current);
    });
  }

  async #collectEvidence(input: StartSkillLearningInput, sourceKind: SkillLearningSourceKind, instruction: string): Promise<string> {
    if (sourceKind === "text") return instruction;
    if (sourceKind === "session") {
      const source = this.#store.getSession(input.sourceSessionId!).descriptor;
      if (source.deletedAt !== undefined || source.targetId !== input.targetId) {
        throw new Error("The source task is unavailable on the selected Target.");
      }
      const excerpts = this.#store.listEvents({ sessionId: source.id, order: "desc", limit: 200 })
        .filter((event) => event.payload.type === "message_complete"
          && (event.payload.role === "assistant" || event.payload.role === "user"))
        .slice(0, 20)
        .reverse()
        .map((event) => {
          if (event.payload.type !== "message_complete") return "";
          const text = event.payload.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n");
          return `${event.payload.role}: ${safeEvidence(text, 2_000)}`;
        });
      return safeEvidence(excerpts.join("\n\n"), MAX_EVIDENCE);
    }
    const entry = this.#market?.getEntry(input.marketIdentity!);
    if (entry === undefined) throw new Error("Skill catalog evidence is unavailable.");
    const identity = input.marketIdentity!;
    const lease = await this.#market!.acquireEntry(identity);
    const temporary = join(this.#root, `market-${randomUUID().replaceAll("-", "")}`);
    try {
      const inspection = await lease.extractTo(temporary);
      const main = await readFile(join(inspection.canonicalPath, "SKILL.md"), "utf8");
      const references: string[] = [];
      for (const file of lease.archiveEntries) {
        if (file.kind !== "file" || file.key === "SKILL.md" || file.size > MAX_EVIDENCE) continue;
        const raw = await readFile(join(inspection.canonicalPath, ...file.key.split("/")));
        if (raw.byteLength > MAX_EVIDENCE) continue;
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        } catch {
          continue;
        }
        if (/[\u0000-\u0008\u000e-\u001f]/u.test(content)) continue;
        references.push(`<file path="${file.key}">\n${safeEvidence(content, MAX_EVIDENCE)}\n</file>`);
      }
      await lease.assertCurrent();
      return safeEvidence([
        `Catalog Skill: ${entry.name} (${entry.slug})`,
        `Description: ${entry.description}`,
        `Tags: ${entry.tags.join(", ")}`,
        main,
        ...references
      ].join("\n\n"), MAX_EVIDENCE);
    } finally {
      lease.release();
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #reconcile(run: StoredLearningRun): Promise<StoredLearningRun> {
    if (run.state === "awaiting_review" && run.expiresAt <= this.#now()) {
      const expired = this.#save(run, { state: "expired", proposal: undefined });
      await this.#removeProposal(run).catch(() => undefined);
      return expired;
    }
    if ((run.state !== "distilling" && run.state !== "awaiting_review" && run.state !== "failed") || run.distillationSessionId === undefined) return run;
    let modelRunId = run.modelRunId;
    if (run.state === "awaiting_review" || run.state === "failed") {
      const recent = this.#store.listRuns({ sessionId: run.distillationSessionId, limit: 20 });
      const latest = recent[0];
      if (latest === undefined || latest.descriptor.id === run.processedRunId) return run;
      const processedIndex = recent.findIndex((candidate) => candidate.descriptor.id === run.processedRunId);
      if (run.processedRunId !== undefined && processedIndex < 0) {
        const processed = this.#store.findRun(run.processedRunId)?.descriptor;
        if (processed === undefined || latest.descriptor.createdAt <= processed.createdAt) return run;
      }
      modelRunId = latest.descriptor.id;
      run = this.#save(run, { state: "distilling", modelRunId });
    }
    if (modelRunId === undefined) return run;
    const modelRun = this.#store.findRun(modelRunId)?.descriptor;
    if (modelRun === undefined || modelRun.state === "queued" || modelRun.state === "running"
      || modelRun.state === "waiting" || modelRun.state === "retrying") return run;
    if (modelRun.state !== "completed") {
      return this.#save(run, {
        state: run.proposal === undefined ? "failed" : "awaiting_review",
        error: "The distillation task did not complete. Return to it and try a revision.",
        processedRunId: modelRunId
      });
    }
    try {
      const output = this.#assistantText(run.distillationSessionId!, modelRunId);
      const candidate = parseCandidate(output);
      const staged = await this.#stage(run, candidate);
      const updated = this.#save(run, {
        state: "awaiting_review",
        proposal: staged,
        error: undefined,
        processedRunId: modelRunId
      });
      if (run.proposal?.generation !== staged.generation) await this.#removeGeneration(run).catch(() => undefined);
      return updated;
    } catch {
      return this.#save(run, {
        state: run.proposal === undefined ? "failed" : "awaiting_review",
        error: "The distillation response is not one valid Skill proposal. Revise the task and return here.",
        processedRunId: modelRunId
      });
    }
  }

  #assistantText(sessionId: string, runId: string): string {
    let beforeCursor: bigint | undefined;
    for (;;) {
      const page = this.#store.listEvents({ sessionId, order: "desc", limit: 1_000,
        ...(beforeCursor === undefined ? {} : { beforeCursor }) });
      const event = page.find((entry) => entry.runId === runId && entry.payload.type === "message_complete"
        && entry.payload.role === "assistant");
      if (event !== undefined && event.payload.type === "message_complete") {
        const text = event.payload.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n");
        if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT) throw new Error("Learning response exceeds the output budget.");
        return text;
      }
      if (page.length < 1_000) throw new Error("Distillation task produced no complete text response.");
      beforeCursor = page.at(-1)!.globalCursor;
    }
  }

  async #stage(run: StoredLearningRun, candidate: ParsedCandidate): Promise<StoredProposal> {
    const digest = sha(JSON.stringify(candidate));
    const generation = digest.slice(7);
    const parent = join(this.#root, run.id);
    const temporary = join(parent, `.stage-${randomUUID().replaceAll("-", "")}`);
    const destination = join(parent, generation);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await mkdir(temporary, { recursive: false, mode: 0o700 });
    let published = false;
    try {
      for (const file of candidate.files) {
        const path = join(temporary, ...file.key.split("/"));
        await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
        await writeFile(path, file.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      }
      try {
        await rename(temporary, destination);
        published = true;
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await rm(temporary, { recursive: true, force: true });
      }
      const preview = await this.#resources.previewLearnedSkill({
        runId: run.id, backendId: run.backendId, name: candidate.name, candidateRoot: destination
      });
      return proposalFromPreview(candidate, preview, generation);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      if (published) await rm(destination, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #public(run: StoredLearningRun): Promise<SkillLearningRun> {
    let proposal: SkillLearningProposal | undefined;
    if (run.proposal !== undefined && (run.state === "awaiting_review" || run.state === "distilling")) {
      const root = this.#proposalRoot(run);
      const files: SkillLearningFile[] = [];
      for (const key of run.proposal.fileKeys) {
        const path = join(root, ...key.split("/"));
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
          throw new Error("Learning proposal file changed outside the review boundary.");
        }
        files.push({ key, content: await readFile(path, "utf8") });
      }
      const digest = sha(JSON.stringify({
        name: run.proposal.name,
        description: run.proposal.description,
        explanation: run.proposal.explanation,
        files
      }));
      if (digest.slice(7) !== run.proposal.generation) {
        throw new Error("Learning proposal content changed outside review.");
      }
      const { fileKeys: _fileKeys, generation: _generation, currentResourceVersion, ...meta } = run.proposal;
      proposal = {
        ...meta,
        ...(currentResourceVersion === undefined ? {} : { currentResourceVersion: BigInt(currentResourceVersion) }),
        files
      };
    }
    return {
      id: run.id,
      revision: BigInt(run.revision),
      state: run.state,
      sourceKind: run.sourceKind,
      backendId: run.backendId,
      targetId: run.targetId,
      ...(run.sourceSessionId === undefined ? {} : { sourceSessionId: run.sourceSessionId }),
      ...(run.distillationSessionId === undefined ? {} : { distillationSessionId: run.distillationSessionId }),
      summary: run.summary,
      ...(run.error === undefined ? {} : { error: run.error }),
      ...(proposal === undefined ? {} : { proposal }),
      ...(run.appliedResourceId === undefined ? {} : { appliedResourceId: run.appliedResourceId }),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      expiresAt: run.expiresAt
    };
  }

  #proposalRoot(run: StoredLearningRun): string {
    if (run.proposal === undefined || !/^[a-f0-9]{64}$/u.test(run.proposal.generation)) {
      throw new Error("Learning proposal generation is unavailable.");
    }
    return join(this.#root, run.id, run.proposal.generation);
  }

  async #removeGeneration(run: StoredLearningRun): Promise<void> {
    if (run.proposal !== undefined) await rm(this.#proposalRoot(run), { recursive: true, force: true });
  }

  async #removeProposal(run: StoredLearningRun): Promise<void> {
    await rm(join(this.#root, run.id), { recursive: true, force: true });
  }

  #storedRuns(): StoredLearningRun[] {
    return this.#store.listSettings("service", SETTING_SCOPE).map((setting) => validateStoredRun(setting.value));
  }

  #read(id: string, store = this.#store): StoredLearningRun | undefined {
    if (!RUN_ID.test(id)) throw new Error("Learning run ID is invalid.");
    const value = store.findSetting("service", SETTING_SCOPE, id)?.value;
    return value === undefined ? undefined : validateStoredRun(value);
  }

  #require(id: string, store = this.#store): StoredLearningRun {
    const run = this.#read(id, store);
    if (run === undefined) throw new Error("Learning run was not found.");
    return run;
  }

  #save(current: StoredLearningRun, patch: Partial<StoredLearningRun>, store = this.#store): StoredLearningRun {
    return store.transaction((transaction) => {
      const live = this.#require(current.id, transaction);
      if (live.revision !== current.revision) throw new Error("Learning run changed concurrently.");
      const next = validateStoredRun(Object.fromEntries(Object.entries({
        ...live,
        ...patch,
        revision: (BigInt(live.revision) + 1n).toString(10),
        updatedAt: this.#now()
      }).filter(([, value]) => value !== undefined)));
      transaction.setSetting("service", SETTING_SCOPE, current.id, next);
      return next;
    });
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const execution = this.#tail.then(task, task);
    this.#tail = execution.then(() => undefined, () => undefined);
    return execution;
  }
}

interface ParsedCandidate {
  readonly name: string;
  readonly description: string;
  readonly explanation: string;
  readonly files: readonly SkillLearningFile[];
}

function parseCandidate(output: string): ParsedCandidate {
  const trimmed = output.trim();
  const raw = trimmed.startsWith("```json") && trimmed.endsWith("```")
    ? trimmed.slice(7, -3).trim() : trimmed;
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT) throw new Error("Learning output is too large.");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Learning output must be an object.");
  const name = String(value["name"] ?? "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 100) throw new Error("Learning Skill name is invalid.");
  const description = safeEvidence(String(value["description"] ?? ""), 4_000);
  const explanation = safeEvidence(String(value["explanation"] ?? ""), 12_000);
  const rawFiles = value["files"];
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_FILES) {
    throw new Error("Learning proposal must contain a bounded file list.");
  }
  let total = 0;
  const keys = new Set<string>();
  const files = rawFiles.map((rawFile): SkillLearningFile => {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) throw new Error("Learning file is invalid.");
    const record = rawFile as Record<string, unknown>;
    const key = portableFileKey(record["path"]);
    if (keys.has(key.toLocaleLowerCase("en-US"))) throw new Error("Learning file key is duplicated.");
    keys.add(key.toLocaleLowerCase("en-US"));
    if (typeof record["content"] !== "string") throw new Error("Learning file content must be text.");
    if (Buffer.byteLength(record["content"], "utf8") > MAX_FILE_BYTES) {
      throw new Error("Learning file exceeds the byte budget.");
    }
    const content = redactPrivateText(record["content"]);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error("Learning file exceeds the byte budget.");
    total += bytes;
    if (total > MAX_TOTAL_BYTES) throw new Error("Learning proposal exceeds the byte budget.");
    return { key, content };
  });
  if (!keys.has("skill.md")) throw new Error("Learning proposal has no SKILL.md.");
  return { name, description, explanation, files };
}

function portableFileKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\\") || value.startsWith("/")) {
    throw new Error("Learning file key is invalid.");
  }
  const parts = value.split("/");
  if (parts.length > 16 || parts.some((part) => !SAFE_KEY_PART.test(part) || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error("Learning file key is not portable.");
  }
  return value;
}

function proposalFromPreview(candidate: ParsedCandidate, preview: PiLearnedSkillPreview, generation: string): StoredProposal {
  return {
    name: candidate.name,
    description: candidate.description,
    explanation: candidate.explanation,
    revision: preview.candidateRevision,
    fileKeys: candidate.files.map((file) => file.key),
    generation,
    resourceId: preview.resourceId,
    ...(preview.currentResource === undefined ? {} : {
      currentResourceId: preview.currentResource.resourceId,
      currentResourceVersion: preview.currentResource.resourceVersion.toString(10),
      currentObservedRevision: preview.currentResource.observedRevision
    }),
    diffAvailable: preview.diffAvailable,
    ...(preview.diffReason === undefined ? {} : { diffReason: preview.diffReason }),
    changes: preview.changes.map((change) => ({
      ...change,
      ...(change.unifiedDiff === undefined ? {} : { unifiedDiff: redactPrivateText(change.unifiedDiff) })
    })),
    diffTruncated: preview.diffTruncated
  };
}

function validateStoredRun(value: unknown): StoredLearningRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored learning run is malformed.");
  const run = value as StoredLearningRun;
  if (run.format !== 1 || !RUN_ID.test(run.id) || !/^[1-9]\d*$/u.test(run.revision)
    || !REVISION.test(run.requestDigest) || !/^[1-9]\d*$/u.test(run.targetRevision)
    || !["collecting", "distilling", "awaiting_review", "applied", "discarded", "failed", "cancelled", "expired"].includes(run.state)
    || !["text", "session", "market"].includes(run.sourceKind)
    || typeof run.backendId !== "string" || run.backendId === ""
    || typeof run.targetId !== "string" || run.targetId === ""
    || typeof run.ownerConnectionId !== "string" || run.ownerConnectionId === ""
    || typeof run.summary !== "string" || run.summary.length > 160
    || !Number.isSafeInteger(run.createdAt) || !Number.isSafeInteger(run.updatedAt)
    || !Number.isSafeInteger(run.expiresAt)) throw new Error("Stored learning run is malformed.");
  if (run.proposal !== undefined && (run.proposal === null || !REVISION.test(run.proposal.revision)
    || !/^[a-f0-9]{64}$/u.test(run.proposal.generation)
    || !Array.isArray(run.proposal.fileKeys)
    || run.proposal.fileKeys.some((key) => portableFileKey(key) !== key))) {
    throw new Error("Stored learning proposal is malformed.");
  }
  return run;
}

function assertReview(run: StoredLearningRun, expectedRevision: bigint): void {
  if (run.state !== "awaiting_review" || run.proposal === undefined || BigInt(run.revision) !== expectedRevision) {
    throw new Error("Learning proposal changed. Refresh it before review.");
  }
}

function boundedRequestId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id) || id !== value) throw new Error("Learning request ID is invalid.");
  return id;
}

function learningPrompt(instruction: string, evidence: string): string {
  return ["<learning_request>", instruction || "Create a reusable Skill from the evidence.", "</learning_request>",
    "<bounded_evidence>", evidence, "</bounded_evidence>", DISTILLATION_INSTRUCTION].join("\n\n");
}

function safeEvidence(value: string, maximum: number): string {
  return redactPrivateText(value).slice(0, maximum).trim();
}

function redactPrivateText(value: string): string {
  const text = redactSecrets(value);
  const urls: string[] = [];
  const masked = text.replace(/\b(?:https?|ssh):\/\/[^\s"'<>|]+/giu, (url) => {
    try {
      const parsed = new URL(url);
      urls.push(parsed.username || parsed.password ? "<url>" : `${parsed.origin}${parsed.pathname}`);
    } catch {
      urls.push("<url>");
    }
    return `\0URL${urls.length - 1}\0`;
  });
  return masked.replace(/[A-Za-z]:\\[^\s"'<>|]*/gu, "<path>")
    .replace(/\\\\[^\s"'<>|]+/gu, "<path>")
    .replace(/\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]*/gu, "<path>")
    .replace(/~\/[^\s"'<>|]*/gu, "<path>")
    .replace(/\0URL(\d+)\0/gu, (_match, index: string) => urls[Number(index)] ?? "<url>");
}

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
