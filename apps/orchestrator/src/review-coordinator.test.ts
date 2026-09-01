import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationalStore, type ConnectionRecord, type OperationExecution } from "@joko/store";

import {
  ReviewCoordinator,
  type CreateFreshReviewerInput,
  type ReviewRuntimeController,
  type ReviewRuntimeDispatch,
  type ReviewRuntimeOutcome
} from "./review-coordinator.js";
import { buildReviewEvidence as buildEvidence, type BuildReviewEvidenceInput } from "./review-evidence.js";
import { ReviewEvidenceCaptureError } from "./review-evidence-provider.js";
import type { StartReviewRequest } from "./review-types.js";

const cleanups: Array<() => void> = [];
const hash = (character: string): string => character.repeat(64);

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("ReviewCoordinator", () => {
  it("persists run and lease before effect, attaches read-only policy before exactly-once queue, and completes after final freshness", async () => {
    const fixture = setup();
    const runtime = new FakeRuntime(fixture.store, { state: "completed", visibleResult: "P1: defect" });
    const onActivityTransition = vi.fn();
    const coordinator = coordinatorFor(
      fixture.store,
      runtime,
      [evidence(), evidence(), evidence(), evidence()],
      onActivityTransition
    );
    const result = await startReview(coordinator, fixture.connection);
    expect(result.run).toMatchObject({ state: "completed", reviewerSessionId: "reviewer-session" });
    await coordinator.waitForFinalizations();
    expect(fixture.store.getReviewRun(result.reviewRunId)).toMatchObject({ state: "completed", result: "P1: defect" });
    expect(fixture.store.getReviewRunBundle(result.reviewRunId).sourceLease.state).toBe("released");
    expect(runtime.order).toEqual(["create:durable-running", "enqueue:policy-attached", "close"]);
    expect(runtime.operationIds).toEqual([`review-initial:${result.reviewRunId}`]);
    expect(onActivityTransition.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(runtime.creation).toMatchObject({
      sourceSessionId: "source",
      providerId: "provider",
      modelId: "model",
      effort: "high",
      runtimePolicy: "review_read_only",
      nativeStart: { kind: "new" },
      permissionMode: "ask",
      planMode: false,
      fastMode: false
    });
  });

  it("fails stale source evidence before creating any external runtime", async () => {
    const fixture = setup();
    const runtime = new FakeRuntime(fixture.store, { state: "completed", visibleResult: "unused" });
    const original = evidence();
    const changed: BuildReviewEvidenceInput = { ...original, conversation: { ...original.conversation, sessionGeneration: 2 } };
    await expect(startReview(coordinatorFor(fixture.store, runtime, [evidence(), changed]), fixture.connection))
      .rejects.toMatchObject({ code: "REVIEW_SOURCE_CHANGED" });
    const result = fixture.store.listReviewRuns()[0]!;
    expect(result).toMatchObject({
      state: "failed",
      freshness: "stale",
      failureCode: "source-conversation-changed"
    });
    expect(runtime.order).toEqual([]);
    expect(fixture.store.getReviewRunBundle(result.id).sourceLease.state).toBe("released");
    expect(fixture.store.getOperation("start-review-op").status).toBe("failed");
  });

  it("keeps StartReview failed when Backend acceptance rejects, while retaining the failed durable card", async () => {
    const fixture = setup();
    const rejected = Promise.reject(new Error("backend rejected"));
    void rejected.catch(() => undefined);
    const runtime = new FakeRuntime(
      fixture.store,
      { state: "failed" },
      rejected
    );
    const coordinator = coordinatorFor(fixture.store, runtime, [evidence(), evidence(), evidence()]);
    await expect(startReview(coordinator, fixture.connection)).rejects.toMatchObject({ code: "REVIEW_NOT_ACCEPTED" });
    expect(fixture.store.getOperation("start-review-op").status).toBe("failed");
    expect(fixture.store.listReviewRuns()[0]).toMatchObject({ state: "failed", failureCode: "cancelled-before-start" });
  });

  it("rechecks source activity immediately before enqueue and never dispatches when it becomes busy", async () => {
    const fixture = setup();
    const runtime = new FakeRuntime(fixture.store, { state: "completed", visibleResult: "unused" });
    const coordinator = coordinatorFor(fixture.store, runtime, [
      evidence(),
      evidence(),
      new ReviewEvidenceCaptureError("source-busy", "source became busy")
    ]);
    await expect(startReview(coordinator, fixture.connection)).rejects.toMatchObject({ code: "REVIEW_SOURCE_BUSY" });
    expect(runtime.order).toEqual(["create:durable-running", "close"]);
    expect(fixture.store.listReviewRuns()[0]).toMatchObject({
      state: "failed",
      freshness: "unavailable",
      failureCode: "provider-failed"
    });
    expect(fixture.store.getOperation("start-review-op").status).toBe("failed");
  });

  it("preserves the completed conclusion and marks freshness stale when source files change", async () => {
    const fixture = setup();
    const runtime = new FakeRuntime(fixture.store, { state: "completed", visibleResult: "looks good" });
    const original = evidence();
    const changed: BuildReviewEvidenceInput = { ...original, workspace: { ...original.workspace, files: [{ relativePath: "src/a.ts", sha256: hash("f"), byteLength: 1 }] } };
    const coordinator = coordinatorFor(fixture.store, runtime, [evidence(), evidence(), evidence(), changed]);
    const result = await startReview(coordinator, fixture.connection);
    await coordinator.waitForFinalizations();
    expect(fixture.store.getReviewRun(result.reviewRunId)).toMatchObject({
      state: "completed",
      freshness: "stale",
      result: "looks good"
    });
    const completedEvents = fixture.store.listEvents({ sessionId: "source" })
      .filter((event) => event.payload.type === "review_run_changed" && event.payload.reviewRun.state === "completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.payload).toEqual(expect.objectContaining({
      reviewRun: expect.objectContaining({ state: "completed", freshness: "stale", result: "looks good" })
    }));
    expect(fixture.store.getReviewRunBundle(result.reviewRunId).sourceLease.state).toBe("released");
    expect(runtime.order.at(-1)).toBe("close");
  });

  it("keeps a completed conclusion when final artifact evidence becomes unavailable", async () => {
    const fixture = setup();
    const runtime = new FakeRuntime(fixture.store, { state: "completed", visibleResult: "artifact conclusion" });
    const coordinator = coordinatorFor(fixture.store, runtime, [
      evidence(),
      evidence(),
      evidence(),
      new ReviewEvidenceCaptureError("artifact-unavailable", "artifact changed")
    ]);
    const result = await startReview(coordinator, fixture.connection);
    await coordinator.waitForFinalizations();
    expect(fixture.store.getReviewRun(result.reviewRunId)).toMatchObject({
      state: "completed",
      freshness: "unavailable",
      result: "artifact conclusion"
    });
    expect(runtime.order.at(-1)).toBe("close");
  });

  it("reobserves the exact durable source and attachments while preserving a monotonic completed conclusion", async () => {
    const fixture = setup();
    const runtime = new FakeRuntime(fixture.store, { state: "completed", visibleResult: "Durable conclusion" });
    const attachment = {
      kind: "file" as const,
      displayName: "proof.txt",
      blob: {
        id: "proof-blob",
        sha256: hash("e"),
        byteLength: 4,
        mimeType: "text/plain",
        fileName: "proof.txt"
      }
    };
    const stable = { ...evidence(), artifacts: [attachment] } satisfies BuildReviewEvidenceInput;
    const changed = {
      ...stable,
      conversation: { ...stable.conversation, sessionGeneration: 2 }
    } satisfies BuildReviewEvidenceInput;
    const reobservedRequests: StartReviewRequest[] = [];
    let observedAt = 0;
    const coordinator = coordinatorFor(
      fixture.store,
      runtime,
      [
        stable, stable, stable, stable,
        stable,
        new ReviewEvidenceCaptureError("artifact-unavailable", "temporarily unavailable"),
        stable,
        changed,
        stable
      ],
      undefined,
      {
        now: () => observedAt,
        onCapture: (captureRequest, purpose) => {
          if (purpose === "reobserve") reobservedRequests.push(captureRequest);
        }
      }
    );
    const started = await coordinator.start({
      operationId: "start-review-with-attachment",
      connection: fixture.connection,
      request: { sourceSessionId: "source", focus: "transient focus", attachments: [attachment] }
    });
    await coordinator.waitForFinalizations();
    const terminal = fixture.store.getReviewRun(started.reviewRunId);
    const originalBundle = fixture.store.getReviewRunBundle(started.reviewRunId);
    observedAt = terminal.freshnessCheckedAt + 1;

    const observe = async (operationId: string) => {
      const result = await coordinator.reobserve({
        operationId,
        connection: fixture.connection,
        reviewRunId: started.reviewRunId
      });
      observedAt += 1;
      return result.run;
    };

    expect(await observe("reobserve-same")).toMatchObject({
      state: "completed",
      freshness: "current",
      freshnessCheckedAt: terminal.freshnessCheckedAt + 1,
      result: "Durable conclusion"
    });
    expect((await observe("reobserve-unavailable")).freshness).toBe("unavailable");
    expect((await observe("reobserve-recovered")).freshness).toBe("current");
    expect((await observe("reobserve-changed")).freshness).toBe("stale");
    expect((await observe("reobserve-stale-monotonic")).freshness).toBe("stale");

    expect(reobservedRequests).toHaveLength(5);
    for (const captureRequest of reobservedRequests) {
      expect(captureRequest).toEqual({ sourceSessionId: "source", attachments: [attachment] });
    }
    const finalBundle = fixture.store.getReviewRunBundle(started.reviewRunId);
    expect(finalBundle.evidenceSeal).toEqual(originalBundle.evidenceSeal);
    expect(finalBundle.run).toMatchObject({
      state: terminal.state,
      endedAt: terminal.endedAt,
      result: terminal.result,
      freshness: "stale"
    });
    for (const operationId of [
      "reobserve-same",
      "reobserve-unavailable",
      "reobserve-recovered",
      "reobserve-changed",
      "reobserve-stale-monotonic"
    ]) {
      expect(fixture.store.getOperation(operationId).status).toBe("completed");
      expect(fixture.store.listEvents({ sessionId: "source" }).some((event) => event.operationId === operationId)).toBe(true);
    }
  });

  it("marks a completed conclusion stale when final capture proves an in-read source change", async () => {
    const fixture = setup();
    const runtime = new FakeRuntime(fixture.store, { state: "completed", visibleResult: "race conclusion" });
    const coordinator = coordinatorFor(fixture.store, runtime, [
      evidence(),
      evidence(),
      evidence(),
      new ReviewEvidenceCaptureError("source-changed", "file changed while hashing")
    ]);
    const result = await startReview(coordinator, fixture.connection);
    await coordinator.waitForFinalizations();
    expect(fixture.store.getReviewRun(result.reviewRunId)).toMatchObject({
      state: "completed",
      freshness: "stale",
      result: "race conclusion"
    });
  });

  it.each([
    [{ state: "completed", visibleResult: "" }, "no-visible-result"],
    [{ state: "aborted" }, "cancelled-before-start"],
    [{ state: "closed" }, "reviewer-closed"],
    [{ state: "failed" }, "provider-failed"]
  ] as const)("maps runtime outcome %j to %s", async (outcome, failureCode) => {
    const fixture = setup();
    const runtime = new FakeRuntime(fixture.store, outcome);
    const captures = outcome.state === "completed"
      ? [evidence(), evidence(), evidence(), evidence()]
      : [evidence(), evidence(), evidence()];
    const coordinator = coordinatorFor(fixture.store, runtime, captures);
    const result = await startReview(coordinator, fixture.connection);
    expect(result.run.state).toBe("failed");
    expect(fixture.store.getOperation("start-review-op").status).toBe("completed");
    await coordinator.waitForFinalizations();
    expect(fixture.store.getReviewRun(result.reviewRunId)).toMatchObject({ state: "failed", failureCode });
  });

  it("returns the durable running card at Backend acceptance without waiting for reviewer terminal output", async () => {
    const fixture = setup();
    let finish!: (outcome: ReviewRuntimeOutcome) => void;
    const terminal = new Promise<ReviewRuntimeOutcome>((resolve) => { finish = resolve; });
    const runtime = new FakeRuntime(fixture.store, terminal);
    const coordinator = coordinatorFor(fixture.store, runtime, [evidence(), evidence(), evidence(), evidence()]);
    const result = await startReview(coordinator, fixture.connection);
    expect(result.run).toMatchObject({ state: "running", reviewerSessionId: "reviewer-session" });
    expect(fixture.store.getReviewRunBundle(result.reviewRunId).sourceLease.state).toBe("active");
    finish({ state: "completed", visibleResult: "async result" });
    await coordinator.waitForFinalizations();
    expect(fixture.store.getReviewRun(result.reviewRunId)).toMatchObject({ state: "completed", result: "async result" });
  });

  it("runs durable review recovery before asking runtime cleanup", async () => {
    const fixture = setup();
    fixture.store.createReviewRun({
      id: "review-crashed",
      sourceSessionId: "source",
      targetKind: "task",
      evidenceSeal: seal(),
      attachments: []
    });
    const runtime = new FakeRuntime(fixture.store, { state: "failed" });
    const recovered = await coordinatorFor(fixture.store, runtime, []).reconcileStartup();
    expect(recovered[0]).toMatchObject({ id: "review-crashed", state: "failed", failureCode: "interrupted" });
  });
});

class FakeRuntime implements ReviewRuntimeController {
  readonly order: string[] = [];
  readonly operationIds: string[] = [];
  creation?: CreateFreshReviewerInput;

  constructor(
    readonly store: OperationalStore,
    readonly outcome: ReviewRuntimeOutcome | Promise<ReviewRuntimeOutcome>,
    readonly accepted: Promise<void> = Promise.resolve()
  ) {}

  async mutate<T>(input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly kind: string;
    readonly body: unknown;
    readonly commit: (store: OperationalStore) => T;
    readonly precondition?: (store: OperationalStore) => void;
    readonly effect?: () => Promise<void>;
  }): Promise<OperationExecution<T>> {
    const claim = this.store.claimAuthorizedDeferredEffectOperation<T>(
      input.connection.id,
      input.connection.authKeyDigest,
      { id: input.operationId, kind: input.kind, body: input.body },
      input.precondition
    );
    if (!claim.claimed) return { replayed: true, value: claim.value, operation: claim.operation };
    try {
      await input.effect?.();
      return this.store.completeAuthorizedDeferredEffectOperation(
        input.connection.id,
        input.connection.authKeyDigest,
        input.operationId,
        claim.operation.bodyHash,
        input.commit
      );
    } catch (error) {
      this.store.failEffectOperation(input.operationId, claim.operation.bodyHash, error);
      throw error;
    }
  }

  async createFreshReviewer(input: CreateFreshReviewerInput): Promise<{ readonly reviewerSessionId: string }> {
    expect(this.store.getReviewRun(input.reviewRunId).state).toBe("running");
    expect(this.store.getReviewRunBundle(input.reviewRunId).sourceLease.state).toBe("active");
    this.order.push("create:durable-running");
    this.creation = input;
    this.store.createSession({
      id: "reviewer-session",
      backendId: "pi",
      targetId: "target",
      title: "Reviewer",
      binding: { opaqueRef: "native/reviewer.jsonl", generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      providerId: input.providerId,
      modelId: input.modelId,
      effort: input.effort,
      fastMode: false,
      createdAt: 2,
      updatedAt: 2
    });
    return { reviewerSessionId: "reviewer-session" };
  }

  async enqueueInitialPrompt(input: { readonly operationId: string; readonly reviewRunId: string; readonly reviewerSessionId: string }): Promise<ReviewRuntimeDispatch> {
    expect(this.store.getSessionRuntimePolicy(input.reviewerSessionId).policy).toBe("review_read_only");
    this.order.push("enqueue:policy-attached");
    this.operationIds.push(input.operationId);
    return { accepted: this.accepted, outcome: Promise.resolve(this.outcome) };
  }

  async closeReviewer(): Promise<void> {
    this.order.push("close");
  }
}

function coordinatorFor(
  store: OperationalStore,
  runtime: ReviewRuntimeController,
  captures: Array<BuildReviewEvidenceInput | Error>,
  onActivityTransition?: () => void,
  options: {
    readonly onCapture?: (request: StartReviewRequest, purpose: "start" | "reobserve" | undefined) => void;
    readonly now?: () => number;
  } = {}
): ReviewCoordinator {
  let index = 0;
  return new ReviewCoordinator({
    store,
    runtime,
    evidence: {
      capture: async (request, purpose) => {
        options.onCapture?.(request, purpose);
        const capture = captures[index++] ?? (() => { throw new Error("unexpected capture"); })();
        if (capture instanceof Error) throw capture;
        return capture;
      }
    },
    idFactory: () => "fixed",
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(onActivityTransition === undefined ? {} : { onActivityTransition })
  });
}

function evidence(): BuildReviewEvidenceInput {
  return {
    conversation: {
      sessionId: "source",
      sessionGeneration: 1,
      nativeBindingIdentity: "native-source",
      messages: [{ id: "m1", ordinal: 1, role: "user", text: "task" }]
    },
    workspace: {
      workspaceId: "workspace",
      files: [{ relativePath: "src/a.ts", sha256: hash("a"), byteLength: 1 }],
      git: { headOid: "a".repeat(40), indexTreeOid: "b".repeat(40), worktreeRevision: "clean", baseOid: "c".repeat(40), mergeBaseOid: "d".repeat(40) },
      changeSet: null
    },
    workspaceEvidence: null,
    changeSetEvidence: null,
    artifacts: []
  };
}

function request(): unknown {
  return { sourceSessionId: "source", focus: "race", attachments: [] };
}

function seal() {
  const value = buildSealEvidence();
  return value;
}

function buildSealEvidence() {
  const built = buildReviewSealFromEvidence(evidence());
  return built;
}

function buildReviewSealFromEvidence(value: BuildReviewEvidenceInput) {
  // Keep this helper local so Store integration is exercised with the exact
  // Orchestrator evidence algorithm instead of test-only hashes.
  const built = requireEvidence(value);
  return {
    version: 1 as const,
    conversationSha256: built.conversationSha256,
    workspaceSha256: built.workspaceSha256,
    filesSha256: built.filesSha256,
    artifactsSha256: built.artifactsSha256,
    sealSha256: built.sealSha256
  };
}

function requireEvidence(value: BuildReviewEvidenceInput) {
  // Static import would be equivalent; split helper keeps fixture declarations compact.
  return buildEvidence(value).freshness;
}

function setup(): { readonly store: OperationalStore; readonly connection: ConnectionRecord } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-review-coordinator-"));
  const store = new OperationalStore(path.join(directory, "store.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertBackend({
    id: "pi", adapterKind: "fixture", instanceGeneration: 0,
    displayName: "Pi", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  store.upsertTarget({ id: "target", backendId: "pi", displayName: "Target", workspaceRoot: "D:/workspace", managed: false, trusted: true });
  store.createSession({
    id: "source", backendId: "pi", targetId: "target", title: "Source",
    binding: { opaqueRef: "native/source.jsonl", generation: 1 },
    pinned: false, archived: false, permissionMode: "bypassPermissions", planMode: true,
    providerId: "provider", modelId: "model", effort: "high", fastMode: true,
    createdAt: 1, updatedAt: 1
  });
  const connection = store.createConnection({ id: "review-test-connection", name: "Review test", authKeyDigest: "review-test-auth" });
  return { store, connection };
}

function startReview(coordinator: ReviewCoordinator, connection: ConnectionRecord, operationId = "start-review-op") {
  return coordinator.start({ operationId, connection, request: request() });
}
