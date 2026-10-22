import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { AdapterContext, EventPayload } from "@joko/core";
import { expect, it, vi } from "vitest";
import { HostedAgentController, type HostedAgentOperationOwner } from "./hosted-agent-controller.js";
import { HostedAgentExecutor } from "./hosted-agent-executor.js";
import type { HostedAgentFrame } from "./hosted-agent-exchange.js";

it("captures each original dispatch owner before effects and persists its event before acknowledging the cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-source-operation-")), seen: string[] = [], events: EventPayload[] = [];
  const base: AdapterContext = { sessionId: "task", generation: 3, target: { id: "target", backendId: "native", workspaceRoot: root,
    displayName: "Task", managed: true, trusted: true }, signal: new AbortController().signal, artifactCapacityBytes: 1024,
    emit: async () => { throw new Error("The creation callback must not own a later dispatch."); },
    requestInteraction: async () => { throw new Error("The creation approval must not own a later dispatch."); },
    storeArtifact: async () => { throw new Error("No Artifact in this fixture."); } };
  const executor = new HostedAgentExecutor({ context: base, virtualRoot: "/provider/workspace", assertCurrent: () => {},
    readPolicy: () => ({ revision: "policy", permissionMode: "ask", planMode: false, approvedRoots: [], confirmCredentials: true }) });
  let release!: () => void; const writing = new Promise<void>(resolve => { release = resolve; });
  const owners = new Map<string, HostedAgentOperationOwner>(["one", "two"].map(id => [id, { executor, context: { ...base,
    emit: async event => { seen.push(`event:${id}`); if (id === "one") await writing; events.push(event); },
    requestInteraction: async () => { seen.push(`question:${id}`); return { kind: "confirmed", confirmed: true }; } },
    persistFence: async () => { seen.push(`fence:${id}`); } }]));
  const frames: HostedAgentFrame[] = [
    { sequence: 1, payload: { kind: "event", operationId: "one", event: { type: "status", key: "turn", text: "First owner" } } },
    { sequence: 2, payload: { kind: "event", operationId: "two", event: { type: "native_session_changed", opaqueRef: "/private/sdk.jsonl" } } },
    { sequence: 3, payload: { kind: "request", id: "question", operationId: "one", request: { kind: "interaction",
      interaction: { id: "native-question", kind: "extension_confirm", extensionId: "extension", title: "Confirm" } } } },
    { sequence: 4, payload: { kind: "request", id: "fence", operationId: "two", request: { kind: "native_dispatch", operationId: "two",
      preparation: { inputFingerprint: "a".repeat(64), nativeHistory: { events: [] } } } } }
  ];
  const replies: string[] = [], poll = vi.fn(async (after: number, signal: AbortSignal) => {
    seen.push(`cursor:${after}`);
    if (after === 0) return { frames, cursor: 4, finished: false };
    expect(events).toHaveLength(2);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    return { frames: [], cursor: after, finished: true };
  });
  const controller = new HostedAgentController({ context: base, executor, binding: () => ({ opaqueRef: "source:task", generation: 3 }),
    resolveOperation: id => { const owner = owners.get(id); if (!owner) throw new Error("Unknown dispatch."); return owner; },
    assertCurrent: () => {}, temporaryRoot: root, port: { poll,
      reply: async (id, reply) => { expect(reply.ok).toBe(true); replies.push(id); }, readArtifact: async () => ({ data: "" }) } });
  try {
    const pump = controller.start();
    await vi.waitFor(() => expect(seen).toContain("event:one")); expect(poll).toHaveBeenCalledTimes(1); expect(events).toHaveLength(0);
    release(); await pump;
    expect(events[1]).toEqual({ type: "native_session_changed", opaqueRef: "source:task" });
    expect(seen).toEqual(["cursor:0", "event:one", "event:two", "cursor:4", "question:one", "fence:two"]);
  } finally { release(); await controller.stop(); executor.dispose();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true }); }
});
