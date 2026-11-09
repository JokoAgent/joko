import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractBackgroundWorkflowProgress, readBackgroundWorkflowProgress } from "./workflow-progress.js";

const sdkId = "8e2c0c04-e172-4205-bf6b-5ca755405bf4", otherSdkId = "e430348f-a200-4880-94b6-70d2c878a1cd";
const rawId = "original-native-workflow", taskId = `claude-task-${createHash("sha256").update(rawId).digest("hex").slice(0, 32)}`;
const project = (value: unknown, maximum: number) => String(value).replaceAll("private-marker", "[redacted]").slice(0, maximum);
const progress = () => ({ taskId: rawId, runId: "workflow-run", status: "done", workflowName: "Investigation", agentCount: 2,
  totalTokens: 0, totalToolCalls: 4, durationMs: 3_200, phases: [{ title: "Review", detail: "Review private-marker evidence" }],
  workflowProgress: [{ type: "workflow_agent", label: "Queued worker", state: "queued", phaseIndex: 1, attempt: 2, model: "native-model" },
    { type: "workflow_agent", agentId: "worker", state: "done", phaseTitle: "Review", lastToolName: "Read", lastToolSummary: "Opened evidence",
      resultPreview: "Found private-marker", durationMs: 3_000 }], logs: Array.from({ length: 55 }, (_, i) => `Log ${i} private-marker`) });

it("extracts persisted phases, queued agents without IDs, attempts and terminal facts with bounded redacted logs", () => {
  const result = extractBackgroundWorkflowProgress(progress(), 16_384, project)!;
  expect(result.workflow).toMatchObject({ runId: "workflow-run", status: "done", agentCount: 2, totalTokens: 0,
    phases: [{ index: 1, title: "Review", detail: "Review [redacted] evidence" }],
    agents: [{ label: "Queued worker", state: "queued", phaseIndex: 1, attempt: 2, model: "native-model" },
      { label: "worker", state: "done", lastToolName: "Read", resultPreview: "Found [redacted]", durationMs: 3_000 }] });
  expect(result.workflow.logs).toHaveLength(50); expect(result.workflow.logs[0]).toBe("Log 5 [redacted]");
  expect(JSON.stringify(result)).not.toContain("private-marker");
  const limited = extractBackgroundWorkflowProgress(progress(), 650, project)!;
  expect(limited.truncated).toBe(true); expect(Buffer.byteLength(JSON.stringify(limited.workflow))).toBeLessThanOrEqual(650);
  expect(extractBackgroundWorkflowProgress(progress(), 8, project)).toBeUndefined();
  for (const input of [null, [], {}, { runId: "" }]) expect(extractBackgroundWorkflowProgress(input, 1024, project)).toBeUndefined();
});

it("prefers explicit workflow phases, rejects malformed numeric facts and tolerates unrelated records", () => {
  const result = extractBackgroundWorkflowProgress({ ...progress(), agentCount: -1, totalTokens: Number.MAX_SAFE_INTEGER + 1,
    workflowProgress: [null, { type: "workflow_phase", index: 4, title: "Review" }, { type: "workflow_phase", index: -1, title: "Invalid" },
      { type: "workflow_agent", state: "running" }, { type: "workflow_agent", label: "Worker", state: "running", attempt: 0, durationMs: -1 }] }, 16_384, project)!;
  expect(result.workflow.phases).toEqual([{ index: 4, title: "Review", detail: "Review [redacted] evidence" }]);
  expect(result.workflow.agents).toEqual([{ label: "Worker", state: "running" }]);
  expect(result.workflow.agentCount).toBeUndefined(); expect(result.workflow.totalTokens).toBeUndefined();
});

it("reads only adopted SDK directories and the exact native task, including a terminal file after reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-workflow-progress-")), configurationDirectory = join(root, "config"), workingDirectory = join(root, "workspace");
  const directory = (id: string) => join(configurationDirectory, "projects", workingDirectory.replace(/[^a-zA-Z0-9]/gu, "-"), id, "workflows");
  const read = (ids = [sdkId]) => readBackgroundWorkflowProgress({ configurationDirectory, workingDirectory, nativeSessionIds: ids,
    taskId, maximumBytes: 16_384, project, assertCurrent() {} });
  try {
    await mkdir(directory(otherSdkId), { recursive: true }); await writeFile(join(directory(otherSdkId), "wf_foreign.json"), JSON.stringify(progress()));
    expect((await read()).status).toBe("unavailable");
    await mkdir(directory(sdkId), { recursive: true });
    await writeFile(join(directory(sdkId), "wf_bad.json"), "{");
    await writeFile(join(directory(sdkId), "wf_other.json"), JSON.stringify({ ...progress(), taskId: "other-native-task" }));
    expect((await read()).status).toBe("unavailable");
    await writeFile(join(directory(sdkId), "wf_owned.json"), JSON.stringify(progress()));
    const result = await read(); expect(result.status).toBe("available"); expect(result.workflow?.status).toBe("done");
    expect(result.totalBytes).toBe(Buffer.byteLength(JSON.stringify(progress()))); expect(Number.isSafeInteger(result.modifiedAtMs)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(configurationDirectory); expect(JSON.stringify(result)).not.toContain("private-marker");
    expect((await read(["../other"])).status).toBe("unavailable");
    let checks = 0;
    await expect(readBackgroundWorkflowProgress({ configurationDirectory, workingDirectory, nativeSessionIds: [sdkId], taskId,
      maximumBytes: 16_384, project, assertCurrent() { if (++checks >= 8) throw new Error("retired owner"); } })).rejects.toThrow("retired owner");
    expect((await read()).workflow?.runId).toBe("workflow-run");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("refuses redirected workflow directories and oversized records without exposing their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-workflow-path-")), workingDirectory = join(root, "workspace"), configurationDirectory = join(root, "config");
  const directory = join(configurationDirectory, "projects", workingDirectory.replace(/[^a-zA-Z0-9]/gu, "-"), sdkId, "workflows");
  const read = () => readBackgroundWorkflowProgress({ configurationDirectory, workingDirectory, nativeSessionIds: [sdkId], taskId, maximumBytes: 16_384, project, assertCurrent() {} });
  try {
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "wf_large.json"), JSON.stringify({ ...progress(), padding: "x".repeat(1024 * 1024) }));
    expect((await read()).status).toBe("unavailable");
    await writeFile(join(directory, "wf_owned.json"), JSON.stringify(progress()));
    const moved = join(root, "redirected"); await rename(directory, moved);
    await symlink(moved, directory, process.platform === "win32" ? "junction" : "dir");
    expect((await read()).status).toBe("unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("uses the frozen native profile's explicit SDK project namespace without accepting a path component escape", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-workflow-project-")), workingDirectory = join(root, "workspace"), configurationDirectory = join(root, "config");
  const projectDirectoryName = "owned-project", directory = join(configurationDirectory, "projects", projectDirectoryName, sdkId, "workflows");
  const input = { configurationDirectory, workingDirectory, nativeSessionIds: [sdkId], taskId, maximumBytes: 16_384, project, assertCurrent() {} };
  try {
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, "wf_owned.json"), JSON.stringify(progress()));
    expect((await readBackgroundWorkflowProgress(input)).status).toBe("unavailable");
    expect((await readBackgroundWorkflowProgress({ ...input, projectDirectoryName })).workflow?.runId).toBe("workflow-run");
    expect((await readBackgroundWorkflowProgress({ ...input, projectDirectoryName: "../owned-project" })).status).toBe("unavailable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
