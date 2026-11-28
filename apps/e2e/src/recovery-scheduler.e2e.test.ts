import { randomUUID } from "node:crypto";

import { create, clone } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  EntityKind, InputContentSchema, OperationMutationSchema, OperationState, QueueDispatchState, QueueItemState, RunState, ScheduleInputSchema, ScheduleRecurrenceSchema,
  ScheduleRunOutcome, ScheduleSessionMode, ScheduleState, schedulePullRequestRuleToProto, type QueueControl
} from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createManualScheduleMutation,
  createSessionMutation,
  deleteMutation,
  pauseQueueMutation,
  queueItemIdFrom,
  queueRunIdFrom,
  resumeQueueMutation,
  scheduleIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit,
  triggerScheduleMutation
} from "./operations.js";

describe("Orchestrator restart recovery and unattended schedules", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("rejects a stale Web schedule rename after a catalog refresh and preserves the other device's pause and prompt", async () => {
    const host = fixture = await OrchestratorE2eFixture.start();
    const first = await host.pair("Schedule editor");
    const second = await host.pair("Other schedule editor");
    const request = createManualScheduleMutation({ backendId: host.adapter().id, targetId: host.targetId(), text: "Old instructions" });
    if (request.payload.case !== "createSchedule" || !request.payload.value.schedule) throw new Error("Missing schedule input.");
    const input = request.payload.value.schedule;
    input.recurrence = create(ScheduleRecurrenceSchema, { kind: { case: "cron", value: { expression: "0 3 * * *" } } });
    const scheduleId = scheduleIdFrom(await submit(first.clients.operation, first.connectionId, request));
    const editor = await openWebScheduleEditor(host, first);
    try {
      const draft = editor.draft(scheduleId);
      const { schedule: opened } = await second.clients.scheduler.getSchedule({ scheduleId });
      expect(opened?.nextTriggerAt).toBeDefined();
      const updated = clone(ScheduleInputSchema, input);
      updated.enabled = false;
      updated.input = create(InputContentSchema, { parts: [{ content: { case: "text", value: "New instructions" } }] });
      const result = await submit(second.clients.operation, second.connectionId, create(OperationMutationSchema, {
        preconditions: [{ entity: { kind: EntityKind.SCHEDULE, id: scheduleId }, expectedRevision: opened!.version!.revision }],
        payload: { case: "updateSchedule", value: { scheduleId, schedule: updated } }
      }));
      expect(result.state).toBe(OperationState.SUCCEEDED);
      const paused = host.application.store.getSchedule(scheduleId);
      await editor.gateway.refresh();
      expect(editor.draft(scheduleId)).toMatchObject({ enabled: false, inputText: "New instructions" });
      await expect(editor.gateway.saveSchedule(scheduleId, { ...draft, name: "Stale rename" })).rejects.toThrow(/revision|conflict/i);
      expect(host.application.store.getSchedule(scheduleId)).toEqual(paused);
      const { schedule } = await first.clients.scheduler.getSchedule({ scheduleId });
      expect(schedule).toMatchObject({ displayName: input.displayName, state: ScheduleState.DISABLED,
        input: { parts: [{ content: { case: "text", value: "New instructions" } }] } });
      expect(host.application.store.listDueSchedules(paused.nextRunAt!)).toEqual([]);
    } finally { editor.gateway.disconnect(); }
  });

  it("preserves the original expiration through a Web rename during a repeated hour", async () => {
    const host = fixture = await OrchestratorE2eFixture.start();
    const owner = await host.pair("Schedule deadline editor");
    const deadline = { seconds: BigInt(Date.parse("2027-11-07T06:30:45Z") / 1000), nanos: 123_000_000 };
    const request = createManualScheduleMutation({ backendId: host.adapter().id, targetId: host.targetId(),
      text: "Check the project", execution: { expireAt: deadline } });
    if (request.payload.case !== "createSchedule" || !request.payload.value.schedule) throw new Error("Missing schedule input.");
    request.payload.value.schedule.timeZone = "America/New_York";
    const id = scheduleIdFrom(await submit(owner.clients.operation, owner.connectionId, request));
    const editor = await openWebScheduleEditor(host, owner);
    const readDeadline = async () => (await owner.clients.scheduler.getSchedule({ scheduleId: id })).schedule?.execution?.expireAt;
    try {
      const draft = editor.draft(id);
      expect(draft.expireAtExpression).toBe("2027-11-07T01:30");
      await editor.gateway.saveSchedule(id, { ...draft, name: "Renamed schedule" });
      expect(await readDeadline()).toMatchObject(deadline);
      await editor.gateway.refresh();
      await editor.gateway.saveSchedule(id, { ...editor.draft(id), timezone: "UTC" });
      expect(await readDeadline()).toMatchObject({ seconds: BigInt(Date.parse("2027-11-07T01:30:00Z") / 1000), nanos: 0 });
      await editor.gateway.refresh();
      await editor.gateway.saveSchedule(id, { ...editor.draft(id), expireAtExpression: "" });
      expect(await readDeadline()).toBeUndefined();
    } finally { editor.gateway.disconnect(); }
  });

  it("round trips the complete v1 scheduled input through a Web rename", async () => {
    const host = fixture = await OrchestratorE2eFixture.start();
    const owner = await host.pair("Schedule editor");
    const request = createManualScheduleMutation({ backendId: host.adapter().id, targetId: host.targetId(), text: "Summarize" });
    if (request.payload.case !== "createSchedule" || !request.payload.value.schedule) throw new Error("Missing schedule input.");
    const schedule = request.payload.value.schedule;
    schedule.input = create(InputContentSchema, {
      parts: [{ content: { case: "text", value: "Summarize" } }, { content: { case: "workspaceMention", value: {
        workspaceId: "workspace-main", relativePath: "notes/today.md", displayText: "today.md", lineRange: { startLine: 2, endLine: 4 }
      } } }]
    });
    const scheduleId = scheduleIdFrom(await submit(owner.clients.operation, owner.connectionId, request));
    const editor = await openWebScheduleEditor(host, owner);
    try {
      const draft = editor.draft(scheduleId);
      expect(draft.inputText).toBe("Summarize\n@today.md");
      await editor.gateway.saveSchedule(scheduleId, { ...draft, name: "Renamed schedule" });
      const saved = (await owner.clients.scheduler.getSchedule({ scheduleId })).schedule;
      expect(saved?.displayName).toBe("Renamed schedule");
      expect(saved?.input).toEqual(schedule.input);
      expect(host.application.store.getSchedule(scheduleId).prompt.mentions).toMatchObject([{
        kind: "workspace_file", workspaceId: "workspace-main", reference: "notes/today.md", label: "today.md",
        lineRange: { startLine: 2, endLine: 4 }
      }]);
    } finally { editor.gateway.disconnect(); }
  });

  it.each([
    ["merged", "any", "creation", -1, 0], ["merged", "any", "creation", 0, 0], ["merged", "any", "creation", 1, 1],
    ["merged", "any", "last run", -1, 0], ["merged", "any", "last run", 0, 0], ["merged", "any", "last run", 1, 1],
    ["merged", "merged", "last run", 1, 1],
    ["closed", "any", "creation", -1, 0], ["closed", "any", "creation", 0, 0], ["closed", "any", "creation", 1, 1],
    ["closed", "any", "last run", -1, 0], ["closed", "any", "last run", 0, 0], ["closed", "any", "last run", 1, 1],
    ["closed", "merged", "last run", 1, 0]
  ] as const)(
    "reconciles the first authorized GitLab %s observation for %s at %s offset %i exactly %i time(s)", async (state, change, boundary, offset, count) => {
    let clock = Date.now(), reads = 0, terminalAt: number | undefined;
    const url = "https://git.team.example/group/Sub/project/-/merge_requests/7";
    const host = fixture = await OrchestratorE2eFixture.start({ scheduler: { now: () => clock, heartbeatLeaseMs: 20 * 60_000,
      pullRequestProviders: authority => [{ capability: "code-host.pull-request", minimumTimeToLiveMs: 5_000,
        supports: reference => reference.webUrl === url,
        getPullRequest: async (reference, options) => {
          const grant = authority.authorize(options.sessionOwnerId, reference);
          if (!grant || !authority.isCurrent(grant, reference) || options.purpose !== "follow") throw new Error("Missing follow grant");
          if (terminalAt === undefined) throw new Error("MR metadata is not yet readable");
          reads++;
          return { state, draft: false, title: "Watched MR", headBranch: "feature", observedAt: clock,
            activity: state === "merged" ? { mergedAt: terminalAt } : { closedAt: terminalAt } };
        } }] } });
    const { clients, connectionId } = await host.pair("Merge request follower");
    const backendId = host.adapter().id, targetId = host.targetId();
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({ backendId, targetId })));
    const scheduleId = scheduleIdFrom(await submit(clients.operation, connectionId, createManualScheduleMutation({ backendId, targetId, sessionId,
      sessionMode: ScheduleSessionMode.BOUND, text: "Follow this merge.", execution: { followPullRequest: schedulePullRequestRuleToProto({ url, change }) } })));
    const createdAt = host.application.store.getSchedule(scheduleId).createdAt;
    const history = async () => (await clients.scheduler.listScheduleRunHistory({ scheduleId })).history;
    if (boundary === "last run") {
      clock = createdAt + 10_000;
      expect((await submit(clients.operation, connectionId, triggerScheduleMutation(scheduleId))).state).toBe(OperationState.SUCCEEDED);
      await expect.poll(async () => (await history())[0]?.state).toBe(RunState.SUCCEEDED);
      expect(host.application.store.getSchedule(scheduleId).lastRunAt).toBe(clock);
    }
    const originalRuns = new Set((await history()).map(run => run.runId));
    const followedRuns = async () => (await history()).filter(run => !originalRuns.has(run.runId));
    terminalAt = (boundary === "last run" ? clock : createdAt) + offset;
    clock = Math.max(clock, createdAt) + 60_001;
    await expect.poll(() => reads).toBe(1);
    await expect.poll(async () => (await followedRuns()).length).toBe(count);
    clock += 60_001;
    await expect.poll(() => reads).toBe(2);
    expect((await followedRuns()).map(run => run.sessionId)).toEqual(count ? [sessionId] : []);
  });

  it("follows the current GitLab pipeline across identical job counts, partial fields and repeated polls", async () => {
    let clock = Date.now(), reads = 0;
    const url = "https://git.team.example/group/project/-/merge_requests/7";
    let pipeline: { pipelineId?: string; pipelineStatus?: string; pipelineFinishedAt?: number } = {
      pipelineId: "gid://gitlab/Ci::Pipeline/10", pipelineStatus: "SUCCESS", pipelineFinishedAt: clock
    };
    const host = fixture = await OrchestratorE2eFixture.start({ scheduler: { now: () => clock, heartbeatLeaseMs: 20 * 60_000,
      pullRequestProviders: authority => [{ capability: "code-host.pull-request", supports: reference => reference.webUrl === url,
        getPullRequest: async (reference, options) => {
          const grant = authority.authorize(options.sessionOwnerId, reference);
          if (!grant || !authority.isCurrent(grant, reference) || options.purpose !== "follow") throw new Error("Missing follow grant");
          reads++;
          return { state: "open", draft: false, title: "Pipeline rerun", headBranch: "feature",
            activity: { headSha: "a".repeat(40), checks: ["passed:1", "failed:0", "total:1", "pending:0", "skipped:0"], ...pipeline } };
        } }] } });
    const { clients, connectionId } = await host.pair("Pipeline follower");
    const backendId = host.adapter().id, targetId = host.targetId();
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({ backendId, targetId })));
    const scheduleId = scheduleIdFrom(await submit(clients.operation, connectionId, createManualScheduleMutation({ backendId, targetId, sessionId,
      sessionMode: ScheduleSessionMode.BOUND, text: "Check this pipeline.", execution: { followPullRequest: schedulePullRequestRuleToProto({ url, change: "checks" }) } })));
    const poll = async (expectedReads: number, expectedRuns: number) => {
      clock += 60_001;
      await expect.poll(() => reads).toBe(expectedReads);
      await expect.poll(async () => (await clients.scheduler.listScheduleRunHistory({ scheduleId })).history.map(run => run.state))
        .toEqual(Array(expectedRuns).fill(RunState.SUCCEEDED));
    };
    await poll(1, 0);
    pipeline.pipelineId = "gid://gitlab/Ci::Pipeline/11";
    await poll(2, 1);
    const rerun = pipeline;
    pipeline = {};
    await poll(3, 1);
    pipeline = rerun;
    await poll(4, 1);
    pipeline.pipelineFinishedAt = clock;
    await poll(5, 2);
    pipeline.pipelineStatus = "FAILED";
    await poll(6, 3);
    await poll(7, 3);
  });

  it.each([["checks", "github.com"], ["review", "github.com"], ["checks", "git.team.example"]] as const)(
    "wakes only the authorized bound task for newly readable PR %s on %s and coalesces busy changes", { timeout: 45_000 }, async (change, host) => {
    let clock = Date.now() - 10 * 60_000;
    let signal: "failure" | "queued" | "success" | undefined;
    const reads: { owner: string; url: string; authorized: boolean }[] = [];
    fixture = await OrchestratorE2eFixture.start({ scheduler: {
      now: () => clock,
      heartbeatLeaseMs: 20 * 60_000,
      pullRequestProviders: authority => [{
        capability: "code-host.pull-request",
        minimumTimeToLiveMs: 5_000,
        supports: reference => reference.host === host,
        getPullRequest: async (reference, options) => {
          const authorized = authority.authorize(options.sessionOwnerId, reference);
          reads.push({ owner: options.sessionOwnerId, url: reference.webUrl,
            authorized: authorized !== undefined && options.purpose === "follow" && authority.isCurrent(authorized, reference) });
          return { state: "open", draft: false, title: "Follow checks", headBranch: "feature",
            observedAt: clock, activity: { headSha: "a".repeat(40),
              checks: change === "checks" && signal !== undefined ? [signal === "queued" ? "check:queued:" : `check:completed:${signal}`] : undefined,
              reviewDecision: change === "review" && signal !== undefined
                ? { failure: "CHANGES_REQUESTED", queued: "REVIEW_REQUIRED", success: "APPROVED" }[signal] : undefined } };
        }
      }]
    } });
    const { clients, connectionId } = await fixture.pair("Pull request automation owner");
    const { store } = fixture.application;
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId,
      createSessionMutation({ backendId, targetId, displayName: "Bound follow task" })));
    const unrelatedId = sessionIdFrom(await submit(clients.operation, connectionId,
      createSessionMutation({ backendId, targetId, displayName: "Unrelated task" })));
    const mr = "https://git.team.example/group/Sub/project/-/merge_requests/7";
    const rawUrl = host === "github.com" ? "https://github.com/JokoAgent/Joko/pull/17/" : mr + "/";
    const url = host === "github.com" ? "https://github.com/jokoagent/joko/pull/17" : mr;
    const request = createManualScheduleMutation({ backendId, targetId, sessionId,
      sessionMode: ScheduleSessionMode.BOUND, text: "Inspect the changed checks.", execution: {
        followPullRequest: schedulePullRequestRuleToProto({ url: rawUrl, change })
      } });
    if (request.payload.case !== "createSchedule" || request.payload.value.schedule === undefined) throw new Error("Missing Automation input.");
    const original = request.payload.value.schedule;
    const invalid = clone(ScheduleInputSchema, original);
    invalid.sessionId = "";
    invalid.sessionMode = ScheduleSessionMode.FRESH;
    await expect(submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "createSchedule", value: { schedule: invalid } }
    }))).rejects.toMatchObject({ code: Code.InvalidArgument });
    const scheduleId = scheduleIdFrom(await submit(clients.operation, connectionId, request));
    const history = async () => (await clients.scheduler.listScheduleRunHistory({ scheduleId })).history;
    const watchState = () => store.findSetting<{ pending?: { url: string } | null }>("service", scheduleId, SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY);
    const clockTick = async (ms: number, expectedReads: number) => {
      clock += ms;
      await expect.poll(() => reads.length, { timeout: 8_000 }).toBe(expectedReads);
    };
    await clockTick(5_001, 1);
    expect(reads[0]).toEqual({ owner: scheduleId, url, authorized: true });
    expect(await history()).toHaveLength(0);
    const baseline = watchState();
    expect(baseline?.value).toMatchObject({ format: 1 });
    expect(baseline?.value).not.toHaveProperty("pending");
    store.setSetting("service", scheduleId, SCHEDULE_PULL_REQUEST_WATCH_SETTING_KEY,
      { ...baseline!.value, pending: null, lastDispatchedAt: null });
    await clockTick(5_001, 2);
    expect(await history()).toHaveLength(0);

    signal = "failure";
    await clockTick(5_001, 3);
    await expect.poll(async () => (await history()).map(run => run.outcome)).toEqual([ScheduleRunOutcome.SUCCEEDED]);
    const first = (await history())[0]!;
    expect(first).toMatchObject({ sessionId, pullRequestUrl: url });
    signal = undefined;
    await clockTick(5_001, 4);
    signal = "failure";
    await clockTick(5_001, 5);
    expect(await history()).toHaveLength(1);
    expect(watchState()?.value.pending).toBeUndefined();
    const queueControl = async () => requiredQueueControl(await clients.queue.getQueueControl({ sessionId }));
    await submit(clients.operation, connectionId, pauseQueueMutation(await queueControl()));
    await submit(clients.operation, connectionId, sendInputMutation(sessionId,
      BigInt(store.getSession(sessionId).descriptor.binding.generation), "Keep this task busy"));
    signal = "queued";
    await clockTick(5_001, 6);
    signal = "success";
    await clockTick(5_001, 7);
    expect(await history()).toHaveLength(1);
    expect(fixture.adapter().sendCalls.map(input => input.text)).toEqual(["Inspect the changed checks."]);
    await submit(clients.operation, connectionId, resumeQueueMutation(await queueControl()));
    await expect.poll(() => store.listRuns({ sessionId, activeOnly: true }).length).toBe(0);
    await clockTick(5_001, 8);
    expect(await history()).toHaveLength(1);
    await clockTick(60_001, 9);
    await expect.poll(async () => (await history()).map(run => run.outcome))
      .toEqual([ScheduleRunOutcome.SUCCEEDED, ScheduleRunOutcome.SUCCEEDED]);
    expect((await history()).map(run => run.sessionId)).toEqual([sessionId, sessionId]);
    expect(store.listRuns({ sessionId: unrelatedId })).toHaveLength(0);

    const legacy = clone(ScheduleInputSchema, original);
    legacy.execution!.followPullRequest = undefined;
    const update = (schedule: typeof legacy) => submit(clients.operation, connectionId, create(OperationMutationSchema, {
      payload: { case: "updateSchedule", value: { scheduleId, schedule } }
    }));
    expect((await update(legacy)).state).toBe(OperationState.SUCCEEDED);
    expect((await clients.scheduler.getSchedule({ scheduleId })).schedule?.execution?.followPullRequest?.url).toBe(url);
    signal = "failure";
    await clockTick(5_001, 10);
    expect(await history()).toHaveLength(2);
    await expect.poll(() => watchState()?.value.pending?.url).toBe(url);
    legacy.execution!.followPullRequest = schedulePullRequestRuleToProto(null);
    expect((await update(legacy)).state).toBe(OperationState.SUCCEEDED);
    expect((await clients.scheduler.getSchedule({ scheduleId })).schedule?.execution?.followPullRequest).toBeUndefined();
    expect(watchState()).toBeUndefined();
    clock += 60_001;
    await fixture.application.scheduler.tick();
    expect(await history()).toHaveLength(2);
    expect(reads.every(read => read.authorized)).toBe(true);
  });

  it("fences an in-flight dispatch as dispatch_unknown after server/store restart without replay", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }] });
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("restart client");
    const adapterId = fixture.adapter().id;
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: adapterId, targetId: fixture.targetId() })
    ));
    fixture.adapter().injectFault(sessionId, "hang");
    const operationId = randomUUID();
    const queued = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "may already have external effects"),
      operationId
    );
    const queueItemId = queueItemIdFrom(queued);
    await waitFor(
      async () => fixture!.adapter().sendCalls.length,
      (value) => value === 1,
      "Backend send to enter the possibly-accepted crash window"
    );
    expect((await paired.clients.queue.listQueueItems({ sessionId })).queueItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ queueItemId, state: QueueItemState.DISPATCHING })
      ]));

    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({
      rootDirectory,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }]
    });
    const restartedClients = fixture.clients(paired.authKey);
    const recoveredQueue = await waitFor(
      () => restartedClients.queue.listQueueItems({ sessionId }),
      (value) => value.queueItems.some((item) => item.queueItemId === queueItemId && item.state === QueueItemState.DISPATCH_UNKNOWN),
      "dispatch_unknown recovery"
    );
    const item = recoveredQueue.queueItems.find((candidate) => candidate.queueItemId === queueItemId)!;
    expect(item.state).toBe(QueueItemState.DISPATCH_UNKNOWN);
    const recoveredRun = await restartedClients.run.getRun({ runId: item.runId });
    expect(recoveredRun.run?.state).toBe(RunState.DISPATCH_UNKNOWN);
    expect(fixture.adapter().sendCalls).toHaveLength(0);

    const persistedOperation = await restartedClients.operation.getOperation({ operationId });
    const payload = persistedOperation.operation?.mutation?.payload;
    expect(payload?.case).toBe("sendInput");
    if (payload?.case !== "sendInput") throw new Error("Persisted Operation lost its SendInput mutation.");
    expect(payload.value.input?.parts[0]?.content).toEqual({
      case: "text",
      value: "may already have external effects"
    });
  });

  it("keeps pre-dispatch accepted work paused across server/store restart and dispatches it once after resume", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }] });
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("pre-dispatch restart client");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId() })
    ));
    await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(
        requiredQueueControl(await paired.clients.queue.getQueueControl({ sessionId })),
        "hold before restart"
      )
    );
    const queued = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "durable before dispatch")
    );
    const queueItemId = queueItemIdFrom(queued);
    const runId = queueRunIdFrom(queued);
    expect((await paired.clients.queue.getQueueControl({ sessionId })).queueControl?.dispatchState)
      .toBe(QueueDispatchState.PAUSED);
    expect((await paired.clients.queue.listQueueItems({ sessionId })).queueItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ queueItemId, state: QueueItemState.ACCEPTED })
      ]));
    expect((await paired.clients.run.getRun({ runId })).run?.state).toBe(RunState.QUEUED);
    expect(fixture.adapter().sendCalls).toHaveLength(0);

    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({
      rootDirectory,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }]
    });
    const restarted = fixture.clients(paired.authKey);
    const restartedControl = requiredQueueControl(await restarted.queue.getQueueControl({ sessionId }));
    expect(restartedControl.dispatchState).toBe(QueueDispatchState.PAUSED);
    expect((await restarted.queue.listQueueItems({ sessionId })).queueItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ queueItemId, state: QueueItemState.ACCEPTED })
      ]));
    expect((await restarted.run.getRun({ runId })).run?.state).toBe(RunState.QUEUED);
    expect(fixture.adapter().sendCalls).toHaveLength(0);

    await submit(
      restarted.operation,
      paired.connectionId,
      resumeQueueMutation(restartedControl)
    );
    const settled = await waitFor(
      () => restarted.run.getRun({ runId }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      "pre-dispatch recovered Run"
    );
    expect(settled.run?.attempts.map((attempt) => attempt.generation)).toEqual([1n, 2n]);
    expect(settled.run?.attempts.every((attempt) => attempt.endedAt !== undefined)).toBe(true);
    expect((await restarted.queue.listQueueItems({ sessionId })).queueItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ queueItemId, state: QueueItemState.COMPLETED })
      ]));
    expect(fixture.adapter().sendCalls).toHaveLength(1);
    expect(fixture.adapter().sendCalls[0]?.text).toBe("durable before dispatch");
  });

  it("dispatches a durable manual schedule through SessionHost without a live UI caller", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }] });
    const creator = await fixture.pair("schedule creator");
    const observer = await fixture.pair("schedule observer");
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const sessionId = sessionIdFrom(await submit(
      creator.clients.operation,
      creator.connectionId,
      createSessionMutation({ backendId, targetId, displayName: "Unattended task" })
    ));
    const scheduleId = scheduleIdFrom(await submit(
      creator.clients.operation,
      creator.connectionId,
      createManualScheduleMutation({ backendId, targetId, sessionId, text: "scheduled while UI is absent" })
    ));

    // This is the same coordinator path used by its timer/supervisor, not an RPC
    // owned by either connected client.
    await fixture.application.scheduler.runNow(scheduleId, randomUUID());
    const history = await waitFor(
      () => observer.clients.scheduler.listScheduleRunHistory({ scheduleId }),
      (value) => value.history.length === 1 && value.history[0]?.state === RunState.SUCCEEDED,
      "unattended scheduled Run"
    );
    expect(history.history[0]?.runId).not.toBe("");
    expect(fixture.adapter().sendCalls.some((item) => item.text === "scheduled while UI is absent")).toBe(true);
    const schedules = await observer.clients.scheduler.listSchedules({ sessionId });
    expect(schedules.schedules[0]?.scheduleId).toBe(scheduleId);
  });

  it("keeps a bound manual Automation and its original successful history visible after task deletion", async () => {
    const host = fixture = await OrchestratorE2eFixture.start();
    const { clients, connectionId } = await host.pair("Automation owner");
    const backendId = host.adapter().id;
    const targetId = host.targetId();
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({ backendId, targetId })));
    const scheduleId = scheduleIdFrom(await submit(clients.operation, connectionId, createManualScheduleMutation({
      backendId, targetId, sessionId, sessionMode: ScheduleSessionMode.BOUND, text: "Keep this completed occurrence"
    })));
    expect((await submit(clients.operation, connectionId, triggerScheduleMutation(scheduleId))).state).toBe(OperationState.SUCCEEDED);
    const completed = await waitFor(
      () => clients.scheduler.listScheduleRunHistory({ scheduleId }),
      ({ history }) => history.length === 1 && history[0]?.state === RunState.SUCCEEDED,
      "the original bound manual occurrence"
    );
    const [original] = completed.history;
    expect(original?.sessionId).toBe(sessionId);
    expect(original?.runId).toBeTruthy();

    expect((await submit(clients.operation, connectionId, deleteMutation(sessionId))).state).toBe(OperationState.SUCCEEDED);
    expect(host.application.store.getSession(sessionId).descriptor.deletedAt).toBeDefined();
    const snapshot = (await clients.event.getSnapshot({})).snapshot;
    expect(snapshot?.sessions.some((task) => task.sessionId === sessionId)).toBe(false);
    expect(snapshot?.runs.some((run) => run.runId === original?.runId)).toBe(false);
    expect(snapshot?.schedules).toEqual([expect.objectContaining({
      scheduleId, sessionId, recentRuns: [expect.objectContaining({
        triggerId: original?.triggerId, runId: original?.runId, sessionId, state: RunState.SUCCEEDED
      })]
    })]);
    expect((await clients.scheduler.listSchedules({})).schedules.map((schedule) => schedule.scheduleId)).toEqual([scheduleId]);
    expect((await clients.scheduler.listScheduleRunHistory({ scheduleId })).history).toEqual(completed.history);
    expect(host.adapter().sendCalls).toHaveLength(1);
  });

  it("saves and dispatches each exact one-shot quota recovery instant in a repeated hour", async () => {
    // Advance the service wall clock while leaving real RPC and test timers running.
    const realNow = Date.now;
    let clockOffset = Date.parse("2027-11-07T04:00:00Z") - realNow();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
    let disconnect: (() => void) | undefined;
    try {
      const serverId = "one-shot-repeated-hour";
      const host = fixture = await OrchestratorE2eFixture.start({ serverId });
      const owner = await host.pair("Quota recovery schedule owner");
      const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
        backendId: host.adapter().id, targetId: host.targetId(), displayName: "Quota recovery task"
      })));
      const { createOrchestratorGateway, mapSnapshot } = await import(new URL("../../web/src/gateway.ts", import.meta.url).href);
      const { scheduleDraft } = await import(new URL("../../web/src/components/SchedulesPage.tsx", import.meta.url).href);
      const { buildUsageLimitScheduleDraft, usageLimitRecoveryHint } = await import(new URL("../../web/src/usage-limit-recovery.ts", import.meta.url).href);
      const gateway = createOrchestratorGateway({ id: owner.connectionId, deviceId: owner.deviceId, serverId,
        name: "Quota recovery Web", origin: host.baseUrl }, owner.authKey, {}, () => createConnectTransport({
        baseUrl: host.baseUrl, httpVersion: "1.1", useBinaryFormat: true,
        interceptors: [next => async request => { request.header.set("authorization", `Bearer ${owner.authKey}`); return next(request); }]
      }));
      disconnect = () => gateway.disconnect();
      await gateway.connect({ snapshotOnly: true });
      const readOwner = async () => {
        const { snapshot } = await owner.clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } });
        if (snapshot === undefined) throw new Error("The paired node returned no Owner snapshot.");
        return mapSnapshot(snapshot);
      };
      const { targets, sessions, models, backends } = await readOwner();
      const session = sessions.find((item: { readonly id: string }) => item.id === sessionId);
      expect(session).toBeDefined();
      const timezone = "America/New_York";
      const base = { ...scheduleDraft(undefined, targets, sessions, models, backends), timezone };
      const schedules = [];
      for (const hour of [5, 6]) {
        const triggerAt = Date.UTC(2027, 10, 7, hour, 31);
        const hint = usageLimitRecoveryHint({ code: "PROVIDER_REQUEST_FAILED",
          message: `Rate limit exceeded; resets at ${(triggerAt - 60_000) / 1_000}`,
          phase: "stream", severity: "blocked", retryable: false, recovery: [] }, Date.now());
        expect(hint?.resetAtMs).toBe(triggerAt - 60_000);
        const name = `Original quota recovery ${hour}`, prompt = `Resume original task at ${hour} UTC`;
        const draft = buildUsageLimitScheduleDraft(base, { ...hint, requestId: `quota-recovery-${hour}`, sessionId }, session, { name, prompt });
        expect(draft.expression).toBe("2027-11-07T01:31");
        await gateway.saveSchedule(undefined, draft);
        const listed = (await owner.clients.scheduler.listSchedules({ sessionId })).schedules.find(item => item.displayName === name);
        if (!listed) throw new Error("The new one-shot Schedule is absent from the paired node.");
        const receipt = { seconds: BigInt(triggerAt / 1000), nanos: 0 };
        expect(listed.nextTriggerAt).toMatchObject(receipt);
        const current = (await readOwner()).schedules.find((item: { readonly id: string }) => item.id === listed.scheduleId);
        expect(current?.expression).toBe(new Date(triggerAt).toISOString());
        const reopened = scheduleDraft(current, targets, sessions, models, backends);
        expect(reopened.expression).toBe(draft.expression);
        await gateway.saveSchedule(listed.scheduleId, { ...reopened, name: `${name} edited` });
        const saved = (await owner.clients.scheduler.getSchedule({ scheduleId: listed.scheduleId })).schedule;
        expect(saved?.nextTriggerAt).toMatchObject(receipt);
        schedules.push({ scheduleId: listed.scheduleId, triggerAt, receipt, prompt });
      }

      const [first, second] = schedules;
      if (first === undefined || second === undefined) throw new Error("Both one-shot Schedules must be saved before dispatch.");
      const history = (scheduleId: string) => owner.clients.scheduler.listScheduleRunHistory({ scheduleId });
      for (const entry of [first, second]) {
        clockOffset = entry.triggerAt - realNow();
        const result = await waitFor(() => history(entry.scheduleId), response => response.history[0]?.state === RunState.SUCCEEDED,
          "the one-shot occurrence at its saved instant");
        expect(result.history).toHaveLength(1);
        expect(result.history[0]).toMatchObject({ sessionId, scheduledFor: entry.receipt });
        const saved = (await owner.clients.scheduler.getSchedule({ scheduleId: entry.scheduleId })).schedule;
        expect(saved?.state).toBe(ScheduleState.DISABLED);
        if (entry === first) {
          expect((await history(second.scheduleId)).history).toEqual([]);
          expect(host.adapter().sendCalls.map(input => input.text)).toEqual([first.prompt]);
        }
      }
      expect((await history(first.scheduleId)).history).toHaveLength(1);
      expect(host.adapter().sendCalls.map(input => input.text)).toEqual([first.prompt, second.prompt]);
    } finally {
      disconnect?.();
      clock.mockRestore();
    }
  });
});

async function openWebScheduleEditor(host: OrchestratorE2eFixture, owner: Awaited<ReturnType<OrchestratorE2eFixture["pair"]>>) {
  const { createOrchestratorGateway, mapSnapshot } = await import(new URL("../../web/src/gateway.ts", import.meta.url).href);
  const { scheduleDraft } = await import(new URL("../../web/src/components/SchedulesPage.tsx", import.meta.url).href);
  let snapshot: ReturnType<typeof mapSnapshot>;
  const gateway = createOrchestratorGateway({ id: owner.connectionId, deviceId: owner.deviceId, serverId: "orchestrator-e2e",
    name: "Schedule Web editor", origin: host.baseUrl }, owner.authKey, {
    onSnapshot: (current: typeof snapshot) => { snapshot = current; }
  }, () => createConnectTransport({ baseUrl: host.baseUrl, httpVersion: "1.1", useBinaryFormat: true,
    interceptors: [next => async request => { request.header.set("authorization", `Bearer ${owner.authKey}`); return next(request); }] }));
  await gateway.connect({ snapshotOnly: true });
  return { gateway, draft(scheduleId: string) {
    const schedule = snapshot.schedules.find((item: { id: string }) => item.id === scheduleId);
    if (!schedule) throw new Error("Schedule missing from the editor's catalog.");
    return scheduleDraft(schedule, snapshot.targets, snapshot.sessions, snapshot.models, snapshot.backends);
  } };
}

function requiredQueueControl(response: { readonly queueControl?: QueueControl }): QueueControl {
  if (response.queueControl === undefined) throw new Error("Orchestrator returned no queue control.");
  return response.queueControl;
}
