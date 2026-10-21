import { OperationalStore } from "@joko/store";
import { afterEach, expect, it } from "vitest";
import { persistSessionTaskActivity, sessionTaskActivity } from "./session-task-activity.js";
const stores: OperationalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new OperationalStore(":memory:"); stores.push(store);
  store.upsertBackend({ id: "backend", displayName: "Backend", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "backend", displayName: "Target", workspaceRoot: process.cwd(), managed: false, trusted: true });
  store.createSession({ id: "session", backendId: "backend", targetId: "target", title: "Task", binding: { opaqueRef: "opaque", generation: 1 }, pinned: false,
    archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  let sequence = 0;
  const run = (id: string, createdAt: number) => store.createRun({ id, sessionId: "session", source: "user", state: "completed", createdAt, startedAt: createdAt, endedAt: createdAt + 1 });
  const message = (runId: string, role: "user" | "assistant", text: string) => store.appendEvent({ id: `message-${++sequence}`, emittedAt: sequence,
    backendId: "backend", targetId: "target", sessionId: "session", generation: 1, runId, traceId: "test",
    payload: { type: "message_complete", role, blocks: [{ kind: "text", text }] } });
  return { store, run, message, read: () => sessionTaskActivity(store, store.getSession("session")) };
}
it("summarizes only the last assistant text of the exact current turn and clears it for a new reply-less Run", () => {
  const f = fixture(); f.run("old", 1); f.message("old", "user", "Old question"); f.message("old", "assistant", "Old reply");
  f.run("current", 3); f.message("current", "user", "Current question"); f.message("current", "assistant", "First paragraph"); f.message("current", "assistant", "Last\n answer");
  expect(f.read()?.completedReplySummary).toBe("Last answer");
  f.run("next", 5); f.message("next", "user", "Next question"); f.message("old", "assistant", "Late old reply");
  expect(f.read()).toMatchObject({ runId: "next", completedReplySummary: "" });
});
it("persists notification ownership before publication, rotates its Run fence and does not republish identical state", () => {
  const f = fixture(); f.run("run", 1); const events: string[] = [];
  const stop = f.store.subscribe(event => { if (event.payload.type === "session_changed") { events.push(event.id); expect(f.read()?.completionNotification).toBe("pending"); } });
  persistSessionTaskActivity(f.store, "session", { runId: "run", completionNotification: "pending", silent: true });
  persistSessionTaskActivity(f.store, "session", { runId: "run", completionNotification: "pending", silent: true });
  expect(events).toHaveLength(1); stop();
  persistSessionTaskActivity(f.store, "session", { runId: "run", completionNotification: "teammate" });
  expect(f.read()).toMatchObject({ completionNotification: "teammate", silent: true });
  f.run("next", 3); expect(f.read()).toMatchObject({ runId: "next", completionNotification: "none", silent: false });
});
