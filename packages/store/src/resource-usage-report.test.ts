import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EventPayload, ResourceUsageEventPayload, ResourceUsageSource } from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore, StoreError } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("exact Resource usage projection", () => {
  it("builds a restart-stable local-calendar 30-day report and compares only sufficiently sampled adjacent versions", () => {
    const fixture = createFixture(Date.UTC(2026, 8, 14, 12));
    const market = {
      sourceId: "skill_market_source_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceRevision: "7",
      entryId: "skill_market_entry_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      entryRevision: "9",
      entryContentRevision: `sha256:${"2".repeat(64)}`,
      installedContentRevision: `sha256:${"2".repeat(64)}`
    };
    for (let index = 0; index < 5; index += 1) fixture.append({
      occurrenceId: `version-one-${index}`,
      entityRevision: "4",
      contentRevision: `sha256:${"1".repeat(64)}`,
      version: "1.0.0",
      source: "native_skill_command",
      activity: "strong_active",
      action: "command_succeeded"
    }, Date.UTC(2026, 7, 20 + index, 23));
    for (let index = 0; index < 5; index += 1) fixture.append({
      occurrenceId: `version-two-${index}`,
      entityRevision: "8",
      contentRevision: market.installedContentRevision,
      version: "2.0.0",
      market,
      source: "runtime_tool_call",
      activity: "strong_active",
      action: index === 4 ? "tool_failed" : "tool_succeeded"
    }, Date.UTC(2026, 8, 10 + index, 1));
    // An uncertain native retry may append another Event, but its stable
    // source/run occurrence contributes only one projected sample.
    fixture.append({
      occurrenceId: "version-two-4",
      entityRevision: "8",
      contentRevision: market.installedContentRevision,
      version: "2.0.0",
      market,
      source: "runtime_tool_call",
      activity: "strong_active",
      action: "tool_failed"
    }, Date.UTC(2026, 8, 14, 2));

    const query = {
      resourceId: "resource-skill",
      timeZone: "Asia/Shanghai",
      current: {
        entityRevision: "8",
        contentRevision: market.installedContentRevision,
        version: "2.0.0"
      }
    } as const;
    const report = fixture.store.getResourceUsageReport(query);
    expect(report).toMatchObject({
      fromDay: "2026-08-16",
      throughDay: "2026-09-14",
      totals: { samples: 10, strongActive: 10, commands: 5, toolCalls: 5, toolErrors: 1 },
      projection: { complete: true, streamCount: 2, pendingStreamCount: 0, failures: [] },
      comparison: {
        available: true,
        minimumSamples: 5,
        current: { identity: { version: "2.0.0" }, metrics: { samples: 5 } },
        previous: { identity: { version: "1.0.0" }, metrics: { samples: 5 } }
      }
    });
    expect(report.days).toHaveLength(30);
    expect(report.days[0]).toMatchObject({ localDay: "2026-08-16", metrics: { samples: 0 } });
    expect(report.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "native_skill_command", metrics: expect.objectContaining({ commands: 5 }) }),
      expect.objectContaining({ source: "runtime_tool_call", metrics: expect.objectContaining({ toolCalls: 5 }) })
    ]));
    expect(report.versions.find((value) => value.identity.version === "2.0.0")?.identity)
      .toMatchObject({ entityRevision: "8", contentRevision: market.installedContentRevision });

    fixture.reopen();
    expect(fixture.store.getResourceUsageReport(query)).toEqual(report);
  });

  it("does not skip an under-sampled adjacent version to compare with an older version", () => {
    const fixture = createFixture(Date.UTC(2026, 8, 14, 12));
    const versions = [
      { version: "1.0.0", revision: "1", content: `sha256:${"1".repeat(64)}`, samples: 5, day: 1 },
      { version: "1.1.0", revision: "2", content: `sha256:${"2".repeat(64)}`, samples: 2, day: 6 },
      { version: "2.0.0", revision: "3", content: `sha256:${"3".repeat(64)}`, samples: 5, day: 9 }
    ] as const;
    for (const value of versions) for (let index = 0; index < value.samples; index += 1) fixture.append({
      occurrenceId: `${value.version}-${index}`,
      entityRevision: value.revision,
      contentRevision: value.content,
      version: value.version,
      source: "runtime_confirmed_resource_load",
      activity: "passive",
      action: "exposure"
    }, Date.UTC(2026, 8, value.day, index));
    const comparison = fixture.store.getResourceUsageReport({
      resourceId: "resource-skill",
      timeZone: "UTC",
      current: { entityRevision: "3", contentRevision: versions[2].content, version: "2.0.0" }
    }).comparison;
    expect(comparison).toMatchObject({
      available: false,
      unavailableReason: "previous_samples",
      current: { identity: { version: "2.0.0" }, metrics: { samples: 5 } },
      previous: { identity: { version: "1.1.0" }, metrics: { samples: 2 } }
    });
  });

  it("retains the last verified stream projection, retries with backoff, and advances another session independently", () => {
    const fixture = createFixture(10_000, true);
    const first = fixture.append(command("first"), 1_000);
    const malformed = fixture.append(command("malformed"), 2_000);
    const independent = fixture.append(command("independent"), 3_000, "session-2", "run-2");
    fixture.store.close();
    const database = new DatabaseSync(fixture.path);
    database.prepare("DELETE FROM resource_usage_evidence WHERE event_cursor IN (?, ?)")
      .run(malformed.globalCursor, independent.globalCursor);
    database.prepare(`
      UPDATE resource_usage_projection_cursors SET last_event_cursor = ?, last_projected_at = 1000,
        failure_count = 0, retry_after = NULL, error_code = NULL
      WHERE session_id = 'session-1' AND source = 'native_skill_command'
    `).run(first.globalCursor);
    database.prepare(`
      UPDATE resource_usage_projection_cursors SET last_event_cursor = 0, last_projected_at = NULL,
        failure_count = 0, retry_after = NULL, error_code = NULL
      WHERE session_id = 'session-2' AND source = 'native_skill_command'
    `).run();
    database.prepare("UPDATE events SET payload_json = ? WHERE global_cursor = ?").run(JSON.stringify({
      payload: { type: "resource_usage", resourceId: "resource-skill", source: "native_skill_command" }
    }), malformed.globalCursor);
    database.close();
    fixture.reopen();

    const query = { resourceId: "resource-skill", timeZone: "UTC" } as const;
    const failed = fixture.store.getResourceUsageReport(query);
    expect(failed.totals.samples).toBe(2);
    expect(failed.projection).toMatchObject({
      complete: false,
      streamCount: 2,
      pendingStreamCount: 1,
      failures: [{ sessionId: "session-1", attempts: 1, errorCode: "RESOURCE_USAGE_PROJECTION_FAILED" }]
    });
    expect(fixture.store.getResourceUsageReport(query).projection.failures[0]?.attempts).toBe(1);

    fixture.setNow(12_000);
    fixture.store.close();
    const repair = new DatabaseSync(fixture.path);
    repair.prepare("UPDATE events SET payload_json = ? WHERE global_cursor = ?")
      .run(JSON.stringify({ payload: usage(command("malformed")) }), malformed.globalCursor);
    repair.close();
    fixture.reopen();
    expect(fixture.store.getResourceUsageReport(query)).toMatchObject({
      totals: { samples: 3 },
      projection: { complete: true, pendingStreamCount: 0, failures: [] }
    });
  });

  it("rejects incomplete, stale, widened, or activity-spoofed evidence before persistence", () => {
    const fixture = createFixture(10_000);
    const base = usage(command("invalid"));
    expect(() => fixture.store.appendEvent({
      backendId: "pi", targetId: "target-1", sessionId: "session-1",
      generation: 1, emittedAt: 10_000, traceId: "usage:missing-run", payload: base
    })).toThrow(/exact Event run/u);
    expect(() => fixture.store.appendEvent(fixture.event({ ...base, runtimeGeneration: 2 }))).toThrow(/runtime generation/u);
    expect(() => fixture.store.appendEvent(fixture.event({ ...base, activity: "passive" } as EventPayload))).toThrow(StoreError);
    expect(() => fixture.store.appendEvent(fixture.event({ ...base, prompt: "private" } as unknown as EventPayload))).toThrow(StoreError);
  });
});

function command(occurrenceId: string): Omit<ResourceUsageEventPayload, "type" | "resourceId" | "runtimeGeneration"> {
  return {
    occurrenceId,
    entityRevision: "1",
    contentRevision: `sha256:${"a".repeat(64)}`,
    version: "1.0.0",
    source: "native_skill_command",
    activity: "strong_active",
    action: "command_succeeded"
  };
}

function usage(value: Omit<ResourceUsageEventPayload, "type" | "resourceId" | "runtimeGeneration">): ResourceUsageEventPayload {
  return { type: "resource_usage", resourceId: "resource-skill", runtimeGeneration: 1, ...value };
}

function createFixture(initialNow: number, secondSession = false): {
  readonly path: string;
  readonly store: OperationalStore;
  setNow(value: number): void;
  reopen(): void;
  append(
    value: Omit<ResourceUsageEventPayload, "type" | "resourceId" | "runtimeGeneration">,
    emittedAt: number,
    sessionId?: string,
    runId?: string
  ): ReturnType<OperationalStore["appendEvent"]>;
  event(payload: EventPayload, runId?: string): Parameters<OperationalStore["appendEvent"]>[0];
} {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-resource-usage-"));
  const filePath = path.join(directory, "operational.sqlite");
  let now = initialNow;
  let store = new OperationalStore(filePath, { now: () => now });
  const seedSession = (sessionId: string, runId: string): void => {
    store.createSession({
      id: sessionId,
      backendId: "pi",
      targetId: "target-1",
      title: sessionId,
      binding: { opaqueRef: `native/${sessionId}.jsonl`, generation: 1 },
      pinned: false,
      archived: false,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: 1,
      updatedAt: 1
    });
    store.createRun({ id: runId, sessionId, source: "user", state: "running", createdAt: 2 });
  };
  store.upsertBackend({
    id: "pi", displayName: "Pi", version: "test", health: "healthy", adapterKind: "fixture",
    instanceGeneration: 0, installationState: "installed", authenticationState: "not_required",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  store.upsertTarget({
    id: "target-1", backendId: "pi", displayName: "Workspace", workspaceRoot: "D:/workspace",
    managed: false, trusted: true
  });
  seedSession("session-1", "run-1");
  if (secondSession) seedSession("session-2", "run-2");
  const fixture = {
    path: filePath,
    get store() { return store; },
    setNow(value: number) { now = value; },
    reopen() {
      store.close();
      store = new OperationalStore(filePath, { now: () => now });
    },
    append(
      value: Omit<ResourceUsageEventPayload, "type" | "resourceId" | "runtimeGeneration">,
      emittedAt: number,
      sessionId = "session-1",
      runId = "run-1"
    ) {
      return store.appendEvent({
        backendId: "pi", targetId: "target-1", sessionId, runId,
        generation: 1, emittedAt, traceId: `usage:${value.occurrenceId}`, payload: usage(value)
      });
    },
    event(payload: EventPayload, runId = "run-1") {
      return {
        backendId: "pi", targetId: "target-1", sessionId: "session-1",
        ...(runId === undefined ? {} : { runId }),
        generation: 1, emittedAt: now, traceId: "usage:invalid", payload
      };
    }
  };
  cleanups.push(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}
