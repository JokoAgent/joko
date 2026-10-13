import { create } from "@bufbuild/protobuf";
import { ListPartnerTaskOutputsResponseSchema, PartnerTaskOutputSourceKind, PartnerTaskOutputReadiness,
  PartnerTaskOutputFileStatus } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { projectMobilePartnerTaskOutputs, sameMobilePartnerTaskOutputSource } from "./mobile-partner-task-outputs";

function response() {
  return create(ListPartnerTaskOutputsResponseSchema, { partnerId: "partner-a", outputs: [{
    sourceKind: PartnerTaskOutputSourceKind.SESSION_TASK, sourceId: "task-a", parentSessionId: "parent",
    sessionId: "child", execution: 2n, sourceRevision: { value: 7n }, runIds: ["run-one", "run-two"], title: "Source task",
    readiness: PartnerTaskOutputReadiness.READY, files: [{ path: "src/main.ts", status: PartnerTaskOutputFileStatus.MODIFIED }], truncated: true
  }] });
}
describe("Partner task output metadata projection", () => {
  it("preserves typed current execution, all ordered Runs, readiness, paths and truncation", () => {
    const input = response(); input.truncated = true;
    const value = projectMobilePartnerTaskOutputs(input, "partner-a");
    expect(value).toMatchObject({ partnerId: "partner-a", truncated: true, rows: [{ kind: "session-task", id: "task-a",
      parentSessionId: "parent", sessionId: "child", execution: 2, revision: 7n, runIds: ["run-one", "run-two"],
      files: [{ path: "src/main.ts", status: "modified" }], readiness: "ready", truncated: true }] });
    input.outputs[0]!.runIds[0] = "changed"; expect(value.rows[0]!.runIds[0]).toBe("run-one");
    expect(Object.isFrozen(value.rows[0]!.files[0])).toBe(true);
  });
  it("keeps pending and unavailable sources distinct from confirmed empty ready output", () => {
    const input = response(); const ready = input.outputs[0]!; ready.files = [];
    input.outputs.push({ ...ready,
      sourceId: "pending", sessionId: "", runIds: [], readiness: PartnerTaskOutputReadiness.PENDING });
    input.outputs.push({ ...ready, sourceKind: PartnerTaskOutputSourceKind.DELEGATION, sourceId: "unavailable", readiness: PartnerTaskOutputReadiness.UNAVAILABLE });
    expect(projectMobilePartnerTaskOutputs(input, "partner-a").rows.map(row => row.readiness)).toEqual(["ready", "pending", "unavailable"]);
  });
  it.each(["/etc/file", "C:\\file", "..\\escape", "a/../escape", "bad\u0000path"])("rejects unsafe path %s", path => {
    const input = response(); input.outputs[0]!.files[0]!.path = path;
    expect(() => projectMobilePartnerTaskOutputs(input, "partner-a")).toThrow(/metadata/u);
  });
  it("rejects requester mismatch, duplicate source/Run/path, invalid enums and oversized public inventories", () => {
    const change = (edit: (input: ReturnType<typeof response>) => void) => { const input = response(); edit(input);
      expect(() => projectMobilePartnerTaskOutputs(input, "partner-a")).toThrow(/metadata/u); };
    change(input => { input.partnerId = "partner-b"; });
    change(input => { input.outputs.push(input.outputs[0]!); });
    change(input => { input.outputs[0]!.runIds.push("run-one"); });
    change(input => { input.outputs[0]!.files.push(input.outputs[0]!.files[0]!); });
    change(input => { input.outputs[0]!.sourceKind = PartnerTaskOutputSourceKind.UNSPECIFIED; });
    change(input => { input.outputs[0]!.readiness = PartnerTaskOutputReadiness.UNSPECIFIED; });
    change(input => { input.outputs[0]!.files[0]!.status = PartnerTaskOutputFileStatus.UNSPECIFIED; });
    change(input => { input.outputs[0]!.files = Array.from({ length: 65 }, (_, index) => ({ ...input.outputs[0]!.files[0]!, path: `path-${index}` })); });
    change(input => { input.outputs = Array.from({ length: 201 }, (_, index) => ({ ...input.outputs[0]!, sourceId: `task-${index}` })); });
    change(input => { input.outputs[0]!.execution = BigInt(Number.MAX_SAFE_INTEGER) + 1n; });
    change(input => { input.outputs[0]!.sourceRevision = undefined; });
    change(input => { input.outputs[0]!.runIds = []; });
  });
  it("compares the complete source identity and does not impose a new Run capacity", () => {
    const input = response(); input.outputs[0]!.runIds = Array.from({ length: 600 }, (_, index) => `run-${index}`);
    const row = projectMobilePartnerTaskOutputs(input, "partner-a").rows[0]!;
    expect(row.runIds).toHaveLength(600);
    expect(sameMobilePartnerTaskOutputSource(row, { ...row, files: [], readiness: "pending" })).toBe(true);
    for (const changed of [{ ...row, runIds: ["changed", ...row.runIds.slice(1)] }, { ...row, execution: 3 },
      { ...row, sessionId: "other" }, { ...row, parentSessionId: "other" }, { ...row, revision: 8n }]) {
      expect(sameMobilePartnerTaskOutputSource(row, changed)).toBe(false);
    }
  });
});
