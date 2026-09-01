import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD,
  NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD,
  nativeHistoryEventContext,
  type EventPayload,
  type PiEventMetadata
} from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore } from "./index.js";

const cleanups: Array<() => void> = [];
const EMBEDDING_GENERATION_ID = "embedding-generation-1";
// Hosted Windows disks make FULL-synchronous SQLite commits materially slower;
// retain the tighter budget on the other CI platforms while bounding Windows.
const DEEP_NATIVE_LINEAGE_ACTIVATION_BUDGET_MS = process.platform === "win32" ? 5_000 : 3_000;

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("OperationalStore visible message search", () => {
  it("loads a bounded centered timeline window without scanning a fixed event prefix", () => {
    const fixture = createFixture();
    for (let index = 1; index <= 9; index += 1) {
      appendMessage(fixture.store, `event-${index}`, "session-a", index * 10, visible(`message ${index}`));
    }
    appendMessage(fixture.store, "event-other-session", "session-b", 100, visible("other"));

    expect(fixture.store.listEventsAround("session-a", "event-5", 5).map((event) => event.id))
      .toEqual(["event-3", "event-4", "event-5", "event-6", "event-7"]);
    expect(fixture.store.listEventsAround("session-a", "event-1", 5).map((event) => event.id))
      .toEqual(["event-1", "event-2", "event-3", "event-4", "event-5"]);
    expect(fixture.store.listEventsAround("session-a", "event-9", 5).map((event) => event.id))
      .toEqual(["event-5", "event-6", "event-7", "event-8", "event-9"]);
    expect(() => fixture.store.listEventsAround("session-a", "event-other-session", 5)).toThrow(/Event/u);
  });

  it("searches visible messages and typed question/plan interactions across explicit scopes", () => {
    const fixture = createFixture();
    appendMessage(fixture.store, "event-visible", "session-a", 10, {
      type: "message_complete",
      role: "user",
      blocks: [
        { kind: "text", text: "Hello release plan" },
        { kind: "thinking", text: "private-thinking-marker", redacted: false },
        {
          kind: "image",
          blob: { id: "image-1", sha256: "a".repeat(64), byteLength: 1, mimeType: "image/png" },
          alt: "private-base64-marker"
        },
        { kind: "tool_call", callId: "call-1", name: "bash", input: "private-tool-argument" },
        { kind: "tool_result", callId: "call-1", output: "private-tool-output", isError: false }
      ],
      nativeHistory: { identity: { entryId: "entry-visible" } }
    }, diagnosticPi("entry-visible"));
    appendMessage(fixture.store, "event-chinese", "session-c", 20, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "这是中文消息，也可以精确搜索。" }]
    });
    appendMessage(fixture.store, "event-stream", "session-a", 30, {
      type: "text_delta",
      blockId: "stream-1",
      delta: "private-stream-marker"
    });
    appendMessage(fixture.store, "event-tool", "session-a", 40, {
      type: "tool_result",
      callId: "call-2",
      name: "search",
      output: "private-top-level-tool-output",
      isError: false
    });
    fixture.store.appendEvent({
      id: "event-metadata",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 50,
      traceId: "message-search:metadata",
      payload: { type: "status", key: "quiet" },
      metadata: { namespace: "test", fields: { hidden: "private-metadata-marker" } }
    });
    appendMessage(fixture.store, "event-question", "session-a", 60, {
      type: "interaction_opened",
      interaction: {
        id: "question-1",
        kind: "question",
        title: "Deployment choice",
        prompt: "Which deployment region should we use?",
        fields: [{
          id: "region",
          kind: "single",
          label: "Select the release region",
          description: "Do not expose sk-abcdefghijklmnop",
          required: true,
          choices: [{ id: "east", label: "East" }]
        }]
      }
    });
    appendMessage(fixture.store, "event-plan-review", "session-a", 70, {
      type: "interaction_opened",
      interaction: {
        id: "plan-1",
        kind: "plan_review",
        title: "Review plan",
        markdown: "Roll out the canary deployment, then verify telemetry.",
        choices: ["execute", "stay", "refine"]
      }
    });
    appendMessage(fixture.store, "event-permission", "session-a", 80, {
      type: "interaction_opened",
      interaction: {
        id: "permission-1",
        kind: "permission",
        title: "Permission",
        toolName: "bash",
        summary: "private-permission-marker",
        risk: "high",
        choices: ["allow", "deny"]
      }
    });

    const english = fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "hello plan"
    });
    expect(english.matches).toEqual([expect.objectContaining({
      sessionId: "session-a",
      targetId: "target-a",
      eventId: "event-visible",
      timelineItemId: "entry-visible",
      role: "user",
      kind: "text_message",
      snippet: "Hello release plan",
      createdAt: 10
    })]);
    expect(english.matches[0]?.score).toBeGreaterThan(0);

    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "which region"
    }).matches).toEqual([expect.objectContaining({
      eventId: "event-question",
      timelineItemId: "interaction:question-1",
      role: "assistant",
      snippet: expect.stringContaining("Which deployment region")
    })]);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "canary telemetry"
    }).matches).toEqual([expect.objectContaining({
      eventId: "event-plan-review",
      timelineItemId: "interaction:plan-1",
      role: "assistant"
    })]);
    const redactedQuestion = fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "Do not expose"
    });
    expect(redactedQuestion.matches[0]?.snippet).toContain("[REDACTED]");

    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "中文消息"
    }).matches.map((match) => match.sessionId)).toEqual(["session-c"]);
    expect(fixture.store.searchSessionMessages({
      scope: { targetId: "target-a" },
      query: "中文消息"
    }).matches).toEqual([]);
    expect(fixture.store.searchSessionMessages({
      scope: { targetId: "target-b" },
      query: "中文消息"
    }).matches).toHaveLength(1);
    expect(() => fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "x".repeat(257)
    })).toThrow(/exceeds 256/u);
    expect(() => fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "release",
      limit: 101
    })).toThrow(/between 1 and 100/u);
    expect(fixture.store.validateSessionMessageSearch({
      scope: { owner: true },
      query: "find sk-abcdefghijklmnop now",
      semanticRequested: true
    })).toEqual({ query: "find [REDACTED] now", useSemantic: true });
    expect(() => fixture.store.validateSessionMessageSearch({
      scope: { owner: true },
      query: "x".repeat(257),
      semanticRequested: true
    })).toThrow(/exceeds 256/u);
    expect(() => fixture.store.validateSessionMessageSearch({
      scope: { owner: true },
      query: "release",
      pageToken: "not-a-valid-page-token",
      semanticRequested: true
    })).toThrow(/malformed/u);

    for (const hidden of [
      "private-thinking-marker",
      "private-base64-marker",
      "private-tool-argument",
      "private-tool-output",
      "private-stream-marker",
      "private-top-level-tool-output",
      "private-metadata-marker",
      "private-permission-marker",
      "abcdefghijklmnop"
    ]) {
      expect(fixture.store.searchSessionMessages({ scope: { owner: true }, query: hidden }).matches).toEqual([]);
    }
    expect(() => fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: `Hello\" OR *`
    })).not.toThrow();
    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: `Hello\" OR *`
    }).matches.map((match) => match.eventId)).toEqual(["event-visible"]);
  });

  it("keeps service-owned continuation prompts out of search and embedding jobs", () => {
    const fixture = createFixture();
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    appendMessage(fixture.store, "event-internal-continuation", "session-a", 10, {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "internal continuation search marker" }],
      automaticContinuation: { recoveryId: "recovery-a" }
    });
    appendMessage(fixture.store, "event-visible-continuation-control", "session-a", 20, visible("visible control marker"));

    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "internal continuation search marker"
    }).matches.map((match) => match.eventId)).not.toContain("event-internal-continuation");
    expect(fixture.store.claimMessageEmbeddingJobs(8, 30).map((job) => job.eventId))
      .toEqual(["event-visible-continuation-control"]);
  });

  it("matches Unicode OR tokens safely, including short tokens and the 32-token bound", () => {
    const fixture = createFixture();
    appendMessage(
      fixture.store,
      "event-separated",
      "session-a",
      10,
      visible(`foo ${"distant ".repeat(20)}bar`)
    );
    appendMessage(fixture.store, "event-short-cjk", "session-b", 20, visible("修复完成"));
    appendMessage(fixture.store, "event-term-31", "session-c", 30, visible("term31"));
    appendMessage(fixture.store, "event-term-32", "session-c", 40, visible("term32"));

    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "foo ... bar"
    }).matches.map((match) => match.eventId)).toEqual(["event-separated"]);
    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "foo foo missing"
    }).matches.map((match) => match.eventId)).toEqual(["event-separated"]);
    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "修复，未命中!!!"
    }).matches.map((match) => match.eventId)).toEqual(["event-short-cjk"]);
    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "-*:()，。"
    })).toEqual(expect.objectContaining({ matches: [], totalSize: 0 }));

    const boundedQuery = Array.from({ length: 33 }, (_, index) => `term${String(index).padStart(2, "0")}`)
      .join(" ");
    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: boundedQuery
    }).matches.map((match) => match.eventId)).toEqual(["event-term-31"]);
  });

  it("centers snippets on the earliest matching token when the full query phrase is absent", () => {
    const fixture = createFixture();
    appendMessage(
      fixture.store,
      "event-late-token",
      "session-a",
      10,
      visible(`${"opening filler ".repeat(30)}EARLIEST marker after the distant prefix`)
    );

    const result = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "absent earliest"
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.snippet).toMatch(/^…/u);
    expect(result.matches[0]?.snippet).toContain("EARLIEST");
    expect(result.matches[0]?.snippet.length).toBeLessThan("opening filler ".repeat(30).length);
  });

  it("keeps pagination deterministic, rejects stale tokens, and excludes soft-deleted Sessions", () => {
    const fixture = createFixture();
    appendMessage(fixture.store, "event-a", "session-a", 10, visible("stable needle one"));
    appendMessage(fixture.store, "event-b", "session-b", 20, visible("stable needle two"));
    appendMessage(fixture.store, "event-c", "session-c", 30, visible("stable needle tri"));
    appendMessage(fixture.store, "event-multi", "session-a", 40, {
      type: "message_complete",
      role: "assistant",
      blocks: [
        { kind: "text", text: "stable needle four" },
        { kind: "text", text: "stable needle still one durable message" }
      ]
    });
    const duplicate = fixture.store.appendEventIfAbsent({
      id: "event-multi",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 40,
      traceId: "message-search:event-multi",
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [
          { kind: "text", text: "stable needle four" },
          { kind: "text", text: "stable needle still one durable message" }
        ]
      }
    });
    expect(duplicate.id).toBe("event-multi");

    const seen: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = fixture.store.searchSessionMessages({
        scope: { owner: true },
        query: "stable needle",
        limit: 1,
        ...(pageToken === undefined ? {} : { pageToken })
      });
      seen.push(...page.matches.map((match) => match.eventId));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    expect(seen).toEqual(["event-c", "event-b", "event-a", "event-multi"]);
    expect(new Set(seen).size).toBe(4);

    const first = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "stable needle",
      limit: 1
    });
    expect(first.nextPageToken).toBeDefined();
    expect(JSON.parse(Buffer.from(first.nextPageToken!, "base64url").toString("utf8"))).toMatchObject({ v: 1 });
    const filteredFirst = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "stable needle",
      filters: { targetIds: ["target-a"] },
      limit: 1
    });
    expect(filteredFirst.nextPageToken).toBeDefined();
    expect(() => fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "stable needle",
      filters: { targetIds: ["target-b"] },
      limit: 1,
      pageToken: filteredFirst.nextPageToken
    })).toThrow(/does not match/u);
    expect(() => fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "stable needle",
      filters: { targetIds: ["target-a", "target-a"] },
      limit: 1,
      pageToken: filteredFirst.nextPageToken
    })).not.toThrow();
    const sessionB = fixture.store.getSession("session-b");
    fixture.store.updateSession("session-b", { deletedAt: 100 }, sessionB.revision, 100);
    expect(() => fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "stable needle",
      limit: 1,
      pageToken: first.nextPageToken
    })).toThrow(/stale/u);

    const afterDelete = fixture.store.searchSessionMessages({ scope: { owner: true }, query: "stable needle" });
    expect(afterDelete.matches.map((match) => match.sessionId)).not.toContain("session-b");
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-b" },
      query: "stable needle"
    }).matches).toEqual([]);
    expect(fixture.store.searchSessionMessages({
      scope: { targetId: "target-a" },
      query: "stable needle"
    }).matches.map((match) => match.sessionId)).not.toContain("session-b");
    const sessionC = fixture.store.getSession("session-c");
    fixture.store.updateSession("session-c", { archived: true }, sessionC.revision, 110);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-c" },
      query: "stable needle"
    }).matches).toHaveLength(1);
  });

  it("fairly pages per-Session top hits before a long Session can consume the result window", () => {
    const fixture = createFixture();
    for (let index = 1; index <= 5; index += 1) {
      appendMessage(fixture.store, `event-a-${index}`, "session-a", index * 10, visible("fair needle"));
    }
    appendMessage(fixture.store, "event-b-1", "session-b", 60, visible("fair needle"));
    appendMessage(fixture.store, "event-b-2", "session-b", 70, visible("fair needle"));
    appendMessage(fixture.store, "event-c-1", "session-c", 80, visible("fair needle"));

    const firstWindow = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "fair needle",
      limit: 4
    });
    expect(firstWindow.matches.map((match) => match.eventId)).toEqual([
      "event-c-1",
      "event-b-2",
      "event-a-5",
      "event-b-1"
    ]);
    expect(firstWindow.totalSize).toBe(8);

    const paged: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = fixture.store.searchSessionMessages({
        scope: { owner: true },
        query: "fair needle",
        limit: 2,
        ...(pageToken === undefined ? {} : { pageToken })
      });
      paged.push(...page.matches.map((match) => match.eventId));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    expect(paged).toEqual([
      "event-c-1",
      "event-b-2",
      "event-a-5",
      "event-b-1",
      "event-a-4",
      "event-a-3",
      "event-a-2",
      "event-a-1"
    ]);
    expect(new Set(paged).size).toBe(8);

    expect(fixture.store.searchSessionMessages({
      scope: { targetId: "target-a" },
      query: "fair needle",
      limit: 4
    }).matches.map((match) => match.eventId)).toEqual([
      "event-b-2",
      "event-a-5",
      "event-b-1",
      "event-a-4"
    ]);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "fair needle",
      limit: 3
    }).matches.map((match) => match.eventId)).toEqual([
      "event-a-5",
      "event-a-4",
      "event-a-3"
    ]);
  });

  it("durably queues only post-cutoff visible messages and performs real vector + FTS RRF retrieval", () => {
    const fixture = createFixture();
    appendMessage(fixture.store, "event-before-cutoff", "session-a", 5, visible("historical deployment note"));
    const enabled = fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    expect(enabled).toEqual(expect.objectContaining({
      enabled: true,
      vectorAvailable: true,
      modelId: "voyage/voyage-4",
      dimensions: 1024,
      pendingCount: 0
    }));

    appendMessage(fixture.store, "event-semantic-a", "session-a", 10, visible("release train readiness checklist"));
    appendMessage(fixture.store, "event-semantic-b", "session-b", 20, visible("banana dessert recipe"));
    const jobs = fixture.store.claimMessageEmbeddingJobs(8, 30);
    expect(jobs.map((job) => job.eventId)).toEqual(["event-semantic-a", "event-semantic-b"]);
    expect(jobs.every((job) => !job.text.includes("historical deployment note"))).toBe(true);
    fixture.store.completeMessageEmbeddingJob(jobs[0]!.eventCursor, jobs[0]!.claimToken, "embedding-provider", EMBEDDING_GENERATION_ID, "voyage/voyage-4", embedding(0), 31);
    fixture.store.completeMessageEmbeddingJob(jobs[1]!.eventCursor, jobs[1]!.claimToken, "embedding-provider", EMBEDDING_GENERATION_ID, "voyage/voyage-4", embedding(1), 32);

    const semanticOnly = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "deployment guidance",
      semantic: { providerId: "embedding-provider", providerGenerationId: EMBEDDING_GENERATION_ID, modelId: "voyage/voyage-4", queryEmbedding: embedding(0) }
    });
    expect(semanticOnly.vectorUsed).toBe(true);
    expect(semanticOnly.matches[0]).toEqual(expect.objectContaining({
      eventId: "event-semantic-a",
      vectorRank: 1
    }));
    expect(semanticOnly.matches[0]?.ftsRank).toBeUndefined();

    const hybrid = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "banana",
      semantic: { providerId: "embedding-provider", providerGenerationId: EMBEDDING_GENERATION_ID, modelId: "voyage/voyage-4", queryEmbedding: embedding(0) }
    });
    expect(hybrid.matches.map((match) => match.eventId)).toEqual(expect.arrayContaining([
      "event-semantic-a",
      "event-semantic-b"
    ]));
    expect(hybrid.matches.find((match) => match.eventId === "event-semantic-b"))
      .toEqual(expect.objectContaining({ ftsRank: 1 }));

    const scoped = fixture.store.searchSessionMessages({
      scope: { sessionId: "session-b" },
      query: "deployment guidance",
      semantic: { providerId: "embedding-provider", providerGenerationId: EMBEDDING_GENERATION_ID, modelId: "voyage/voyage-4", queryEmbedding: embedding(0) }
    });
    expect(scoped.matches.map((match) => match.eventId)).toEqual(["event-semantic-b"]);
    expect(fixture.store.messageEmbeddingStatus()).toEqual(expect.objectContaining({
      pendingCount: 0,
      runningCount: 0,
      doneCount: 2,
      failedCount: 0
    }));

    const firstHybridPage = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "deployment guidance",
      limit: 1,
      semantic: { providerId: "embedding-provider", providerGenerationId: EMBEDDING_GENERATION_ID, modelId: "voyage/voyage-4", queryEmbedding: embedding(0) }
    });
    expect(firstHybridPage.nextPageToken).toBeDefined();
    expect(() => fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "deployment guidance",
      limit: 1,
      pageToken: firstHybridPage.nextPageToken,
      semantic: { providerId: "embedding-provider", providerGenerationId: EMBEDDING_GENERATION_ID, modelId: "voyage/voyage-4", queryEmbedding: embedding(1) }
    })).toThrow(/semantic query generation changed/u);

    const sessionB = fixture.store.getSession("session-b");
    fixture.store.updateSession("session-b", { deletedAt: 100 }, sessionB.revision, 100);
    expect(fixture.store.messageEmbeddingStatus()).toEqual(expect.objectContaining({
      pendingCount: 0,
      runningCount: 0,
      doneCount: 1
    }));
  });

  it("fuses lexical and vector ranks by timeline identity while preserving the lexical representative", () => {
    const fixture = createFixture();
    appendMessage(fixture.store, "identity-lexical", "session-a", 10, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "lexicalidentityneedle from the first projection" }],
      nativeHistory: { identity: { entryId: "shared-entry" } }
    });
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    appendMessage(fixture.store, "identity-vector", "session-a", 20, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "the completed projection used for semantic retrieval" }],
      nativeHistory: { identity: { entryId: "shared-entry" } }
    });
    const [job] = fixture.store.claimMessageEmbeddingJobs(1, 30);
    expect(job?.eventId).toBe("identity-vector");
    fixture.store.completeMessageEmbeddingJob(
      job!.eventCursor,
      job!.claimToken,
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4",
      embedding(0),
      31
    );

    const hybrid = fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "lexicalidentityneedle",
      semantic: {
        providerId: "embedding-provider",
        providerGenerationId: EMBEDDING_GENERATION_ID,
        modelId: "voyage/voyage-4",
        queryEmbedding: embedding(0)
      }
    });

    expect(hybrid.matches).toEqual([expect.objectContaining({
      eventId: "identity-lexical",
      timelineItemId: "shared-entry",
      snippet: expect.stringContaining("lexicalidentityneedle"),
      score: 1,
      ftsRank: 1,
      vectorRank: 1
    })]);
  });

  it("uses backend-neutral native identity for keyword and hybrid timeline navigation", () => {
    const fixture = createFixture();
    fixture.store.upsertBackend({
      id: "generic-backend",
      displayName: "Generic Backend",
      version: "test",
      health: "healthy",
      adapterKind: "fixture",
      instanceGeneration: 0,
      installationState: "installed",
      authenticationState: "not_required",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    fixture.store.upsertTarget({
      id: "generic-target",
      backendId: "generic-backend",
      displayName: "Generic target",
      workspaceRoot: "D:/generic-workspace",
      managed: false,
      trusted: true
    });
    fixture.store.createSession({
      id: "generic-session",
      backendId: "generic-backend",
      targetId: "generic-target",
      title: "Generic session",
      binding: { opaqueRef: "generic-session.native", generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    appendMessageTo(
      fixture.store,
      "generic-event",
      "generic-backend",
      "generic-target",
      "generic-session",
      10,
      {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "generic history needle" }],
        nativeHistory: { identity: { entryId: "generic-entry" } }
      }
    );

    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "generic-session" },
      query: "history needle"
    }).matches[0]).toEqual(expect.objectContaining({
      eventId: "generic-event",
      timelineItemId: "generic-entry"
    }));

    const [job] = fixture.store.claimMessageEmbeddingJobs(1, 20);
    expect(job?.eventId).toBe("generic-event");
    fixture.store.completeMessageEmbeddingJob(
      job!.eventCursor,
      job!.claimToken,
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4",
      embedding(0),
      21
    );
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "generic-session" },
      query: "semantic-only",
      semantic: {
        providerId: "embedding-provider",
        providerGenerationId: EMBEDDING_GENERATION_ID,
        modelId: "voyage/voyage-4",
        queryEmbedding: embedding(0)
      }
    }).matches[0]).toEqual(expect.objectContaining({
      eventId: "generic-event",
      timelineItemId: "generic-entry",
      vectorRank: 1
    }));

    const current = fixture.store.getSession("generic-session");
    fixture.store.updateSession("generic-session", {
      binding: { opaqueRef: "generic-session.rebound", generation: 1 }
    }, current.revision, 30);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "generic-session" },
      query: "history needle"
    }).matches).toEqual([]);
    expect(() => fixture.store.listEventsAround("generic-session", "generic-event", 5)).toThrow(/Event/u);
  });

  it("searches and loads context from only the active native branch without live-history duplicates", () => {
    const fixture = createFixture();
    fixture.store.upsertBackend({
      id: "branch-backend",
      displayName: "Branch Backend",
      version: "test",
      health: "healthy",
      adapterKind: "fixture",
      instanceGeneration: 0,
      installationState: "installed",
      authenticationState: "not_required",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    fixture.store.upsertTarget({
      id: "branch-target",
      backendId: "branch-backend",
      displayName: "Branch target",
      workspaceRoot: "D:/branch-workspace",
      managed: false,
      trusted: true
    });
    const nativeReference = "branch-session.native";
    fixture.store.createSession({
      id: "branch-session",
      backendId: "branch-backend",
      targetId: "branch-target",
      title: "Branch session",
      binding: { opaqueRef: nativeReference, generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    const bindingFingerprint = `sha256:${createHash("sha256").update(nativeReference).digest("hex")}`;
    const append = (
      id: string,
      emittedAt: number,
      payload: EventPayload,
      fields: Readonly<Record<string, string | number | boolean>>
    ): void => {
      fixture.store.appendEvent({
        id,
        backendId: "branch-backend",
        targetId: "branch-target",
        sessionId: "branch-session",
        generation: 0,
        emittedAt,
        traceId: `message-search:${id}`,
        payload,
        metadata: { namespace: "test.native_history", fields }
      });
    };
    append("branch-live", 10, visible("sharedactiveneedle"), {
      [NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD]: true
    });
    append("branch-root", 20, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "root lineage marker" }],
      nativeHistory: { identity: { entryId: "branch-root-entry" } }
    }, { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint });
    append("branch-a", 30, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "sharedactiveneedle alphabranchquartz" }],
      nativeHistory: {
        identity: { entryId: "branch-a-entry", parentEntryId: "branch-root-entry" }
      }
    }, { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint });
    append("branch-b", 40, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "text", text: "betabranchquartz" }],
      nativeHistory: {
        identity: { entryId: "branch-b-entry", parentEntryId: "branch-root-entry" }
      }
    }, { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint });
    append("branch-marker-a", 50, {
      type: "native_session_changed",
      opaqueRef: nativeReference,
      leafId: "branch-a-entry"
    }, {});

    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "branch-session" },
      query: "sharedactiveneedle"
    })).toMatchObject({
      totalSize: 1,
      matches: [expect.objectContaining({ eventId: "branch-a", timelineItemId: "branch-a-entry" })]
    });
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "branch-session" },
      query: "betabranchquartz"
    }).matches).toEqual([]);
    expect(() => fixture.store.listEventsAround("branch-session", "branch-b", 5)).toThrow(/Event/u);
    expect(fixture.store.listEventsAround("branch-session", "branch-a", 5).map((event) => event.id))
      .toEqual(["branch-root", "branch-a", "branch-marker-a"]);

    for (;;) {
      const jobs = fixture.store.claimMessageEmbeddingJobs(64, 60);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        fixture.store.completeMessageEmbeddingJob(
          job.eventCursor,
          job.claimToken,
          "embedding-provider",
          EMBEDDING_GENERATION_ID,
          "voyage/voyage-4",
          embedding(0),
          61
        );
      }
    }
    const hybrid = fixture.store.searchSessionMessages({
      scope: { sessionId: "branch-session" },
      query: "semantic-only",
      semantic: {
        providerId: "embedding-provider",
        providerGenerationId: EMBEDDING_GENERATION_ID,
        modelId: "voyage/voyage-4",
        queryEmbedding: embedding(0)
      }
    });
    expect(hybrid.matches.map((match) => match.eventId)).toEqual(["branch-a", "branch-root"]);

    append("branch-marker-b", 70, {
      type: "native_session_changed",
      opaqueRef: nativeReference,
      leafId: "branch-b-entry"
    }, {});
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "branch-session" },
      query: "alphabranchquartz"
    }).matches).toEqual([]);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "branch-session" },
      query: "betabranchquartz"
    }).matches).toEqual([
      expect.objectContaining({ eventId: "branch-b", timelineItemId: "branch-b-entry" })
    ]);

    const beforeRebind = fixture.store.getSession("branch-session");
    const rebound = fixture.store.updateSession("branch-session", {
      binding: { opaqueRef: "branch-session-rebound.native", generation: 1 }
    }, beforeRebind.revision, 80);
    expect(rebound.descriptor.binding.generation).toBe(1);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "branch-session" },
      query: "betabranchquartz"
    }).matches).toEqual([]);
    expect(() => fixture.store.listEventsAround("branch-session", "branch-b", 5)).toThrow(/Event/u);

    const reboundFingerprint = `sha256:${createHash("sha256")
      .update(rebound.descriptor.binding.opaqueRef).digest("hex")}`;
    fixture.store.appendEvent({
      id: "branch-rebound-entry",
      backendId: "branch-backend",
      targetId: "branch-target",
      sessionId: "branch-session",
      generation: 1,
      emittedAt: 90,
      traceId: "message-search:branch-rebound-entry",
      payload: {
        type: "message_complete",
        role: "assistant",
        blocks: [{ kind: "text", text: "newbindingquartz" }],
        nativeHistory: { identity: { entryId: "branch-rebound-entry" } }
      },
      metadata: {
        namespace: "test.native_history",
        fields: { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: reboundFingerprint }
      }
    });
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "branch-session" },
      query: "newbindingquartz"
    }).matches).toEqual([]);
    fixture.store.appendEvent({
      id: "branch-rebound-marker",
      backendId: "branch-backend",
      targetId: "branch-target",
      sessionId: "branch-session",
      generation: 1,
      emittedAt: 100,
      traceId: "message-search:branch-rebound-marker",
      payload: {
        type: "native_session_changed",
        opaqueRef: rebound.descriptor.binding.opaqueRef,
        leafId: "branch-rebound-entry"
      }
    });
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "branch-session" },
      query: "newbindingquartz"
    }).matches).toEqual([
      expect.objectContaining({ eventId: "branch-rebound-entry", timelineItemId: "branch-rebound-entry" })
    ]);
  });

  it("promotes the next visible canonical identity after deleting the first projection", () => {
    const fixture = createFixture();
    const nativeReference = fixture.store.getSession("session-a").descriptor.binding.opaqueRef;
    const bindingFingerprint = `sha256:${createHash("sha256").update(nativeReference).digest("hex")}`;
    const appendNative = (
      id: string,
      emittedAt: number,
      entryId: string,
      text: string,
      parentEntryId?: string
    ): void => {
      fixture.store.appendEvent({
        id,
        backendId: "pi",
        targetId: "target-a",
        sessionId: "session-a",
        generation: 0,
        emittedAt,
        traceId: `message-search:${id}`,
        payload: {
          type: "message_complete",
          role: "assistant",
          blocks: [{ kind: "text", text }],
          nativeHistory: {
            identity: { entryId, ...(parentEntryId === undefined ? {} : { parentEntryId }) }
          }
        },
        metadata: {
          namespace: "test.native_history",
          fields: { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint }
        }
      });
    };
    appendNative("canonical-left", 10, "left-parent", "leftparentneedle");
    appendNative("canonical-right", 20, "right-parent", "rightparentneedle");
    appendNative("canonical-first", 30, "shared-child", "firstprojectionneedle", "left-parent");
    appendNative("canonical-second", 40, "shared-child", "secondprojectionneedle", "right-parent");
    fixture.store.appendEvent({
      id: "canonical-marker",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 50,
      traceId: "message-search:canonical-marker",
      payload: { type: "native_session_changed", opaqueRef: nativeReference, leafId: "shared-child" }
    });

    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "leftparentneedle"
    }).matches.map((match) => match.eventId)).toEqual(["canonical-left"]);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "rightparentneedle"
    }).matches).toEqual([]);

    fixture.store.runOperation(
      { id: "canonical-delete", kind: "delete_session_message", body: {} },
      (store) => store.commitMessageDeletion({
        sessionId: "session-a",
        requestedEventId: "canonical-first",
        deletedEventIds: ["canonical-first"],
        operationId: "canonical-delete",
        traceId: "message-search:canonical-delete",
        at: 60
      })
    );

    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "leftparentneedle"
    }).matches).toEqual([]);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "rightparentneedle"
    }).matches.map((match) => match.eventId)).toEqual(["canonical-right"]);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "secondprojectionneedle"
    }).matches.map((match) => match.eventId)).toEqual(["canonical-second"]);
  });

  it("extends an active lineage when ancestors arrive after its marker and terminates a native identity cycle", () => {
    const fixture = createFixture();
    const nativeReference = fixture.store.getSession("session-a").descriptor.binding.opaqueRef;
    const bindingFingerprint = `sha256:${createHash("sha256").update(nativeReference).digest("hex")}`;
    const appendNative = (
      id: string,
      emittedAt: number,
      entryId: string,
      text: string,
      parentEntryId?: string
    ): void => {
      fixture.store.appendEvent({
        id,
        backendId: "pi",
        targetId: "target-a",
        sessionId: "session-a",
        generation: 0,
        emittedAt,
        traceId: `message-search:${id}`,
        payload: {
          type: "message_complete",
          role: "assistant",
          blocks: [{ kind: "text", text }],
          nativeHistory: {
            identity: { entryId, ...(parentEntryId === undefined ? {} : { parentEntryId }) }
          }
        },
        metadata: {
          namespace: "test.native_history",
          fields: { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint }
        }
      });
    };

    fixture.store.appendEvent({
      id: "late-lineage-marker",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 10,
      traceId: "message-search:late-lineage-marker",
      payload: { type: "native_session_changed", opaqueRef: nativeReference, leafId: "late-child" }
    });
    appendNative("late-child-event", 20, "late-child", "latechildquartz", "late-parent");
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "latechildquartz"
    }).matches.map((match) => match.eventId)).toEqual(["late-child-event"]);

    appendNative("late-parent-event", 30, "late-parent", "lateparentzircon", "late-root");
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "lateparentzircon"
    }).matches.map((match) => match.eventId)).toEqual(["late-parent-event"]);

    appendNative("late-root-event", 40, "late-root", "laterootopal");
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "laterootopal"
    }).matches.map((match) => match.eventId)).toEqual(["late-root-event"]);

    appendNative("cycle-a-event", 50, "cycle-a", "cyclealphaquartz", "cycle-b");
    appendNative("cycle-b-event", 60, "cycle-b", "cyclebetazircon", "cycle-c");
    appendNative("cycle-c-event", 70, "cycle-c", "cyclegammaopal", "cycle-a");
    fixture.store.appendEvent({
      id: "cycle-marker",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 80,
      traceId: "message-search:cycle-marker",
      payload: { type: "native_session_changed", opaqueRef: nativeReference, leafId: "cycle-a" }
    });

    for (const [query, eventId] of [
      ["cyclealphaquartz", "cycle-a-event"],
      ["cyclebetazircon", "cycle-b-event"],
      ["cyclegammaopal", "cycle-c-event"]
    ] as const) {
      expect(fixture.store.searchSessionMessages({
        scope: { sessionId: "session-a" },
        query
      }).matches.map((match) => match.eventId)).toEqual([eventId]);
    }
  });

  it("overfetches KNN candidates across hidden sibling projections until it reaches the active branch", () => {
    const fixture = createFixture();
    fixture.store.upsertBackend({
      id: "knn-branch-backend",
      displayName: "KNN Branch Backend",
      version: "test",
      health: "healthy",
      adapterKind: "fixture",
      instanceGeneration: 0,
      installationState: "installed",
      authenticationState: "not_required",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    fixture.store.upsertTarget({
      id: "knn-branch-target",
      backendId: "knn-branch-backend",
      displayName: "KNN branch target",
      workspaceRoot: "D:/knn-branch-workspace",
      managed: false,
      trusted: true
    });
    const nativeReference = "knn-branch-session.native";
    fixture.store.createSession({
      id: "knn-branch-session",
      backendId: "knn-branch-backend",
      targetId: "knn-branch-target",
      title: "KNN branch session",
      binding: { opaqueRef: nativeReference, generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    const bindingFingerprint = `sha256:${createHash("sha256").update(nativeReference).digest("hex")}`;
    const appendNative = (
      id: string,
      emittedAt: number,
      entryId: string,
      parentEntryId: string | undefined,
      text: string
    ): void => {
      fixture.store.appendEvent({
        id,
        backendId: "knn-branch-backend",
        targetId: "knn-branch-target",
        sessionId: "knn-branch-session",
        generation: 0,
        emittedAt,
        traceId: `message-search:${id}`,
        payload: {
          type: "message_complete",
          role: "assistant",
          blocks: [{ kind: "text", text }],
          nativeHistory: {
            identity: { entryId, ...(parentEntryId === undefined ? {} : { parentEntryId }) }
          }
        },
        metadata: {
          namespace: "test.native_history",
          fields: { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint }
        }
      });
    };

    appendNative("knn-root", 10, "knn-root-entry", undefined, "root outside the embedding cutoff");
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    appendNative("knn-hidden-1", 20, "knn-hidden-entry", "knn-root-entry", "hidden sibling projection one");
    appendNative("knn-hidden-2", 30, "knn-hidden-entry", "knn-root-entry", "hidden sibling projection two");
    appendNative("knn-hidden-3", 40, "knn-hidden-entry", "knn-root-entry", "hidden sibling projection three");
    appendNative("knn-hidden-4", 50, "knn-other-hidden-entry", "knn-root-entry", "another hidden sibling");
    appendNative("knn-active", 60, "knn-active-entry", "knn-root-entry", "active semantic survivor");
    fixture.store.appendEvent({
      id: "knn-active-marker",
      backendId: "knn-branch-backend",
      targetId: "knn-branch-target",
      sessionId: "knn-branch-session",
      generation: 0,
      emittedAt: 70,
      traceId: "message-search:knn-active-marker",
      payload: { type: "native_session_changed", opaqueRef: nativeReference, leafId: "knn-active-entry" }
    });

    const slopes = new Map<string, number>([
      ["knn-hidden-1", 0.01],
      ["knn-hidden-2", 0.02],
      ["knn-hidden-3", 0.03],
      ["knn-hidden-4", 0.04],
      ["knn-active", 0.5]
    ]);
    const jobs = fixture.store.claimMessageEmbeddingJobs(8, 80);
    expect(jobs.map((job) => job.eventId)).toEqual([
      "knn-hidden-1",
      "knn-hidden-2",
      "knn-hidden-3",
      "knn-hidden-4",
      "knn-active"
    ]);
    for (const job of jobs) {
      fixture.store.completeMessageEmbeddingJob(
        job.eventCursor,
        job.claimToken,
        "embedding-provider",
        EMBEDDING_GENERATION_ID,
        "voyage/voyage-4",
        slopedEmbedding(slopes.get(job.eventId)!),
        81
      );
    }

    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "knn-branch-session" },
      query: "semantic-only",
      semantic: {
        providerId: "embedding-provider",
        providerGenerationId: EMBEDDING_GENERATION_ID,
        modelId: "voyage/voyage-4",
        queryEmbedding: slopedEmbedding(0),
        poolLimit: 1
      }
    })).toMatchObject({
      poolCapped: false,
      totalSize: 1,
      matches: [expect.objectContaining({
        eventId: "knn-active",
        timelineItemId: "knn-active-entry",
        vectorRank: 1
      })]
    });
  });

  it("activates a 4000-entry native lineage through indexed canonical parents", { timeout: 60_000 }, () => {
    const fixture = createFixture();
    const nativeReference = fixture.store.getSession("session-a").descriptor.binding.opaqueRef;
    const bindingFingerprint = `sha256:${createHash("sha256").update(nativeReference).digest("hex")}`;
    fixture.store.transaction((store) => {
      for (let index = 0; index < 4_000; index += 1) {
        const entryId = `deep-entry-${index}`;
        store.appendEvent({
          id: `deep-event-${index}`,
          backendId: "pi",
          targetId: "target-a",
          sessionId: "session-a",
          generation: 0,
          emittedAt: 10 + index,
          traceId: `message-search:deep-event-${index}`,
          payload: {
            type: "message_complete",
            role: "assistant",
            blocks: [{ kind: "text", text: index === 3_999 ? "deepterminalneedle" : "lineage" }],
            nativeHistory: {
              identity: {
                entryId,
                ...(index === 0 ? {} : { parentEntryId: `deep-entry-${index - 1}` })
              }
            }
          },
          metadata: {
            namespace: "test.native_history",
            fields: { [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: bindingFingerprint }
          }
        });
      }
    });

    const startedAt = performance.now();
    fixture.store.appendEvent({
      id: "deep-marker",
      backendId: "pi",
      targetId: "target-a",
      sessionId: "session-a",
      generation: 0,
      emittedAt: 5_000,
      traceId: "message-search:deep-marker",
      payload: {
        type: "native_session_changed",
        opaqueRef: nativeReference,
        leafId: "deep-entry-3999"
      }
    });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(DEEP_NATIVE_LINEAGE_ACTIVATION_BUDGET_MS);
    expect(fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "deepterminalneedle"
    }).matches.map((match) => match.eventId)).toEqual(["deep-event-3999"]);
    expect(fixture.store.listEventsAround("session-a", "deep-event-3999", 3).map((event) => event.id))
      .toEqual(["deep-event-3998", "deep-event-3999", "deep-marker"]);
  });

  it("queues only searchable typed interactions for semantic indexing", () => {
    const fixture = createFixture();
    fixture.store.setMessageEmbeddingEnabled(true);
    appendMessage(fixture.store, "semantic-question", "session-a", 10, {
      type: "interaction_opened",
      interaction: {
        id: "semantic-question-1",
        kind: "question",
        title: "Choose",
        prompt: "Which release lane should run?",
        fields: [{
          id: "lane",
          kind: "text",
          label: "Release lane",
          description: "Enter the deployment lane",
          required: true,
          multiline: false,
          sensitive: false
        }]
      }
    });
    appendMessage(fixture.store, "semantic-plan", "session-a", 20, {
      type: "interaction_opened",
      interaction: {
        id: "semantic-plan-1",
        kind: "plan_review",
        title: "Plan",
        markdown: "Validate staging and deploy the canary.",
        choices: ["execute", "stay"]
      }
    });
    appendMessage(fixture.store, "semantic-permission", "session-a", 30, {
      type: "interaction_opened",
      interaction: {
        id: "semantic-permission-1",
        kind: "permission",
        title: "Permission",
        toolName: "write",
        summary: "must not become an embedding job",
        risk: "medium",
        choices: ["allow", "deny"]
      }
    });

    const jobs = fixture.store.claimMessageEmbeddingJobs(8, 40);
    expect(jobs.map((job) => job.eventId)).toEqual(["semantic-question", "semantic-plan"]);
    expect(jobs[0]?.text).toBe([
      "Which release lane should run?",
      "Release lane",
      "Enter the deployment lane"
    ].join("\n"));
    expect(jobs[1]?.text).toBe("Validate staging and deploy the canary.");
  });

  it("keeps the first enable cutoff, skips ineligible jobs, and fences recovered claims", () => {
    const fixture = createFixture();
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    appendMessage(fixture.store, "event-before-disable", "session-a", 10, visible("accepted before disable"));

    fixture.store.setMessageEmbeddingEnabled(false);
    appendMessage(fixture.store, "event-while-disabled", "session-a", 20, visible("must never backfill"));
    const [accepted] = fixture.store.claimMessageEmbeddingJobs(8, 30);
    expect(accepted?.eventId).toBe("event-before-disable");
    fixture.store.completeMessageEmbeddingJob(
      accepted!.eventCursor,
      accepted!.claimToken,
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4",
      embedding(0),
      31
    );

    fixture.store.setMessageEmbeddingEnabled(true);
    appendMessage(fixture.store, "event-after-reenable", "session-a", 40, visible("accepted after re-enable"));
    appendMessage(fixture.store, "event-no-visible-text", "session-a", 41, {
      type: "message_complete",
      role: "assistant",
      blocks: [{ kind: "thinking", text: "not visible", redacted: true }]
    });
    appendMessage(fixture.store, "event-too-large", "session-a", 42, visible("x".repeat(31 * 1024)));
    expect(fixture.store.pruneUnembeddableMessageEmbeddingJobs()).toBe(2);
    const [firstClaim] = fixture.store.claimMessageEmbeddingJobs(1, 50);
    expect(firstClaim?.eventId).toBe("event-after-reenable");
    expect(fixture.store.recoverMessageEmbeddingJobs(50 + 59_999)).toBe(0);
    expect(fixture.store.recoverMessageEmbeddingJobs(50 + 60_000)).toBe(1);
    const [recovered] = fixture.store.claimMessageEmbeddingJobs(1, 50 + 60_001);
    expect(recovered?.claimToken).not.toBe(firstClaim?.claimToken);
    expect(() => fixture.store.completeMessageEmbeddingJob(
      firstClaim!.eventCursor,
      firstClaim!.claimToken,
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4",
      embedding(0)
    )).toThrow(/not running/u);
    fixture.store.completeMessageEmbeddingJob(
      recovered!.eventCursor,
      recovered!.claimToken,
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4",
      embedding(0)
    );
    expect(fixture.store.messageEmbeddingStatus()).toEqual(expect.objectContaining({
      pendingCount: 0,
      runningCount: 0,
      doneCount: 2
    }));
    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "must never backfill"
    }).matches.map((match) => match.eventId)).toEqual(["event-while-disabled"]);
  });

  it("invalidates and rebuilds every vector when a pinned Provider generation changes", () => {
    const fixture = createFixture();
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    appendMessage(fixture.store, "event-old-generation", "session-a", 10, visible("old generation vector"));
    const [completed] = fixture.store.claimMessageEmbeddingJobs(1, 20);
    fixture.store.completeMessageEmbeddingJob(
      completed!.eventCursor,
      completed!.claimToken,
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4",
      embedding(0),
      21
    );
    appendMessage(fixture.store, "event-stale-claim", "session-a", 30, visible("stale claimant vector"));
    const [stale] = fixture.store.claimMessageEmbeddingJobs(1, 40);

    const nextGeneration = "embedding-generation-2";
    const rebound = fixture.store.bindMessageEmbeddingProvider("embedding-provider", nextGeneration);
    expect(rebound).toEqual(expect.objectContaining({
      providerId: "embedding-provider",
      providerGenerationId: nextGeneration,
      pendingCount: 2,
      runningCount: 0,
      doneCount: 0
    }));
    expect(fixture.store.hasMessageEmbeddings(
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4"
    )).toBe(false);
    expect(() => fixture.store.completeMessageEmbeddingJob(
      stale!.eventCursor,
      stale!.claimToken,
      "embedding-provider",
      EMBEDDING_GENERATION_ID,
      "voyage/voyage-4",
      embedding(1)
    )).toThrow(/not running/u);

    const rebuilt = fixture.store.claimMessageEmbeddingJobs(8, 50);
    expect(rebuilt.map((job) => job.eventId)).toEqual([
      "event-old-generation",
      "event-stale-claim"
    ]);
    for (const [index, job] of rebuilt.entries()) {
      fixture.store.completeMessageEmbeddingJob(
        job.eventCursor,
        job.claimToken,
        "embedding-provider",
        nextGeneration,
        "voyage/voyage-4",
        embedding(index === 0 ? 0 : 1),
        51 + index
      );
    }
    expect(fixture.store.hasMessageEmbeddings(
      "embedding-provider",
      nextGeneration,
      "voyage/voyage-4"
    )).toBe(true);
    const result = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "semantic-only",
      semantic: {
        providerId: "embedding-provider",
        providerGenerationId: nextGeneration,
        modelId: "voyage/voyage-4",
        queryEmbedding: embedding(0)
      }
    });
    expect(result.matches.map((match) => match.eventId)).toEqual(expect.arrayContaining([
      "event-old-generation",
      "event-stale-claim"
    ]));
  });

  it("keeps embedding failures credential-free, retryable, and outside a stable hybrid page", () => {
    const fixture = createFixture();
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    appendMessage(fixture.store, "event-retry", "session-a", 10, visible("retry vector message"));
    const [first] = fixture.store.claimMessageEmbeddingJobs(1, 20);
    expect(first).toBeDefined();
    fixture.store.failMessageEmbeddingJob(first!.eventCursor, first!.claimToken, "upstream sk-secret-that-must-not-persist", 21);
    expect(fixture.store.messageEmbeddingStatus().pendingCount).toBe(1);
    expect(fixture.store.claimMessageEmbeddingJobs(1, 1_020)).toEqual([]);
    const [retry] = fixture.store.claimMessageEmbeddingJobs(1, 1_021);
    expect(retry?.attempts).toBe(2);
    fixture.store.completeMessageEmbeddingJob(retry!.eventCursor, retry!.claimToken, "embedding-provider", EMBEDDING_GENERATION_ID, "voyage/voyage-4", embedding(0), 1_022);

    const firstPage = fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "retry",
      limit: 1,
      semantic: { providerId: "embedding-provider", providerGenerationId: EMBEDDING_GENERATION_ID, modelId: "voyage/voyage-4", queryEmbedding: embedding(0) }
    });
    expect(firstPage.matches).toHaveLength(1);
    expect(JSON.stringify(fixture.store.messageEmbeddingStatus())).not.toContain("sk-secret");
  });

  it("applies Session scope inside KNN before the candidate limit", () => {
    const fixture = createFixture();
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    appendMessage(fixture.store, "event-in-scope", "session-a", 10, visible("the scoped semantic result"));
    for (let index = 0; index < 6; index += 1) {
      appendMessage(fixture.store, `event-closer-${index}`, "session-b", 20 + index, visible(`closer out of scope ${index}`));
    }
    const jobs = fixture.store.claimMessageEmbeddingJobs(16, 100);
    for (const job of jobs) {
      fixture.store.completeMessageEmbeddingJob(
        job.eventCursor,
        job.claimToken,
        "embedding-provider",
        EMBEDDING_GENERATION_ID,
        "voyage/voyage-4",
        job.eventId === "event-in-scope" ? embedding(1) : embedding(0)
      );
    }
    const result = fixture.store.searchSessionMessages({
      scope: { sessionId: "session-a" },
      query: "deployment guidance",
      semantic: {
        providerId: "embedding-provider",
        providerGenerationId: EMBEDDING_GENERATION_ID,
        modelId: "voyage/voyage-4",
        queryEmbedding: embedding(0),
        poolLimit: 1
      }
    });
    expect(result.matches.map((match) => match.eventId)).toEqual(["event-in-scope"]);
    expect(result.poolCapped).toBe(false);
  });

  it("applies every structured filter before the hybrid arm pool despite more than 5x pool noise", { timeout: 60_000 }, () => {
    const fixture = createFixture();
    fixture.store.upsertBackend({
      id: "backend-filtered",
      displayName: "Filtered Backend",
      version: "test",
      health: "healthy",
      adapterKind: "fixture",
      instanceGeneration: 0,
      installationState: "installed",
      authenticationState: "not_required",
      capabilities: new Map(),
      models: [],
      tools: [],
      diagnostics: []
    });
    fixture.store.upsertTarget({
      id: "target-filtered",
      backendId: "backend-filtered",
      displayName: "target-filtered",
      workspaceRoot: "D:/workspace-filtered",
      managed: false,
      trusted: true
    });
    fixture.store.createSession({
      id: "session-filtered",
      backendId: "backend-filtered",
      targetId: "target-filtered",
      title: "session-filtered",
      binding: { opaqueRef: "session-filtered.jsonl", generation: 0 },
      pinned: false,
      archived: true,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 9_000,
      updatedAt: 9_000
    });
    fixture.store.setMessageEmbeddingEnabled(true);
    fixture.store.bindMessageEmbeddingProvider("embedding-provider", EMBEDDING_GENERATION_ID);
    for (let index = 0; index < 760; index += 1) {
      appendMessage(fixture.store, `event-noise-${index}`, "session-a", 100 + index, visible("needle"));
    }
    appendMessageTo(
      fixture.store,
      "event-filtered",
      "backend-filtered",
      "target-filtered",
      "session-filtered",
      10_000,
      visible("needle selected result with deliberately weaker lexical and vector ranks")
    );
    for (;;) {
      const jobs = fixture.store.claimMessageEmbeddingJobs(64, 20_000);
      if (jobs.length === 0) break;
      for (const job of jobs) {
        fixture.store.completeMessageEmbeddingJob(
          job.eventCursor,
          job.claimToken,
          "embedding-provider",
          EMBEDDING_GENERATION_ID,
          "voyage/voyage-4",
          job.eventId === "event-filtered" ? embedding(1) : embedding(0),
          20_001
        );
      }
    }

    const semantic = {
      providerId: "embedding-provider",
      providerGenerationId: EMBEDDING_GENERATION_ID,
      modelId: "voyage/voyage-4",
      queryEmbedding: embedding(0)
    } as const;
    for (const filters of [
      { targetIds: ["target-filtered"] },
      { sessionIds: ["session-filtered"] },
      { backendIds: ["backend-filtered"] },
      { sessionStatus: "archived" as const },
      { sessionActivityFrom: 9_000 },
      { messageCreatedFrom: 9_000, messageCreatedBefore: 11_000 },
      {
        targetIds: ["target-filtered"],
        sessionIds: ["session-filtered"],
        backendIds: ["backend-filtered"],
        sessionStatus: "archived" as const,
        sessionActivityFrom: 9_000,
        messageCreatedFrom: 9_000,
        messageCreatedBefore: 11_000
      }
    ]) {
      const result = fixture.store.searchSessionMessages({
        scope: { owner: true },
        query: "needle",
        filters,
        semantic
      });
      expect(result.matches.map((match) => match.eventId)).toEqual(["event-filtered"]);
      expect(result.vectorUsed).toBe(true);
      expect(result.poolCapped).toBe(false);
    }
    expect(fixture.store.searchSessionMessages({
      scope: { owner: true },
      query: "needle",
      filters: { sessionIds: [] },
      semantic
    }).matches).toEqual([]);
  });

  it("atomically tombstones deleted messages, excludes every read model, and fences context rebuild", () => {
    const fixture = createFixture();
    appendMessage(fixture.store, "delete-user", "session-a", 10, {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "keep the user row" }]
    });
    appendMessage(fixture.store, "delete-assistant", "session-a", 20, visible("remove secret answer marker"));
    appendMessage(fixture.store, "delete-tool", "session-a", 21, {
      type: "tool_result",
      callId: "delete-call",
      name: "search",
      output: "remove tool marker",
      isError: false
    });
    const execution = fixture.store.runOperation(
      { id: "delete-operation", kind: "delete_session_message", body: { sessionId: "session-a", eventId: "delete-assistant" } },
      (store) => store.commitMessageDeletion({
        sessionId: "session-a",
        requestedEventId: "delete-assistant",
        deletedEventIds: ["delete-assistant", "delete-tool"],
        operationId: "delete-operation",
        traceId: "test:message-delete"
      })
    );

    expect(execution.value.event.payload).toEqual({
      type: "message_deleted",
      requestedEventId: "delete-assistant",
      deletedEventIds: ["delete-assistant", "delete-tool"]
    });
    expect(fixture.store.findEvent("delete-assistant")).toBeUndefined();
    expect(fixture.store.findEvent("delete-assistant", { includeTombstoned: true })?.id).toBe("delete-assistant");
    expect(fixture.store.listEvents({ sessionId: "session-a" }).map((event) => event.id)).toContain("delete-user");
    expect(fixture.store.listEvents({ sessionId: "session-a" }).map((event) => event.id)).not.toContain("delete-assistant");
    expect(fixture.store.listEvents({ sessionId: "session-a", includeTombstoned: true }).map((event) => event.id))
      .toEqual(expect.arrayContaining(["delete-assistant", "delete-tool"]));
    expect(() => fixture.store.listEventsAround("session-a", "delete-assistant", 5)).toThrow();
    expect(fixture.store.searchSessionMessages({ scope: { sessionId: "session-a" }, query: "secret answer marker" }).matches)
      .toEqual([]);

    const pending = fixture.store.findPendingContextRebuild("session-a");
    expect(pending).toMatchObject({
      latestDeletionOperationId: "delete-operation",
      sourceNativeOpaqueRef: "session-a.jsonl",
      state: "pending"
    });
    expect(JSON.stringify(pending, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("secret answer marker");
    const claim = fixture.store.claimPendingContextRebuild("session-a");
    expect(claim).toMatchObject({ state: "running", sourceNativeOpaqueRef: "session-a.jsonl" });
    expect(fixture.store.releasePendingContextRebuild("session-a", claim!.claimToken)).toBe(true);
    const reclaimed = fixture.store.claimPendingContextRebuild("session-a")!;
    const updated = fixture.store.completePendingContextRebuild({
      sessionId: "session-a",
      claimToken: reclaimed.claimToken,
      binding: { opaqueRef: "session-a-rebuilt.jsonl", nativeSessionId: "rebuilt-native", generation: 1 },
      operationId: "delete-operation",
      traceId: "test:message-delete:rebuild"
    });
    expect(updated.descriptor.binding).toEqual({
      opaqueRef: "session-a-rebuilt.jsonl",
      nativeSessionId: "rebuilt-native",
      generation: 1
    });
    expect(fixture.store.findPendingContextRebuild("session-a")).toBeUndefined();
    expect(fixture.store.findLatestNativeSessionChange("session-a")?.payload).toMatchObject({
      type: "native_session_changed",
      opaqueRef: "session-a-rebuilt.jsonl"
    });
  });

  it("rolls message deletion back when any requested event is not visible in the task", () => {
    const fixture = createFixture();
    appendMessage(fixture.store, "delete-valid", "session-a", 10, visible("still visible after rollback"));
    appendMessage(fixture.store, "delete-foreign", "session-b", 20, visible("foreign row"));
    expect(() => fixture.store.runOperation(
      { id: "delete-invalid-operation", kind: "delete_session_message", body: {} },
      (store) => store.commitMessageDeletion({
        sessionId: "session-a",
        requestedEventId: "delete-valid",
        deletedEventIds: ["delete-valid", "delete-foreign"],
        operationId: "delete-invalid-operation",
        traceId: "test:message-delete:invalid"
      })
    )).toThrow();
    expect(fixture.store.findEvent("delete-valid")?.id).toBe("delete-valid");
    expect(fixture.store.findPendingContextRebuild("session-a")).toBeUndefined();
    expect(fixture.store.searchSessionMessages({ scope: { sessionId: "session-a" }, query: "still visible" }).matches)
      .toHaveLength(1);
  });

  it("durably fences an unhealthy native context without storing its input and atomically replaces the binding", () => {
    const fixture = createFixture();
    const sourceError = {
      code: "CONTEXT_OVERFLOW",
      message: "The provider rejected the context window.",
      phase: "stream",
      retryable: false,
      stateMayHaveChanged: true,
      recovery: "Replace the native context before retrying."
    } as const;
    fixture.store.runOperation(
      { id: "overflow-operation", kind: "send_input", body: { sessionId: "session-a" } },
      (store) => {
        store.createRun({
          id: "overflow-run",
          sessionId: "session-a",
          source: "user",
          state: "queued",
          createdAt: 100
        });
        store.createAttempt({
          id: "overflow-attempt",
          runId: "overflow-run",
          ordinal: 1,
          generation: 0,
          startedAt: 100
        });
        store.enqueueQueueItem({
          id: "overflow-queue",
          sessionId: "session-a",
          runId: "overflow-run",
          attemptId: "overflow-attempt",
          operationId: "overflow-operation",
          disposition: "prompt",
          body: {
            text: "failed source input marker",
            images: [],
            files: [],
            mentions: [],
            disposition: "prompt"
          },
          createdAt: 100
        });
        expect(store.claimNextQueueItem({
          sessionId: "session-a",
          backendInstanceGeneration: 0,
          traceId: "overflow:dispatch"
        })?.id)
          .toBe("overflow-queue");
        store.updateQueueState({
          queueItemId: "overflow-queue",
          state: "dispatch_unknown",
          attemptId: "overflow-attempt",
          error: sourceError,
          traceId: "overflow:unknown"
        });
        store.updateRunState({
          runId: "overflow-run",
          state: "dispatch_unknown",
          activeAttemptId: "overflow-attempt",
          error: sourceError,
          traceId: "overflow:run-unknown",
          operationId: "overflow-operation"
        });
        store.armPendingContextRebuild({
          sessionId: "session-a",
          reason: "context_overflow",
          operationId: "overflow-operation",
          sourceRunId: "overflow-run",
          sourceQueueItemId: "overflow-queue",
          sourceInputPending: true,
          replaySafe: true,
          at: 110
        });
        return { armed: true };
      }
    );

    const pending = fixture.store.findPendingContextRebuild("session-a");
    expect(pending).toMatchObject({
      reason: "context_overflow",
      sourceRunId: "overflow-run",
      sourceQueueItemId: "overflow-queue",
      sourceInputPending: true,
      replaySafe: true,
      state: "pending"
    });
    expect(JSON.stringify(pending, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("failed source input marker");

    const abandonedClaim = fixture.store.claimPendingContextRebuild("session-a")!;
    expect(abandonedClaim.state).toBe("running");
    expect(fixture.store.recoverPendingContextRebuilds(115)).toBe(1);
    const recovered = fixture.store.findPendingContextRebuild("session-a");
    expect(recovered).toMatchObject({ state: "pending" });
    expect(recovered?.claimToken).toBeUndefined();
    expect(recovered?.claimedAt).toBeUndefined();
    const claim = fixture.store.claimPendingContextRebuild("session-a")!;
    const updated = fixture.store.completePendingContextRebuild({
      sessionId: "session-a",
      claimToken: claim.claimToken,
      binding: { opaqueRef: "session-a-overflow-rebuilt.jsonl", nativeSessionId: "overflow-rebuilt", generation: 1 },
      operationId: "overflow-operation",
      handoff: "[JOKO SAFE CONTEXT HANDOFF]\nSurviving context only.",
      replayScheduled: true,
      traceId: "overflow:rebuild",
      at: 120
    });
    expect(updated.descriptor.binding).toMatchObject({
      opaqueRef: "session-a-overflow-rebuilt.jsonl",
      generation: 1
    });
    expect(fixture.store.getQueueItem("overflow-queue")).toMatchObject({
      state: "failed",
      error: { code: "NATIVE_CONTEXT_REPLACED", stateMayHaveChanged: false }
    });
    expect(fixture.store.getRun("overflow-run").descriptor).toMatchObject({
      state: "failed",
      error: { code: "NATIVE_CONTEXT_REPLACED" }
    });
    expect(fixture.store.findPendingContextRebuild("session-a")).toBeUndefined();
    expect(fixture.store.listEvents({ sessionId: "session-a" }).find((event) =>
      event.payload.type === "context_rebuild"
    )?.payload).toEqual({
      type: "context_rebuild",
      reason: "context_overflow",
      handoff: "[JOKO SAFE CONTEXT HANDOFF]\nSurviving context only.",
      sourceRunId: "overflow-run",
      replayScheduled: true
    });
  });

  it("atomically resets a Session boundary while preserving append-only audit rows", () => {
    const fixture = createFixture();
    appendMessage(fixture.store, "reset-old-message", "session-a", 10, visible("pre clear marker"));
    fixture.store.createRun({
      id: "reset-old-run",
      sessionId: "session-a",
      source: "user",
      state: "failed",
      createdAt: 20,
      endedAt: 21,
      error: {
        code: "OLD_FAILURE",
        message: "old failure",
        phase: "test",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "retry"
      }
    });
    fixture.store.setSetting("session", "session-a", "runtime.backend.materialized_state", { old: true });
    fixture.store.setSetting("session", "session-a", "user.preference", { keep: true });
    const source = fixture.store.getSession("session-a").descriptor.binding;
    const execution = fixture.store.runOperation(
      { id: "reset-operation", kind: "reset_session", body: { sessionId: "session-a" } },
      (store) => store.commitSessionReset({
        sessionId: "session-a",
        sourceBinding: source,
        binding: {
          opaqueRef: "session-a-empty.jsonl",
          nativeSessionId: "native-empty",
          generation: source.generation + 1
        },
        operationId: "reset-operation",
        traceId: "test:session-reset",
        at: 100
      })
    );

    expect(execution.value.event.payload).toEqual({ type: "session_reset" });
    expect(fixture.store.getSession("session-a").descriptor.binding).toEqual({
      opaqueRef: "session-a-empty.jsonl",
      nativeSessionId: "native-empty",
      generation: 1
    });
    expect(fixture.store.listEvents({ sessionId: "session-a" }).map((event) => event.payload.type))
      .toEqual(["session_reset", "session_attention"]);
    expect(fixture.store.listEvents({ sessionId: "session-a", includeTombstoned: true }).map((event) => event.id))
      .toEqual(expect.arrayContaining(["reset-old-message", execution.value.event.id]));
    expect(fixture.store.searchSessionMessages({ scope: { sessionId: "session-a" }, query: "pre clear marker" }).matches)
      .toEqual([]);
    expect(fixture.store.listRuns({ sessionId: "session-a" })).toEqual([]);
    expect(fixture.store.listRuns({ sessionId: "session-a", includeCleared: true }).map((run) => run.descriptor.id))
      .toContain("reset-old-run");
    expect(fixture.store.findSetting("session", "session-a", "runtime.backend.materialized_state")).toBeUndefined();
    expect(fixture.store.getSetting("session", "session-a", "user.preference").value).toEqual({ keep: true });

    appendMessage(fixture.store, "reset-new-message", "session-a", 110, visible("post clear marker"));
    fixture.store.createRun({
      id: "reset-new-run",
      sessionId: "session-a",
      source: "user",
      state: "completed",
      createdAt: 110,
      endedAt: 111
    });
    expect(fixture.store.listRuns({ sessionId: "session-a" }).map((run) => run.descriptor.id))
      .toEqual(["reset-new-run"]);
    expect(fixture.store.searchSessionMessages({ scope: { sessionId: "session-a" }, query: "post clear marker" }).matches)
      .toEqual([expect.objectContaining({ eventId: "reset-new-message" })]);
  });

});

function visible(text: string): EventPayload {
  return { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text }] };
}

function embedding(axis: 0 | 1): number[] {
  return Array.from({ length: 1024 }, (_, index) => index === axis ? 1 : 0);
}

function slopedEmbedding(slope: number): number[] {
  return Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : index === 1 ? slope : 0);
}

function diagnosticPi(entryId: string): PiEventMetadata {
  return {
    rpcEventType: "message_end",
    entryId,
    payload: {
      case: "diagnostic",
      value: { command: "unknown", nativeEventType: "message_end" }
    }
  };
}

function appendMessage(
  store: OperationalStore,
  id: string,
  sessionId: "session-a" | "session-b" | "session-c",
  emittedAt: number,
  payload: EventPayload,
  pi?: PiEventMetadata
): void {
  appendMessageTo(
    store,
    id,
    "pi",
    sessionId === "session-c" ? "target-b" : "target-a",
    sessionId,
    emittedAt,
    payload,
    pi
  );
}

function appendMessageTo(
  store: OperationalStore,
  id: string,
  backendId: string,
  targetId: string,
  sessionId: string,
  emittedAt: number,
  payload: EventPayload,
  pi?: PiEventMetadata
): void {
  const nativeHistory = nativeHistoryEventContext(payload);
  store.appendEvent({
    id,
    backendId,
    targetId,
    sessionId,
    generation: store.getSession(sessionId).descriptor.binding.generation,
    emittedAt,
    traceId: `message-search:${id}`,
    payload,
    ...(nativeHistory?.identity === undefined
      ? {}
      : {
          metadata: {
            namespace: "test.native_history",
            fields: {
              [NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD]: `sha256:${createHash("sha256")
                .update(store.getSession(sessionId).descriptor.binding.opaqueRef)
                .digest("hex")}`
            }
          }
        }),
    ...(pi === undefined ? {} : { pi })
  });
}

function createFixture(): { readonly store: OperationalStore } {
  const database = createDatabase();
  const store = database.open();
  seedFixture(store);
  return { store };
}

function seedFixture(store: OperationalStore): void {
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "not_required",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  for (const target of [
    { id: "target-a", root: "D:/workspace-a" },
    { id: "target-b", root: "D:/workspace-b" }
  ] as const) {
    store.upsertTarget({
      id: target.id,
      backendId: "pi",
      displayName: target.id,
      workspaceRoot: target.root,
      managed: false,
      trusted: true
    });
  }
  for (const session of [
    { id: "session-a", targetId: "target-a" },
    { id: "session-b", targetId: "target-a" },
    { id: "session-c", targetId: "target-b" }
  ] as const) {
    store.createSession({
      id: session.id,
      backendId: "pi",
      targetId: session.targetId,
      title: session.id,
      binding: { opaqueRef: `${session.id}.jsonl`, generation: 0 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
  }
}

function createDatabase(): {
  readonly filePath: string;
  readonly open: () => OperationalStore;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-message-search-"));
  const filePath = path.join(directory, "operational.sqlite");
  const stores: OperationalStore[] = [];
  cleanups.push(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    filePath,
    open: () => {
      const store = new OperationalStore(filePath);
      stores.push(store);
      return store;
    }
  };
}
