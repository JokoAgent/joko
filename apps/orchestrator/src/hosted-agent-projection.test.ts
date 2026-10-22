import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { AdapterContext, AdapterEventMetadata, InteractionPayload, NativeHistoryProjection, NativeSessionState, SubagentRunDetail } from "@joko/core";
import { expect, it } from "vitest";
import { HostedAgentProjection } from "./hosted-agent-projection.js";
import { ExecutorWorkspace } from "./hosted-agent-workspace.js";

const context = { sessionId: "original-task", target: { id: "original-target", backendId: "native", displayName: "Task",
  workspaceRoot: process.cwd(), managed: true, trusted: true } } satisfies Pick<AdapterContext, "sessionId" | "target">;
const sourceBinding = { opaqueRef: "source-native:retained-task", nativeSessionId: "retained-task", generation: 4 };
const shadow = "/provider/private/workspace";
const workspace = new ExecutorWorkspace({ workingDir: context.target.workspaceRoot, aliases: [{ from: shadow, to: context.target.workspaceRoot }] });
workspace.setVirtualRoot(shadow);
const projection = new HostedAgentProjection(workspace, context, () => sourceBinding);

it("keeps Provider persistence private in state, identity events, metadata and durable dispatch history", () => {
  const native = { nativeSessionId: "provider-sdk", nativeSessionName: "Task", nativeSessionFileDisplay: "/provider/private/native/session.jsonl",
    thinkingLevel: "", streaming: false, compacting: false, steeringMode: "unknown", followUpMode: "unknown", autoCompaction: true,
    autoRetry: false, messageCount: 1, pendingMessageCount: 0, activeLeafId: "leaf" } as const;
  const state: NativeSessionState = { binding: { opaqueRef: native.nativeSessionFileDisplay, nativeSessionId: native.nativeSessionId, generation: 1 },
    streaming: false, compacting: false, pendingMessages: 0, fastMode: false, permissionMode: "ask", pi: native };
  expect(projection.state(state)).toMatchObject({ binding: sourceBinding, pi: { nativeSessionId: sourceBinding.nativeSessionId, nativeSessionFileDisplay: "" } });
  const metadata: AdapterEventMetadata = { namespace: "native", fields: { rpcEventType: "state" }, pi: { rpcEventType: "state",
    payload: { case: "sessionIdentityUpdate", value: { previousNativeSessionId: "prior-sdk", nativeSessionId: "provider-sdk",
      nativeSessionName: "Task", nativeSessionFileDisplay: native.nativeSessionFileDisplay, activeLeafId: "leaf", change: "switched" } } } };
  const history: NativeHistoryProjection = { events: [{ nativeEntryId: "entry", projectionKind: "identity", contentIndex: 0,
    payload: { type: "native_session_changed", opaqueRef: native.nativeSessionFileDisplay, nativeSessionId: "provider-sdk", leafId: "leaf" }, metadata }],
    activeEntryId: "entry", activeLineage: [{ entryId: "entry" }], activeEntryMetadata: metadata };
  const prepared = projection.dispatch({ inputFingerprint: "a".repeat(64), nativeHistory: history });
  expect(prepared.nativeHistory.events[0]?.payload).toEqual({ type: "native_session_changed", opaqueRef: sourceBinding.opaqueRef, nativeSessionId: "retained-task", leafId: "leaf" });
  expect(prepared.nativeHistory.activeLineage).toEqual(history.activeLineage); expect(prepared.inputFingerprint).toBe("a".repeat(64));
  expect(JSON.stringify(prepared)).not.toContain("session.jsonl"); expect(JSON.stringify(prepared)).not.toContain("provider-sdk");
  expect(history.events[0]?.payload).toHaveProperty("opaqueRef", native.nativeSessionFileDisplay);
});

it("restores owned file references and subagent ownership while preserving opaque IDs, web URLs and binary strings", () => {
  const local = join(context.target.workspaceRoot, "file.txt");
  const value = { id: `${shadow}/opaque-id`, providerId: shadow, path: `${shadow}/file.txt`, data: `${shadow}/encoded-bytes`,
    text: `Read ${shadow}/file.txt`, url: `https://example.test${shadow}/file.txt`, fileUrl: `file://${shadow}/file.txt?download=1#page` };
  expect(projection.value(value)).toEqual({ ...value, path: local, text: `Read ${local.replace(/\\/gu, "/")}`, fileUrl: pathToFileURL(local).href + "?download=1#page" });
  const run: SubagentRunDetail = { id: "child", sessionId: "hosted-session:private", logicalAgentId: "agent", identityAliases: ["opaque"], providerRunIds: ["native"],
    state: "running", startedAt: 1, updatedAt: 1, activity: [], capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: true,
      stop: true, steer: false, followUp: false, resume: false, parentContext: "snapshot" } };
  expect(projection.event({ type: "subagent_run", run })).toMatchObject({ run: { ...run, sessionId: context.sessionId } });
});

it("keeps exact permission/question receipts and maps only plan display references", () => {
  const permission = { id: "permission", kind: "permission", title: "Read", toolName: "read", summary: `${shadow}/file.txt`, risk: "low", choices: ["allow_once"] } as const;
  // The native correlation payload must be byte-for-byte stable. The Source
  // tool gate separately resolves the requested path against its current roots.
  expect(projection.interaction(permission)).toBe(permission);
  const plan: InteractionPayload = { id: "plan", kind: "plan_review", title: "Plan", markdown: `Change ${shadow}/file.txt`, choices: ["execute"] };
  expect(projection.interaction(plan)).toMatchObject({ markdown: `Change ${join(context.target.workspaceRoot, "file.txt").replace(/\\/gu, "/")}` });
});
