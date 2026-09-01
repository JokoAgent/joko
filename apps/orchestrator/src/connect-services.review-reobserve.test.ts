import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, type ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore, type ConnectionRecord } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import { buildReviewEvidence } from "./review-evidence.js";
import type { ReviewCoordinator } from "./review-coordinator.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("Connect Review reobservation", () => {
  it("routes the typed mutation through the durable operation and returns the Review run", async () => {
    const fixture = setup();
    const response = await submit(fixture, "reobserve-review", fixture.runRevision);

    expect(fixture.reobserve).toHaveBeenCalledTimes(1);
    expect(response.operation?.mutation?.payload.case).toBe("reobserveReview");
    expect(response.operation?.result?.payload).toMatchObject({
      case: "reviewRun",
      value: {
        reviewRunId: "review-run",
        resultMarkdown: "Durable conclusion",
        state: contract.ReviewRunState.COMPLETED,
        freshness: { state: contract.ReviewFreshnessState.CURRENT }
      }
    });
    expect(fixture.store.getOperation("reobserve-review")).toMatchObject({
      kind: "reobserve_review",
      status: "completed"
    });
  });

  it("enforces Review run revision preconditions inside the operation boundary", async () => {
    const fixture = setup();
    await expect(submit(fixture, "reobserve-stale", fixture.runRevision - 1n)).rejects.toMatchObject({
      code: Code.Aborted
    } satisfies Partial<ConnectError>);
    expect(fixture.store.getOperation("reobserve-stale").status).toBe("failed");
  });
});

function setup(): {
  readonly store: OperationalStore;
  readonly connection: ConnectionRecord;
  readonly runRevision: bigint;
  readonly reobserve: ReturnType<typeof vi.fn>;
  readonly services: ReturnType<typeof createConnectServices>;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-connect-review-reobserve-"));
  const store = new OperationalStore(path.join(directory, "store.sqlite"), { now: () => 10 });
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertBackend({
    id: "backend", adapterKind: "fixture", instanceGeneration: 0,
    displayName: "Backend", version: "1", health: "healthy",
    installationState: "installed", authenticationState: "authenticated",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  store.upsertTarget({
    id: "target", backendId: "backend", displayName: "Target",
    workspaceRoot: "D:/workspace", managed: false, trusted: true
  });
  store.createSession({
    id: "source", backendId: "backend", targetId: "target", title: "Source",
    binding: { opaqueRef: "native-source", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false,
    fastMode: false, createdAt: 1, updatedAt: 1
  });
  store.createSession({
    id: "reviewer", backendId: "backend", targetId: "target", title: "Reviewer",
    binding: { opaqueRef: "native-reviewer", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false,
    fastMode: false, createdAt: 1, updatedAt: 1
  });
  const created = store.createReviewRun({
    id: "review-run",
    sourceSessionId: "source",
    targetKind: "task",
    evidenceSeal: buildReviewEvidence({
      conversation: {
        sessionId: "source",
        sessionGeneration: 1,
        nativeBindingIdentity: "native-source",
        messages: []
      },
      workspace: { workspaceId: "workspace", files: [], git: null, changeSet: null },
      workspaceEvidence: null,
      changeSetEvidence: null,
      artifacts: []
    }).freshness,
    attachments: []
  });
  const attached = store.attachReviewSession({
    reviewRunId: "review-run",
    reviewerSessionId: "reviewer",
    sourceLeaseFencingToken: created.sourceLease.fencingToken,
    expectedRunRevision: created.run.revision
  });
  const run = store.finishReviewRun({
    reviewRunId: "review-run",
    state: "completed",
    result: "Durable conclusion",
    freshness: "current",
    sourceLeaseFencingToken: created.sourceLease.fencingToken,
    expectedRunRevision: attached.revision
  });
  const connection = store.createConnection({
    id: "review-connection",
    name: "Review test",
    authKeyDigest: "review-auth"
  });
  const reobserve = vi.fn(async (input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly operationBody?: unknown;
    readonly reviewRunId: string;
    readonly precondition?: (value: OperationalStore) => void;
  }) => {
    const execution = store.runAuthorizedOperation(
      input.connection.id,
      input.connection.authKeyDigest,
      { id: input.operationId, kind: "reobserve_review", body: input.operationBody },
      (currentStore) => {
        input.precondition?.(currentStore);
        return { reviewRunId: input.reviewRunId };
      }
    );
    return {
      reviewRunId: execution.value.reviewRunId,
      run: store.getReviewRun(execution.value.reviewRunId)
    };
  });
  const application = {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store,
    connections: { authenticate: () => connection },
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    workspaces: {},
    workspaceChanges: {},
    sessionHost: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    reviewCoordinator: { reobserve } as unknown as ReviewCoordinator,
    close: async () => undefined
  } as unknown as OrchestratorApplication;
  return {
    store,
    connection,
    runRevision: run.revision,
    reobserve,
    services: createConnectServices(application)
  };
}

async function submit(
  fixture: ReturnType<typeof setup>,
  operationId: string,
  expectedRevision: bigint
): Promise<contract.SubmitOperationResponse> {
  const handler = fixture.services.operation.submitOperation;
  if (typeof handler !== "function") throw new Error("Operation handler is missing.");
  return (handler as (request: unknown, context: unknown) => Promise<contract.SubmitOperationResponse>)({
    operationId,
    connectionId: fixture.connection.id,
    mutation: create(contract.OperationMutationSchema, {
      preconditions: [create(contract.OperationPreconditionSchema, {
        entity: create(contract.EntityRefSchema, {
          kind: contract.EntityKind.REVIEW_RUN,
          id: "review-run"
        }),
        expectedRevision: create(contract.RevisionSchema, { value: expectedRevision })
      })],
      payload: {
        case: "reobserveReview",
        value: create(contract.ReobserveReviewMutationSchema, { reviewRunId: "review-run" })
      }
    })
  }, {
    requestHeader: new Headers({ authorization: "Bearer review-test" }),
    signal: new AbortController().signal
  });
}
