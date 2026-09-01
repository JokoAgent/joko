import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeToolCallContext, McpCallResult } from "./mcp-router.js";
import { scheduleExtensionSnapshot, scheduleWorktreeConfiguration } from "./schedule-extensions.js";
import { ScheduleHookScriptInstaller } from "./schedule-hook-script-installer.js";
import { ScheduleRunNotificationController } from "./schedule-run-notifications.js";
import {
  SCHEDULER_TOOL_NAMES,
  SchedulerToolBridgeProvider,
  type SchedulerToolCoordinator
} from "./scheduler-tool-provider.js";

const NOW = Date.UTC(2026, 7, 25, 2, 30, 0);

const openStores: OperationalStore[] = [];
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SchedulerToolBridgeProvider", () => {
  it("rejects incomplete persisted Schedule extension shapes", () => {
    expect(() => scheduleExtensionSnapshot({
      useWorktree: false,
      refreshWorktreeRemote: false
    })).toThrow("Stored Schedule extensions are invalid.");
    expect(() => scheduleWorktreeConfiguration({
      useWorktree: false
    })).toThrow("Stored Schedule isolated workspace configuration is invalid.");
  });

  it("advertises all twelve direct tools with read and mutation permissions separated", () => {
    const { provider } = fixture();
    expect(provider.tools.map((tool) => tool.name)).toEqual(SCHEDULER_TOOL_NAMES);
    expect(provider.tools.map((tool) => tool.runtimeName)).toEqual(SCHEDULER_TOOL_NAMES);
    expect(provider.tools.filter((tool) => !tool.requiresPermission).map((tool) => tool.name)).toEqual([
      "schedule_list",
      "schedule_get",
      "schedule_list_runs"
    ]);
    expect(provider.tools.filter((tool) => tool.requiresPermission).map((tool) => tool.name)).toEqual([
      "schedule_create",
      "schedule_update",
      "schedule_delete",
      "schedule_pause",
      "schedule_resume",
      "schedule_run_now",
      "schedule_set_pre_run_hook",
      "schedule_notify_current_run",
      "schedule_silence_current_run"
    ]);
    expect(provider.includeForTarget("target-a")).toBe(true);
    expect(provider.includeForTarget("target-untrusted")).toBe(false);
    expect(provider.includeForTarget("missing")).toBe(false);
  });

  it("creates a durable cron schedule from authenticated routing and caller execution defaults", async () => {
    const { store, provider } = fixture();
    const result = await call(provider, "schedule_create", {
      name: "Morning review",
      prompt: "Review open changes",
      cronExpr: "0 9 * * *",
      timezone: "Asia/Shanghai",
      recurring: true,
      agentKind: "backend-a"
    });

    expect(result.isError).toBe(false);
    const created = resultData(result) as Record<string, unknown>;
    expect(created).toMatchObject({
      name: "Morning review",
      prompt: "Review open changes",
      kind: "cron",
      status: "active",
      cronExpr: "0 9 * * *",
      timezone: "Asia/Shanghai",
      recurring: true,
      agentKind: "backend-a",
      providerId: "provider-a",
      model: "model-a",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      nextFireAt: Date.UTC(2026, 7, 26, 1)
    });
    const stored = store.getSchedule(String(created["id"]));
    expect(stored).toMatchObject({
      backendId: "backend-a",
      targetId: "target-a",
      sessionMode: "fresh",
      expression: "0 9 * * *",
      timezone: "Asia/Shanghai"
    });
    expect(stored.prompt).toEqual({
      text: "Review open changes",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt"
    });
    expect(stored.executionSnapshot).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      useWorktree: false,
      refreshWorktreeRemote: false,
      scheduler: {
        format: 1,
        silentWhenIdle: false,
        notify: { desktop: true },
        executionMode: "agent"
      }
    });
  });

  it("supports interval, explicit one-shot, next-cron one-shot, and manual recurrences", async () => {
    const { provider } = fixture();
    const interval = resultData(await call(provider, "schedule_create", {
      name: "Interval",
      prompt: "poll",
      kind: "interval",
      intervalMs: 60_000,
      timezone: "UTC"
    })) as Record<string, unknown>;
    const oneShot = resultData(await call(provider, "schedule_create", {
      name: "Once",
      prompt: "run once",
      kind: "one_shot",
      runAt: NOW + 5_000,
      timezone: "UTC"
    })) as Record<string, unknown>;
    const cronOnce = resultData(await call(provider, "schedule_create", {
      name: "Next slot",
      prompt: "run next slot",
      cronExpr: "0 4 * * *",
      timezone: "UTC",
      recurring: false
    })) as Record<string, unknown>;
    const manual = resultData(await call(provider, "schedule_create", {
      name: "Manual",
      prompt: "only on demand",
      kind: "manual"
    })) as Record<string, unknown>;

    expect(interval).toMatchObject({ kind: "interval", intervalMs: 60_000, nextFireAt: NOW + 60_000 });
    expect(oneShot).toMatchObject({ kind: "one_shot", runAt: NOW + 5_000, recurring: false });
    expect(cronOnce).toMatchObject({ kind: "one_shot", cronExpr: "0 4 * * *", recurring: false });
    expect(manual).toMatchObject({ kind: "manual", manual: true, status: "active" });
    expect(manual).not.toHaveProperty("nextFireAt");
  });

  it("binds current task without accepting caller-controlled routing and supports persistent mode", async () => {
    const { store, provider } = fixture();
    const bound = resultData(await call(provider, "schedule_create", {
      name: "Heartbeat",
      prompt: "follow up",
      kind: "manual",
      bindToCurrentSession: true
    })) as Record<string, unknown>;
    expect(bound).toMatchObject({ targetSessionId: "session-a", persistentSession: false });
    expect(store.getSchedule(String(bound["id"]))).toMatchObject({ sessionMode: "bound", sessionId: "session-a" });

    const persistent = resultData(await call(provider, "schedule_create", {
      name: "Persistent",
      prompt: "continue",
      kind: "manual",
      persistentSession: true
    })) as Record<string, unknown>;
    expect(persistent).toMatchObject({ persistentSession: true });
    expect(store.getSchedule(String(persistent["id"]))).toMatchObject({ sessionMode: "persistent" });

    const conflict = await call(provider, "schedule_create", {
      name: "Wrong",
      prompt: "wrong",
      kind: "manual",
      bindToCurrentSession: true,
      targetSessionId: "session-a"
    });
    expect(errorData(conflict)).toMatchObject({ errorCode: "INVALID_PARAMS" });

    const crossTarget = await call(provider, "schedule_create", {
      name: "Wrong target",
      prompt: "wrong",
      kind: "manual",
      targetSessionId: "session-b"
    });
    expect(errorData(crossTarget)).toMatchObject({ errorCode: "INVALID_PARAMS" });
  });

  it("conceals schedules across target scopes for reads and mutations", async () => {
    const { store, provider } = fixture();
    const created = resultData(await call(provider, "schedule_create", baseCron())) as Record<string, unknown>;
    const id = String(created["id"]);

    const foreignGet = await call(provider, "schedule_get", { id }, context("session-b", "target-b"));
    expect(resultData(foreignGet)).toBeNull();
    const foreignDelete = await call(provider, "schedule_delete", { id }, context("session-b", "target-b"));
    expect(errorData(foreignDelete)).toMatchObject({ errorCode: "NOT_FOUND" });
    expect(store.getSchedule(id).id).toBe(id);

    const list = resultData(await call(provider, "schedule_list", {}, context("session-b", "target-b")));
    expect(list).toEqual([]);
  });

  it("patches only supplied fields and revision-fences pause and resume", async () => {
    const { store, provider } = fixture();
    const created = resultData(await call(provider, "schedule_create", baseCron())) as Record<string, unknown>;
    const id = String(created["id"]);
    const initialNext = created["nextFireAt"];
    const initialRevision = String(created["revision"]);

    const updated = resultData(await call(provider, "schedule_update", {
      id,
      expectedRevision: initialRevision,
      prompt: "new prompt",
      permissionMode: "ask"
    })) as Record<string, unknown>;
    expect(updated).toMatchObject({ prompt: "new prompt", cronExpr: "0 9 * * *", nextFireAt: initialNext });

    const stale = await call(provider, "schedule_pause", { id, expectedRevision: initialRevision });
    expect(errorData(stale)).toMatchObject({ errorCode: "CONFLICT" });

    const paused = resultData(await call(provider, "schedule_pause", {
      id,
      expectedRevision: updated["revision"]
    })) as Record<string, unknown>;
    expect(paused).toMatchObject({ status: "paused", enabled: false, nextFireAt: initialNext });
    const resumed = resultData(await call(provider, "schedule_resume", {
      id,
      expectedRevision: paused["revision"]
    })) as Record<string, unknown>;
    expect(resumed).toMatchObject({ status: "active", enabled: true, nextFireAt: initialNext });
    expect(store.getSchedule(id).enabled).toBe(true);
  });

  it("preserves service-validated isolated workspace fields across tool-authored patches", async () => {
    const { store, provider } = fixture();
    const created = resultData(await call(provider, "schedule_create", baseCron())) as Record<string, unknown>;
    const id = String(created["id"]);
    const initial = store.getSchedule(id);
    const isolated = store.upsertSchedule({
      ...initial,
      expectedRevision: initial.revision,
      executionSnapshot: {
        ...(initial.executionSnapshot as Readonly<Record<string, unknown>>),
        useWorktree: true,
        worktreeSourceRef: "refs/heads/main",
        refreshWorktreeRemote: true
      },
      now: NOW
    });

    const updated = resultData(await call(provider, "schedule_update", {
      id,
      expectedRevision: isolated.revision.toString(10),
      prompt: "Inspect the isolated checkout"
    })) as Record<string, unknown>;

    expect(updated).toMatchObject({
      useWorktree: true,
      worktreeSourceRef: "refs/heads/main",
      refreshWorktreeRemote: true
    });
    expect(store.getSchedule(id).executionSnapshot).toMatchObject({
      useWorktree: true,
      worktreeSourceRef: "refs/heads/main",
      refreshWorktreeRemote: true
    });
  });

  it("queues run-now through the coordinator and preserves the recurrence cadence", async () => {
    const runNowWithResult = vi.fn(async (_scheduleId: string, _operationId?: string) => ({
      runId: "run-now-1",
      sessionId: "session-a"
    }));
    const { provider } = fixture({ runNowWithResult });
    const created = resultData(await call(provider, "schedule_create", baseCron())) as Record<string, unknown>;
    const result = await call(provider, "schedule_run_now", { id: created["id"] });

    expect(resultData(result)).toMatchObject({
      scheduleId: created["id"],
      runId: "run-now-1",
      sessionId: "session-a",
      nextFireAt: created["nextFireAt"]
    });
    expect(runNowWithResult).toHaveBeenCalledOnce();
    expect(runNowWithResult.mock.calls[0]?.[0]).toBe(created["id"]);
    expect(runNowWithResult.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("returns bounded durable run history and rejects invalid limits", async () => {
    const { store, provider } = fixture();
    const created = resultData(await call(provider, "schedule_create", baseCron())) as Record<string, unknown>;
    const scheduleId = String(created["id"]);
    store.createRun({
      id: "run-history-1",
      sessionId: "session-a",
      source: "schedule",
      state: "completed",
      createdAt: NOW,
      startedAt: NOW,
      endedAt: NOW + 1
    });
    store.recordScheduleRun(scheduleId, "run-history-1", "success", { private: "not projected" }, NOW + 1);

    const runs = resultData(await call(provider, "schedule_list_runs", { scheduleId, limit: 1 }));
    expect(runs).toEqual([expect.objectContaining({
      scheduleId,
      runId: "run-history-1",
      sessionId: "session-a",
      firedAt: NOW + 1,
      status: "success"
    })]);
    expect(JSON.stringify(runs)).not.toContain("not projected");
    expect(errorData(await call(provider, "schedule_list_runs", { scheduleId, limit: 501 })))
      .toMatchObject({ errorCode: "INVALID_ARGS" });
  });

  it("persists and patches notification, expiration, and managed hook extensions", async () => {
    const { store, provider } = fixture();
    const created = resultData(await call(provider, "schedule_create", {
      name: "Quiet watcher",
      prompt: "check for changes",
      kind: "manual",
      silentWhenIdle: true,
      notify: { desktop: false },
      expireAt: NOW + 86_400_000
    })) as Record<string, unknown>;
    expect(created).toMatchObject({
      silentWhenIdle: true,
      notify: { desktop: false },
      expireAt: NOW + 86_400_000
    });

    const installed = resultData(await call(provider, "schedule_set_pre_run_hook", {
      scheduleId: created["id"],
      script: [
        "let body = '';",
        "process.stdin.setEncoding('utf8');",
        "for await (const chunk of process.stdin) body += chunk;",
        "JSON.parse(body);",
        "process.exit(0);"
      ].join("\n"),
      timeoutMs: 5_000
    })) as Record<string, unknown>;
    expect(installed).toMatchObject({
      attached: true,
      test: { status: "passed", decision: "run", exitCode: 0 }
    });
    expect(existsSync(String(installed["filePath"]))).toBe(true);
    const attached = resultData(await call(provider, "schedule_get", { id: created["id"] })) as Record<string, unknown>;
    expect(attached).toMatchObject({
      preRunHook: {
        command: installed["command"],
        filePath: installed["filePath"],
        timeoutMs: 5_000
      }
    });

    const detached = resultData(await call(provider, "schedule_update", {
      id: created["id"],
      expectedRevision: attached["revision"],
      expireAt: null,
      preRunHook: null
    })) as Record<string, unknown>;
    expect(detached).not.toHaveProperty("expireAt");
    expect(detached).not.toHaveProperty("preRunHook");
    expect(JSON.stringify(store.getSchedule(String(created["id"])).executionSnapshot)).not.toContain("preRunHook");
  });

  it("creates zero-token script schedules and rejects incompatible or credential-bearing configurations", async () => {
    const { store, provider } = fixture();
    const created = resultData(await call(provider, "schedule_create", {
      name: "Workspace probe",
      kind: "manual",
      executionMode: "script",
      scriptConfig: {
        command: "node scripts/probe.mjs",
        timeoutMs: 15_000,
        capabilities: ["sessions.dispatch"]
      }
    })) as Record<string, unknown>;
    expect(created).toMatchObject({
      name: "Workspace probe",
      prompt: "",
      executionMode: "script",
      scriptConfig: {
        command: "node scripts/probe.mjs",
        timeoutMs: 15_000,
        capabilities: ["sessions.dispatch"]
      },
      persistentSession: false,
      silentWhenIdle: false
    });
    expect(store.getSchedule(String(created["id"]))).toMatchObject({
      sessionMode: "fresh",
      prompt: { text: "" },
      executionSnapshot: {
        scheduler: {
          executionMode: "script",
          scriptConfig: {
            command: "node scripts/probe.mjs",
            capabilities: ["sessions.dispatch"]
          }
        }
      }
    });

    expect(errorData(await call(provider, "schedule_create", {
      name: "Missing prompt",
      kind: "manual"
    }))).toMatchObject({ errorCode: "INVALID_PARAMS" });
    expect(errorData(await call(provider, "schedule_create", {
      name: "Bound script",
      kind: "manual",
      bindToCurrentSession: true,
      executionMode: "script",
      scriptConfig: { command: "node scripts/probe.mjs", capabilities: [] }
    }))).toMatchObject({ errorCode: "INVALID_PARAMS" });
    expect(errorData(await call(provider, "schedule_create", {
      name: "Silent script",
      kind: "manual",
      silentWhenIdle: true,
      executionMode: "script",
      scriptConfig: { command: "node scripts/probe.mjs", capabilities: [] }
    }))).toMatchObject({ errorCode: "INVALID_PARAMS" });
    expect(errorData(await call(provider, "schedule_create", {
      name: "Unsafe script",
      kind: "manual",
      executionMode: "script",
      scriptConfig: { command: "node run.mjs sk-abcdefghijklmnop", capabilities: [] }
    }))).toMatchObject({ errorCode: "INVALID_ARGS" });

    const agent = resultData(await call(provider, "schedule_update", {
      id: created["id"],
      expectedRevision: created["revision"],
      executionMode: "agent",
      prompt: "Continue with the agent"
    })) as Record<string, unknown>;
    expect(agent).toMatchObject({ executionMode: "agent", prompt: "Continue with the agent" });
    expect(agent).not.toHaveProperty("scriptConfig");
  });

  it("changes attention for only the authenticated in-flight schedule run", async () => {
    const { store, provider, runNotifications } = fixture();
    const created = resultData(await call(provider, "schedule_create", {
      name: "Quiet task",
      prompt: "inspect",
      kind: "manual",
      bindToCurrentSession: true,
      silentWhenIdle: true
    })) as Record<string, unknown>;
    const scheduleId = String(created["id"]);

    store.createRun({
      id: "run-live-1",
      sessionId: "session-a",
      source: "schedule",
      state: "running",
      createdAt: NOW,
      startedAt: NOW
    });
    store.recordScheduleRun(scheduleId, "run-live-1", "running", undefined, NOW);
    expect(resultData(await call(provider, "schedule_notify_current_run", {}))).toEqual({
      notified: true,
      runId: "run-live-1"
    });
    expect(runNotifications.settle("run-live-1", "completed")).toEqual({
      suppressAttention: true,
      markHistoryRead: false
    });
    store.updateRunState({ runId: "run-live-1", state: "completed", traceId: "test:completed:1" });

    store.createRun({
      id: "run-live-2",
      sessionId: "session-a",
      source: "schedule",
      state: "running",
      createdAt: NOW + 1,
      startedAt: NOW + 1
    });
    store.recordScheduleRun(scheduleId, "run-live-2", "running", undefined, NOW + 1);
    expect(resultData(await call(provider, "schedule_silence_current_run", { runId: "run-live-2" }))).toEqual({
      silenced: true,
      runId: "run-live-2"
    });
    expect(runNotifications.settle("run-live-2", "completed")).toEqual({
      suppressAttention: true,
      markHistoryRead: true
    });
    expect(errorData(await call(provider, "schedule_silence_current_run", { runId: "missing" })))
      .toMatchObject({ errorCode: "NOT_FOUND" });
  });

  it("returns self-correcting structured errors without leaking internal failures", async () => {
    const { provider } = fixture();
    expect(errorData(await call(provider, "schedule_create", {
      name: "Bad cron",
      prompt: "test",
      cronExpr: "not cron",
      timezone: "UTC"
    }))).toEqual({
      ok: false,
      errorCode: "INVALID_PARAMS",
      message: "cronExpr or timezone is invalid."
    });
    expect(errorData(await call(provider, "schedule_get", { id: "missing", hidden: "value" })))
      .toMatchObject({ errorCode: "INVALID_ARGS", message: "Unexpected argument: hidden." });
    expect(errorData(await call(provider, "schedule_create", {
      name: "Wrong runtime",
      prompt: "test",
      kind: "manual",
      agentKind: "other"
    }))).toMatchObject({ errorCode: "INVALID_ARGS" });
  });
});

function fixture(coordinatorOverrides: Partial<SchedulerToolCoordinator> = {}) {
  const store = new OperationalStore(":memory:");
  openStores.push(store);
  const workspaceBase = mkdtempSync(join(tmpdir(), "joko-scheduler-tools-"));
  temporaryRoots.push(workspaceBase);
  store.upsertBackend({
    id: "backend-a",
    displayName: "Backend A",
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
  for (const [id, trusted] of [["target-a", true], ["target-b", true], ["target-untrusted", false]] as const) {
    const workspaceRoot = join(workspaceBase, id);
    mkdirSync(workspaceRoot, { recursive: true });
    store.upsertTarget({
      id,
      backendId: "backend-a",
      displayName: id,
      workspaceRoot,
      managed: false,
      trusted
    });
  }
  store.createSession({
    id: "session-a",
    backendId: "backend-a",
    targetId: "target-a",
    title: "Session A",
    binding: { opaqueRef: "session-a.jsonl", generation: 7 },
    pinned: false,
    archived: false,
    permissionMode: "auto",
    planMode: true,
    providerId: "provider-a",
    modelId: "model-a",
    effort: "high",
    fastMode: true,
    createdAt: NOW,
    updatedAt: NOW
  });
  store.createSession({
    id: "session-b",
    backendId: "backend-a",
    targetId: "target-b",
    title: "Session B",
    binding: { opaqueRef: "session-b.jsonl", generation: 7 },
    pinned: false,
    archived: false,
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    createdAt: NOW,
    updatedAt: NOW
  });
  const coordinator: SchedulerToolCoordinator = {
    runNowWithResult: async () => ({ runId: "run-default", sessionId: "session-a" }),
    ...coordinatorOverrides
  };
  const runNotifications = new ScheduleRunNotificationController(store);
  return {
    store,
    coordinator,
    runNotifications,
    provider: new SchedulerToolBridgeProvider({
      store,
      coordinator: () => coordinator,
      hookScripts: new ScheduleHookScriptInstaller(),
      runNotifications,
      now: () => NOW
    })
  };
}

async function call(
  provider: SchedulerToolBridgeProvider,
  name: string,
  input: Readonly<Record<string, unknown>>,
  callContext = context("session-a", "target-a")
): Promise<McpCallResult> {
  return provider.callTool(name, input, undefined, callContext);
}

function context(sessionId: string, targetId: string): BridgeToolCallContext {
  return { sessionId, targetId, generation: 7 };
}

function baseCron(): Readonly<Record<string, unknown>> {
  return {
    name: "Daily",
    prompt: "daily prompt",
    cronExpr: "0 9 * * *",
    timezone: "UTC"
  };
}

function resultData(result: McpCallResult): unknown {
  expect(result.isError).toBe(false);
  return result.structuredContent?.["data"];
}

function errorData(result: McpCallResult): Readonly<Record<string, unknown>> {
  expect(result.isError).toBe(true);
  return result.structuredContent ?? {};
}
