import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AdapterContext, BlobRef, EventPayload, InteractionPayload, TargetDescriptor } from "@joko/core";
import { describe, expect, it, vi } from "vitest";

import { managedSubagentSessionKey } from "./durable-subagent-runs.js";
import type { PiManagedDurableRunSnapshot, PiManagedDurableStore } from "./managed-durable-store.js";
import {
  assertManagedSubagentControlTarget,
  ManagedSubagentObserver,
  writeManagedSubagentDurableControl
} from "./managed-subagent-observer.js";
import { encodePolicyDecisionRequest } from "./policy-decision-bridge.js";
import { mkdtemp } from "./test-paths.js";

describe("managed Subagent public observation", () => {
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
    })).resolves.toBeUndefined();
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
      })).resolves.toBeUndefined();
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
    })).resolves.toBeUndefined();
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

  it("evaluates current delegated policy requests and fails an older policy generation closed", async () => {
    const root = join(await mkdtemp(join(tmpdir(), "joko-subagent-policy-")), "subagent-runs");
    const sessionId = `session-${randomUUID()}`;
    const currentTaskId = "policy-call:current";
    const staleTaskId = "policy-call:stale";
    const observation = {
      subjectKind: "browser" as const,
      risk: "high" as const,
      toolProviderId: "browser",
      toolName: "navigate"
    };
    const currentApprovalId = `policy-${randomUUID()}`;
    const staleApprovalId = `policy-${randomUUID()}`;
    const [current, stale] = await Promise.all([
      physicalRun(root, sessionId, currentTaskId, 6, 1, [], undefined, "running", {
        pendingApproval: {
          id: currentApprovalId,
          childId: `${currentTaskId}:child`,
          method: "input",
          title: encodePolicyDecisionRequest({ policyGeneration: 7, observation }),
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
            id: "deny-browser-navigation",
            effect: "deny",
            subjectKind: "browser",
            toolProviderId: "browser",
            toolName: "navigate",
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
    observer.stop();
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
  #revision = createHash("sha256").update("remote fixture revision:0").digest("hex");
  #controlRevision = createHash("sha256").update("remote fixture control:0").digest("hex");
  readonly #transcriptRevision = createHash("sha256").update("remote fixture transcript:0").digest("hex");
  readonly #resultRevision = createHash("sha256").update("remote fixture result:absent").digest("hex");
  #lastControl: Readonly<Record<string, unknown>> | undefined;

  constructor(sessionId: string, taskId: string, approvalId: string) {
    this.#sessionId = sessionId;
    this.#taskId = taskId;
    this.#approvalId = approvalId;
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
    const runDirectory = `/home/fixture/.joko/subagent-runs/${input.sessionKey}/${this.#runId}`;
    const runnerScript = `${runDirectory}/joko-managed-subagent-runner.cjs`;
    const transcriptPath = `${runDirectory}/transcript.jsonl`;
    const config = {
      format: 1,
      runId: this.#runId,
      launchToken: this.#launchToken,
      runnerInstanceId: this.#runnerInstanceId,
      runDir: runDirectory,
      runnerScript,
      runnerScriptSha256: this.#runnerScriptSha256,
      productSessionId: this.#sessionId,
      productGeneration: 3,
      parentTaskId: "parent-tool-call",
      taskId: this.#taskId,
      childId: `${this.#taskId}:child`,
      title: "Remote fixture task",
      readOnly: false,
      contextMode: "fork",
      route: { provider: "remote", model: "fixture", effort: "high" },
      nativeSessionId: randomUUID(),
      turnCount: 1,
      transcriptPath
    };
    const owner = {
      format: 1,
      runId: this.#runId,
      launchToken: this.#launchToken,
      productSessionId: this.#sessionId,
      taskId: this.#taskId,
      runnerScript,
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
      runnerScript,
      runnerScriptSha256: this.#runnerScriptSha256,
      runnerPid: 42,
      runnerInstanceId: this.#runnerInstanceId,
      state: "running",
      summary: "running",
      createdAt: 1_000,
      startedAt: 1_001,
      heartbeatAt: 1_002,
      nativeSessionId: config.nativeSessionId,
      nativeSessionPath: `${runDirectory}/sessions/${config.nativeSessionId}.jsonl`,
      transcriptPath,
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
