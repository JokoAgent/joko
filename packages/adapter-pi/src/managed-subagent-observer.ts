import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  AdapterContext,
  InteractionDecision,
  PublicError,
  SubagentActivityEntry,
  SubagentControlAction,
  SubagentRunDetail,
  SubagentRunState,
  SubagentTranscriptEntry,
  SubagentUsage
} from "@joko/core";
import { evaluateOrderedPolicyRules } from "@joko/core";
import type { CommandConcurrencyGate } from "@joko/runtime-governance";

import { handleCommandGateExtensionRequest } from "./command-gate-bridge.js";
import { handlePolicyDecisionExtensionRequest } from "./policy-decision-bridge.js";
import { redactManagedSecrets } from "./errors.js";
import { managedSubagentSessionKey } from "./durable-subagent-runs.js";
import type { PiManagedDurableRunSnapshot, PiManagedDurableStore } from "./managed-durable-store.js";

const FORMAT = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TERMINAL_STATES = new Set(["completed", "failed", "aborted"]);
const MAX_JSON_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
// The runner accepts up to 50 MiB and may still append one final bounded
// truncation marker. Keep the reader aligned with that durable format.
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024 + 4_096;
const MAX_TRANSCRIPT_CONTENT_BYTES = 256 * 1024;
const MAX_TOOL_INPUT_BYTES = 64 * 1024;
const RUNNER_HEARTBEAT_STALE_MS = 10_000;
const DEFAULT_INTERVAL_MS = 500;
const MAXIMUM_RETRY_INTERVAL_MS = 30_000;
const REMOTE_SCAN_LIMIT_BYTES = 1024 * 1024;
const REMOTE_READ_CHUNK_BYTES = 256 * 1024;

interface PhysicalRun {
  readonly runId: string;
  readonly directory: string;
  readonly durableRevision?: string;
  readonly durableControlRevision?: string;
  readonly durableTranscriptRevision?: string;
  readonly durableResultRevision?: string;
  readonly config: Record<string, unknown>;
  readonly status: Record<string, unknown>;
  readonly result?: Record<string, unknown>;
  readonly transcript: readonly Record<string, unknown>[];
  readonly resumeSafe: boolean;
  readonly controlSafe: boolean;
}

interface LogicalProjection {
  readonly taskId: string;
  readonly run: SubagentRunDetail;
  readonly transcript: readonly SubagentTranscriptEntry[];
  readonly latest: PhysicalRun;
}

interface DurableProjectionState {
  revision?: string;
  projections: readonly LogicalProjection[];
  retryAfterMs: number;
}

interface DeliveryJournal {
  readonly format: 1;
  readonly productSessionId: string;
  readonly productGeneration: number;
  readonly taskId: string;
  readonly runFingerprint?: string;
  readonly deliveredSequence: number;
  readonly approval?: ApprovalDelivery;
}

interface ApprovalResponse {
  readonly confirmed?: boolean;
  readonly value?: string;
  readonly cancelled?: true;
}

interface ApprovalDelivery {
  readonly runId: string;
  readonly childId: string;
  readonly approvalId: string;
  readonly interactionId: string;
  readonly requestId: string;
  readonly decidedAt: number;
  readonly response: ApprovalResponse;
}

interface PendingApproval {
  readonly id: string;
  readonly childId: string;
  readonly method: "confirm" | "input";
  readonly title: string;
  readonly message?: string;
  readonly placeholder?: string;
}

export interface ManagedSubagentObserverOptions {
  readonly root: string;
  readonly journalRoot?: string;
  readonly durableStore?: PiManagedDurableStore;
  readonly context: AdapterContext;
  readonly policyGeneration?: number;
  readonly redactValues?: readonly string[];
  readonly intervalMs?: number;
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
}

/**
 * Projects private detached-run artifacts through the AdapterContext event
 * boundary. A small non-secret delivery journal prevents ordinary Pi runtime
 * detach/restart cycles from replaying already persisted transcript entries.
 */
export class ManagedSubagentObserver {
  readonly #root: string;
  readonly #journalRoot: string;
  readonly #durableStore: PiManagedDurableStore | undefined;
  #context: AdapterContext;
  #policyGeneration: number;
  #redactValues: readonly string[];
  readonly #intervalMs: number;
  readonly #commandConcurrencyGate: CommandConcurrencyGate | undefined;
  readonly #journals = new Map<string, DeliveryJournal>();
  readonly #transcriptCache = new Map<string, { readonly size: number; readonly records: readonly Record<string, unknown>[] }>();
  readonly #resultCache = new Map<string, { readonly size: number; readonly result: Readonly<Record<string, unknown>> }>();
  readonly #controlRevisions = new Map<string, { readonly snapshotRevision: string; readonly currentRevision: string }>();
  readonly #durableProjectionState: DurableProjectionState = {
    projections: [],
    retryAfterMs: DEFAULT_INTERVAL_MS
  };
  #timer: NodeJS.Timeout | undefined;
  #refreshing: Promise<number> | undefined;
  #consecutiveFailures = 0;
  #failureVisible = false;
  #stopped = false;

  constructor(options: ManagedSubagentObserverOptions) {
    this.#root = normalizedRoot(options.root);
    this.#journalRoot = normalizedRoot(options.journalRoot ?? options.root);
    this.#durableStore = options.durableStore;
    this.#context = options.context;
    this.#policyGeneration = options.policyGeneration ?? 0;
    this.#redactValues = options.redactValues ?? [];
    this.#intervalMs = Math.max(100, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.#commandConcurrencyGate = options.commandConcurrencyGate;
  }

  get sessionId(): string {
    return this.#context.sessionId;
  }

  get generation(): number {
    return this.#context.generation;
  }

  get durableStore(): PiManagedDurableStore | undefined {
    return this.#durableStore;
  }

  update(context: AdapterContext, redactValues: readonly string[], policyGeneration = this.#policyGeneration): void {
    if (context.sessionId !== this.#context.sessionId || context.generation !== this.#context.generation) {
      throw new Error("managed Subagent observer ownership changed");
    }
    if (!Number.isSafeInteger(policyGeneration) || policyGeneration < 0) {
      throw new Error("managed Subagent observer policy generation is invalid");
    }
    this.#context = context;
    this.#policyGeneration = policyGeneration;
    this.#redactValues = redactValues;
  }

  start(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.#refreshing?.catch(() => undefined);
  }

  async refresh(): Promise<number> {
    if (this.#stopped) return 0;
    if (this.#refreshing !== undefined) return this.#refreshing;
    const refresh = this.#refreshOnce().finally(() => {
      if (this.#refreshing === refresh) this.#refreshing = undefined;
    });
    this.#refreshing = refresh;
    return refresh;
  }

  async #refreshOnce(): Promise<number> {
    const projections = await readLogicalProjections(
      this.#root,
      this.#context.sessionId,
      this.#context.generation,
      this.#context.runtimePolicy !== "review_read_only",
      this.#redactValues,
      this.#transcriptCache,
      this.#durableStore,
      this.#resultCache,
      this.#durableProjectionState
    );
    for (const projection of projections) {
      await this.#processApproval(projection);
      await this.#publish(projection);
    }
    return projections.filter((projection) =>
      projection.run.state === "queued" || projection.run.state === "running"
    ).length;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#poll();
    }, Math.max(0, delayMs));
    this.#timer.unref?.();
  }

  async #poll(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.refresh();
      this.#consecutiveFailures = 0;
      if (this.#failureVisible) {
        this.#failureVisible = false;
        await this.#context.emit({ type: "status", key: "subagent-observation" }).catch(() => undefined);
      }
    } catch {
      this.#consecutiveFailures = Math.min(16, this.#consecutiveFailures + 1);
      if (!this.#failureVisible) {
        this.#failureVisible = true;
        await this.#context.emit({
          type: "status",
          key: "subagent-observation",
          text: "Delegated-run updates are temporarily unavailable."
        }).catch(() => undefined);
      }
    } finally {
      const multiplier = 2 ** Math.min(6, this.#consecutiveFailures);
      this.#schedule(Math.min(
        MAXIMUM_RETRY_INTERVAL_MS,
        Math.max(this.#durableProjectionState.retryAfterMs, this.#intervalMs * multiplier)
      ));
    }
  }

  async #processApproval(projection: LogicalProjection): Promise<void> {
    if (this.#stopped) return;
    const pending = pendingApprovalOf(projection, this.#redactValues);
    if (pending === undefined) return;
    const journal = await this.#journal(projection.taskId);
    const launchGeneration = requiredGeneration(projection.latest.config["productGeneration"]);
    const interactionId = approvalInteractionId(
      this.#context.sessionId,
      launchGeneration,
      projection.latest.runId,
      pending.childId,
      pending.id
    );
    const retained = journal.approval;
    if (retained !== undefined && retained.runId === projection.latest.runId
        && retained.childId === pending.childId && retained.approvalId === pending.id
        && retained.interactionId === interactionId) {
      await this.#writeApprovalControl(projection, pending, retained);
      return;
    }

    if (pending.method === "input") {
      let delivered: ApprovalDelivery | undefined;
      const observer = this;
      const extensionEvent = {
        type: "extension_ui_request",
        id: pending.id,
        method: pending.method,
        title: pending.title,
        placeholder: pending.placeholder ?? ""
      } as const;
      const extensionTransport = {
        get closed() { return observer.#stopped; },
        async notify(message: { readonly value: string } | { readonly cancelled: true }) {
          delivered = observer.#approvalDelivery(
            projection,
            pending,
            interactionId,
            "value" in message ? { value: message.value } : { cancelled: true }
          );
        }
      };
      let handled = await handleCommandGateExtensionRequest(extensionEvent, {
        gate: this.#commandConcurrencyGate,
        sessionId: this.#context.sessionId,
        generation: this.#context.generation,
        signal: this.#context.signal,
        transport: extensionTransport,
        isCurrent: () => !this.#stopped
          && this.#context.sessionId === projection.run.sessionId
          && this.#context.generation >= launchGeneration
      }).catch(() => false);
      if (!handled) {
        handled = await handlePolicyDecisionExtensionRequest(extensionEvent, {
          decide: async (request) => {
            if (request.policyGeneration !== this.#policyGeneration) return "stale";
            const snapshot = this.#context.policySnapshot;
            return snapshot === undefined
              ? "default"
              : evaluateOrderedPolicyRules(snapshot, request.observation)?.action ?? "default";
          },
          transport: extensionTransport,
          isCurrent: () => !this.#stopped
            && this.#context.sessionId === projection.run.sessionId
            && this.#context.generation >= launchGeneration
        }).catch(() => false);
      }
      if (!handled || delivered === undefined) {
        delivered = this.#approvalDelivery(projection, pending, interactionId, { cancelled: true });
      }
      await this.#retainAndWriteApproval(journal, projection, pending, delivered);
      return;
    }

    let decision: InteractionDecision = { kind: "confirmed", confirmed: false };
    try {
      decision = await decisionOrCancellation(this.#context.requestInteraction({
        id: interactionId,
        kind: "permission",
        title: `Allow delegated Pi tool: ${permissionToolName(pending.title)}`,
        toolName: permissionToolName(pending.title),
        summary: pending.message ?? "",
        risk: "high",
        choices: ["allow_once", "deny"]
      }), this.#context.signal);
    } catch {
      decision = { kind: "confirmed", confirmed: false };
    }
    const confirmed = decision.kind === "confirmed"
      ? decision.confirmed
      : decision.kind === "selected" && (decision.value === "allow_once" || decision.value === "yes");
    const delivery = this.#approvalDelivery(projection, pending, interactionId, { confirmed });
    await this.#retainAndWriteApproval(journal, projection, pending, delivery);
  }

  #approvalDelivery(
    projection: LogicalProjection,
    pending: PendingApproval,
    interactionId: string,
    response: ApprovalResponse
  ): ApprovalDelivery {
    return {
      runId: projection.latest.runId,
      childId: pending.childId,
      approvalId: pending.id,
      interactionId,
      requestId: deterministicUuid(`${interactionId}\u0000${pending.id}`),
      decidedAt: Date.now(),
      response
    };
  }

  async #retainAndWriteApproval(
    journal: DeliveryJournal,
    projection: LogicalProjection,
    pending: PendingApproval,
    delivery: ApprovalDelivery
  ): Promise<void> {
    await this.#writeJournal({ ...journal, productGeneration: this.#context.generation, approval: delivery });
    await this.#writeApprovalControl(projection, pending, delivery);
  }

  async #writeApprovalControl(
    projection: LogicalProjection,
    pending: PendingApproval,
    delivery: ApprovalDelivery
  ): Promise<void> {
    if (this.#stopped || delivery.runId !== projection.latest.runId || delivery.childId !== pending.childId
        || delivery.approvalId !== pending.id) return;
    const config = projection.latest.config;
    const value = {
      format: FORMAT,
      requestId: delivery.requestId,
      runId: projection.latest.runId,
      launchToken: requiredString(config["launchToken"], 64),
      productSessionId: this.#context.sessionId,
      productGeneration: requiredGeneration(config["productGeneration"]),
      taskId: projection.taskId,
      childId: pending.childId,
      approvalId: pending.id,
      action: "approval",
      ...delivery.response,
      requestedAt: delivery.decidedAt
    } as const;
    if (this.#durableStore !== undefined) {
      const snapshotRevision = requiredRevision(projection.latest.durableControlRevision);
      const retainedRevision = this.#controlRevisions.get(projection.latest.runId);
      const expectedRevision = retainedRevision?.snapshotRevision === snapshotRevision
        ? retainedRevision.currentRevision
        : snapshotRevision;
      const result = await this.#durableStore.writeControl({
        sessionId: this.#context.sessionId,
        runId: projection.latest.runId,
        runnerInstanceId: requiredUuid(projection.latest.status["runnerInstanceId"], "runner instance"),
        launchToken: requiredUuid(config["launchToken"], "launch token"),
        runnerScriptSha256: requiredDigest(config["runnerScriptSha256"], "runner script"),
        expectedControlRevision: expectedRevision,
        kind: "approval",
        value
      });
      const revision = requiredRevision(result.controlRevision);
      if (typeof result.receipt !== "string" || !/^[0-9a-f]{64}$/u.test(result.receipt)) {
        throw new Error("managed Subagent durable control receipt is invalid");
      }
      this.#controlRevisions.set(projection.latest.runId, {
        snapshotRevision,
        currentRevision: revision
      });
      return;
    }
    await atomicWriteJson(join(projection.latest.directory, "approval-control.json"), value);
  }

  async #publish(projection: LogicalProjection): Promise<void> {
    if (this.#stopped) return;
    const journal = await this.#journal(projection.taskId);
    if (journal.deliveredSequence > projection.transcript.length) {
      throw new Error("managed Subagent transcript delivery cursor exceeds its validated source");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(projection.run)).digest("hex");
    const pending = projection.transcript.filter((entry) => entry.sequence > journal.deliveredSequence);
    if (journal.runFingerprint === fingerprint && pending.length === 0) return;

    let delivered = journal;
    if (journal.runFingerprint !== fingerprint
        || journal.productGeneration !== this.#context.generation && pending.length > 0) {
      await this.#context.emit(
        { type: "subagent_run", run: projection.run },
        observationMetadata(projection, "run")
      );
      delivered = {
        ...journal,
        productGeneration: this.#context.generation,
        runFingerprint: fingerprint
      };
      await this.#writeJournal(delivered);
    }
    if (this.#stopped) return;
    for (const entry of pending) {
      if (this.#stopped) return;
      await this.#context.emit(
        { type: "subagent_transcript", subagentRunId: projection.run.id, entry },
        observationMetadata(projection, "transcript")
      );
      delivered = { ...delivered, deliveredSequence: entry.sequence };
      await this.#writeJournal(delivered);
    }
  }

  async #journal(taskId: string): Promise<DeliveryJournal> {
    const cached = this.#journals.get(taskId);
    if (cached !== undefined) return cached;
    const path = await this.#journalPath(taskId);
    const parsed = await readBoundedJson(path, MAX_JSON_BYTES).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const journal = isDeliveryJournal(parsed, this.#context.sessionId, this.#context.generation, taskId)
      ? parsed
      : {
          format: FORMAT,
          productSessionId: this.#context.sessionId,
          productGeneration: this.#context.generation,
          taskId,
          deliveredSequence: 0
        } satisfies DeliveryJournal;
    if (parsed !== undefined && !isDeliveryJournal(parsed, this.#context.sessionId, this.#context.generation, taskId)) {
      throw new Error("managed Subagent delivery journal failed ownership validation");
    }
    this.#journals.set(taskId, journal);
    return journal;
  }

  async #writeJournal(journal: DeliveryJournal): Promise<void> {
    const path = await this.#journalPath(journal.taskId);
    await atomicWriteJson(path, journal);
    this.#journals.set(journal.taskId, journal);
  }

  async #journalPath(taskId: string): Promise<string> {
    await ensurePrivateDirectory(this.#journalRoot);
    const sessionDirectory = join(this.#journalRoot, managedSubagentSessionKey(this.#context.sessionId));
    const observationDirectory = join(sessionDirectory, "observations");
    await mkdir(sessionDirectory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const sessionInfo = await lstat(sessionDirectory);
    if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink() || !samePath(await realpath(sessionDirectory), sessionDirectory)) {
      throw new Error("managed Subagent observation Session root is unsafe");
    }
    await chmod(sessionDirectory, 0o700);
    await mkdir(observationDirectory, { recursive: false, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const observationInfo = await lstat(observationDirectory);
    if (!observationInfo.isDirectory() || observationInfo.isSymbolicLink()
        || !samePath(await realpath(observationDirectory), observationDirectory)) {
      throw new Error("managed Subagent observation directory contains a path alias");
    }
    await chmod(observationDirectory, 0o700);
    const taskKey = createHash("sha256").update(taskId).digest("hex").slice(0, 40);
    return join(observationDirectory, `${taskKey}.json`);
  }
}

export async function assertManagedSubagentControlTarget(input: {
  readonly root: string;
  readonly durableStore?: PiManagedDurableStore;
  readonly productSessionId: string;
  readonly productGeneration: number;
  readonly runId: string;
  readonly childId?: string;
  readonly action: SubagentControlAction;
}): Promise<void> {
  const projections = await readLogicalProjections(
    normalizedRoot(input.root),
    input.productSessionId,
    input.productGeneration,
    true,
    [],
    new Map(),
    input.durableStore,
    new Map(),
    input.durableStore === undefined
      ? undefined
      : { projections: [], retryAfterMs: DEFAULT_INTERVAL_MS }
  );
  assertOwnedManagedSubagentControlTarget(projections, input);
}

export async function writeManagedSubagentDurableControl(input: {
  readonly root: string;
  readonly durableStore: PiManagedDurableStore;
  readonly productSessionId: string;
  readonly productGeneration: number;
  readonly runId: string;
  readonly childId?: string;
  readonly action: Exclude<SubagentControlAction, "resume">;
  readonly message?: string;
  readonly operationId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<void> {
  const transcriptCache = new Map<string, { readonly size: number; readonly records: readonly Record<string, unknown>[] }>();
  const resultCache = new Map<string, { readonly size: number; readonly result: Readonly<Record<string, unknown>> }>();
  const durableState: DurableProjectionState = { projections: [], retryAfterMs: DEFAULT_INTERVAL_MS };
  const read = (): Promise<readonly LogicalProjection[]> => readLogicalProjections(
    normalizedRoot(input.root),
    input.productSessionId,
    input.productGeneration,
    true,
    [],
    transcriptCache,
    input.durableStore,
    resultCache,
    durableState
  );
  let projections = await read();
  let projection = assertOwnedManagedSubagentControlTarget(projections, input);
  const requestSeed = input.operationId === undefined
    ? randomUUID()
    : [
        input.operationId,
        input.productSessionId,
        String(input.productGeneration),
        input.runId,
        input.childId ?? "",
        input.action,
        input.message ?? ""
      ].join("\u0000");
  const requestId = input.operationId === undefined ? requestSeed : deterministicUuid(requestSeed);
  const prior = managedControlReceipt(projection.latest.status, requestId);
  if (prior === true) return;
  if (prior === false) throw new Error("managed Subagent runner rejected the durable control request");
  const config = projection.latest.config;
  const result = await input.durableStore.writeControl({
    sessionId: input.productSessionId,
    runId: projection.latest.runId,
    runnerInstanceId: requiredUuid(projection.latest.status["runnerInstanceId"], "runner instance"),
    launchToken: requiredUuid(config["launchToken"], "launch token"),
    runnerScriptSha256: requiredDigest(config["runnerScriptSha256"], "runner script"),
    expectedControlRevision: requiredRevision(projection.latest.durableControlRevision),
    kind: "control",
    value: {
      format: FORMAT,
      requestId,
      runId: projection.latest.runId,
      launchToken: requiredUuid(config["launchToken"], "launch token"),
      productSessionId: input.productSessionId,
      productGeneration: requiredGeneration(config["productGeneration"]),
      taskId: projection.taskId,
      action: input.action,
      ...(input.message === undefined ? {} : { message: input.message }),
      requestedAt: Date.now()
    }
  });
  requiredRevision(result.controlRevision);
  if (typeof result.receipt !== "string" || !/^[0-9a-f]{64}$/u.test(result.receipt)) {
    throw new Error("managed Subagent durable control receipt is invalid");
  }

  const deadline = Date.now() + Math.max(1_000, input.timeoutMs ?? 15_000);
  for (;;) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("managed Subagent control was cancelled");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("managed Subagent durable control was not confirmed before the deadline");
    await abortableDelay(Math.min(remaining, durableState.retryAfterMs), input.signal);
    projections = await read();
    projection = projections.find((candidate) => candidate.run.id === input.runId)
      ?? projection;
    const receipt = managedControlReceipt(projection.latest.status, requestId);
    if (receipt === true) return;
    if (receipt === false) throw new Error("managed Subagent runner rejected the durable control request");
  }
}

function assertOwnedManagedSubagentControlTarget(
  projections: readonly LogicalProjection[],
  input: {
    readonly runId: string;
    readonly childId?: string;
    readonly action: SubagentControlAction;
  }
): LogicalProjection {
  const projection = projections.find((candidate) => candidate.run.id === input.runId);
  if (projection === undefined) throw new Error("managed Subagent run is not owned by this Session generation");
  const canonicalChildId = childIdOf(projection.taskId);
  if (input.childId !== undefined && input.childId !== canonicalChildId) {
    throw new Error("managed Subagent child identity is not owned by this run");
  }
  const capabilities = projection.run.capabilities;
  const supported = input.action === "stop"
    ? capabilities.stop
    : input.action === "steer"
      ? capabilities.steer
      : input.action === "follow_up"
        ? capabilities.followUp
        : capabilities.resume;
  if (!supported) throw new Error(`managed Subagent ${input.action} is unavailable in its current state`);
  return projection;
}

function managedControlReceipt(status: Readonly<Record<string, unknown>>, requestId: string): boolean | undefined {
  const receipt = status["lastControl"];
  if (!isRecord(receipt) || receipt["requestId"] !== requestId) return undefined;
  if (receipt["accepted"] === true) return true;
  if (receipt["accepted"] === false) return false;
  throw new Error("managed Subagent durable control acknowledgement is invalid");
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("managed Subagent control was cancelled");
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, Math.max(1, milliseconds));
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectDelay(signal?.reason ?? new Error("managed Subagent control was cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function removeManagedSubagentObservationJournal(root: string, productSessionId: string): Promise<void> {
  const normalized = normalizedRoot(root);
  if (productSessionId.trim() === "") throw new Error("managed Subagent observation Session identity is invalid");
  const info = await lstat(normalized).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(normalized), normalized)) {
    throw new Error("managed Subagent observation root is unsafe");
  }
  const sessionDirectory = join(normalized, managedSubagentSessionKey(productSessionId));
  const sessionInfo = await lstat(sessionDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (sessionInfo === undefined) return;
  if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink()
      || !samePath(await realpath(sessionDirectory), sessionDirectory)) {
    throw new Error("managed Subagent observation Session root is unsafe");
  }
  await rm(sessionDirectory, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
}

async function readLogicalProjections(
  root: string,
  productSessionId: string,
  productGeneration: number,
  controlEnabled: boolean,
  redactValues: readonly string[],
  transcriptCache: Map<string, { readonly size: number; readonly records: readonly Record<string, unknown>[] }>,
  durableStore?: PiManagedDurableStore,
  resultCache: Map<string, { readonly size: number; readonly result: Readonly<Record<string, unknown>> }> = new Map(),
  durableState?: DurableProjectionState
): Promise<readonly LogicalProjection[]> {
  if (durableStore !== undefined) {
    return readDurableLogicalProjections(
      durableStore,
      productSessionId,
      productGeneration,
      controlEnabled,
      redactValues,
      transcriptCache,
      resultCache,
      durableState ?? { projections: [], retryAfterMs: DEFAULT_INTERVAL_MS }
    );
  }
  const sessionDirectory = join(root, managedSubagentSessionKey(productSessionId));
  const sessionInfo = await lstat(sessionDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (sessionInfo === undefined) return [];
  if (!sessionInfo.isDirectory() || sessionInfo.isSymbolicLink() || !samePath(await realpath(sessionDirectory), sessionDirectory)) {
    throw new Error("managed Subagent session observation root is unsafe");
  }
  const grouped = new Map<string, PhysicalRun[]>();
  for (const entry of await readdir(sessionDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_PATTERN.test(entry.name)) continue;
    const physical = await readPhysicalRun(
      join(sessionDirectory, entry.name),
      productSessionId,
      productGeneration,
      redactValues,
      transcriptCache
    ).catch(() => undefined);
    if (physical === undefined) continue;
    const taskId = requiredString(physical.status["taskId"], 256);
    const runs = grouped.get(taskId) ?? [];
    runs.push(physical);
    grouped.set(taskId, runs);
  }
  const values: LogicalProjection[] = [];
  for (const [taskId, physicalRuns] of grouped) {
    physicalRuns.sort(comparePhysicalRuns);
    values.push(projectLogicalRun(productSessionId, taskId, physicalRuns, controlEnabled, redactValues));
  }
  return values.sort((left, right) => left.run.startedAt - right.run.startedAt || left.taskId.localeCompare(right.taskId));
}

async function readDurableLogicalProjections(
  store: PiManagedDurableStore,
  productSessionId: string,
  productGeneration: number,
  controlEnabled: boolean,
  redactValues: readonly string[],
  transcriptCache: Map<string, { readonly size: number; readonly records: readonly Record<string, unknown>[] }>,
  resultCache: Map<string, { readonly size: number; readonly result: Readonly<Record<string, unknown>> }>,
  durableState: DurableProjectionState
): Promise<readonly LogicalProjection[]> {
  const scan = await store.scan({
    sessionId: productSessionId,
    sessionKey: managedSubagentSessionKey(productSessionId),
    ...(durableState.revision === undefined ? {} : { afterRevision: durableState.revision }),
    limitBytes: REMOTE_SCAN_LIMIT_BYTES
  });
  const scanRevision = requiredRevision(scan.revision);
  if (typeof scan.unchanged !== "boolean" || !Number.isSafeInteger(scan.retryAfterMs)
      || scan.retryAfterMs < 100 || scan.retryAfterMs > 60_000
      || !Array.isArray(scan.runs) || scan.runs.length > 256) {
    throw new Error("managed Subagent durable scan exceeded its bounded schema");
  }
  durableState.retryAfterMs = scan.retryAfterMs;
  if (scan.unchanged) {
    if (durableState.revision === undefined || scanRevision !== durableState.revision || scan.runs.length !== 0) {
      throw new Error("managed Subagent durable scan crossed its unchanged revision fence");
    }
    return durableState.projections;
  }
  const grouped = new Map<string, PhysicalRun[]>();
  for (const snapshot of scan.runs) {
    const physical = await readDurablePhysicalRun(
      store,
      snapshot,
      productSessionId,
      productGeneration,
      redactValues,
      transcriptCache,
      resultCache
    );
    const taskId = requiredString(physical.status["taskId"], 256);
    const runs = grouped.get(taskId) ?? [];
    runs.push(physical);
    grouped.set(taskId, runs);
  }
  const values: LogicalProjection[] = [];
  for (const [taskId, physicalRuns] of grouped) {
    physicalRuns.sort(comparePhysicalRuns);
    values.push(projectLogicalRun(productSessionId, taskId, physicalRuns, controlEnabled, redactValues));
  }
  const projections = values.sort((left, right) => left.run.startedAt - right.run.startedAt || left.taskId.localeCompare(right.taskId));
  durableState.revision = scanRevision;
  durableState.projections = projections;
  return projections;
}

async function readPhysicalRun(
  directory: string,
  productSessionId: string,
  productGeneration: number,
  redactValues: readonly string[],
  transcriptCache: Map<string, { readonly size: number; readonly records: readonly Record<string, unknown>[] }>
): Promise<PhysicalRun> {
  if (!UUID_PATTERN.test(basename(directory)) || !samePath(await realpath(directory), directory)) {
    throw new Error("managed Subagent physical run path is unsafe");
  }
  const [config, owner, status, claim] = await Promise.all([
    readBoundedJson(join(directory, "config.json"), MAX_JSON_BYTES),
    readBoundedJson(join(directory, "owner.json"), MAX_JSON_BYTES),
    readBoundedJson(join(directory, "status.json"), MAX_JSON_BYTES),
    readBoundedJson(join(directory, "runner.claim.json"), 64 * 1024).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    })
  ]);
  if (!isRecord(config) || !isRecord(owner) || !isRecord(status)) throw new Error("managed Subagent manifests are invalid");
  const runId = basename(directory);
  const runnerScript = join(directory, "joko-managed-subagent-runner.cjs");
  const runnerInfo = await lstat(runnerScript);
  if (!runnerInfo.isFile() || runnerInfo.isSymbolicLink() || runnerInfo.size > MAX_JSON_BYTES
      || !samePath(await realpath(runnerScript), runnerScript)) {
    throw new Error("managed Subagent runner script identity mismatch");
  }
  const runnerScriptSha256 = createHash("sha256").update(await readFile(runnerScript)).digest("hex");
  const taskId = requiredString(status["taskId"], 256);
  if (
    config["format"] !== FORMAT || owner["format"] !== FORMAT || status["format"] !== FORMAT
    || config["runId"] !== runId || owner["runId"] !== runId || status["runId"] !== runId
    || !UUID_PATTERN.test(String(config["launchToken"] ?? ""))
    || owner["launchToken"] !== config["launchToken"] || status["launchToken"] !== config["launchToken"]
    || config["productSessionId"] !== productSessionId || owner["productSessionId"] !== productSessionId
    || status["productSessionId"] !== productSessionId || !Number.isSafeInteger(config["productGeneration"])
    || number(config["productGeneration"]) < 0 || number(config["productGeneration"]) > productGeneration
    || config["taskId"] !== taskId || owner["taskId"] !== taskId
    || config["runnerScript"] !== runnerScript || owner["runnerScript"] !== runnerScript || status["runnerScript"] !== runnerScript
    || config["runnerScriptSha256"] !== runnerScriptSha256 || owner["runnerScriptSha256"] !== runnerScriptSha256
    || status["runnerScriptSha256"] !== runnerScriptSha256
    || !TERMINAL_STATES.has(String(status["state"])) && status["state"] !== "queued" && status["state"] !== "running"
  ) throw new Error("managed Subagent manifest ownership mismatch");
  const ownerState = owner["state"];
  const runnerPid = safeInteger(status["runnerPid"]);
  const claimedRunnerPid = runnerPid !== undefined && runnerPid > 0 ? runnerPid : owner["runnerPid"];
  const claimedRunnerInstanceId = runnerPid !== undefined && runnerPid > 0
    ? status["runnerInstanceId"]
    : owner["runnerInstanceId"];
  const claimValid = isRecord(claim) && claim["format"] === FORMAT && claim["runId"] === runId
    && claim["launchToken"] === config["launchToken"] && claim["runnerScriptSha256"] === runnerScriptSha256
    && claim["runnerPid"] === claimedRunnerPid && claim["runnerInstanceId"] === claimedRunnerInstanceId;
  if (runnerPid === undefined || !(
    ownerState === "reserved" && runnerPid === 0
    || ownerState === "running" && (runnerPid === 0
      || owner["runnerPid"] === runnerPid && owner["runnerInstanceId"] === status["runnerInstanceId"])
  ) || claim !== undefined && !claimValid || ownerState === "running" && runnerPid > 0 && !claimValid) {
    throw new Error("managed Subagent process identity mismatch");
  }
  const transcriptPath = join(directory, "transcript.jsonl");
  if (status["transcriptPath"] !== transcriptPath || config["transcriptPath"] !== transcriptPath) {
    throw new Error("managed Subagent transcript identity mismatch");
  }
  const transcriptInfo = await lstat(transcriptPath);
  if (!transcriptInfo.isFile() || transcriptInfo.isSymbolicLink() || transcriptInfo.size > MAX_TRANSCRIPT_BYTES
      || !samePath(await realpath(transcriptPath), transcriptPath)) {
    throw new Error("managed Subagent transcript is unsafe");
  }
  let transcript = transcriptCache.get(transcriptPath);
  if (transcript === undefined || transcript.size !== transcriptInfo.size) {
    const text = redactManagedSecrets(await readFile(transcriptPath, "utf8"), redactValues);
    const records = text.split("\n").filter(Boolean).map((line) => {
      try {
        const value = JSON.parse(line);
        return isRecord(value) ? value : { type: "joko.subagent.transcript_unreadable" };
      } catch {
        return { type: "joko.subagent.transcript_unreadable" };
      }
    });
    transcript = { size: transcriptInfo.size, records };
    transcriptCache.set(transcriptPath, transcript);
  }
  const result = await readBoundedJson(join(directory, "result.json"), MAX_RESULT_BYTES).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (result !== undefined && (!isRecord(result) || result["format"] !== FORMAT || result["runId"] !== runId
      || result["launchToken"] !== config["launchToken"] || result["taskId"] !== taskId)) {
    throw new Error("managed Subagent result ownership mismatch");
  }
  let resumeSafe = false;
  const nativeSessionPath = status["nativeSessionPath"];
  if (typeof nativeSessionPath === "string" && isAbsolute(nativeSessionPath) && isContained(dirname(directory), resolve(nativeSessionPath))) {
    const nativeInfo = await lstat(nativeSessionPath).catch(() => undefined);
    resumeSafe = nativeInfo !== undefined && nativeInfo.isFile() && !nativeInfo.isSymbolicLink()
      && nativeInfo.size <= 256 * 1024 * 1024 && samePath(await realpath(nativeSessionPath), resolve(nativeSessionPath));
  }
  const active = status["state"] === "queued" || status["state"] === "running";
  const heartbeatAt = timestamp(status["heartbeatAt"], timestamp(status["createdAt"], 0));
  return {
    runId,
    directory,
    config,
    status,
    ...(isRecord(result) ? { result } : {}),
    transcript: transcript.records,
    resumeSafe,
    controlSafe: !active || Date.now() - heartbeatAt <= RUNNER_HEARTBEAT_STALE_MS
  };
}

async function readDurablePhysicalRun(
  store: PiManagedDurableStore,
  snapshot: PiManagedDurableRunSnapshot,
  productSessionId: string,
  productGeneration: number,
  redactValues: readonly string[],
  transcriptCache: Map<string, { readonly size: number; readonly records: readonly Record<string, unknown>[] }>,
  resultCache: Map<string, { readonly size: number; readonly result: Readonly<Record<string, unknown>> }>
): Promise<PhysicalRun> {
  const runId = requiredUuid(snapshot.runId, "run");
  const revision = requiredRevision(snapshot.revision);
  const controlRevision = requiredRevision(snapshot.controlRevision);
  const transcriptRevision = requiredRevision(snapshot.transcriptRevision);
  const resultRevision = requiredRevision(snapshot.resultRevision);
  const runnerInstanceId = requiredUuid(snapshot.runnerInstanceId, "runner instance");
  const launchToken = requiredUuid(snapshot.launchToken, "launch token");
  const runnerScriptSha256 = requiredDigest(snapshot.runnerScriptSha256, "runner script");
  if (!isRecord(snapshot.config) || !isRecord(snapshot.owner) || !isRecord(snapshot.status)
      || snapshot.claim !== undefined && !isRecord(snapshot.claim)
      || !Number.isSafeInteger(snapshot.transcriptBytes) || snapshot.transcriptBytes < 0
      || snapshot.transcriptBytes > MAX_TRANSCRIPT_BYTES
      || !Number.isSafeInteger(snapshot.resultBytes) || snapshot.resultBytes < 0
      || snapshot.resultBytes > MAX_RESULT_BYTES
      || typeof snapshot.resumeSafe !== "boolean" || typeof snapshot.controlSafe !== "boolean") {
    throw new Error("managed Subagent durable snapshot is invalid");
  }
  const config = { ...snapshot.config };
  const owner = { ...snapshot.owner };
  const status = { ...snapshot.status };
  const claim = snapshot.claim === undefined ? undefined : { ...snapshot.claim };
  const taskId = requiredString(status["taskId"], 256);
  const runnerScript = requiredRemotePath(config["runnerScript"], "runner script");
  if (
    config["format"] !== FORMAT || owner["format"] !== FORMAT || status["format"] !== FORMAT
    || config["runId"] !== runId || owner["runId"] !== runId || status["runId"] !== runId
    || config["launchToken"] !== launchToken || owner["launchToken"] !== launchToken
    || status["launchToken"] !== launchToken
    || config["productSessionId"] !== productSessionId || owner["productSessionId"] !== productSessionId
    || status["productSessionId"] !== productSessionId || !Number.isSafeInteger(config["productGeneration"])
    || number(config["productGeneration"]) < 0 || number(config["productGeneration"]) > productGeneration
    || config["taskId"] !== taskId || owner["taskId"] !== taskId
    || owner["runnerScript"] !== runnerScript || status["runnerScript"] !== runnerScript
    || config["runnerScriptSha256"] !== runnerScriptSha256
    || owner["runnerScriptSha256"] !== runnerScriptSha256 || status["runnerScriptSha256"] !== runnerScriptSha256
    || config["runnerInstanceId"] !== runnerInstanceId
    || !TERMINAL_STATES.has(String(status["state"])) && status["state"] !== "queued" && status["state"] !== "running"
  ) throw new Error("managed Subagent durable manifest ownership mismatch");
  const ownerState = owner["state"];
  const runnerPid = safeInteger(status["runnerPid"]);
  const claimedRunnerPid = runnerPid !== undefined && runnerPid > 0 ? runnerPid : owner["runnerPid"];
  const claimedRunnerInstanceId = runnerPid !== undefined && runnerPid > 0
    ? status["runnerInstanceId"]
    : owner["runnerInstanceId"];
  const claimValid = claim !== undefined && claim["format"] === FORMAT && claim["runId"] === runId
    && claim["launchToken"] === launchToken && claim["runnerScriptSha256"] === runnerScriptSha256
    && claim["runnerPid"] === claimedRunnerPid && claim["runnerInstanceId"] === claimedRunnerInstanceId;
  if (runnerPid === undefined || !(
    ownerState === "reserved" && runnerPid === 0
    || ownerState === "running" && (runnerPid === 0
      || owner["runnerPid"] === runnerPid && owner["runnerInstanceId"] === status["runnerInstanceId"])
  ) || claim !== undefined && !claimValid || ownerState === "running" && runnerPid > 0 && !claimValid
      || runnerPid > 0 && status["runnerInstanceId"] !== runnerInstanceId) {
    throw new Error("managed Subagent durable process identity mismatch");
  }
  const transcriptPath = requiredRemotePath(config["transcriptPath"], "transcript");
  if (status["transcriptPath"] !== transcriptPath) {
    throw new Error("managed Subagent durable transcript identity mismatch");
  }

  const cacheKey = `durable:${runId}:transcript:${transcriptRevision}`;
  let transcript = transcriptCache.get(cacheKey);
  if (transcript === undefined || transcript.size !== snapshot.transcriptBytes) {
    for (const key of transcriptCache.keys()) {
      if (key.startsWith(`durable:${runId}:transcript:`) && key !== cacheKey) transcriptCache.delete(key);
    }
    const bytes = await readDurableBytes(store, snapshot, "transcript", snapshot.transcriptBytes);
    const text = redactManagedSecrets(bytes.toString("utf8"), redactValues);
    const records = text.split("\n").filter(Boolean).map((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? value : { type: "joko.subagent.transcript_unreadable" };
      } catch {
        return { type: "joko.subagent.transcript_unreadable" };
      }
    });
    transcript = { size: snapshot.transcriptBytes, records };
    transcriptCache.set(cacheKey, transcript);
  }
  let result: Record<string, unknown> | undefined;
  if (snapshot.resultBytes > 0) {
    const resultKey = `durable:${runId}:result:${resultRevision}`;
    let cachedResult = resultCache.get(resultKey);
    if (cachedResult === undefined || cachedResult.size !== snapshot.resultBytes) {
      for (const key of resultCache.keys()) {
        if (key.startsWith(`durable:${runId}:result:`) && key !== resultKey) resultCache.delete(key);
      }
      const resultBytes = await readDurableBytes(store, snapshot, "result", snapshot.resultBytes);
      const parsed: unknown = JSON.parse(resultBytes.toString("utf8"));
      if (!isRecord(parsed) || parsed["format"] !== FORMAT || parsed["runId"] !== runId
          || parsed["launchToken"] !== launchToken || parsed["taskId"] !== taskId) {
        throw new Error("managed Subagent durable result ownership mismatch");
      }
      cachedResult = { size: snapshot.resultBytes, result: parsed };
      resultCache.set(resultKey, cachedResult);
    }
    result = { ...cachedResult.result };
  }
  return {
    runId,
    directory: `durable:${runId}`,
    durableRevision: revision,
    durableControlRevision: controlRevision,
    durableTranscriptRevision: transcriptRevision,
    durableResultRevision: resultRevision,
    config,
    status,
    ...(result === undefined ? {} : { result }),
    transcript: transcript.records,
    resumeSafe: snapshot.resumeSafe,
    controlSafe: snapshot.controlSafe
  };
}

async function readDurableBytes(
  store: PiManagedDurableStore,
  snapshot: PiManagedDurableRunSnapshot,
  pathKind: "transcript" | "result",
  expectedBytes: number
): Promise<Buffer> {
  if (expectedBytes === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let offset = 0;
  let eof = false;
  const artifactRevision = pathKind === "transcript"
    ? requiredRevision(snapshot.transcriptRevision)
    : requiredRevision(snapshot.resultRevision);
  while (offset < expectedBytes) {
    const response = await store.readTail({
      sessionId: requiredString(snapshot.status["productSessionId"], 512),
      runId: requiredUuid(snapshot.runId, "run"),
      runnerInstanceId: requiredUuid(snapshot.runnerInstanceId, "runner instance"),
      artifactRevision,
      pathKind,
      offset,
      maxBytes: Math.min(REMOTE_READ_CHUNK_BYTES, expectedBytes - offset)
    });
    if (response.artifactRevision !== artifactRevision || response.offset !== offset
        || !(response.content instanceof Uint8Array)) {
      throw new Error("managed Subagent durable read crossed its snapshot fence");
    }
    const content = Buffer.from(response.content);
    const nextOffset = offset + content.byteLength;
    if (content.byteLength === 0 || response.nextOffset !== nextOffset || nextOffset > expectedBytes
        || response.eof && nextOffset !== expectedBytes) {
      throw new Error("managed Subagent durable read returned an invalid bounded range");
    }
    chunks.push(content);
    offset = nextOffset;
    eof = response.eof;
  }
  if (!eof || offset !== expectedBytes) {
    throw new Error("managed Subagent durable read did not confirm its exact end");
  }
  return Buffer.concat(chunks, expectedBytes);
}

function projectLogicalRun(
  productSessionId: string,
  taskId: string,
  physicalRuns: readonly PhysicalRun[],
  controlEnabled: boolean,
  redactValues: readonly string[]
): LogicalProjection {
  const latest = physicalRuns.at(-1)!;
  const status = latest.status;
  const config = latest.config;
  const state = publicState(status["state"]);
  const route = routeOf(config["route"]);
  const usage = usageOf(status);
  const startedAt = Math.min(...physicalRuns.map((run) => timestamp(run.status["startedAt"], timestamp(run.status["createdAt"], 0))));
  const updatedAt = state === "queued"
    ? timestamp(status["createdAt"], startedAt)
    : state === "running"
      ? timestamp(status["startedAt"], startedAt)
      : timestamp(status["endedAt"], startedAt);
  const endedAt = state === "completed" || state === "failed" || state === "stopped"
    ? timestamp(status["endedAt"], updatedAt)
    : undefined;
  const summary = optionalString(status["summary"], 64 * 1024, redactValues);
  const assignment = optionalString(status["task"], 64 * 1024, redactValues);
  const result = state === "completed" || state === "failed" || state === "stopped"
    ? optionalString(latest.result?.["result"], MAX_TRANSCRIPT_CONTENT_BYTES, redactValues)
    : undefined;
  const error = state === "failed" ? publicFailure(status, redactValues) : undefined;
  const resumable = controlEnabled && (state === "completed" || state === "stopped") && safeResumePath(latest);
  const liveControl = controlEnabled && latest.controlSafe;
  const childId = childIdOf(taskId);
  const title = optionalString(status["title"], 120, redactValues)
    ?? `${requiredString(status["agentName"], 128)} subagent`;
  const awaitingApproval = isRecord(status["pendingApproval"])
    && status["pendingApproval"]["childId"] === childId;
  const readOnly = status["readOnly"] !== false;
  const identityAliases = unique(physicalRuns.slice().reverse().flatMap((run) => [
    optionalString(run.status["nativeSessionId"], 512, redactValues),
    run.runId
  ].filter((value): value is string => value !== undefined)));
  const activity = activityOf(physicalRuns, redactValues);
  const run: SubagentRunDetail = {
    id: taskId,
    sessionId: productSessionId,
    ...(optionalString(status["parentTaskId"], 256, redactValues) === undefined ? {} : {
      parentTaskId: optionalString(status["parentTaskId"], 256, redactValues),
      parentToolCallId: optionalString(status["parentTaskId"], 256, redactValues)
    }),
    logicalAgentId: taskId,
    identityAliases,
    providerRunIds: physicalRuns.slice().reverse().map((run) => run.runId),
    state,
    title,
    ...(assignment === undefined ? {} : { description: assignment, assignment }),
    ...(summary === undefined ? {} : { summary }),
    ...(route === undefined ? {} : { route }),
    ...(usage === undefined ? {} : { usage }),
    readOnly,
    capabilities: {
      viewActivity: true,
      viewReturnedResult: true,
      viewFullTranscript: true,
      stop: liveControl && (state === "queued" || state === "running"),
      steer: liveControl && state === "running",
      followUp: liveControl && state === "running",
      resume: resumable,
      parentContext: status["contextMode"] === "fresh" ? "none" : "snapshot"
    },
    startedAt,
    updatedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(error === undefined ? {} : { error }),
    activity,
    children: [{
      id: childId,
      identityAliases,
      role: requiredString(status["agentName"], 128),
      title,
      ...(assignment === undefined ? {} : { assignment }),
      state,
      ...(route === undefined ? {} : { route }),
      ...(usage === undefined ? {} : { usage }),
      readOnly,
      awaitingApproval,
      ...(result === undefined ? {} : {
        result,
        ...(latest.result?.["truncated"] === true ? { resultTruncated: true } : {})
      }),
      ...(error === undefined ? {} : { error }),
      startedAt,
      ...(endedAt === undefined ? {} : { endedAt })
    }],
    ...(result === undefined ? {} : {
      returnedResult: result,
      ...(latest.result?.["truncated"] === true ? { returnedResultTruncated: true } : {})
    })
  };
  return {
    taskId,
    run,
    transcript: transcriptOf(taskId, physicalRuns, redactValues),
    latest
  };
}

function transcriptOf(
  taskId: string,
  physicalRuns: readonly PhysicalRun[],
  redactValues: readonly string[]
): readonly SubagentTranscriptEntry[] {
  const entries: SubagentTranscriptEntry[] = [];
  for (const physical of physicalRuns) {
    for (let index = 0; index < physical.transcript.length; index += 1) {
      const record = physical.transcript[index]!;
      entries.push(transcriptEntry(
        physical,
        record,
        index,
        entries.length + 1,
        childIdOf(taskId),
        redactValues
      ));
    }
  }
  return entries;
}

function transcriptEntry(
  physical: PhysicalRun,
  record: Record<string, unknown>,
  index: number,
  sequence: number,
  childId: string,
  redactValues: readonly string[]
): SubagentTranscriptEntry {
  const nested = isRecord(record["event"]) ? record["event"] : record;
  const type = optionalString(nested["type"], 256, redactValues) ?? "unknown";
  const occurredAt = timestamp(record["at"], timestamp(nested["timestamp"], timestamp(physical.status["createdAt"], 0) + index));
  const base = {
    id: `${physical.runId}:${index + 1}`,
    sequence,
    occurredAt
  };
  if (type === "joko.subagent.parent") {
    return {
      ...base,
      role: "parent",
      content: optionalString(nested["message"], MAX_TRANSCRIPT_CONTENT_BYTES, redactValues) ?? "Delegated task",
      ...(physical.config["resumeSessionPath"] ? { controlAction: "resume" as const, childId } : {})
    };
  }
  if (type === "joko.subagent.control") {
    const action = controlAction(nested["action"]);
    return {
      ...base,
      role: "parent",
      content: optionalString(nested["message"], MAX_TRANSCRIPT_CONTENT_BYTES, redactValues) ?? `Subagent ${action ?? "control"}`,
      childId,
      ...(action === undefined ? {} : { controlAction: action })
    };
  }
  if (type.startsWith("tool_execution_")) {
    const phase = type.endsWith("_start") ? "start" : type.endsWith("_end") ? "end" : "update";
    const toolName = optionalString(nested["toolName"], 4 * 1024, redactValues);
    const toolCallId = optionalString(nested["toolCallId"], 4 * 1024, redactValues);
    if (toolName === undefined && toolCallId === undefined) {
      return {
        ...base,
        role: "system",
        content: type,
        childId,
        systemEvent: { kind: boundedIdentity(type) }
      };
    }
    const input = nested["args"];
    return {
      ...base,
      role: "tool",
      content: transcriptContent(nested, `${phase} ${toolName ?? "tool"}`, redactValues),
      childId,
      ...(toolName === undefined ? {} : { toolName }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
      toolPhase: phase,
      ...(input === undefined ? {} : { toolInputJson: boundedJson(input, redactValues) }),
      ...(nested["isError"] === true ? { isError: true } : {})
    };
  }
  if (type.startsWith("message_")) {
    const message = isRecord(nested["message"]) ? nested["message"] : nested;
    const role = message["role"] === "user" ? "parent" : "subagent";
    return {
      ...base,
      role,
      content: messageText(message, redactValues) ?? type,
      ...(role === "subagent" ? { childId } : {}),
      ...(message["stopReason"] === "error" ? { isError: true } : {})
    };
  }
  return {
    ...base,
    role: "system",
    content: optionalString(nested["error"], MAX_TRANSCRIPT_CONTENT_BYTES, redactValues) ?? type,
    childId,
    ...(type.includes("error") ? { isError: true } : {}),
    systemEvent: { kind: boundedIdentity(type) }
  };
}

function activityOf(physicalRuns: readonly PhysicalRun[], redactValues: readonly string[]): readonly SubagentActivityEntry[] {
  const activity: SubagentActivityEntry[] = [];
  for (let index = 0; index < physicalRuns.length; index += 1) {
    const status = physicalRuns[index]!.status;
    const createdAt = timestamp(status["createdAt"], 0);
    activity.push({
      sequence: activity.length + 1,
      kind: index === 0 ? "started" : "resumed",
      state: "queued",
      summary: index === 0 ? "Delegated task queued" : "Delegated task resumed",
      occurredAt: createdAt
    });
    const current = publicState(status["state"]);
    if (current !== "queued") {
      activity.push({
        sequence: activity.length + 1,
        kind: "progress",
        state: "running",
        ...(optionalString(status["summary"], 64 * 1024, redactValues) === undefined ? {} : {
          summary: optionalString(status["summary"], 64 * 1024, redactValues)
        }),
        occurredAt: timestamp(status["startedAt"], createdAt)
      });
    }
    if (current === "completed" || current === "failed" || current === "stopped") {
      activity.push({
        sequence: activity.length + 1,
        kind: current === "completed" ? "completed" : current === "failed" ? "failed" : "stopped",
        state: current,
        ...(optionalString(status["summary"], 64 * 1024, redactValues) === undefined ? {} : {
          summary: optionalString(status["summary"], 64 * 1024, redactValues)
        }),
        occurredAt: timestamp(status["endedAt"], timestamp(status["startedAt"], createdAt))
      });
    }
  }
  return activity;
}

function usageOf(status: Record<string, unknown>): SubagentUsage | undefined {
  const raw = isRecord(status["usage"]) ? status["usage"] : {};
  const values: SubagentUsage = {
    ...(positiveNumber(raw["inputTokens"]) === undefined ? {} : { inputTokens: positiveNumber(raw["inputTokens"]) }),
    ...(positiveNumber(raw["outputTokens"]) === undefined ? {} : { outputTokens: positiveNumber(raw["outputTokens"]) }),
    ...(positiveNumber(raw["cacheReadTokens"]) === undefined ? {} : { cacheReadTokens: positiveNumber(raw["cacheReadTokens"]) }),
    ...(positiveNumber(raw["cacheWriteTokens"]) === undefined ? {} : { cacheWriteTokens: positiveNumber(raw["cacheWriteTokens"]) }),
    ...(positiveNumber(raw["totalTokens"]) === undefined ? {} : { totalTokens: positiveNumber(raw["totalTokens"]) }),
    ...(positiveNumber(status["toolUses"]) === undefined ? {} : { toolUses: positiveNumber(status["toolUses"]) }),
    ...(positiveNumber(status["durationMs"]) === undefined ? {} : { durationMs: positiveNumber(status["durationMs"]) }),
    ...(positiveNumber(raw["costUsd"]) === undefined ? {} : { costUsd: positiveNumber(raw["costUsd"]) })
  };
  return Object.keys(values).length === 0 ? undefined : values;
}

function routeOf(value: unknown): { readonly providerId?: string; readonly modelId?: string; readonly thinkingLevel?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = optionalString(value["provider"], 128, []);
  const modelId = optionalString(value["model"], 500, []);
  const thinkingLevel = optionalString(value["effort"], 32, []);
  const route = {
    ...(providerId === undefined ? {} : { providerId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel })
  };
  return Object.keys(route).length === 0 ? undefined : route;
}

function publicFailure(status: Record<string, unknown>, redactValues: readonly string[]): PublicError {
  return {
    code: "PI_SUBAGENT_FAILED",
    message: optionalString(status["error"], 2_048, redactValues)
      ?? optionalString(status["summary"], 2_048, redactValues)
      ?? "The delegated Pi run failed.",
    phase: "background_task",
    retryable: true,
    stateMayHaveChanged: false,
    recovery: "Inspect the delegated run transcript and resume or launch a replacement task."
  };
}

function safeResumePath(physical: PhysicalRun): boolean {
  return physical.resumeSafe;
}

function comparePhysicalRuns(left: PhysicalRun, right: PhysicalRun): number {
  return number(left.status["turnCount"]) - number(right.status["turnCount"])
    || timestamp(left.status["createdAt"], 0) - timestamp(right.status["createdAt"], 0)
    || left.runId.localeCompare(right.runId);
}

function publicState(value: unknown): SubagentRunState {
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "aborted") return "stopped";
  if (value === "queued") return "queued";
  return "running";
}

function controlAction(value: unknown): SubagentControlAction | undefined {
  return value === "stop" || value === "steer" || value === "follow_up" || value === "resume" ? value : undefined;
}

function childIdOf(taskId: string): string {
  return `${taskId}:child`;
}

function transcriptContent(record: Record<string, unknown>, fallback: string, redactValues: readonly string[]): string {
  return messageText(record, redactValues)
    ?? messageText(isRecord(record["result"]) ? record["result"] : {}, redactValues)
    ?? fallback;
}

function messageText(value: Record<string, unknown>, redactValues: readonly string[]): string | undefined {
  if (typeof value["content"] === "string") return optionalString(value["content"], MAX_TRANSCRIPT_CONTENT_BYTES, redactValues);
  if (!Array.isArray(value["content"])) return undefined;
  const text = value["content"].flatMap((entry) => isRecord(entry) && entry["type"] === "text" && typeof entry["text"] === "string"
    ? [entry["text"]]
    : []).join("");
  return optionalString(text, MAX_TRANSCRIPT_CONTENT_BYTES, redactValues);
}

function boundedJson(value: unknown, redactValues: readonly string[]): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = "{}";
  }
  return boundedUtf8(redactManagedSecrets(text, redactValues), MAX_TOOL_INPUT_BYTES);
}

function optionalString(value: unknown, maximumBytes: number, redactValues: readonly string[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return boundedUtf8(redactManagedSecrets(value, redactValues), maximumBytes);
}

function requiredString(value: unknown, maximumBytes: number): string {
  const text = optionalString(value, maximumBytes, []);
  if (text === undefined) throw new Error("managed Subagent identity is missing");
  return text;
}

function boundedIdentity(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._:-]/gu, "_");
  return normalized.slice(0, 256) || "unknown";
}

function boundedUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  return `${bytes.subarray(0, Math.max(0, maximumBytes - 3)).toString("utf8").replace(/\uFFFD$/u, "")}…`;
}

function pendingApprovalOf(projection: LogicalProjection, redactValues: readonly string[]): PendingApproval | undefined {
  const value = projection.latest.status["pendingApproval"];
  if (!isRecord(value)) return undefined;
  const id = optionalString(value["id"], 512, redactValues);
  const childId = optionalString(value["childId"], 512, redactValues);
  const method = value["method"];
  const title = optionalString(value["title"], 1024, redactValues);
  const expectedChildId = requiredString(projection.latest.config["childId"], 512);
  if (id === undefined || childId !== expectedChildId || (method !== "confirm" && method !== "input") || title === undefined) {
    return undefined;
  }
  if (method === "confirm" && !title.startsWith("joko:permission:")) return undefined;
  if (method === "input" && !title.startsWith("joko:command-gate/v1/")
      && !title.startsWith("joko:policy-decision/v1/")) return undefined;
  return {
    id,
    childId,
    method,
    title,
    ...(method === "confirm"
      ? { message: optionalString(value["message"], 8192, redactValues) ?? "" }
      : { placeholder: optionalString(value["placeholder"], 1024, redactValues) })
  };
}

function permissionToolName(title: string): string {
  const value = title.startsWith("joko:permission:") ? title.slice("joko:permission:".length) : "unknown";
  return boundedIdentity(value || "unknown");
}

function approvalInteractionId(
  sessionId: string,
  launchGeneration: number,
  runId: string,
  childId: string,
  approvalId: string
): string {
  const digest = createHash("sha256").update([
    sessionId,
    String(launchGeneration),
    runId,
    childId,
    approvalId
  ].join("\u0000")).digest("hex");
  return `pi:subagent-approval:${digest}`;
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

function requiredGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("managed Subagent generation fence is invalid");
  }
  return value;
}

function requiredUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error(`managed Subagent ${label} identity is invalid`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`managed Subagent ${label} digest is invalid`);
  }
  return value;
}

function requiredRevision(value: unknown): string {
  return requiredDigest(value, "durable revision");
}

function requiredRemotePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 32_768
      || !value.startsWith("/") || value.includes("\0")) {
    throw new Error(`managed Subagent remote ${label} path is invalid`);
  }
  return value;
}

async function decisionOrCancellation(
  decision: Promise<InteractionDecision>,
  signal: AbortSignal
): Promise<InteractionDecision> {
  if (signal.aborted) return { kind: "cancelled" };
  return new Promise<InteractionDecision>((resolveDecision, rejectDecision) => {
    let settled = false;
    const finish = (value: InteractionDecision): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveDecision(value);
    };
    const onAbort = (): void => finish({ kind: "cancelled" });
    signal.addEventListener("abort", onAbort, { once: true });
    void decision.then(finish, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      rejectDecision(error);
    });
  });
}

async function readBoundedJson(path: string, maximumBytes: number): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes || !samePath(await realpath(path), path)) {
    throw new Error("managed Subagent artifact is linked, oversized, or unavailable");
  }
  const bytes = await readFile(path);
  const after = await stat(path);
  if (!after.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("managed Subagent artifact changed while being read");
  }
  return JSON.parse(bytes.toString("utf8"));
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  if (!samePath(await realpath(parent), parent)) throw new Error("managed Subagent journal parent contains a path alias");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error("managed Subagent observation root is unsafe");
  }
  await chmod(path, 0o700);
}

function isDeliveryJournal(value: unknown, sessionId: string, generation: number, taskId: string): value is DeliveryJournal {
  if (!isRecord(value)) return false;
  return value["format"] === FORMAT && value["productSessionId"] === sessionId
    && Number.isSafeInteger(value["productGeneration"]) && number(value["productGeneration"]) >= 0
    && number(value["productGeneration"]) <= generation && value["taskId"] === taskId
    && Number.isSafeInteger(value["deliveredSequence"]) && number(value["deliveredSequence"]) >= 0
    && (value["runFingerprint"] === undefined || /^[0-9a-f]{64}$/u.test(String(value["runFingerprint"])))
    && (value["approval"] === undefined || isApprovalDelivery(value["approval"]));
}

function isApprovalDelivery(value: unknown): value is ApprovalDelivery {
  if (!isRecord(value) || !UUID_PATTERN.test(String(value["runId"] ?? ""))
      || typeof value["childId"] !== "string" || typeof value["approvalId"] !== "string"
      || typeof value["interactionId"] !== "string" || !UUID_PATTERN.test(String(value["requestId"] ?? ""))
      || !Number.isSafeInteger(value["decidedAt"]) || number(value["decidedAt"]) < 0
      || !isRecord(value["response"])) return false;
  const response = value["response"];
  const fields = [response["confirmed"] !== undefined, response["value"] !== undefined, response["cancelled"] !== undefined]
    .filter(Boolean).length;
  return fields === 1
    && (response["confirmed"] === undefined || typeof response["confirmed"] === "boolean")
    && (response["value"] === undefined || typeof response["value"] === "string" && response["value"].length <= 1024)
    && (response["cancelled"] === undefined || response["cancelled"] === true);
}

function observationMetadata(projection: LogicalProjection, kind: "run" | "transcript") {
  return {
    namespace: "pi.subagent",
    fields: {
      kind,
      subagentRunId: projection.run.id,
      providerRunId: projection.latest.runId,
      state: projection.run.state
    }
  } as const;
}

function normalizedRoot(root: string): string {
  const normalized = resolve(root);
  if (!isAbsolute(root) || normalized !== root) throw new Error("managed Subagent observation root must be normalized and absolute");
  return normalized;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : Math.max(0, fallback);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isContained(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
