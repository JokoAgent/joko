import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_COLLABORATION_SETTINGS, type CollaborationSettings } from "@joko/runtime-governance";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { CollaborationGoalManager } from "./collaboration-goal-manager.js";
import { CollaborationToolBridgeProvider } from "./collaboration-tool-provider.js";
import type { BridgeToolCallContext, McpCallResult } from "./mcp-router.js";
import { SessionHost } from "./session-host.js";
import { mkdtempSync } from "./test-paths.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("CollaborationToolBridgeProvider", () => {
  it("binds Goal and worker controls to the authenticated lead/worker Session identities", async () => {
    const fixture = await createFixture();
    const leadContext = context(fixture.store, fixture.leadSessionId, "a");
    const listed = resultData(await fixture.provider.callTool("list_tools", {}, undefined, leadContext)) as {
      active_role: string;
      tools: readonly { name: string }[];
    };
    expect(listed.active_role).toBe("none");
    expect(listed.tools.map((tool) => tool.name)).toContain("start_goal");

    const started = await nestedCall(fixture.provider, leadContext, "start_goal", {
      title: "Authenticated collaboration",
      objective: "Exercise the exact lead and worker tool authority."
    }) as PublicTree;
    expect(started.goal).toMatchObject({ status: "active", lead_session_id: fixture.leadSessionId });

    const created = await nestedCall(
      fixture.provider,
      context(fixture.store, fixture.leadSessionId, "b"),
      "create_worker",
      {
        label: "Verifier",
        role: "verification",
        assignment: "Verify the collaboration authority."
      }
    ) as { worker: PublicWorker; tree: PublicTree };
    expect(created.worker).toMatchObject({
      goal_id: started.goal.id,
      label: "Verifier",
      role: "verification",
      runtime_released: false
    });
    expect(created.worker.session_id).toEqual(expect.any(String));
    expect(created.tree.queue).toHaveLength(1);

    const workerSessionId = created.worker.session_id!;
    const workerContext = context(fixture.store, workerSessionId, "c");
    const workerGoal = await nestedCall(fixture.provider, workerContext, "get_goal", {}) as {
      goal: Record<string, unknown>;
      worker: PublicWorker;
      workers?: unknown;
      queue?: unknown;
    };
    expect(workerGoal.worker.id).toBe(created.worker.id);
    expect(workerGoal.workers).toBeUndefined();
    expect(workerGoal.queue).toBeUndefined();
    expect(errorData(await rawNestedCall(fixture.provider, workerContext, "create_worker", {
      label: "Nested",
      role: "forbidden",
      assignment: "Must not be created."
    }))).toMatchObject({ errorCode: "NOT_AUTHORIZED" });

    await nestedCall(fixture.provider, context(fixture.store, workerSessionId, "d"), "send_to_lead", {
      message: "The worker authority is verified."
    });
    expect(fixture.store.listQueueItems({ sessionId: fixture.leadSessionId })
      .some((item) => item.body.text === "[From Verifier]\nThe worker authority is verified.")).toBe(true);

    expect(errorData(await fixture.provider.callTool("list_tools", {}, undefined, {
      ...leadContext,
      generation: leadContext.generation + 1
    }))).toMatchObject({ errorCode: "STALE_SCOPE" });
  });

  it("validates a worker batch before dispatch and stops invoking the host after the hard limit", async () => {
    const fixture = await createFixture({
      ...DEFAULT_COLLABORATION_SETTINGS,
      workerSoftLimit: 1,
      workerHardLimit: 2
    });
    await nestedCall(
      fixture.provider,
      context(fixture.store, fixture.leadSessionId, "e"),
      "start_goal",
      { title: "Bounded batch", objective: "Respect the machine hard limit." }
    );
    const duplicate = await rawNestedCall(
      fixture.provider,
      context(fixture.store, fixture.leadSessionId, "f"),
      "create_workers",
      {
        workers: [
          { label: "Same", role: "one", assignment: "one" },
          { label: "same", role: "two", assignment: "two" }
        ]
      }
    );
    expect(errorData(duplicate)).toMatchObject({ errorCode: "INVALID_ARGS" });
    expect(fixture.store.listCollaborationWorkers()).toHaveLength(0);

    const batch = await nestedCall(
      fixture.provider,
      context(fixture.store, fixture.leadSessionId, "1"),
      "create_workers",
      {
        workers: [
          { label: "One", role: "builder", assignment: "Build one." },
          { label: "Two", role: "builder", assignment: "Build two." },
          { label: "Three", role: "builder", assignment: "Build three." },
          { label: "Four", role: "builder", assignment: "Build four." }
        ]
      }
    ) as {
      request_count: number;
      attempted_count: number;
      dispatched_count: number;
      skipped_count: number;
      results: readonly Record<string, unknown>[];
    };
    expect(batch).toMatchObject({
      request_count: 4,
      attempted_count: 3,
      dispatched_count: 2,
      skipped_count: 1
    });
    expect(batch.results).toEqual([
      expect.objectContaining({ index: 0, ok: true }),
      expect.objectContaining({ index: 1, ok: true }),
      expect.objectContaining({ index: 2, ok: false, error_code: "WORKER_HARD_LIMIT_REACHED" }),
      expect.objectContaining({ index: 3, ok: false, skipped: true, error_code: "WORKER_HARD_LIMIT_REACHED" })
    ]);
    expect(fixture.store.listCollaborationWorkers()).toHaveLength(2);
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })).toHaveLength(3);
  });
});

async function createFixture(settings: CollaborationSettings = DEFAULT_COLLABORATION_SETTINGS) {
  const directory = mkdtempSync(join(tmpdir(), "joko-collaboration-tools-"));
  const store = new OperationalStore(join(directory, "operational.db"));
  const artifacts = new ArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [directory]
  });
  await artifacts.initialize();
  const host = new SessionHost(store, artifacts, [new FakeBackendAdapter(PI_LIKE_PROFILE)]);
  await host.initialize();
  await host.registerTarget({
    id: "target-one",
    backendId: PI_LIKE_PROFILE.id,
    displayName: "Collaboration target",
    workspaceRoot: directory,
    managed: true,
    trusted: true
  });
  const connection = store.createConnection({
    id: "collaboration-tool-test-connection",
    name: "Collaboration tool test",
    authKeyDigest: "digest"
  });
  const leadSessionId = (await host.createSession({
    operationId: "create-collaboration-tool-lead",
    connection,
    targetId: "target-one",
    title: "Lead",
    fastMode: false,
    permissionMode: "ask",
    planMode: false
  })).value.sessionId;
  const manager = new CollaborationGoalManager({ store, sessionHost: host, readSettings: () => settings });
  await manager.initialize();
  const provider = new CollaborationToolBridgeProvider({ store, manager });
  cleanups.push(async () => {
    await manager.close();
    await host.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, host, manager, provider, leadSessionId };
}

function context(store: OperationalStore, sessionId: string, seed: string): BridgeToolCallContext {
  const session = store.getSession(sessionId).descriptor;
  return {
    sessionId,
    targetId: session.targetId,
    generation: session.binding.generation,
    providerGeneration: 1,
    requestIdentity: seed.repeat(64),
    effectIdentity: seed.repeat(64),
    requestBodyHash: `sha256:${seed.repeat(64)}`
  };
}

async function nestedCall(
  provider: CollaborationToolBridgeProvider,
  callContext: BridgeToolCallContext,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<unknown> {
  return resultData(await rawNestedCall(provider, callContext, name, args));
}

function rawNestedCall(
  provider: CollaborationToolBridgeProvider,
  callContext: BridgeToolCallContext,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<McpCallResult> {
  return provider.callTool("call_tool", { name, args }, undefined, callContext);
}

function resultData(result: McpCallResult): unknown {
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent?.["data"];
}

function errorData(result: McpCallResult): Readonly<Record<string, unknown>> {
  expect(result.isError).toBe(true);
  return result.structuredContent ?? {};
}

interface PublicTree {
  readonly goal: { readonly id: string; readonly status: string; readonly lead_session_id: string };
  readonly queue: readonly unknown[];
}

interface PublicWorker {
  readonly id: string;
  readonly goal_id: string;
  readonly session_id: string | null;
  readonly label: string;
  readonly role: string;
  readonly runtime_released: boolean;
}
