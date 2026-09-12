import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD, type EventPayload } from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("historical task reference visibility", () => {
  it("captures an exact branch and high-water without copying message bodies", () => {
    const store = createFixture();
    appendNativeMessage(store, "root-event", "root", undefined, "user", "root prompt");
    appendNativeMessage(store, "branch-a-event", "branch-a", "root", "assistant", "accepted branch");
    appendNativeMessage(store, "branch-b-event", "branch-b", "root", "assistant", "hidden sibling");
    appendMarker(store, "marker-a", "branch-a");

    const snapshot = store.captureSessionReferenceSnapshot("source", 3);
    expect(snapshot).toMatchObject({ mentionIndex: 3, sessionId: "source", historyLeafId: "branch-a" });
    expect(JSON.stringify(snapshot)).not.toContain("root prompt");
    expect(JSON.stringify(snapshot)).not.toContain("accepted branch");

    appendNativeMessage(store, "late-event", "late", "branch-a", "assistant", "later expansion");
    appendMarker(store, "marker-b", "branch-b");
    expect(store.listSessionReferenceMessageEvents(snapshot).map((event) => event.id)).toEqual([
      "root-event",
      "branch-a-event"
    ]);
  });

  it("returns an empty catalog at cursor zero and revokes a snapshot after rebinding", () => {
    const store = createFixture();
    const empty = store.captureSessionReferenceSnapshot("source", 0);
    expect(empty.throughCursor).toBe("0");
    expect(store.listSessionReferenceMessageEvents(empty)).toEqual([]);

    appendNativeMessage(store, "message", "message", undefined, "user", "available");
    const snapshot = store.captureSessionReferenceSnapshot("source", 0);
    const current = store.getSession("source");
    store.updateSession("source", {
      binding: { opaqueRef: "native/rebound.jsonl", generation: current.descriptor.binding.generation + 1 }
    }, current.revision);
    expect(() => store.listSessionReferenceMessageEvents(snapshot)).toThrow("history authority changed");
  });
});

function createFixture(): OperationalStore {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-session-reference-"));
  const store = new OperationalStore(path.join(directory, "operational.sqlite"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertBackend({
    id: "backend", displayName: "Backend", version: "1", health: "healthy", adapterKind: "fixture",
    instanceGeneration: 0, installationState: "installed", authenticationState: "not_required",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  store.upsertTarget({
    id: "target", backendId: "backend", displayName: "Workspace", workspaceRoot: "D:/workspace",
    managed: false, trusted: true
  });
  store.createSession({
    id: "source", backendId: "backend", targetId: "target", title: "Source",
    binding: { opaqueRef: "native/source.jsonl", generation: 0 }, pinned: false, archived: false,
    permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1
  });
  return store;
}

function appendNativeMessage(
  store: OperationalStore,
  id: string,
  entryId: string,
  parentEntryId: string | undefined,
  role: "user" | "assistant",
  text: string
): void {
  const payload: EventPayload = {
    type: "message_complete",
    role,
    blocks: [{ kind: "text", text }],
    nativeHistory: { identity: { entryId, ...(parentEntryId === undefined ? {} : { parentEntryId }) } }
  };
  store.appendEvent({
    id, backendId: "backend", targetId: "target", sessionId: "source", generation: 0,
    traceId: `test:${id}`, payload,
    metadata: {
      namespace: "test.native_history",
      fields: {
        [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: `sha256:${createHash("sha256")
          .update(store.getSession("source").descriptor.binding.opaqueRef).digest("hex")}`
      }
    }
  });
}

function appendMarker(store: OperationalStore, id: string, leafId: string): void {
  store.appendEvent({
    id, backendId: "backend", targetId: "target", sessionId: "source", generation: 0,
    traceId: `test:${id}`,
    payload: { type: "native_session_changed", opaqueRef: "native/source.jsonl", leafId }
  });
}
