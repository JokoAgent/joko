import { mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Capability, PromptInput, SessionDescriptor } from "@joko/core";
import { OperationalStore, type OperationExecution } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeToolCallContext, McpCallResult } from "./mcp-router.js";
import {
  SESSION_HELPER_NESTED_TOOL_NAMES,
  SESSION_HELPER_NESTED_TOOLS,
  SessionHelperToolBridgeProvider
} from "./session-helper-tool-provider.js";
import type { SessionHost } from "./session-host.js";

const NOW = Date.UTC(2026, 7, 25, 8, 0, 0);
const openStores: OperationalStore[] = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionHelperToolBridgeProvider", () => {
  it("exposes exactly two public bridge tools and all eighteen applicable nested tools", async () => {
    const { provider } = fixture();
    expect(provider.tools.map((tool) => tool.name)).toEqual(["list_tools", "call_tool"]);
    expect(provider.tools.map((tool) => tool.requiresPermission)).toEqual([false, true]);
    expect(SESSION_HELPER_NESTED_TOOL_NAMES).toHaveLength(18);
    expect(new Set(SESSION_HELPER_NESTED_TOOL_NAMES).size).toBe(18);
    expect(SESSION_HELPER_NESTED_TOOLS.filter((tool) => tool.category === "product")).toHaveLength(2);
    expect(SESSION_HELPER_NESTED_TOOLS.filter((tool) => tool.category === "control")).toHaveLength(10);
    expect(SESSION_HELPER_NESTED_TOOLS.filter((tool) => tool.category === "history")).toHaveLength(5);
    expect(SESSION_HELPER_NESTED_TOOLS.filter((tool) => tool.category === "handoff")).toHaveLength(1);
    expect(SESSION_HELPER_NESTED_TOOL_NAMES).not.toContain("submit_github_issue");
    expect(SESSION_HELPER_NESTED_TOOL_NAMES).not.toContain("create_worker");

    const overview = resultData(await provider.callTool("list_tools", {}, undefined, context()));
    expect(overview).toEqual({
      categories: [
        { name: "product", tool_count: 2 },
        { name: "control", tool_count: 10 },
        { name: "history", tool_count: 5 },
        { name: "handoff", tool_count: 1 }
      ],
      hint: expect.any(String)
    });
    const control = resultData(await provider.callTool(
      "list_tools",
      { category: "control" },
      undefined,
      context()
    )) as { tools: readonly Record<string, unknown>[] };
    expect(control.tools.map((tool) => tool["name"])).toEqual([
      "set_current_session_title",
      "rename_sessions",
      "archive_sessions",
      "unarchive_sessions",
      "update_session_queued_message",
      "cancel_session_queued_message",
      "steer_session",
      "stop_session_turn",
      "get_session_runtime",
      "set_session_runtime"
    ]);
    expect(control.tools.every((tool) => typeof tool["input_schema"] === "object")).toBe(true);
  });

  it("fences every call to the authenticated trusted task, Target, and generation", async () => {
    const { provider } = fixture();
    expect(provider.includeForTarget("target-a")).toBe(true);
    expect(provider.includeForTarget("target-u")).toBe(false);
    expect(provider.includeForTarget("missing")).toBe(false);

    expect(errorData(await callNested(provider, "get_current_session_id", {}, {
      sessionId: "session-a",
      targetId: "target-a",
      generation: 6
    }))).toMatchObject({ errorCode: "STALE_SCOPE" });
    expect(errorData(await callNested(provider, "get_current_session_id", {}, {
      sessionId: "session-u",
      targetId: "target-u",
      generation: 7
    }))).toMatchObject({ errorCode: "UNTRUSTED_TARGET" });
    expect(errorData(await callNested(provider, "get_current_session_id", {}, {
      sessionId: "session-a",
      targetId: "target-b",
      generation: 7
    }))).toMatchObject({ errorCode: "STALE_SCOPE" });
  });

  it("reports current identity and live capability detail without caller-controlled routing", async () => {
    const { provider, roots } = fixture();
    expect(resultData(await callNested(provider, "get_current_session_id", {}))).toEqual({
      session_id: "session-a",
      agent_kind: "backend-a",
      target_id: "target-a",
      working_dir: roots.a
    });
    const index = resultData(await callNested(provider, "get_capabilities", {})) as {
      capabilities: readonly { key: string }[];
    };
    expect(index.capabilities.map((entry) => entry.key)).toEqual([
      "backend-capabilities",
      "session-helper",
      "workspace",
      "history-search"
    ]);
    const backend = resultData(await callNested(provider, "get_capabilities", {
      key: "backend-capabilities"
    })) as { capability: { detail: readonly { key: string; supported: boolean }[] } };
    expect(backend.capability.detail).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "turn.abort", supported: true }),
      expect.objectContaining({ key: "turn.steer", supported: true })
    ]));
    expect(errorData(await callNested(provider, "get_capabilities", { key: "missing" })))
      .toMatchObject({ errorCode: "UNKNOWN_KEY", data: { available: expect.any(Array) } });
  });

  it("previews and confirmation-fences batch rename, then atomically archives and restores", async () => {
    const { store, provider } = fixture();
    const preview = resultData(await callNested(provider, "rename_sessions", {
      changes: [
        { session_id: "session-b", title: "  Renamed   B  " },
        { session_id: "session-c", title: "Renamed C" }
      ]
    })) as { confirmation_token: string; changes: readonly Record<string, unknown>[] };
    expect(preview.changes).toEqual([
      expect.objectContaining({ session_id: "session-b", current_title: "Session B", new_title: "Renamed B" }),
      expect.objectContaining({ session_id: "session-c", current_title: "Session C", new_title: "Renamed C" })
    ]);
    expect(store.getSession("session-b").descriptor.title).toBe("Session B");

    expect(errorData(await callNested(provider, "rename_sessions", {
      changes: [{ session_id: "session-b", title: "Different" }],
      dry_run: false,
      confirmation_token: preview.confirmation_token
    }))).toMatchObject({ errorCode: "CONFIRMATION_REQUIRED" });

    const committed = resultData(await callNested(provider, "rename_sessions", {
      changes: [
        { session_id: "session-b", title: "  Renamed   B  " },
        { session_id: "session-c", title: "Renamed C" }
      ],
      dry_run: false,
      confirmation_token: preview.confirmation_token
    })) as { changes: readonly Record<string, unknown>[] };
    expect(committed.changes).toHaveLength(2);
    expect(store.getSession("session-b").descriptor.title).toBe("Renamed B");

    const failedBatch = await callNested(provider, "archive_sessions", {
      session_ids: ["session-b", "missing"]
    });
    expect(errorData(failedBatch)).toMatchObject({ errorCode: "NOT_FOUND" });
    expect(store.getSession("session-b").descriptor.archived).toBe(false);
    expect(errorData(await callNested(provider, "archive_sessions", { session_ids: ["session-a"] })))
      .toMatchObject({ errorCode: "INVALID_ARGS" });

    expect(resultData(await callNested(provider, "archive_sessions", { session_ids: ["session-b", "session-c"] })))
      .toMatchObject({ status: "archived", count: 2 });
    expect(store.getSession("session-b").descriptor.archived).toBe(true);
    expect(resultData(await callNested(provider, "unarchive_sessions", { session_ids: ["session-b", "session-c"] })))
      .toMatchObject({ status: "active", count: 2 });
    expect(store.getSession("session-b").descriptor.archived).toBe(false);
  });

  it("lists workdirs, task metadata, raw role history, semantic fallback search, and stable cursors", async () => {
    const { store, provider, roots } = fixture();
    appendMessage(store, "message-a-user", "session-a", "user", "alpha needle", NOW + 10);
    appendMessage(store, "message-a-assistant", "session-a", "assistant", "first answer", NOW + 20);
    appendMessage(store, "message-b-user", "session-b", "user", "second project", NOW + 30);
    appendMessage(store, "message-b-assistant", "session-b", "assistant", "alpha followup", NOW + 40);

    const workdirs = resultData(await callNested(provider, "list_workdirs", { limit: 1 })) as {
      workdirs: readonly Record<string, unknown>[];
      nextCursor: string;
      hasMore: boolean;
    };
    expect(workdirs.workdirs).toHaveLength(1);
    expect(workdirs.workdirs[0]).toMatchObject({ agentKinds: ["backend-a"] });
    expect(workdirs.hasMore).toBe(true);
    const workdirsNext = resultData(await callNested(provider, "list_workdirs", {
      limit: 10,
      cursor: workdirs.nextCursor
    })) as { workdirs: readonly Record<string, unknown>[] };
    expect(workdirsNext.workdirs.length).toBeGreaterThan(0);

    const sessions = resultData(await callNested(provider, "list_sessions", {
      workdir: roots.b,
      agent_kind: "backend-a"
    })) as {
      sessions: readonly Record<string, unknown>[];
    };
    expect(sessions.sessions).toEqual([
      expect.objectContaining({ id: "session-c", workingDir: roots.b, agentKind: "backend-a" }),
      expect.objectContaining({ id: "session-b", workingDir: roots.b, agentKind: "backend-a", messageCount: 2 })
    ]);
    expect(resultData(await callNested(provider, "list_sessions", {
      workdir: roots.b,
      agent_kind: "backend-b"
    }))).toMatchObject({ sessions: [] });

    const history = resultData(await callNested(provider, "get_chat_history", {
      session_ids: ["session-a", "session-b"],
      roles: ["user", "assistant"],
      limit: 2,
      order: "asc"
    })) as { messages: readonly Record<string, unknown>[]; nextCursor: string; hasMore: boolean };
    expect(history.messages.map((message) => message["id"])).toEqual(["message-a-user", "message-a-assistant"]);
    expect(history.hasMore).toBe(true);
    const next = resultData(await callNested(provider, "get_chat_history", {
      session_ids: ["session-a", "session-b"],
      roles: ["user", "assistant"],
      limit: 10,
      order: "asc",
      cursor: history.nextCursor
    })) as { messages: readonly Record<string, unknown>[] };
    expect(next.messages.map((message) => message["id"])).toEqual(["message-b-user", "message-b-assistant"]);
    expect(errorData(await callNested(provider, "get_chat_history", {})))
      .toMatchObject({ errorCode: "INVALID_FILTER" });

    const search = resultData(await callNested(provider, "search_chat_history", {
      query: "alpha",
      context_radius: 1,
      limit: 10
    })) as {
      hits: readonly { messageId: string; context: readonly Record<string, unknown>[] }[];
      vector_used: boolean;
      vector_skip_reason: string;
    };
    expect(search.hits.map((hit) => hit.messageId)).toEqual(expect.arrayContaining([
      "message-a-user",
      "message-b-assistant"
    ]));
    expect(search.hits.every((hit) => hit.context.some((item) => item["isHit"] === true))).toBe(true);
    expect(search.vector_used).toBe(false);
    expect(search.vector_skip_reason).toEqual(expect.any(String));
  });

  it("persists handoff messages before return and enforces per-caller queue edit and cancel ownership", async () => {
    const { store, provider, hostState } = fixture();
    const sent = resultData(await callNested(provider, "send_to_session", {
      target_session_id: "session-b",
      message: "handoff body"
    })) as Record<string, unknown>;
    expect(sent).toMatchObject({
      target_session_id: "session-b",
      wake_kind: "resumed",
      queued_message_id: expect.any(String)
    });
    expect(hostState.resume).toHaveBeenCalledWith("session-b");
    const queueItemId = String(sent["queued_message_id"]);
    expect(store.getQueueItem(queueItemId)).toMatchObject({
      sessionId: "session-b",
      state: "accepted",
      body: expect.objectContaining({ text: "handoff body" })
    });
    expect(store.findOperation(store.getQueueItem(queueItemId).operationId)?.body)
      .toMatchObject({ originSessionId: "session-a" });

    const listed = resultData(await callNested(provider, "list_session_queue", { session_id: "session-b" })) as {
      queue: readonly Record<string, unknown>[];
    };
    expect(listed.queue).toEqual([
      expect.objectContaining({ queued_message_id: queueItemId, source: "session", consuming: false })
    ]);
    expect(resultData(await callNested(provider, "update_session_queued_message", {
      session_id: "session-b",
      queued_message_id: queueItemId,
      message: "replacement"
    }))).toMatchObject({ updated: true });
    expect(store.getQueueItem(queueItemId).body.text).toBe("replacement");

    expect(errorData(await callNested(provider, "cancel_session_queued_message", {
      session_id: "session-b",
      queued_message_id: queueItemId
    }, context("session-c", "target-b")))).toMatchObject({ errorCode: "NOT_AUTHORIZED" });
    expect(resultData(await callNested(provider, "cancel_session_queued_message", {
      session_id: "session-b",
      queued_message_id: queueItemId
    }))).toMatchObject({ cancelled: true });
    expect(store.getQueueItem(queueItemId).state).toBe("cancelled");
  });

  it("pages the complete task queue and uses the exact durable queue count", async () => {
    const { store, provider, roots } = fixture();
    const sent = resultData(await callNested(provider, "send_to_session", {
      target_session_id: "session-b",
      message: "paged handoff"
    })) as Record<string, unknown>;
    const queueItem = store.getQueueItem(String(sent["queued_message_id"]));
    const originalList = store.listQueueItems.bind(store);
    const listSpy = vi.spyOn(store, "listQueueItems").mockImplementation((options = {}) => {
      if (options.sessionId !== "session-b" || options.states === undefined) return originalList(options);
      const offset = options.offset ?? 0;
      if (offset === 0) return Array.from({ length: 1_000 }, () => queueItem);
      if (offset === 1_000) return [queueItem];
      return [];
    });
    const listed = resultData(await callNested(provider, "list_session_queue", { session_id: "session-b" })) as {
      readonly queued_count: number;
      readonly queue: readonly Record<string, unknown>[];
    };
    expect(listed.queued_count).toBe(1_001);
    expect(listed.queue).toHaveLength(1_001);
    expect(listed.queue.at(-1)).toMatchObject({ position: 1_001 });
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ offset: 1_000, limit: 1_000 }));

    listSpy.mockRestore();
    const originalCount = store.countQueueItems.bind(store);
    const countSpy = vi.spyOn(store, "countQueueItems").mockImplementation((options = {}) =>
      options.sessionId === "session-b" ? 100_001 : originalCount(options));
    const sessions = resultData(await callNested(provider, "list_sessions", { workdir: roots.b })) as {
      readonly sessions: readonly Record<string, unknown>[];
    };
    expect(sessions.sessions.find((session) => session["id"] === "session-b"))
      .toMatchObject({ queuedCount: 100_001 });
    expect(countSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-b" }));
  });

  it("queues same-turn steer, stops an active turn, and reports content-free runtime state", async () => {
    const { store, provider, hostState } = fixture();
    store.createRun({
      id: "active-run-b",
      sessionId: "session-b",
      source: "user",
      state: "running",
      createdAt: NOW + 100,
      startedAt: NOW + 100
    });
    const steered = resultData(await callNested(provider, "steer_session", {
      session_id: "session-b",
      message: "look here now"
    })) as Record<string, unknown>;
    expect(steered).toMatchObject({ steered: true, queued_message_id: expect.any(String) });
    expect(store.getQueueItem(String(steered["queued_message_id"])).disposition).toBe("steer");

    expect(resultData(await callNested(provider, "get_session_runtime", { session_id: "session-b" })))
      .toMatchObject({
        phase: "running",
        active: true,
        current_action_summary: "running",
        graceful_stop_state: "available",
        fallback_enabled: false
      });
    expect(hostState.sessionRuntimeFallbackEnabled).toHaveBeenCalled();
    expect(resultData(await callNested(provider, "stop_session_turn", { session_id: "session-b" })))
      .toMatchObject({ status: "requested", turn_generation: 7 });
    expect(hostState.abort).toHaveBeenCalledWith("session-b", "active-run-b");
    expect(resultData(await callNested(provider, "stop_session_turn", { session_id: "session-c" })))
      .toMatchObject({ status: "no-active-turn" });
  });

  it("finds the active turn behind more than one hundred newer queued Runs", async () => {
    const { store, provider } = fixture();
    store.createRun({
      id: "deep-active-run-b",
      sessionId: "session-b",
      source: "user",
      state: "running",
      createdAt: NOW + 100,
      startedAt: NOW + 100
    });
    for (let index = 0; index < 101; index += 1) {
      store.createRun({
        id: `newer-queued-run-${index}`,
        sessionId: "session-b",
        source: "system",
        state: "queued",
        createdAt: NOW + 200 + index
      });
    }

    expect(resultData(await callNested(provider, "get_session_runtime", { session_id: "session-b" })))
      .toMatchObject({ phase: "running", active: true, current_action_summary: "running" });
  });

  it("creates a visible Backend task with inherited execution settings and fails closed for mismatched Backends, unknown roots, or Worktree errors", async () => {
    const { store, provider, hostState, roots } = fixture();
    const created = resultData(await callNested(provider, "send_to_session", {
      message: "Implement the fix\nwith tests",
      title: "  Issue   42  ",
      working_dir: roots.b,
      model: "model-next",
      effort: "xhigh",
      fast: false,
      use_worktree: true,
      agent_kind: "backend-a"
    })) as Record<string, unknown>;
    const createdId = String(created["target_session_id"]);
    expect(created).toMatchObject({
      wake_kind: "created",
      target_title: "Issue 42",
      model: "model-next",
      effort: "xhigh",
      fast_mode: false,
      queued_message_id: expect.any(String)
    });
    expect(store.getSession(createdId).descriptor).toMatchObject({
      targetId: "target-b",
      providerId: "provider-a",
      modelId: "model-next",
      effort: "xhigh",
      fastMode: false,
      permissionMode: "auto",
      planMode: true
    });
    expect(hostState.createServiceSession).toHaveBeenCalledWith(expect.objectContaining({
      serviceKind: "session_handoff",
      targetId: "target-b",
      worktree: { refreshRemote: false }
    }));

    expect(errorData(await callNested(provider, "send_to_session", {
      target_session_id: "session-b",
      message: "wrong Backend",
      agent_kind: "backend-b"
    }))).toMatchObject({ errorCode: "INVALID_ARGS" });

    const crossBackend = resultData(await callNested(provider, "send_to_session", {
      message: "use destination defaults",
      working_dir: roots.other,
      agent_kind: "backend-b"
    })) as Record<string, unknown>;
    expect(crossBackend).toMatchObject({ agent_kind: "backend-b", fast_mode: false });
    expect(hostState.createServiceSession).toHaveBeenLastCalledWith(expect.objectContaining({
      targetId: "target-other",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    }));
    const crossBackendInput = hostState.createServiceSession.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(crossBackendInput).not.toHaveProperty("providerId");
    expect(crossBackendInput).not.toHaveProperty("modelId");
    expect(crossBackendInput).not.toHaveProperty("effort");

    expect(errorData(await callNested(provider, "send_to_session", {
      message: "wrong root",
      working_dir: join(roots.base, "not-registered")
    }))).toMatchObject({ errorCode: "INVALID_ARGS" });

    hostState.createServiceSession.mockRejectedValueOnce({
      code: "WORKTREE_UNAVAILABLE",
      message: "An isolated workspace could not be acquired."
    });
    const beforeQueues = store.listQueueItems().length;
    expect(errorData(await callNested(provider, "send_to_session", {
      message: "must isolate",
      use_worktree: true
    }))).toMatchObject({ errorCode: "WORKTREE_UNAVAILABLE" });
    expect(store.listQueueItems()).toHaveLength(beforeQueues);
  });

  it("returns selected schemas for invalid calls and never accepts unknown nested tools", async () => {
    const { provider } = fixture();
    expect(errorData(await provider.callTool("call_tool", {
      name: "missing_tool",
      args: {}
    }, undefined, context()))).toMatchObject({
      errorCode: "UNKNOWN_TOOL",
      data: { requested: "missing_tool", available: SESSION_HELPER_NESTED_TOOL_NAMES }
    });
    expect(errorData(await provider.callTool("call_tool", {
      name: "get_current_session_id",
      args: "not-json"
    }, undefined, context()))).toMatchObject({
      errorCode: "INVALID_ARGS",
      data: { tool: "get_current_session_id", schema: expect.any(Object) }
    });
    expect(errorData(await callNested(provider, "get_current_session_id", { hidden: true })))
      .toMatchObject({ errorCode: "INVALID_ARGS", message: "Unexpected argument: hidden." });
  });
});

function fixture() {
  const store = new OperationalStore(":memory:");
  openStores.push(store);
  const base = mkdtempSync(join(tmpdir(), "joko-session-helper-"));
  temporaryRoots.push(base);
  const roots = {
    base,
    a: join(base, "target-a"),
    b: join(base, "target-b"),
    other: join(base, "target-other"),
    u: join(base, "target-u")
  };
  mkdirSync(roots.a, { recursive: true });
  mkdirSync(roots.b, { recursive: true });
  mkdirSync(roots.other, { recursive: true });
  mkdirSync(roots.u, { recursive: true });
  const supported = (key: string): Capability => ({ key, supported: true });
  store.upsertBackend({
    id: "backend-a",
    displayName: "Backend A",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map([
      ["turn.abort", supported("turn.abort")],
      ["turn.steer", supported("turn.steer")],
      ["session.resume", supported("session.resume")]
    ]),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertBackend({
    id: "backend-b",
    displayName: "Backend B",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  for (const [id, root, trusted] of [
    ["target-a", roots.a, true],
    ["target-b", roots.b, true],
    ["target-u", roots.u, false]
  ] as const) {
    store.upsertTarget({
      id,
      backendId: "backend-a",
      displayName: id,
      workspaceRoot: root,
      managed: false,
      trusted
    });
  }
  store.upsertTarget({
    id: "target-other",
    backendId: "backend-b",
    displayName: "target-other",
    workspaceRoot: roots.other,
    managed: false,
    trusted: true
  });
  createSession(store, {
    id: "session-a",
    targetId: "target-a",
    title: "Session A",
    providerId: "provider-a",
    modelId: "model-a",
    effort: "high",
    fastMode: true,
    permissionMode: "auto",
    planMode: true,
    createdAt: NOW,
    updatedAt: NOW
  });
  createSession(store, {
    id: "session-b",
    targetId: "target-b",
    title: "Session B",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    createdAt: NOW + 1,
    updatedAt: NOW + 1
  });
  createSession(store, {
    id: "session-c",
    targetId: "target-b",
    title: "Session C",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    createdAt: NOW + 2,
    updatedAt: NOW + 2
  });
  createSession(store, {
    id: "session-u",
    targetId: "target-u",
    title: "Untrusted",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    createdAt: NOW + 3,
    updatedAt: NOW + 3
  });

  const activeSessions = new Set<string>(["session-a"]);
  let serviceSequence = 0;
  const enqueueServiceInput = vi.fn((input: {
    operationId: string;
    sessionId: string;
    prompt: PromptInput;
    source: "schedule" | "system";
    originSessionId?: string;
  }) => enqueueService(store, input));
  const createServiceSession = vi.fn(async (input: {
    operationId: string;
    targetId: string;
    title: string;
    providerId?: string;
    modelId?: string;
    effort?: string;
    fastMode: boolean;
    permissionMode: SessionDescriptor["permissionMode"];
    planMode: boolean;
  }) => {
    const sessionId = `created-${++serviceSequence}`;
    const execution = store.runOperation(
      { id: input.operationId, kind: "create_session_handoff", body: { targetId: input.targetId } },
      (transactionStore) => {
        const backendId = transactionStore.getTarget(input.targetId).descriptor.backendId;
        createSession(transactionStore, {
          id: sessionId,
          backendId,
          targetId: input.targetId,
          title: input.title,
          ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          fastMode: input.fastMode,
          permissionMode: input.permissionMode,
          planMode: input.planMode,
          createdAt: NOW + 100 + serviceSequence,
          updatedAt: NOW + 100 + serviceSequence
        });
        return { sessionId };
      }
    );
    activeSessions.add(sessionId);
    return execution;
  });
  const resume = vi.fn(async (sessionId: string) => {
    activeSessions.add(sessionId);
    return {};
  });
  const abort = vi.fn(async () => undefined);
  let runtimeGeneration = 0;
  const getSessionRuntimeControl = vi.fn((sessionId: string) => {
    const descriptor = store.getSession(sessionId).descriptor;
    const baseline = descriptor.providerId === undefined || descriptor.modelId === undefined
      ? undefined
      : {
          backendId: descriptor.backendId,
          providerId: descriptor.providerId,
          modelId: descriptor.modelId,
          ...(descriptor.effort === undefined ? {} : { effort: descriptor.effort }),
          fastMode: descriptor.fastMode
        };
    return {
      generation: runtimeGeneration,
      ...(baseline === undefined ? {} : { baseline, effective: baseline }),
      fallbackHop: 0,
      visitedRoutes: []
    };
  });
  const setSessionRuntimeControl = vi.fn(async (input: {
    sessionId: string;
    expectedGeneration: number;
    patch: { providerId?: string | null; modelId?: string; effort?: string; fastMode?: boolean };
  }) => {
    const current = getSessionRuntimeControl(input.sessionId).effective;
    if (current === undefined) throw new Error("Missing runtime baseline.");
    runtimeGeneration += 1;
    return {
      status: "applied" as const,
      generation: runtimeGeneration,
      effective: {
        ...current,
        ...(input.patch.providerId === undefined || input.patch.providerId === null
          ? {}
          : { providerId: input.patch.providerId }),
        ...(input.patch.modelId === undefined ? {} : { modelId: input.patch.modelId }),
        ...(input.patch.effort === undefined ? {} : { effort: input.patch.effort }),
        ...(input.patch.fastMode === undefined ? {} : { fastMode: input.patch.fastMode })
      }
    };
  });
  const hostState = {
    abort,
    createServiceSession,
    enqueueServiceInput,
    getSessionRuntimeControl,
    isSessionActive: vi.fn((sessionId: string) => activeSessions.has(sessionId)),
    resume,
    sessionRuntimeFallbackEnabled: vi.fn(() => false),
    setSessionRuntimeControl
  };
  const provider = new SessionHelperToolBridgeProvider({
    store,
    host: () => hostState as unknown as Pick<
      SessionHost,
      "abort" | "createServiceSession" | "enqueueServiceInput" | "getSessionRuntimeControl" |
      "isSessionActive" | "resume" | "sessionRuntimeFallbackEnabled" | "setSessionRuntimeControl"
    >,
    now: () => NOW + 10_000
  });
  return { store, provider, hostState, roots };
}

function createSession(
  store: OperationalStore,
  input: Omit<SessionDescriptor, "backendId" | "binding" | "pinned" | "archived"> & { readonly backendId?: string }
): void {
  store.createSession({
    ...input,
    backendId: input.backendId ?? "backend-a",
    binding: { opaqueRef: `${input.id}.jsonl`, generation: 7 },
    pinned: false,
    archived: false
  });
}

function enqueueService(
  store: OperationalStore,
  input: {
    operationId: string;
    sessionId: string;
    prompt: PromptInput;
    source: "schedule" | "system";
    originSessionId?: string;
  }
): OperationExecution<{ sessionId: string; runId: string; attemptId: string; queueItemId: string }> {
  const suffix = input.operationId.replace(/[^A-Za-z0-9]/gu, "").slice(-24);
  const runId = `run-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const queueItemId = `queue-${suffix}`;
  return store.runOperation(
    {
      id: input.operationId,
      kind: "service_send_input",
      body: {
        sessionId: input.sessionId,
        prompt: input.prompt,
        source: input.source,
        ...(input.originSessionId === undefined ? {} : { originSessionId: input.originSessionId })
      }
    },
    (transactionStore) => {
      transactionStore.createRun({
        id: runId,
        sessionId: input.sessionId,
        source: input.source,
        state: "queued",
        createdAt: NOW + 5_000
      });
      transactionStore.createAttempt({
        id: attemptId,
        runId,
        ordinal: 1,
        generation: transactionStore.getSession(input.sessionId).descriptor.binding.generation,
        startedAt: NOW + 5_000
      });
      transactionStore.enqueueQueueItem({
        id: queueItemId,
        sessionId: input.sessionId,
        runId,
        attemptId,
        operationId: input.operationId,
        disposition: input.prompt.disposition,
        body: input.prompt,
        createdAt: NOW + 5_000
      });
      return { sessionId: input.sessionId, runId, attemptId, queueItemId };
    }
  );
}

function appendMessage(
  store: OperationalStore,
  id: string,
  sessionId: string,
  role: "user" | "assistant",
  text: string,
  emittedAt: number
): void {
  const session = store.getSession(sessionId).descriptor;
  store.appendEvent({
    id,
    backendId: session.backendId,
    targetId: session.targetId,
    sessionId,
    generation: session.binding.generation,
    emittedAt,
    traceId: `test:${id}`,
    payload: { type: "message_complete", role, blocks: [{ kind: "text", text }] }
  });
}

async function callNested(
  provider: SessionHelperToolBridgeProvider,
  name: string,
  args: Readonly<Record<string, unknown>>,
  callContext = context()
): Promise<McpCallResult> {
  return provider.callTool("call_tool", { name, args }, undefined, callContext);
}

function context(sessionId = "session-a", targetId = "target-a"): BridgeToolCallContext {
  return { sessionId, targetId, generation: 7 };
}

function resultData(result: McpCallResult): unknown {
  expect(result.isError).toBe(false);
  return result.structuredContent?.["data"];
}

function errorData(result: McpCallResult): Readonly<Record<string, unknown>> {
  expect(result.isError).toBe(true);
  return result.structuredContent ?? {};
}
