import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import {
  ManualRecurrenceSchema,
  PermissionMode,
  ScheduleExecutionMode,
  ScheduleInputSchema,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRecurrenceSchema,
  ScheduleSessionMode
} from "@joko/contracts";
import { OperationalStore, type UpsertScheduleInput } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROJECT_AUTOMATION_CONFIG_PATH,
  ProjectAutomationConfigController,
  projectScheduleId,
  scheduleProjectAutomationOrigin,
  withoutScheduleProjectAutomationOrigin,
  withScheduleProjectAutomationOrigin,
  type ProjectScheduleMaterializer
} from "./project-automation-config.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

describe("ProjectAutomationConfigController", () => {
  it("writes a project-owned config, reconciles its source, and preserves a local pause", async () => {
    const fixture = createFixture();
    await fixture.controller.upsert("target", "daily-review", scheduleInput("Daily review", "Review open work"));

    const file = JSON.parse(readFileSync(join(fixture.workspace, ...PROJECT_AUTOMATION_CONFIG_PATH.split("/")), "utf8")) as {
      version: number;
      schedules: Array<{ id: string; schedule: { backendId: string; targetId: string } }>;
    };
    expect(file.version).toBe(1);
    expect(file.schedules).toEqual([
      expect.objectContaining({
        id: "daily-review",
        schedule: expect.objectContaining({ backendId: "pi", targetId: "target" })
      })
    ]);

    expect(await fixture.controller.reconcileTarget("target", materialize)).toEqual({
      targetId: "target",
      inserted: 1,
      updated: 0,
      deleted: 0,
      skipped: null
    });
    const id = projectScheduleId("target", "daily-review");
    const inserted = fixture.store.getSchedule(id);
    expect(inserted.name).toBe("Daily review");
    expect(scheduleProjectAutomationOrigin(inserted.executionSnapshot)).toEqual({
      targetId: "target",
      configId: "daily-review"
    });

    fixture.store.upsertSchedule({ ...inserted, enabled: false, expectedRevision: inserted.revision });
    expect(await fixture.controller.reconcileTarget("target", materialize)).toMatchObject({
      inserted: 0,
      updated: 0,
      deleted: 0
    });
    expect(fixture.store.getSchedule(id).enabled).toBe(false);
  });

  it("updates and deletes durable project schedules when the checked-in file changes", async () => {
    const fixture = createFixture();
    await fixture.controller.upsert("target", "one", scheduleInput("One", "First"));
    await fixture.controller.upsert("target", "two", scheduleInput("Two", "Second"));
    await fixture.controller.reconcileTarget("target", materialize);

    await fixture.controller.upsert("target", "one", scheduleInput("One changed", "Updated"));
    await fixture.controller.remove("target", "two");
    expect(await fixture.controller.reconcileTarget("target", materialize)).toMatchObject({
      inserted: 0,
      updated: 1,
      deleted: 1,
      skipped: null
    });
    expect(fixture.store.getSchedule(projectScheduleId("target", "one")).name).toBe("One changed");
    expect(fixture.store.findSchedule(projectScheduleId("target", "two"))).toBeUndefined();
  });

  it("restores the previous config when the durable upsert commit fails", async () => {
    const fixture = createFixture();
    await fixture.controller.upsert("target", "guarded", scheduleInput("Before", "Original"));

    await expect(fixture.controller.upsertWithCommit(
      "target",
      "guarded",
      scheduleInput("After", "Changed"),
      async () => { throw new Error("store commit failed"); }
    )).rejects.toThrow("store commit failed");

    expect(readConfig(fixture.workspace).schedules).toEqual([
      expect.objectContaining({ id: "guarded", schedule: expect.objectContaining({ displayName: "Before" }) })
    ]);
  });

  it("removes a newly created config when its first durable commit fails", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.workspace, ...PROJECT_AUTOMATION_CONFIG_PATH.split("/"));

    await expect(fixture.controller.upsertWithCommit(
      "target",
      "guarded",
      scheduleInput("Guarded", "Changed"),
      async () => { throw new Error("initial store commit failed"); }
    )).rejects.toThrow("initial store commit failed");

    expect(existsSync(configPath)).toBe(false);
  });

  it("restores a removed config entry when the durable delete commit fails", async () => {
    const fixture = createFixture();
    await fixture.controller.upsert("target", "guarded", scheduleInput("Guarded", "Original"));

    await expect(fixture.controller.removeWithCommit(
      "target",
      "guarded",
      async () => { throw new Error("store delete failed"); }
    )).rejects.toThrow("store delete failed");

    expect(readConfig(fixture.workspace).schedules).toEqual([
      expect.objectContaining({ id: "guarded", schedule: expect.objectContaining({ displayName: "Guarded" }) })
    ]);
  });

  it("does not let project update, create, or reconcile resurrect a Schedule with pending deletion", async () => {
    const fixture = createFixture();
    await fixture.controller.upsert("target", "guarded", scheduleInput("Guarded", "Original"));
    await fixture.controller.reconcileTarget("target", materialize);
    const scheduleId = projectScheduleId("target", "guarded");
    const schedule = fixture.store.getSchedule(scheduleId);
    fixture.store.prepareScheduleDeletionCleanup({
      operationId: "delete-project-guarded",
      scheduleId,
      disposition: "keep",
      occurrenceRunIds: [],
      projectTargetId: "target",
      projectConfigId: "guarded",
      at: 21_000
    });

    // The deletion effect removes the checked-in entry before its potentially
    // long generated-task cleanup. A racing create/update must restore that
    // missing state when the Store's deletion fence rejects its commit.
    await fixture.controller.remove("target", "guarded");
    const changed = scheduleInput("Guarded changed", "Concurrent update");
    await expect(fixture.controller.upsertWithCommit(
      "target",
      "guarded",
      changed,
      async () => {
        fixture.store.upsertSchedule({
          ...materialize(scheduleId, changed, 22_000, schedule),
          expectedRevision: fixture.store.getSchedule(scheduleId).revision
        });
      }
    )).rejects.toThrow(/deletion is in progress/u);
    expect(readConfig(fixture.workspace).schedules).toEqual([]);

    await expect(fixture.controller.reconcileTarget("target", materialize))
      .rejects.toThrow(/deletion is in progress/u);
    expect(fixture.store.getSchedule(scheduleId).enabled).toBe(false);

    fixture.store.finalizeScheduleDeletionCleanup({
      operationId: "delete-project-guarded",
      completedSessionIds: [],
      failures: [],
      at: 23_000
    });
    await fixture.controller.reconcileTarget("target", materialize);
    expect(fixture.store.findSchedule(scheduleId)).toBeUndefined();
  });

  it("fails a malformed authoritative file closed and removes its stale projection", async () => {
    const fixture = createFixture();
    await fixture.controller.upsert("target", "guarded", scheduleInput("Guarded", "Check"));
    await fixture.controller.reconcileTarget("target", materialize);
    const configPath = join(fixture.workspace, ...PROJECT_AUTOMATION_CONFIG_PATH.split("/"));
    writeFileSync(configPath, "{not-json\n", "utf8");

    expect(await fixture.controller.reconcileTarget("target", materialize)).toEqual({
      targetId: "target",
      inserted: 0,
      updated: 0,
      deleted: 1,
      skipped: "invalid"
    });
    expect(fixture.store.listSchedules()).toHaveLength(0);
  });

  it("rejects bound task routing, unsafe IDs, and credential material", async () => {
    const fixture = createFixture();
    await expect(fixture.controller.upsert("target", "Bad_ID", scheduleInput("Bad", "No")))
      .rejects.toThrow("lowercase kebab-case");
    await expect(fixture.controller.upsert("target", "bound", create(ScheduleInputSchema, {
      ...scheduleInput("Bound", "No"),
      sessionMode: ScheduleSessionMode.BOUND,
      sessionId: "session"
    }))).rejects.toThrow("cannot bind");
    await expect(fixture.controller.upsert("target", "secret", scheduleInput("Secret", "use sk-abcdefghijklmnop")))
      .rejects.toThrow("credential material");
  });

  it("adds and removes source metadata without disturbing execution settings", () => {
    const snapshot = { permissionMode: "ask", scheduler: { format: 1 } };
    const owned = withScheduleProjectAutomationOrigin(snapshot, { targetId: "target", configId: "nightly" });
    expect(scheduleProjectAutomationOrigin(owned)).toEqual({ targetId: "target", configId: "nightly" });
    expect(withoutScheduleProjectAutomationOrigin(owned)).toEqual(snapshot);
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "joko-project-automations-"));
  const workspace = join(root, "workspace");
  const store = new OperationalStore(join(root, "operational.sqlite"), { now: () => 10_000 });
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  mkdirSync(workspace, { recursive: true });
  store.upsertTarget({
    id: "target",
    backendId: "pi",
    displayName: "Project",
    workspaceRoot: workspace,
    managed: false,
    trusted: true
  });
  const controller = new ProjectAutomationConfigController({ store, now: () => 20_000 });
  cleanups.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, workspace, store, controller };
}

const materialize: ProjectScheduleMaterializer = (id, input, at, existing): UpsertScheduleInput => ({
  id,
  backendId: input.backendId,
  targetId: input.targetId,
  sessionMode: input.sessionMode === ScheduleSessionMode.PERSISTENT ? "persistent" : "fresh",
  name: input.displayName,
  kind: "manual",
  timezone: input.timeZone,
  enabled: input.enabled,
  prompt: {
    text: scheduleText(input),
    images: [],
    files: [],
    mentions: [],
    disposition: "prompt"
  },
  executionSnapshot: { scheduler: { format: 1 }, marker: input.displayName },
  overlapPolicy: "queue",
  misfirePolicy: "run_once",
  now: at,
  ...(existing === undefined ? {} : { expectedRevision: existing.revision })
});

function scheduleInput(name: string, prompt: string) {
  return create(ScheduleInputSchema, {
    displayName: name,
    backendId: "ignored",
    targetId: "ignored",
    sessionMode: ScheduleSessionMode.FRESH,
    recurrence: create(ScheduleRecurrenceSchema, {
      kind: { case: "manual", value: create(ManualRecurrenceSchema, {}) }
    }),
    timeZone: "UTC",
    input: { parts: [{ content: { case: "text", value: prompt } }] },
    execution: {
      executionMode: ScheduleExecutionMode.AGENT,
      permissionMode: PermissionMode.ASK,
      notify: { desktop: true }
    },
    overlapPolicy: ScheduleOverlapPolicy.QUEUE,
    misfirePolicy: ScheduleMisfirePolicy.RUN_ONCE,
    enabled: true
  });
}

function scheduleText(input: ReturnType<typeof scheduleInput>): string {
  const content = input.input?.parts[0]?.content;
  return content?.case === "text" ? content.value : "";
}

function readConfig(workspace: string): {
  readonly version: number;
  readonly schedules: readonly { readonly id: string; readonly schedule: { readonly displayName: string } }[];
} {
  return JSON.parse(readFileSync(join(workspace, ...PROJECT_AUTOMATION_CONFIG_PATH.split("/")), "utf8")) as {
    readonly version: number;
    readonly schedules: readonly { readonly id: string; readonly schedule: { readonly displayName: string } }[];
  };
}
