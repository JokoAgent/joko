import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AdapterContext, BlobRef, EventPayload, InteractionPayload, TargetDescriptor } from "@joko/core";
import { createCommandConcurrencyGate } from "@joko/runtime-governance";
import { describe, expect, it, vi } from "vitest";

import { COMMAND_GATE_REQUEST_PREFIX } from "./command-gate-bridge.js";
import { managedSubagentSessionKey } from "./durable-subagent-runs.js";
import type { PiManagedDurableRunSnapshot, PiManagedDurableStore } from "./managed-durable-store.js";
import {
  assertManagedSubagentControlTarget,
  assertManagedSubagentHostedToolScope,
  ManagedSubagentObserver,
  writeManagedSubagentDurableControl
} from "./managed-subagent-observer.js";
import {
  encodePolicyDecisionRequest,
  MAXIMUM_POLICY_DECISION_ENVELOPE_CHARACTERS,
  MAXIMUM_POLICY_DECISION_TITLE_BYTES,
  POLICY_DECISION_REQUEST_PREFIX
} from "./policy-decision-bridge.js";
import { mkdtemp } from "./test-paths.js";

describe("managed Subagent public observation", () => {
  it("fences hosted child tools to the exact live claimed runner and separates reserved registration from effects", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-hosted-child-scope-")), "subagent-runs"), sessionId = "hosted-child-session", taskId = "original-parent:step-1";
    const run = await physicalRun(root, sessionId, taskId, 1, 1, [], undefined, "running");
    const directory = join(root, managedSubagentSessionKey(sessionId), run.runId);
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
    const status = JSON.parse(await readFile(join(directory, "status.json"), "utf8"));
    const owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
    const scope = { taskId, runId: run.runId, launchToken: config.launchToken, runnerInstanceId: config.runnerInstanceId, nativeSessionId: config.nativeSessionId };
    const input = { root, productSessionId: sessionId, productGeneration: 1, scope };
    await expect(assertManagedSubagentHostedToolScope(input)).resolves.toMatchObject({ taskId });
    await expect(assertManagedSubagentHostedToolScope({ ...input, scope: { ...scope, launchToken: randomUUID() } })).rejects.toThrow();
    await expect(assertManagedSubagentHostedToolScope({ ...input, scope: { ...scope, runnerInstanceId: randomUUID() } })).rejects.toThrow();
    await expect(assertManagedSubagentHostedToolScope({ ...input, scope: { ...scope, nativeSessionId: randomUUID() } })).rejects.toThrow();
    await expect(assertManagedSubagentHostedToolScope({ ...input, productGeneration: 2 })).rejects.toThrow();
    await expect(assertManagedSubagentHostedToolScope({ ...input, productSessionId: "another-session" })).rejects.toThrow();
    await writeFile(join(directory, "status.json"), JSON.stringify({ ...status, state: "completed", endedAt: Date.now() }));
    await expect(assertManagedSubagentHostedToolScope(input)).rejects.toThrow();
    await writeFile(join(directory, "owner.json"), JSON.stringify({ ...owner, state: "reserved", runnerPid: 0 }));
    await writeFile(join(directory, "status.json"), JSON.stringify({ ...status, state: "queued", runnerPid: 0 }));
    await rm(join(directory, "runner.claim.json"));
    await expect(assertManagedSubagentHostedToolScope({ ...input, reserved: true })).resolves.toMatchObject({ taskId });
    await expect(assertManagedSubagentHostedToolScope(input)).rejects.toThrow();
  });

  it("emits a canonical run before a globally sequenced transcript and resumes without replay", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-observer-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const taskId = "delegated-call:1";
    const first = await physicalRun(root, sessionId, taskId, 1, 1, [
      { type: "joko.subagent.parent", message: "Inspect the target", at: 11 },
      { type: "tool_execution_start", toolName: "read", toolCallId: "tool-1", args: { path: "safe.txt" }, timestamp: 12 },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first result" }], stopReason: "stop" }, timestamp: 13 }
    ]);
    const events: EventPayload[] = [];
    const observer = new ManagedSubagentObserver({ root, context: context(sessionId, 1, events), intervalMs: 60_000 });
    await observer.refresh();

    expect(events.map((event) => event.type)).toEqual([
      "subagent_run",
      "subagent_transcript",
      "subagent_transcript",
      "subagent_transcript"
    ]);
    const initialRun = events[0]?.type === "subagent_run" ? events[0].run : undefined;
    expect(initialRun).toMatchObject({
      id: taskId,
      sessionId,
      state: "completed",
      logicalAgentId: taskId,
      providerRunIds: [first.runId],
      capabilities: {
        viewActivity: true,
        viewReturnedResult: true,
        viewFullTranscript: true,
        stop: false,
        steer: false,
        followUp: false,
        resume: true,
        parentContext: "snapshot"
      },
      returnedResult: "result turn 1"
    });
    const initialEntries = events
      .filter((event): event is Extract<EventPayload, { type: "subagent_transcript" }> => event.type === "subagent_transcript")
      .map((event) => event.entry);
    expect(initialEntries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(initialEntries[1]).toMatchObject({
      role: "tool",
      childId: `${taskId}:child`,
      toolName: "read",
      toolCallId: "tool-1",
      toolPhase: "start",
      toolInputJson: "{\"path\":\"safe.txt\"}"
    });
    await observer.refresh();
    expect(events).toHaveLength(4);

    const restartedEvents: EventPayload[] = [];
    const restarted = new ManagedSubagentObserver({ root, context: context(sessionId, 2, restartedEvents), intervalMs: 60_000 });
    await restarted.refresh();
    expect(restartedEvents).toEqual([]);
    await appendFile(
      join(root, managedSubagentSessionKey(sessionId), first.runId, "transcript.jsonl"),
      `${JSON.stringify({ type: "joko.subagent.late_observation", at: 20 })}\n`,
      { encoding: "utf8" }
    );
    await restarted.refresh();
    expect(restartedEvents.map((event) => event.type)).toEqual(["subagent_run", "subagent_transcript"]);
    expect(restartedEvents[1]?.type === "subagent_transcript" ? restartedEvents[1].entry.sequence : undefined).toBe(4);
    restartedEvents.splice(0);

    const second = await physicalRun(root, sessionId, taskId, 2, 2, [
      { type: "joko.subagent.parent", message: "Continue the retained session", at: 21 },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second result" }], stopReason: "stop" }, timestamp: 22 }
    ], first.nativeSessionPath);
    await restarted.refresh();
    expect(restartedEvents.map((event) => event.type)).toEqual([
      "subagent_run",
      "subagent_transcript",
      "subagent_transcript"
    ]);
    const resumedRun = restartedEvents[0]?.type === "subagent_run" ? restartedEvents[0].run : undefined;
    expect(resumedRun).toMatchObject({
      providerRunIds: [second.runId, first.runId],
      returnedResult: "result turn 2"
    });
    expect(resumedRun?.activity.some((entry) => entry.kind === "resumed")).toBe(true);
    const resumedEntries = restartedEvents
      .filter((event): event is Extract<EventPayload, { type: "subagent_transcript" }> => event.type === "subagent_transcript")
      .map((event) => event.entry);
    expect(resumedEntries.map((entry) => entry.sequence)).toEqual([5, 6]);
    expect(resumedEntries[0]).toMatchObject({ role: "parent", controlAction: "resume" });

    await expect(assertManagedSubagentControlTarget({
      root,
      productSessionId: sessionId,
      productGeneration: 2,
      runId: taskId,
      childId: `${taskId}:child`,
      action: "resume"
    })).resolves.toBe("local");
    await expect(assertManagedSubagentControlTarget({
      root,
      productSessionId: sessionId,
      productGeneration: 2,
      runId: taskId,
      action: "stop"
    })).rejects.toThrow("unavailable");
  });

  it("drains an in-flight projection and cannot deliver old transcript entries after stop", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-observer-drain-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const taskId = "drain-call:1";
    await physicalRun(root, sessionId, taskId, 1, 1, [
      { type: "joko.subagent.parent", message: "Do not outlive deletion", at: 41 }
    ]);
    const events: EventPayload[] = [];
    let releaseRun!: () => void;
    let markRunEntered!: () => void;
    const runBlocked = new Promise<void>((resolveBlocked) => { releaseRun = resolveBlocked; });
    const runEntered = new Promise<void>((resolveEntered) => { markRunEntered = resolveEntered; });
    const base = context(sessionId, 1, events);
    const observer = new ManagedSubagentObserver({
      root,
      context: {
        ...base,
        emit: async (payload) => {
          events.push(payload);
          if (payload.type === "subagent_run") {
            markRunEntered();
            await runBlocked;
          }
        }
      },
      intervalMs: 60_000
    });
    const refresh = observer.refresh();
    await runEntered;
    let drained = false;
    const stopping = observer.stopAndDrain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseRun();
    await Promise.all([refresh, stopping]);
    expect(events.map((event) => event.type)).toEqual(["subagent_run"]);
    await observer.refresh();
    expect(events.map((event) => event.type)).toEqual(["subagent_run"]);
  });

  it("gates live controls by exact Session, generation, child, and runner state", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-control-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const taskId = "live-call:1";
    const live = await physicalRun(root, sessionId, taskId, 3, 1, [
      { type: "joko.subagent.parent", message: "Keep working", at: 31 }
    ], undefined, "running");
    for (const action of ["stop", "steer", "follow_up"] as const) {
      await expect(assertManagedSubagentControlTarget({
        root,
        productSessionId: sessionId,
        productGeneration: 3,
        runId: taskId,
        childId: `${taskId}:child`,
        action
      })).resolves.toBe("local");
    }
    await expect(assertManagedSubagentControlTarget({
      root,
      productSessionId: sessionId,
      productGeneration: 3,
      runId: taskId,
      childId: "foreign-child",
      action: "stop"
    })).rejects.toThrow("not owned");
    await expect(assertManagedSubagentControlTarget({
      root,
      productSessionId: sessionId,
      productGeneration: 2,
      runId: taskId,
      action: "stop"
    })).rejects.toThrow("not owned");
    const liveDirectory = join(root, managedSubagentSessionKey(sessionId), live.runId);
    const staleStatus = JSON.parse(await readFile(join(liveDirectory, "status.json"), "utf8")) as Record<string, unknown>;
    await writeFile(join(liveDirectory, "status.json"), `${JSON.stringify({
      ...staleStatus,
      heartbeatAt: Date.now() - 20_000
    })}\n`, { mode: 0o600 });
    await expect(assertManagedSubagentControlTarget({
      root,
      productSessionId: sessionId,
      productGeneration: 3,
      runId: taskId,
      action: "stop"
    })).rejects.toThrow("unavailable");
    await writeFile(
      join(liveDirectory, "joko-managed-subagent-runner.cjs"),
      "replaced runner\n",
      { mode: 0o600 }
    );
    await expect(assertManagedSubagentControlTarget({
      root,
      productSessionId: sessionId,
      productGeneration: 3,
      runId: taskId,
      action: "stop"
    })).rejects.toThrow("not owned");

  });

  it("writes remote controls without a live parent runtime and reuses the host operation identity", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-remote-control-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const taskId = "remote-control:1";
    const store = new DurableStoreFixture(sessionId, taskId, `approval-${randomUUID()}`);
    const input = {
      root,
      durableStore: store,
      productSessionId: sessionId,
      productGeneration: 3,
      runId: taskId,
      childId: `${taskId}:child`,
      action: "stop" as const,
      operationId: randomUUID(),
      timeoutMs: 2_000
    };

    await writeManagedSubagentDurableControl(input);
    await writeManagedSubagentDurableControl(input);

    expect(store.controls).toHaveLength(1);
    expect(store.controls[0]).toMatchObject({
      kind: "control",
      value: {
        format: 1,
        productSessionId: sessionId,
        productGeneration: 3,
        taskId,
        action: "stop"
      }
    });
    expect(store.controls[0]!.value).not.toHaveProperty("seq");
  });

  it("stops only the remote durable runs holding the revoked Provider route", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-remote-auth-revoke-")), "subagent-runs");
    const revokedSessionId = `session-${randomUUID()}`;
    const siblingSessionId = `session-${randomUUID()}`;
    const revokedStore = new DurableStoreFixture(
      revokedSessionId,
      "remote-revoked:1",
      `approval-${randomUUID()}`,
      { providerId: "revoked-provider", terminateOnStop: true }
    );
    const siblingStore = new DurableStoreFixture(
      siblingSessionId,
      "remote-sibling:1",
      `approval-${randomUUID()}`,
      { providerId: "sibling-provider", terminateOnStop: true }
    );
    const revokedObserver = new ManagedSubagentObserver({
      root,
      durableStore: revokedStore,
      context: context(revokedSessionId, 3, []),
      intervalMs: 60_000
    });
    const siblingObserver = new ManagedSubagentObserver({
      root,
      durableStore: siblingStore,
      context: context(siblingSessionId, 3, []),
      intervalMs: 60_000
    });

    await Promise.all([
      revokedObserver.stopCredentialedRunsByProvider("revoked-provider", 2_000),
      siblingObserver.stopCredentialedRunsByProvider("revoked-provider", 2_000)
    ]);

    expect(revokedStore.controls).toHaveLength(1);
    expect(revokedStore.controls[0]).toMatchObject({
      kind: "control",
      value: { action: "stop", productSessionId: revokedSessionId }
    });
    expect(siblingStore.controls).toEqual([]);
    revokedObserver.stop();
    siblingObserver.stop();
  });

  it.each([
    ["absent", { omitRoute: true }],
    ["malformed", { route: { provider: 42, model: "fixture", effort: "high" } }],
    ["illegal Provider", { route: { provider: "invalid provider", model: "fixture", effort: "high" } }]
  ])("fails Provider retirement closed for a live remote child with an %s immutable route", async (_label, routeOptions) => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-remote-auth-route-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const store = new DurableStoreFixture(
      sessionId,
      "remote-unknown-route:1",
      `approval-${randomUUID()}`,
      { providerId: "revoked-provider", ...routeOptions }
    );
    const observer = new ManagedSubagentObserver({
      root,
      durableStore: store,
      context: context(sessionId, 3, []),
      intervalMs: 60_000
    });

    await expect(observer.stopCredentialedRunsByProvider("revoked-provider", 2_000))
      .rejects.toThrow(/Provider ownership is invalid/iu);
    expect(store.controls).toEqual([]);
    observer.stop();
  });

  it("backs off repeated remote scan failures and publishes only one visible outage edge", async () => {
    vi.useFakeTimers();
    try {
      const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-remote-backoff-")), "subagent-runs");
      const sessionId = `session-${randomUUID()}`;
      const store = new DurableStoreFixture(sessionId, "remote-backoff:1", `approval-${randomUUID()}`);
      store.failuresRemaining = 2;
      const events: EventPayload[] = [];
      const observer = new ManagedSubagentObserver({
        root,
        durableStore: store,
        journalRoot: join(dirname(root), "subagent-observations"),
        context: context(sessionId, 3, events),
        intervalMs: 500
      });
      observer.start();

      await vi.advanceTimersByTimeAsync(0);
      expect(store.scanCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(store.scanCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.scanCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(store.scanCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.scanCalls).toBe(3);
      await observer.refresh();

      expect(events.filter((event) => event.type === "status" && event.key === "subagent-observation"))
        .toEqual([
          { type: "status", key: "subagent-observation", text: "Delegated-run updates are temporarily unavailable." },
          { type: "status", key: "subagent-observation" }
        ]);
      observer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("durably fences approval decisions and replays the mailbox without asking twice after restart", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-approval-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const taskId = "approval-call:worker";
    const approvalId = `approval-${randomUUID()}`;
    const physical = await physicalRun(root, sessionId, taskId, 3, 1, [], undefined, "running", {
      agentName: "worker",
      title: "Writable task",
      readOnly: false,
      pendingApproval: {
        id: approvalId,
        childId: `${taskId}:child`,
        method: "confirm",
        title: "joko:permission:bash",
        message: "Run the bounded reviewed command",
        requestedAt: Date.now()
      }
    });
    const events: EventPayload[] = [];
    const interactions: InteractionPayload[] = [];
    const base = context(sessionId, 3, events);
    const observer = new ManagedSubagentObserver({
      root,
      context: {
        ...base,
        requestInteraction: async (interaction) => {
          interactions.push(interaction);
          return { kind: "confirmed", confirmed: true };
        }
      },
      intervalMs: 60_000
    });
    await observer.refresh();
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ kind: "permission", toolName: "bash", summary: "Run the bounded reviewed command" });
    const controlPath = join(root, managedSubagentSessionKey(sessionId), physical.runId, "approval-control.json");
    const control = JSON.parse(await readFile(controlPath, "utf8")) as Record<string, unknown>;
    expect(control).toMatchObject({
      format: 1,
      runId: physical.runId,
      productSessionId: sessionId,
      productGeneration: 3,
      taskId,
      childId: `${taskId}:child`,
      approvalId,
      action: "approval",
      confirmed: true
    });
    observer.stop();

    let restartedPrompts = 0;
    const restarted = new ManagedSubagentObserver({
      root,
      context: {
        ...context(sessionId, 4, []),
        requestInteraction: async () => {
          restartedPrompts += 1;
          return { kind: "confirmed", confirmed: false };
        }
      },
      intervalMs: 60_000
    });
    await restarted.refresh();
    expect(restartedPrompts).toBe(0);
    expect(JSON.parse(await readFile(controlPath, "utf8"))).toMatchObject({ confirmed: true, approvalId });
    restarted.stop();
  });

  it("observes and controls a remote durable run without reading its host paths or replaying approval", async () => {
    const serviceRoot = await mkdtemp(join(tmpdir(), "joko-subagent-remote-observer-"));
    const root = join(serviceRoot, "subagent-runs");
    const journalRoot = join(serviceRoot, "subagent-observations");
    const sessionId = `session-${randomUUID()}`;
    const taskId = "remote-call:worker";
    const approvalId = `approval-${randomUUID()}`;
    const store = new DurableStoreFixture(sessionId, taskId, approvalId);
    const events: EventPayload[] = [];
    const interactions: InteractionPayload[] = [];
    const base = context(sessionId, 3, events);
    const observer = new ManagedSubagentObserver({
      root,
      journalRoot,
      durableStore: store,
      context: {
        ...base,
        requestInteraction: async (interaction) => {
          interactions.push(interaction);
          return { kind: "confirmed", confirmed: true };
        }
      },
      intervalMs: 60_000
    });

    await observer.refresh();
    expect(events.map((event) => event.type)).toEqual([
      "subagent_run",
      "subagent_transcript"
    ]);
    expect(events[0]?.type === "subagent_run" ? events[0].run : undefined).toMatchObject({
      id: taskId,
      state: "running",
      capabilities: { stop: true, steer: true, followUp: true, resume: false }
    });
    expect(interactions).toHaveLength(1);
    expect(store.controls).toHaveLength(1);
    expect(store.controls[0]).toMatchObject({ kind: "approval", value: { approvalId, confirmed: true } });

    const restartedInteractions: InteractionPayload[] = [];
    const restarted = new ManagedSubagentObserver({
      root,
      journalRoot,
      durableStore: store,
      context: {
        ...context(sessionId, 4, []),
        requestInteraction: async (interaction) => {
          restartedInteractions.push(interaction);
          return { kind: "confirmed", confirmed: false };
        }
      },
      intervalMs: 60_000
    });
    await restarted.refresh();
    expect(restartedInteractions).toEqual([]);
    expect(store.controls).toHaveLength(2);
    expect(store.controls[1]).toMatchObject({ kind: "approval", value: { approvalId, confirmed: true } });

    await expect(assertManagedSubagentControlTarget({
      root,
      durableStore: store,
      productSessionId: sessionId,
      productGeneration: 4,
      runId: taskId,
      childId: `${taskId}:child`,
      action: "stop"
    })).resolves.toBe("remote");
    observer.stop();
    restarted.stop();
  });

  it("answers only the reserved durable command gate input and never persists its tool arguments", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-gate-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const taskId = "gate-call:worker";
    const toolCallId = Buffer.from("tool-1", "utf8").toString("base64url");
    const approvalId = `gate-${randomUUID()}`;
    const physical = await physicalRun(root, sessionId, taskId, 5, 1, [], undefined, "running", {
      agentName: "worker",
      readOnly: false,
      pendingApproval: {
        id: approvalId,
        childId: `${taskId}:child`,
        method: "input",
        title: `joko:command-gate/v1/acquire/${toolCallId}`,
        placeholder: "",
        requestedAt: Date.now()
      }
    });
    const observer = new ManagedSubagentObserver({ root, context: context(sessionId, 5, []), intervalMs: 60_000 });
    await observer.refresh();
    const control = JSON.parse(await readFile(
      join(root, managedSubagentSessionKey(sessionId), physical.runId, "approval-control.json"),
      "utf8"
    )) as Record<string, unknown>;
    expect(control).toMatchObject({ action: "approval", approvalId, value: "admitted" });
    expect(JSON.stringify(control)).not.toContain("arguments");
    observer.stop();
  });

  it("services release from one child while another waits, and drains an undelivered acquire on stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-subagent-command-wait-"));
    const root = join(directory, "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const gate = createCommandConcurrencyGate({ readMaximum: () => 1, maximumWaitMs: 60_000 });
    const observer = new ManagedSubagentObserver({ root, context: context(sessionId, 6, []), commandConcurrencyGate: gate });
    const title = (action: "acquire" | "release") => `${COMMAND_GATE_REQUEST_PREFIX}${action}/${Buffer.from("provider-call-one").toString("base64url")}`;
    const approval = (taskId: string, id: string, action: "acquire" | "release") => ({
      id, childId: `${taskId}:child`, method: "input", title: title(action), requestedAt: Date.now()
    });
    const createRun = async (taskId: string) => {
      const { runId } = await physicalRun(root, sessionId, taskId, 5, 1, [], undefined, "running", {
        pendingApproval: approval(taskId, `${taskId}-acquire`, "acquire")
      });
      return join(root, managedSubagentSessionKey(sessionId), runId);
    };
    const setApproval = async (run: string, pendingApproval?: ReturnType<typeof approval>) => {
      const statusPath = join(run, "status.json");
      const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
      await writeFile(statusPath, JSON.stringify({ ...status, heartbeatAt: Date.now(), pendingApproval }), { mode: 0o600 });
    };
    const readReply = async (run: string) => JSON.parse(await readFile(join(run, "approval-control.json"), "utf8")) as Record<string, unknown>;
    try {
      const first = await createRun("first");
      await vi.waitFor(async () => {
        await observer.refresh();
        expect(await readReply(first)).toMatchObject({ approvalId: "first-acquire", value: "admitted" });
      });
      const second = await createRun("second");
      await observer.refresh();
      expect(gate.snapshot()).toEqual({ running: 1, queued: 1 });
      await expect(readReply(second)).rejects.toMatchObject({ code: "ENOENT" });

      await setApproval(first, approval("first", "first-release", "release"));
      await vi.waitFor(async () => {
        await observer.refresh();
        expect(await readReply(first)).toMatchObject({ approvalId: "first-release", value: "released" });
        expect(await readReply(second)).toMatchObject({ approvalId: "second-acquire", value: "admitted" });
      });
      await setApproval(first);
      await setApproval(second, approval("second", "second-release", "release"));
      await observer.refresh();
      expect(gate.snapshot()).toEqual({ running: 0, queued: 0 });

      await gate.acquire({ commandId: "outside", sessionId: "other-session" });
      await setApproval(second, approval("second", "retire-waiter", "acquire"));
      await observer.refresh();
      expect(gate.snapshot()).toEqual({ running: 1, queued: 1 });
      await observer.stopAndDrain();
      expect(gate.snapshot()).toEqual({ running: 1, queued: 0 });
      expect(await readReply(second)).toMatchObject({ approvalId: "second-release", value: "released" });
    } finally {
      await observer.stopAndDrain();
      gate.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("evaluates current delegated policy requests and fails an older policy generation closed", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-policy-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const currentTaskId = "policy-call:current";
    const staleTaskId = "policy-call:stale";
    const observation = { subjectKind: "command" as const, risk: "medium" as const, toolName: "bash" };
    const request = (command: string) => encodePolicyDecisionRequest({
      policyGeneration: 7,
      observation,
      toolCall: { toolName: "bash", input: { command } }
    });
    const emptyCommand = "printf '%s' ''";
    const overhead = Buffer.from(request(emptyCommand).slice(POLICY_DECISION_REQUEST_PREFIX.length), "base64url").byteLength;
    const command = `printf '%s' '${"x".repeat(MAXIMUM_POLICY_DECISION_ENVELOPE_CHARACTERS * 3 / 4 - overhead)}'`;
    const title = request(command);
    expect(Buffer.byteLength(title)).toBe(MAXIMUM_POLICY_DECISION_TITLE_BYTES);
    const currentApprovalId = `policy-${randomUUID()}`;
    const staleApprovalId = `policy-${randomUUID()}`;
    const malformedTaskId = "policy-call:malformed";
    const malformedApprovalId = `policy-${randomUUID()}`;
    const [current, stale, malformed] = await Promise.all([
      physicalRun(root, sessionId, currentTaskId, 6, 1, [], undefined, "running", {
        pendingApproval: {
          id: currentApprovalId,
          childId: `${currentTaskId}:child`,
          method: "input",
          title,
          placeholder: "",
          requestedAt: Date.now()
        }
      }),
      physicalRun(root, sessionId, staleTaskId, 6, 1, [], undefined, "running", {
        pendingApproval: {
          id: staleApprovalId,
          childId: `${staleTaskId}:child`,
          method: "input",
          title: encodePolicyDecisionRequest({ policyGeneration: 6, observation }),
          placeholder: "",
          requestedAt: Date.now()
        }
      }),
      physicalRun(root, sessionId, malformedTaskId, 6, 1, [], undefined, "running", {
        pendingApproval: { id: malformedApprovalId, childId: `${malformedTaskId}:child`, method: "input", title: `${title}a` }
      })
    ]);
    const base = context(sessionId, 6, []);
    const observer = new ManagedSubagentObserver({
      root,
      policyGeneration: 7,
      context: {
        ...base,
        policySnapshot: {
          generation: "4",
          backendId: "pi",
          targetId: base.target.id,
          workspaceRoot: base.target.workspaceRoot,
          rules: [{
            id: "deny-shell-command",
            effect: "deny",
            subjectKind: "command",
            toolName: "bash",
            ceiling: "critical",
            priority: 1,
            order: 0
          }]
        }
      },
      intervalMs: 60_000
    });

    await observer.refresh();
    const currentControl = JSON.parse(await readFile(
      join(root, managedSubagentSessionKey(sessionId), current.runId, "approval-control.json"),
      "utf8"
    )) as Record<string, unknown>;
    const staleControl = JSON.parse(await readFile(
      join(root, managedSubagentSessionKey(sessionId), stale.runId, "approval-control.json"),
      "utf8"
    )) as Record<string, unknown>;
    expect(currentControl).toMatchObject({ approvalId: currentApprovalId, value: "deny" });
    expect(staleControl).toMatchObject({ approvalId: staleApprovalId, value: "stale" });
    expect(JSON.parse(await readFile(join(root, managedSubagentSessionKey(sessionId), malformed.runId, "approval-control.json"), "utf8")))
      .toMatchObject({ approvalId: malformedApprovalId, cancelled: true });
    observer.stop();
  });

  it("replays a complete policy reply for a short request from the private delivery journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-subagent-policy-replay-"));
    const root = join(directory, "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const taskId = "policy-call:owner-reply";
    const approvalId = `policy-${randomUUID()}`;
    const ownerText = `主人😀${"\u0001".repeat(15_996)}`;
    const readOwnerUserInstructions = vi.fn(() => [ownerText]);
    const events: EventPayload[] = [];
    const base = context(sessionId, 6, events);
    const options = {
      root, policyGeneration: 7,
      context: { ...base, nativeToolAuthorization: {
        required: true,
        capture: () => "current",
        assertCurrent() {},
        review: async () => ({ verdict: "default" as const }),
        readOwnerUserInstructions
      } }
    };
    const observer = new ManagedSubagentObserver(options);
    const restarted = new ManagedSubagentObserver(options);
    try {
      const physical = await physicalRun(root, sessionId, taskId, 6, 1, [], undefined, "running", {
        pendingApproval: { id: approvalId, childId: `${taskId}:child`, method: "input",
          title: encodePolicyDecisionRequest({ policyGeneration: 7,
            observation: { subjectKind: "command", risk: "medium", toolName: "bash" },
            toolCall: { toolName: "bash", input: { command: "pwd" } }
          })
        }
      });
      await observer.refresh();
      observer.stop();
      const controlPath = join(root, managedSubagentSessionKey(sessionId), physical.runId, "approval-control.json");
      const first = await readFile(controlPath, "utf8");
      expect(Buffer.byteLength(first)).toBeGreaterThan(64 * 1024);
      expect(JSON.parse(first)).toMatchObject({ approvalId, value: JSON.stringify({ decision: "default", ownerUserInstructions: [ownerText] }) });
      await rm(controlPath);
      await restarted.refresh();
      expect(readOwnerUserInstructions).toHaveBeenCalledTimes(1);
      expect(await readFile(controlPath, "utf8")).toBe(first);
      expect(JSON.stringify(events)).not.toContain("主人😀");
    } finally {
      observer.stop();
      restarted.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks recursive Pi child reads that cover denied paths while retaining scoped reads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-subagent-recursive-policy-"));
    const root = join(directory, "subagent-runs"), sessionId = "recursive-policy-owner";
    const base = context(sessionId, 6, []);
    const cases = [
      { name: "grep", raw: ".", expected: "deny" },
      { name: "find", raw: "src", path: "src", expected: "deny" },
      { name: "ls", raw: join("src", "restricted"), path: "src/restricted", expected: "deny" },
      { name: "grep", raw: "alias", path: "src/restricted", expected: "deny" },
      { name: "grep", raw: join("src", "restricted", "alias"), path: "public", expected: "deny" },
      { name: "grep", raw: "public", path: "public", expected: "allow" },
      { name: "grep", raw: "reports", path: "reports", expected: "default" }
    ];
    const observer = new ManagedSubagentObserver({ root, policyGeneration: 7, context: { ...base,
      policySnapshot: {
        generation: "5", backendId: base.target.backendId, targetId: base.target.id, workspaceRoot: base.target.workspaceRoot,
        rules: [
          { id: "deny-subtree", effect: "deny", subjectKind: "file_read", workspaceRelativePathPrefix: "src/restricted",
            ceiling: "critical", priority: 1, order: 0 },
          { id: "allow-public", effect: "allow", subjectKind: "file_read", workspaceRelativePathPrefix: "public",
            ceiling: "critical", priority: 2, order: 1 },
          { id: "allow-one-report", effect: "allow", subjectKind: "file_read", workspaceRelativePathPrefix: "reports/summary",
            ceiling: "critical", priority: 2, order: 2 }
        ]
      }
    }, intervalMs: 60_000 });
    try {
      const requests = await Promise.all(cases.map(async (item, index) => {
        const taskId = `recursive-search-${index}`, approvalId = `policy-${randomUUID()}`;
        const run = await physicalRun(root, sessionId, taskId, 6, 1, [], undefined, "running", {
          pendingApproval: { id: approvalId, childId: `${taskId}:child`, method: "input",
            title: encodePolicyDecisionRequest({ policyGeneration: 7,
              observation: { subjectKind: "file_read", risk: "read_only", toolName: item.name,
                ...(item.path === undefined ? {} : { workspaceRelativePath: item.path }) },
              toolCall: { toolName: item.name, input: { path: item.raw, pattern: "needle" } }
            }), placeholder: "", requestedAt: Date.now() }
        });
        return { approvalId, runId: run.runId, expected: item.expected };
      }));
      await observer.refresh();
      for (const request of requests) {
        const control = JSON.parse(await readFile(join(root, managedSubagentSessionKey(sessionId), request.runId, "approval-control.json"), "utf8"));
        expect(control.approvalId).toBe(request.approvalId);
        if (request.expected === "default") expect(JSON.parse(control.value)).toMatchObject({ decision: "default" });
        else expect(control.value).toBe(request.expected);
      }
    } finally { observer.stop(); await rm(directory, { recursive: true, force: true }); }
  });
});

class DurableStoreFixture implements PiManagedDurableStore {
  readonly controls: Array<{
    readonly kind: "control" | "approval";
    readonly value: Readonly<Record<string, unknown>>;
  }> = [];
  failuresRemaining = 0;
  scanCalls = 0;

  readonly #sessionId: string;
  readonly #taskId: string;
  readonly #runId = randomUUID();
  readonly #runnerInstanceId = randomUUID();
  readonly #launchToken = randomUUID();
  readonly #runnerScriptSha256 = createHash("sha256").update("remote fixture runner\n").digest("hex");
  readonly #transcript: Buffer;
  readonly #approvalId: string;
  readonly #providerId: string;
  readonly #terminateOnStop: boolean;
  readonly #route?: unknown;
  readonly #omitRoute: boolean;
  #revision = createHash("sha256").update("remote fixture revision:0").digest("hex");
  #controlRevision = createHash("sha256").update("remote fixture control:0").digest("hex");
  readonly #transcriptRevision = createHash("sha256").update("remote fixture transcript:0").digest("hex");
  readonly #resultRevision = createHash("sha256").update("remote fixture result:absent").digest("hex");
  #lastControl: Readonly<Record<string, unknown>> | undefined;
  #state: "running" | "aborted" = "running";

  constructor(
    sessionId: string,
    taskId: string,
    approvalId: string,
    options: {
      readonly providerId?: string;
      readonly terminateOnStop?: boolean;
      readonly route?: unknown;
      readonly omitRoute?: boolean;
    } = {}
  ) {
    this.#sessionId = sessionId;
    this.#taskId = taskId;
    this.#approvalId = approvalId;
    this.#providerId = options.providerId ?? "remote";
    this.#terminateOnStop = options.terminateOnStop ?? false;
    this.#route = options.route;
    this.#omitRoute = options.omitRoute === true;
    this.#transcript = Buffer.from(`${JSON.stringify({
      type: "joko.subagent.parent",
      message: "Inspect the remote fixture",
      at: 1_001
    })}\n`, "utf8");
  }

  async scan(input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly afterRevision?: string;
    readonly limitBytes: number;
  }): Promise<{
    readonly revision: string;
    readonly unchanged: boolean;
    readonly retryAfterMs: number;
    readonly runs: readonly PiManagedDurableRunSnapshot[];
  }> {
    this.scanCalls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("simulated remote scan failure");
    }
    expect(input.sessionId).toBe(this.#sessionId);
    expect(input.sessionKey).toBe(managedSubagentSessionKey(this.#sessionId));
    expect(input.limitBytes).toBeGreaterThanOrEqual(this.#transcript.byteLength);
    const config = {
      format: 1,
      runId: this.#runId,
      launchToken: this.#launchToken,
      runnerInstanceId: this.#runnerInstanceId,
      runnerScriptSha256: this.#runnerScriptSha256,
      productSessionId: this.#sessionId,
      productGeneration: 3,
      parentTaskId: "parent-tool-call",
      taskId: this.#taskId,
      childId: `${this.#taskId}:child`,
      title: "Remote fixture task",
      readOnly: false,
      contextMode: "fork",
      ...(this.#omitRoute ? {} : {
        route: this.#route ?? { provider: this.#providerId, model: "fixture", effort: "high" }
      }),
      nativeSessionId: randomUUID(),
      turnCount: 1
    };
    const owner = {
      format: 1,
      runId: this.#runId,
      launchToken: this.#launchToken,
      productSessionId: this.#sessionId,
      taskId: this.#taskId,
      runnerScriptSha256: this.#runnerScriptSha256,
      state: "running",
      runnerPid: 42,
      runnerInstanceId: this.#runnerInstanceId
    };
    const status = {
      format: 1,
      runId: this.#runId,
      launchToken: this.#launchToken,
      productSessionId: this.#sessionId,
      parentTaskId: "parent-tool-call",
      taskId: this.#taskId,
      childId: `${this.#taskId}:child`,
      agentName: "worker",
      title: "Remote fixture task",
      task: "Inspect the remote fixture",
      readOnly: false,
      contextMode: "fork",
      runnerScriptSha256: this.#runnerScriptSha256,
      runnerPid: 42,
      runnerInstanceId: this.#runnerInstanceId,
      state: this.#state,
      summary: "running",
      createdAt: 1_000,
      startedAt: 1_001,
      ...(this.#state === "aborted" ? { endedAt: Date.now() } : {}),
      heartbeatAt: 1_002,
      nativeSessionId: config.nativeSessionId,
      turnCount: 1,
      pendingApproval: {
        id: this.#approvalId,
        childId: `${this.#taskId}:child`,
        method: "confirm",
        title: "joko:permission:bash",
        message: "Run the bounded remote command",
        requestedAt: 1_003
      },
      ...(this.#lastControl === undefined ? {} : { lastControl: this.#lastControl })
    };
    if (input.afterRevision === this.#revision) {
      return { revision: this.#revision, unchanged: true, retryAfterMs: 500, runs: [] };
    }
    return {
      revision: this.#revision,
      unchanged: false,
      retryAfterMs: 500,
      runs: [{
        runId: this.#runId,
        runnerInstanceId: this.#runnerInstanceId,
        launchToken: this.#launchToken,
        runnerScriptSha256: this.#runnerScriptSha256,
        revision: this.#revision,
        controlRevision: this.#controlRevision,
        transcriptRevision: this.#transcriptRevision,
        resultRevision: this.#resultRevision,
        config,
        status,
        owner,
        claim: {
          format: 1,
          runId: this.#runId,
          launchToken: this.#launchToken,
          runnerPid: 42,
          runnerInstanceId: this.#runnerInstanceId,
          runnerScriptSha256: this.#runnerScriptSha256
        },
        transcriptBytes: this.#transcript.byteLength,
        resultBytes: 0,
        resumeSafe: false,
        controlSafe: true
      }]
    };
  }

  async readTail(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly runnerInstanceId: string;
    readonly artifactRevision: string;
    readonly pathKind: "transcript" | "result";
    readonly offset: number;
    readonly maxBytes: number;
  }): Promise<{
    readonly artifactRevision: string;
    readonly offset: number;
    readonly nextOffset: number;
    readonly eof: boolean;
    readonly content: Uint8Array;
  }> {
    expect(input).toMatchObject({
      sessionId: this.#sessionId,
      runId: this.#runId,
      runnerInstanceId: this.#runnerInstanceId,
      artifactRevision: this.#transcriptRevision,
      pathKind: "transcript"
    });
    const end = Math.min(this.#transcript.byteLength, input.offset + input.maxBytes);
    return {
      artifactRevision: this.#transcriptRevision,
      offset: input.offset,
      nextOffset: end,
      eof: end === this.#transcript.byteLength,
      content: this.#transcript.subarray(input.offset, end)
    };
  }

  async writeControl(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly runnerInstanceId: string;
    readonly launchToken: string;
    readonly runnerScriptSha256: string;
    readonly expectedControlRevision: string;
    readonly kind: "control" | "approval";
    readonly value: Readonly<Record<string, unknown>>;
  }): Promise<{ readonly controlRevision: string; readonly receipt: string }> {
    expect(input).toMatchObject({
      sessionId: this.#sessionId,
      runId: this.#runId,
      runnerInstanceId: this.#runnerInstanceId,
      launchToken: this.#launchToken,
      runnerScriptSha256: this.#runnerScriptSha256,
      expectedControlRevision: this.#controlRevision
    });
    this.controls.push({ kind: input.kind, value: input.value });
    if (input.kind === "control") {
      this.#lastControl = {
        requestId: input.value["requestId"],
        action: input.value["action"],
        accepted: true,
        observedAt: Date.now()
      };
      if (this.#terminateOnStop && input.value["action"] === "stop") this.#state = "aborted";
    }
    const receipt = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    this.#controlRevision = createHash("sha256").update(`${this.#controlRevision}:${receipt}`).digest("hex");
    this.#revision = createHash("sha256").update(`${this.#revision}:${this.#controlRevision}`).digest("hex");
    return { controlRevision: this.#controlRevision, receipt };
  }

  async stopAndRemoveSession(input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly terminalRunIds: readonly string[]; readonly removed: true; readonly deletionReceipt: string }> {
    expect(input).toMatchObject({
      sessionId: this.#sessionId,
      sessionKey: managedSubagentSessionKey(this.#sessionId)
    });
    return {
      terminalRunIds: [this.#runId],
      removed: true,
      deletionReceipt: createHash("sha256").update(`deleted:${this.#sessionId}`).digest("hex")
    };
  }

  async finalizeDeletion(_input: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly deletionReceipt: string;
  }): Promise<void> {}

  async dispose(): Promise<void> {}
}

async function physicalRun(
  root: string,
  sessionId: string,
  taskId: string,
  generation: number,
  turnCount: number,
  transcript: readonly Record<string, unknown>[],
  resumeSessionPath?: string,
  state: "running" | "completed" = "completed",
  statusPatch: Readonly<Record<string, unknown>> = {}
): Promise<{ readonly runId: string; readonly nativeSessionPath: string }> {
  const runId = randomUUID();
  const launchToken = randomUUID();
  const runnerInstanceId = randomUUID();
  const nativeSessionId = resumeSessionPath === undefined ? randomUUID() : resumeSessionPath.split(/[\\/]/u).at(-1)!.replace(/\.jsonl$/u, "");
  const sessionDirectory = join(root, managedSubagentSessionKey(sessionId));
  const runDirectory = join(sessionDirectory, runId);
  const runnerScript = join(runDirectory, "joko-managed-subagent-runner.cjs");
  const runnerScriptSource = "fixture runner\n";
  const runnerScriptSha256 = createHash("sha256").update(runnerScriptSource).digest("hex");
  const transcriptPath = join(runDirectory, "transcript.jsonl");
  const nativeSessionPath = resumeSessionPath ?? join(runDirectory, "sessions", `${nativeSessionId}.jsonl`);
  const createdAt = 1_000 * turnCount;
  await Promise.all([
    mkdir(join(runDirectory, "sessions"), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, "runtime"), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, "temporary"), { recursive: true, mode: 0o700 }),
    mkdir(join(sessionDirectory, "slots"), { recursive: true, mode: 0o700 })
  ]);
  const config = {
    format: 1,
    runId,
    launchToken,
    runDir: runDirectory,
    runnerScript,
    runnerScriptSha256,
    runnerInstanceId,
    productSessionId: sessionId,
    productGeneration: generation,
    parentTaskId: "parent-tool-call",
    taskId,
    childId: `${taskId}:child`,
    title: "Fixture task",
    readOnly: true,
    contextMode: "fork",
    route: { provider: "local", model: "fixture", effort: "high" },
    nativeSessionId,
    turnCount,
    transcriptPath,
    ...(resumeSessionPath === undefined ? {} : { resumeSessionPath })
  };
  const owner = {
    format: 1,
    runId,
    launchToken,
    productSessionId: sessionId,
    taskId,
    runnerScript,
    runnerScriptSha256,
    state: "running",
    runnerPid: process.pid,
    runnerInstanceId
  };
  const status = {
    format: 1,
    runId,
    launchToken,
    productSessionId: sessionId,
    parentTaskId: "parent-tool-call",
    taskId,
    childId: `${taskId}:child`,
    agentName: "scout",
    title: "Fixture task",
    task: "Inspect the fixture",
    readOnly: true,
    contextMode: "fork",
    runnerScript,
    runnerScriptSha256,
    runnerPid: process.pid,
    runnerInstanceId,
    state,
    summary: state === "completed" ? `completed turn ${turnCount}` : "running",
    createdAt,
    startedAt: createdAt + 1,
    heartbeatAt: Date.now(),
    ...(state === "completed" ? { endedAt: createdAt + 100 } : {}),
    nativeSessionId,
    nativeSessionPath,
    transcriptPath,
    turnCount,
    usage: state === "completed" ? { inputTokens: turnCount, outputTokens: turnCount, totalTokens: turnCount * 2 } : {},
    toolUses: transcript.filter((entry) => String(entry["type"]).startsWith("tool_execution_")).length,
    durationMs: state === "completed" ? 99 : 10,
    ...statusPatch
  };
  await Promise.all([
    writeFile(runnerScript, runnerScriptSource, { mode: 0o600 }),
    writeFile(join(runDirectory, "config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 }),
    writeFile(join(runDirectory, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 }),
    writeFile(join(runDirectory, "runner.claim.json"), `${JSON.stringify({
      format: 1,
      runId,
      launchToken,
      runnerPid: process.pid,
      runnerInstanceId,
      runnerScriptSha256
    })}\n`, { mode: 0o600 }),
    writeFile(join(runDirectory, "status.json"), `${JSON.stringify(status)}\n`, { mode: 0o600 }),
    writeFile(transcriptPath, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 }),
    writeFile(nativeSessionPath, "{}\n", { mode: 0o600 }),
    ...(state === "completed" ? [writeFile(join(runDirectory, "result.json"), `${JSON.stringify({
      format: 1,
      runId,
      launchToken,
      taskId,
      state,
      result: `result turn ${turnCount}`
    })}\n`, { mode: 0o600 })] : [])
  ]);
  return { runId, nativeSessionPath };
}

function context(sessionId: string, generation: number, events: EventPayload[]): AdapterContext {
  const target: TargetDescriptor = {
    id: "observer-target",
    backendId: "pi",
    displayName: "Observer fixture",
    workspaceRoot: tmpdir(),
    managed: true,
    trusted: false
  };
  return {
    sessionId,
    generation,
    target,
    signal: new AbortController().signal,
    emit: async (payload) => { events.push(payload); },
    requestInteraction: async () => ({ kind: "confirmed", confirmed: true }),
    artifactCapacityBytes: 256 * 1024 * 1024,
    storeArtifact: async (sourcePath, options) => blob(Buffer.from(sourcePath), options?.mimeType, options?.fileName)
  };
}

function blob(bytes: Uint8Array, mimeType = "application/octet-stream", fileName?: string): BlobRef {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { id: `observer-${sha256.slice(0, 12)}`, sha256, byteLength: bytes.byteLength, mimeType, fileName };
}
