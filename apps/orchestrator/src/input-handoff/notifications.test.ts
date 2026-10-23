import { OperationalStore } from "@joko/store";
import type { InputHandoffSnapshot } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { InputHandoffNotifications } from "./notifications.js";

it("notifies once per visible step with fixed metadata, then cancels only its pending private notices", () => {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({ id: "native", displayName: "Native", adapterKind: "fixture", version: "test", health: "healthy", instanceGeneration: 1,
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "workspace", backendId: "native", displayName: "Workspace", workspaceRoot: "D:/workspace", managed: false, trusted: true });
  store.createSession({ id: "task", backendId: "native", targetId: "workspace", title: "Task", binding: { opaqueRef: "private-native", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
  const push = vi.fn((input: Parameters<OperationalStore["enqueueInputHandoffPush"]>[0]) => { store.enqueueInputHandoffPush(input); });
  let current = true;
  const notifications = new InputHandoffNotifications({ store, push: { notifyInputHandoff: push }, isCurrent: () => current });
  const snapshot: InputHandoffSnapshot = { kind: "input_handoff", requestId: "original-request", revision: 1, phase: "ready", purpose: "Untrusted private purpose",
    note: "Untrusted private note", source: { app: "App", origin: "https://example.test" }, controls: [{ id: "field", kind: "text", label: "Private field label", contentType: "password" }], stepNumber: 1 };
  try {
    notifications.notify("task", snapshot); notifications.notify("task", { ...snapshot, revision: 2 });
    notifications.notify("task", { ...snapshot, revision: 3, stepNumber: 2 });
    expect(push).toHaveBeenCalledTimes(2);
    const events = store.listEvents({ sessionId: "task" });
    expect(events).toHaveLength(2); expect(events.every(event => event.payload.type === "extension_ui_effect")).toBe(true);
    const json = JSON.stringify(events, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value);
    for (const text of [snapshot.purpose, snapshot.note!, "Private field label", "https://example.test"]) expect(json).not.toContain(text);
    expect(store.findSessionAttention("task")).toBeUndefined();
    current = false; notifications.notify("task", { ...snapshot, stepNumber: 3 }); expect(push).toHaveBeenCalledTimes(2);
    notifications.publish("task", { ...snapshot, phase: "cancelled", terminal: true });
  } finally { notifications.close(); store.close(); }
});
