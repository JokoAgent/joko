import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { BackgroundTaskOutputSchema, BackgroundTaskOutputState, projectBackgroundWorkflow, backgroundWorkflowStateLabel } from "../dist/index.js";

test("the typed output preserves optional zero counts and workflow facts through the actual binary contract", () => {
  const value = create(BackgroundTaskOutputSchema, { sessionId: "session", backgroundTaskId: "task", state: BackgroundTaskOutputState.AVAILABLE,
    workflow: { runId: "workflow", status: "done", totalTokens: 0n, phases: [{ index: 1, title: "Review", detail: "Evidence" }],
      agents: [{ label: "Reviewer", state: "running", phaseIndex: 1, attempt: 2, model: "model", lastToolName: "Read", resultPreview: "Result", durationMs: 0n }], logs: ["Log"] } });
  const output = fromBinary(BackgroundTaskOutputSchema, toBinary(BackgroundTaskOutputSchema, value));
  assert.deepEqual(output, value); assert.equal(output.workflow.totalTokens, 0n); assert.equal(output.workflow.totalToolCalls, undefined);
  const model = projectBackgroundWorkflow(output.workflow, "running");
  assert.equal(model.status, "done"); assert.equal(model.agentCount, 1n); assert.equal(model.groups[0].title, "Review");
  assert.equal(model.groups[0].detail, "Evidence"); assert.equal(model.groups[0].agents[0].state, "error");
  assert.equal(output.workflow.agents[0].state, "running"); assert.equal(backgroundWorkflowStateLabel("error", "zh-CN"), "失败");
});

test("terminal task presentation corrects unfinished rows, retains native errors and puts unknown phases in a final group", () => {
  const output = create(BackgroundTaskOutputSchema, { workflow: { runId: "workflow", status: "running", agentCount: 1n,
    phases: [{ index: 1, title: "Review" }, { index: 2, title: "Empty" }], agents: [{ label: "Waiting", state: "queued", phaseIndex: 1 },
      { label: "Failed", state: "failed", phaseTitle: "Review", error: "Original error" }, { label: "Orphan", state: "done", phaseTitle: "Absent" }] } });
  const model = projectBackgroundWorkflow(output.workflow, "aborted");
  assert.equal(model.status, "aborted"); assert.equal(model.agentCount, 3n); assert.equal(model.groups.length, 2);
  assert.deepEqual(model.groups[0].agents.map(agent => agent.state), ["error", "failed"]);
  assert.equal(model.groups[0].agents[1].error, "Original error"); assert.equal(model.groups[1].title, undefined);
  assert.equal(model.groups[1].agents[0].label, "Orphan");
});
