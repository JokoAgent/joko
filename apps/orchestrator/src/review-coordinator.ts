import { createHash, randomUUID } from "node:crypto";

import type { PromptInput } from "@joko/core";
import { InvalidStateTransitionError, RevisionConflictError } from "@joko/store";
import type {
  OperationalStore,
  ConnectionRecord,
  OperationExecution,
  ReviewFailureCode as StoreReviewFailureCode,
  ReviewRunRecord
} from "@joko/store";

import { buildReviewEvidence, compareReviewFreshness, type BuildReviewEvidenceInput, type ReviewFreshnessSeal } from "./review-evidence.js";
import { ReviewEvidenceCaptureError } from "./review-evidence-provider.js";
import { buildReviewPrompt } from "./review-prompt.js";
import { readStartReviewRequest, type StartReviewRequest } from "./review-types.js";

export interface ReviewEvidenceProvider {
  /** Captures fresh source truth. The coordinator never logs or persists this return value. */
  capture(request: StartReviewRequest, purpose?: "start" | "reobserve"): Promise<BuildReviewEvidenceInput>;
}

export interface CreateFreshReviewerInput {
  readonly reviewRunId: string;
  readonly sourceSessionId: string;
  readonly sourceLeaseFencingToken: bigint;
  readonly targetId: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly runtimePolicy: "review_read_only";
  readonly nativeStart: { readonly kind: "new" };
  readonly permissionMode: "ask";
  readonly planMode: false;
  readonly fastMode: false;
  readonly title?: string;
}

export type ReviewRuntimeOutcome =
  | { readonly state: "completed"; readonly visibleResult: string }
  | { readonly state: "aborted" }
  | { readonly state: "closed" }
  | { readonly state: "failed" };

export interface ReviewRuntimeDispatch {
  /** Resolves only after the durable queue item is Backend-accepted. */
  readonly accepted: Promise<void>;
  /** Resolves when the isolated reviewer reaches a terminal native outcome. */
  readonly outcome: Promise<ReviewRuntimeOutcome>;
}

export interface ReviewRuntimeController {
  mutate<T>(input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly kind: string;
    readonly body: unknown;
    readonly commit: (store: OperationalStore) => T;
    readonly precondition?: (store: OperationalStore) => void;
    readonly effect?: () => Promise<void>;
  }): Promise<OperationExecution<T>>;
  /** Must create an empty product/native Session without attach, fork, history, context, or memory. */
  createFreshReviewer(input: CreateFreshReviewerInput): Promise<{ readonly reviewerSessionId: string }>;
  /** Must durably enqueue exactly once before Adapter dispatch. */
  enqueueInitialPrompt(input: {
    readonly operationId: string;
    readonly reviewRunId: string;
    readonly reviewerSessionId: string;
    readonly prompt: PromptInput;
  }): Promise<ReviewRuntimeDispatch>;
  closeReviewer(reviewerSessionId: string): Promise<void>;
  cleanupRecoveredReviewer?(reviewerSessionId: string): Promise<void>;
}

export interface ReviewCoordinatorOptions {
  readonly store: OperationalStore;
  readonly evidence: ReviewEvidenceProvider;
  readonly runtime: ReviewRuntimeController;
  readonly idFactory?: () => string;
  readonly locale?: () => string;
  readonly now?: () => number;
  /** Content-free transition hook for destructive-action quiet-period fencing. */
  readonly onActivityTransition?: () => void;
}

export interface ReviewExecutionResult {
  readonly reviewRunId: string;
  readonly reviewerSessionId?: string;
  readonly run: ReviewRunRecord;
}

export interface ReviewReobservationResult {
  readonly reviewRunId: string;
  readonly run: ReviewRunRecord;
}

export class ReviewStartError extends Error {
  constructor(
    readonly code:
      | "REVIEW_SOURCE_CHANGED"
      | "REVIEW_SOURCE_BUSY"
      | "REVIEW_NOTHING_TO_REVIEW"
      | "REVIEW_ARTIFACT_UNAVAILABLE"
      | "REVIEW_PROVIDER_FAILED"
      | "REVIEW_NOT_ACCEPTED",
    message: string
  ) {
    super(message);
    this.name = "ReviewStartError";
  }
}

export class ReviewCoordinator {
  readonly #store: OperationalStore;
  readonly #evidence: ReviewEvidenceProvider;
  readonly #runtime: ReviewRuntimeController;
  readonly #idFactory: () => string;
  readonly #locale: () => string;
  readonly #now: () => number;
  readonly #onActivityTransition: () => void;
  readonly #finalizations = new Set<Promise<void>>();

  constructor(options: ReviewCoordinatorOptions) {
    this.#store = options.store;
    this.#evidence = options.evidence;
    this.#runtime = options.runtime;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#locale = options.locale ?? (() => "en");
    this.#now = options.now ?? Date.now;
    this.#onActivityTransition = options.onActivityTransition ?? (() => undefined);
  }

  /**
   * Run startup reconciliation before SessionHost.initialize(). The Store
   * marks every running Review interrupted and releases each lease before
   * generic queue recovery; native cleanup is best effort and cannot reopen
   * durable state.
   */
  async reconcileStartup(): Promise<readonly ReviewRunRecord[]> {
    const sources = this.#store.listSessions({ includeArchived: true, includeDeleted: true });
    const running = new Map<string, ReviewRunRecord>();
    for (const source of sources) {
      for (const run of this.#store.listReviewRunsBySource(source.descriptor.id)) {
        if (run.state === "running") running.set(run.id, run);
      }
    }
    const recovered: ReviewRunRecord[] = [];
    for (const run of [...running.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      const bundle = this.#store.getReviewRunBundle(run.id);
      recovered.push(this.#store.finishReviewRun({
        reviewRunId: run.id,
        state: "failed",
        failureCode: "interrupted",
        freshness: "unavailable",
        sourceLeaseFencingToken: bundle.sourceLease.fencingToken,
        expectedRunRevision: run.revision,
        traceId: `review-startup:${this.#idFactory()}`
      }));
    }
    // Review leases are terminal before SessionHost.initialize performs the
    // one generic queue/run recovery pass. Never run generic recovery twice.
    for (const run of recovered) {
      if (run.reviewerSessionId !== undefined) await this.#runtime.cleanupRecoveredReviewer?.(run.reviewerSessionId).catch(() => undefined);
    }
    return recovered;
  }

  async start(input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly request: unknown;
    readonly operationBody?: unknown;
  }): Promise<ReviewExecutionResult> {
    this.#notifyActivityTransition();
    const request = readStartReviewRequest(input.request);
    const reviewRunId = reviewRunIdForOperation(input.operationId);
    let execution: OperationExecution<{ readonly reviewRunId: string }>;
    try {
      execution = await this.#runtime.mutate({
        operationId: input.operationId,
        connection: input.connection,
        kind: "start_review",
        body: input.operationBody ?? request,
        precondition: (store) => { store.getSession(request.sourceSessionId); },
        effect: async () => {
          await this.#startAccepted(request, reviewRunId, input.operationId);
        },
        commit: (store) => {
          const run = store.getReviewRun(reviewRunId);
          return { reviewRunId: run.id };
        }
      });
    } catch (error) {
      if (error instanceof ReviewStartError) throw error;
      if (error instanceof ReviewEvidenceCaptureError) throw startErrorForEvidence(error);
      throw error;
    }
    const run = this.#store.getReviewRun(execution.value.reviewRunId);
    return {
      reviewRunId: run.id,
      ...(run.reviewerSessionId === undefined ? {} : { reviewerSessionId: run.reviewerSessionId }),
      run
    };
  }

  async reobserve(input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly reviewRunId: string;
    readonly operationBody?: unknown;
    readonly precondition?: (store: OperationalStore) => void;
  }): Promise<ReviewReobservationResult> {
    this.#notifyActivityTransition();
    let snapshot: {
      readonly expectedRevision: bigint;
      readonly originalFreshness: ReviewFreshnessSeal;
      readonly request: StartReviewRequest;
    } | undefined;
    let observation: {
      readonly freshness: "current" | "stale" | "unavailable";
      readonly checkedAt: number;
    } | undefined;
    const execution = await this.#runtime.mutate({
      operationId: input.operationId,
      connection: input.connection,
      kind: "reobserve_review",
      body: input.operationBody ?? { reviewRunId: input.reviewRunId },
      precondition: (store) => {
        input.precondition?.(store);
        const bundle = store.getReviewRunBundle(input.reviewRunId);
        if (bundle.run.state === "running") {
          throw new InvalidStateTransitionError("review run freshness", "running", "reobserved");
        }
        if (snapshot === undefined) {
          snapshot = {
            expectedRevision: bundle.run.revision,
            originalFreshness: freshnessSealFromStore(bundle.evidenceSeal),
            request: {
              sourceSessionId: bundle.run.sourceSessionId,
              attachments: bundle.attachments.map((attachment) => ({
                kind: attachment.kind,
                displayName: attachment.displayName,
                blob: attachment.blob
              }))
            }
          };
        } else if (bundle.run.revision !== snapshot.expectedRevision) {
          throw new RevisionConflictError(
            "Review run",
            bundle.run.id,
            snapshot.expectedRevision,
            bundle.run.revision
          );
        }
      },
      effect: async () => {
        if (snapshot === undefined) throw new Error("Review reobservation was not durably admitted.");
        try {
          const current = buildReviewEvidence(await this.#evidence.capture(snapshot.request, "reobserve"));
          observation = {
            freshness: compareReviewFreshness(snapshot.originalFreshness, current.freshness) === undefined
              ? "current"
              : "stale",
            checkedAt: this.#now()
          };
        } catch {
          observation = { freshness: "unavailable", checkedAt: this.#now() };
        }
      },
      commit: (store) => {
        if (snapshot === undefined || observation === undefined) {
          throw new Error("Review reobservation has no admitted evidence result.");
        }
        const run = store.reobserveReview({
          reviewRunId: input.reviewRunId,
          expectedRunRevision: snapshot.expectedRevision,
          freshness: observation.freshness,
          checkedAt: observation.checkedAt,
          operationId: input.operationId,
          traceId: `review:${input.reviewRunId}:reobserve`
        });
        return { reviewRunId: run.id };
      }
    });
    const run = this.#store.getReviewRun(execution.value.reviewRunId);
    return { reviewRunId: run.id, run };
  }

  async #startAccepted(request: StartReviewRequest, reviewRunId: string, operationId: string): Promise<ReviewExecutionResult> {
    const source = this.#store.getSession(request.sourceSessionId);
    const initialEvidence = await this.#evidence.capture(request);
    const firstCapture = buildReviewEvidence(initialEvidence);
    const builtPrompt = buildReviewPrompt(firstCapture.promptInput);
    const created = this.#store.createReviewRun({
      id: reviewRunId,
      sourceSessionId: request.sourceSessionId,
      targetKind: builtPrompt.targetKind,
      evidenceSeal: storeSeal(firstCapture.freshness),
      attachments: request.attachments.map((attachment) => ({
        kind: attachment.kind,
        displayName: attachment.displayName,
        blob: attachment.blob
      })),
      operationId,
      traceId: `review:${reviewRunId}:running`
    });
    const fencingToken = created.sourceLease.fencingToken;
    let reviewerSessionId: string | undefined;
    try {
      const beforeEffect = buildReviewEvidence(await this.#evidence.capture(request));
      const preflightFailure = compareReviewFreshness(firstCapture.freshness, beforeEffect.freshness);
      if (preflightFailure !== undefined) {
        this.#fail(created.run, fencingToken, preflightFailure, operationId);
        throw new ReviewStartError("REVIEW_SOURCE_CHANGED", "The review source changed before the isolated reviewer could start.");
      }

      const reviewer = await this.#runtime.createFreshReviewer({
        reviewRunId,
        sourceSessionId: request.sourceSessionId,
        sourceLeaseFencingToken: fencingToken,
        targetId: source.descriptor.targetId,
        ...(source.descriptor.providerId === undefined ? {} : { providerId: source.descriptor.providerId }),
        ...(source.descriptor.modelId === undefined ? {} : { modelId: source.descriptor.modelId }),
        ...(source.descriptor.effort === undefined ? {} : { effort: source.descriptor.effort }),
        runtimePolicy: "review_read_only",
        nativeStart: { kind: "new" },
        permissionMode: "ask",
        planMode: false,
        fastMode: false,
        title: reviewTitle(source.descriptor.title, this.#locale())
      });
      reviewerSessionId = reviewer.reviewerSessionId;
      this.#store.attachReviewSession({
        reviewRunId,
        reviewerSessionId,
        sourceLeaseFencingToken: fencingToken,
        expectedRunRevision: this.#store.getReviewRun(reviewRunId).revision,
        operationId,
        traceId: `review:${reviewRunId}:attached`
      });
      const policy = this.#store.getSessionRuntimePolicy(reviewerSessionId);
      if (policy.policy !== "review_read_only" || policy.reviewRunId !== reviewRunId || policy.sourceLeaseFencingToken !== fencingToken) {
        throw new Error("Reviewer runtime policy attachment failed closed.");
      }

      // Recheck the visible source and activity fence immediately before the
      // durable reviewer queue/dispatch boundary. Reviewer/session lifecycle
      // cards are excluded by the provider, so this cannot self-invalidate.
      const beforeEnqueue = buildReviewEvidence(await this.#evidence.capture(request));
      const enqueueFailure = compareReviewFreshness(firstCapture.freshness, beforeEnqueue.freshness);
      if (enqueueFailure !== undefined) {
        this.#fail(this.#store.getReviewRun(reviewRunId), fencingToken, enqueueFailure, operationId);
        throw new ReviewStartError("REVIEW_SOURCE_CHANGED", "The review source changed before the reviewer prompt was queued.");
      }

      const dispatch = await this.#runtime.enqueueInitialPrompt({
        operationId: `review-initial:${reviewRunId}`,
        reviewRunId,
        reviewerSessionId,
        prompt: {
          text: builtPrompt.prompt,
          images: initialEvidence.artifacts
            .filter((attachment) => attachment.kind === "image")
            .map((attachment) => ({ blob: attachment.blob, alt: attachment.displayName })),
          // File evidence must be extracted into bounded alias-only excerpts by
          // ReviewEvidenceProvider. Pi's ordinary file composer exposes its
          // resolved service path and therefore is forbidden for Review.
          files: [],
          mentions: [],
          disposition: "prompt"
        }
      });
      try {
        await dispatch.accepted;
      } catch {
        this.#fail(this.#store.getReviewRun(reviewRunId), fencingToken, "cancelled-before-start", operationId);
        throw new ReviewStartError("REVIEW_NOT_ACCEPTED", "The isolated reviewer Backend did not accept the review request.");
      }
      const finalization = this.#finalize({
        request,
        reviewRunId,
        reviewerSessionId,
        fencingToken,
        originalFreshness: firstCapture.freshness,
        outcome: dispatch.outcome,
        operationId
      });
      this.#finalizations.add(finalization);
      void finalization.finally(() => {
        this.#finalizations.delete(finalization);
        this.#notifyActivityTransition();
      });
      return { reviewRunId, reviewerSessionId, run: this.#store.getReviewRun(reviewRunId) };
    } catch (error) {
      const current = this.#store.getReviewRun(reviewRunId);
      const failureCode = error instanceof ReviewEvidenceCaptureError ? failureCodeForEvidence(error) : "provider-failed";
      const terminal = current.state === "running" ? this.#fail(
        current,
        fencingToken,
        failureCode,
        operationId,
        error instanceof ReviewEvidenceCaptureError ? freshnessForEvidenceFailure(error) : undefined
      ) : current;
      if (reviewerSessionId !== undefined) await this.#runtime.closeReviewer(reviewerSessionId).catch(() => undefined);
      if (error instanceof ReviewStartError) throw error;
      if (error instanceof ReviewEvidenceCaptureError) throw startErrorForEvidence(error);
      throw new ReviewStartError(
        terminal.failureCode === "cancelled-before-start" ? "REVIEW_NOT_ACCEPTED" : "REVIEW_PROVIDER_FAILED",
        "The isolated reviewer Backend did not accept the review request."
      );
    }
  }

  /** Test/shutdown seam; normal command handlers must return at the accepted boundary. */
  async waitForFinalizations(): Promise<void> {
    await Promise.allSettled([...this.#finalizations]);
  }

  hasInFlightActivity(): boolean {
    return this.#finalizations.size > 0 || this.#store.listReviewRuns({ state: "running", limit: 1 }).length > 0;
  }

  #notifyActivityTransition(): void {
    try {
      this.#onActivityTransition();
    } catch {
      // Observability must not change durable Review semantics.
    }
  }

  async #finalize(input: {
    readonly request: StartReviewRequest;
    readonly reviewRunId: string;
    readonly reviewerSessionId: string;
    readonly fencingToken: bigint;
    readonly originalFreshness: ReviewFreshnessSeal;
    readonly outcome: Promise<ReviewRuntimeOutcome>;
    readonly operationId: string;
  }): Promise<void> {
    try {
      const outcome = await input.outcome.catch(() => ({ state: "failed" as const }));
      const current = this.#store.getReviewRun(input.reviewRunId);
      if (current.state !== "running") return;
      if (outcome.state !== "completed") {
        const failure = outcome.state === "aborted" ? "cancelled-before-start"
          : outcome.state === "closed" ? "reviewer-closed" : "provider-failed";
        this.#fail(current, input.fencingToken, failure, input.operationId);
        return;
      }
      if (outcome.visibleResult.trim() === "") {
        this.#fail(current, input.fencingToken, "no-visible-result", input.operationId);
        return;
      }
      let freshness: "current" | "stale" | "unavailable" = "current";
      try {
        const finalCapture = buildReviewEvidence(await this.#evidence.capture(input.request));
        if (compareReviewFreshness(input.originalFreshness, finalCapture.freshness) !== undefined) {
          freshness = "stale";
        }
      } catch (error) {
        // A completed reviewer conclusion remains durable even when the final
        // evidence can no longer be captured. Freshness fails closed instead.
        freshness = error instanceof ReviewEvidenceCaptureError
          ? freshnessForEvidenceFailure(error)
          : "unavailable";
      }
      const refreshed = this.#store.getReviewRun(input.reviewRunId);
      if (refreshed.state !== "running") return;
      this.#store.finishReviewRun({
        reviewRunId: input.reviewRunId,
        state: "completed",
        result: outcome.visibleResult,
        freshness,
        sourceLeaseFencingToken: input.fencingToken,
        expectedRunRevision: refreshed.revision,
        operationId: input.operationId,
        traceId: `review:${input.reviewRunId}:terminal`
      });
    } catch (error) {
      const current = this.#store.getReviewRun(input.reviewRunId);
      if (current.state === "running") {
        this.#fail(
          current,
          input.fencingToken,
          error instanceof ReviewEvidenceCaptureError ? failureCodeForEvidence(error) : "provider-failed",
          input.operationId
        );
      }
    } finally {
      await this.#runtime.closeReviewer(input.reviewerSessionId).catch(() => undefined);
    }
  }

  #fail(
    run: ReviewRunRecord,
    fencingToken: bigint,
    failureCode: StoreReviewFailureCode,
    operationId?: string,
    freshnessOverride?: "current" | "stale" | "unavailable"
  ): ReviewRunRecord {
    if (run.state !== "running") return run;
    const freshness = freshnessOverride ?? (failureCode === "source-workspace-changed"
      || failureCode === "source-conversation-changed"
      || failureCode === "source-files-changed"
      || failureCode === "artifact-changed"
      ? "stale" as const
      : failureCode === "artifact-unavailable" || failureCode === "interrupted"
        ? "unavailable" as const
        : "current" as const);
    return this.#store.finishReviewRun({
      reviewRunId: run.id,
      state: "failed",
      failureCode,
      freshness,
      sourceLeaseFencingToken: fencingToken,
      expectedRunRevision: run.revision,
      ...(operationId === undefined ? {} : { operationId }),
      traceId: `review:${run.id}:terminal`
    });
  }
}

function failureCodeForEvidence(error: ReviewEvidenceCaptureError): StoreReviewFailureCode {
  switch (error.code) {
    case "source-changed":
      return "source-conversation-changed";
    case "source-busy":
      return "provider-failed";
    case "artifact-unavailable":
      return "artifact-unavailable";
    case "nothing-to-review":
      return "provider-failed";
  }
}

function freshnessForEvidenceFailure(error: ReviewEvidenceCaptureError): "stale" | "unavailable" {
  return error.code === "source-changed" || error.code === "nothing-to-review"
    ? "stale"
    : "unavailable";
}

function startErrorForEvidence(error: ReviewEvidenceCaptureError): ReviewStartError {
  switch (error.code) {
    case "source-busy":
      return new ReviewStartError("REVIEW_SOURCE_BUSY", "The source task has an active or queued turn.");
    case "source-changed":
      return new ReviewStartError("REVIEW_SOURCE_CHANGED", "The review source changed during evidence capture.");
    case "nothing-to-review":
      return new ReviewStartError("REVIEW_NOTHING_TO_REVIEW", "There is no visible evidence to review.");
    case "artifact-unavailable":
      return new ReviewStartError("REVIEW_ARTIFACT_UNAVAILABLE", "Required review evidence is unavailable.");
  }
}

function reviewRunIdForOperation(operationId: string): string {
  return `review-${createHash("sha256").update(operationId).digest("hex").slice(0, 40)}`;
}

export function reviewTitle(sourceTitle: string, locale: string): string {
  const prefix = locale.toLowerCase().startsWith("zh") ? "审查 · " : "Review · ";
  const title = `${prefix}${sourceTitle.trim() || "Task"}`;
  const characters = [...title];
  return characters.length <= 120 ? title : characters.slice(0, 120).join("");
}

function storeSeal(value: ReviewFreshnessSeal): {
  readonly version: 1;
  readonly conversationSha256: string;
  readonly workspaceSha256: string;
  readonly filesSha256: string;
  readonly artifactsSha256: string;
  readonly sealSha256: string;
} {
  return {
    version: 1,
    conversationSha256: value.conversationSha256,
    workspaceSha256: value.workspaceSha256,
    filesSha256: value.filesSha256,
    artifactsSha256: value.artifactsSha256,
    sealSha256: value.sealSha256
  };
}

function freshnessSealFromStore(value: {
  readonly version: 1;
  readonly conversationSha256: string;
  readonly workspaceSha256: string;
  readonly filesSha256: string;
  readonly artifactsSha256: string;
  readonly sealSha256: string;
}): ReviewFreshnessSeal {
  return {
    version: value.version,
    conversationSha256: value.conversationSha256,
    workspaceSha256: value.workspaceSha256,
    filesSha256: value.filesSha256,
    artifactsSha256: value.artifactsSha256,
    sealSha256: value.sealSha256
  };
}
