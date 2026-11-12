import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MakerMemoryBridgeProvider, MakerMemoryController } from "./maker-memory.js";
import type { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import type { BridgeToolCallContext } from "./mcp-router.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("MakerMemoryController", () => {
  it("consolidates exact same-Target sources, updates search and records the learning receipt only once", async () => {
    const { store, memory } = createFixture();
    const target = { type: "project", name: "merged-policy", title: "Merged policy", description: "Project policy", body: "durablepolicy" };
    const previous = memory.write("target-a", { ...target, kind: "project", body: "previouspolicy" });
    const source = memory.write("target-a", { ...target, kind: "project", name: "obsolete-policy", body: "obsoletecitation" });
    const olderSources = Array.from({ length: 20 }, (_, index) => memory.write("target-a", {
      ...target, kind: "project", name: `older-policy-${index}`, description: "Old policy detail. ".repeat(10).trim()
    }).id);
    const other = memory.write("target-b", { ...target, kind: "project", body: "foreignpolicy" });
    expect(memory.search("target-a", "obsoletecitation")).toHaveLength(1);
    expect(memory.writeWarning(previous)?.kind).toBe("index-size-exceeded");
    const recordSaved = vi.fn();
    const approve = vi.fn(async () => undefined);
    const provider = new MakerMemoryBridgeProvider(memory);
    const context = { ...maintenanceContext("merge"), partnerLearningSave: { recordSaved },
      memoryMaintenance: { sourceOperationId: "send-input-a", authorize: approve } };
    const request = { sources: [previous.id, source.id, source.id, "missing-source", ...olderSources], target };
    const receipt = await provider.callTool("memory_consolidate", request, undefined, context);
    expect(receipt.structuredContent).toEqual({
      entryId: previous.id, deletedSources: [source.id, ...olderSources], operation_id: "mcp-memory:merge"
    });
    expect(memory.read("target-a", previous.id).body).toBe("durablepolicy");
    expect(memory.search("target-a", "obsoletecitation")).toEqual([]);
    expect(memory.search("target-a", "durablepolicy")).toHaveLength(1);
    expect(memory.read("target-b", other.id)).toEqual(other);
    const adopted = memory.read("target-a", previous.id);
    await expect(provider.callTool("memory_consolidate", request, undefined, context)).resolves.toEqual(receipt);
    expect(memory.read("target-a", previous.id)).toEqual(adopted);
    expect(recordSaved).toHaveBeenCalledExactlyOnceWith(store, { kind: "memory", entryId: previous.id, title: "Merged policy", action: "updated" });
    expect(approve).toHaveBeenCalledOnce();
    await expect(provider.callTool("memory_consolidate", { ...request, target: { ...target, body: "changed" } }, undefined,
      { ...context, requestBodyHash: "changed-merge-body" })).rejects.toThrow();
    expect(memory.read("target-a", previous.id)).toEqual(adopted);
    expect(store.getOperation("mcp-memory:merge")).toMatchObject({ status: "completed", response: {
      entryId: previous.id, deletedSources: [source.id, ...olderSources]
    } });
  });

  it("rejects foreign and digest sources, and rolls back the target, source and FTS on a failed commit", async () => {
    const { memory, store } = createFixture();
    const target = { type: "project", name: "merged-policy", title: "Merged policy", description: "Project policy", body: "proposedpolicy" };
    const source = memory.write("target-a", { ...target, kind: "project", name: "source", body: "originalsource" });
    const foreign = memory.write("target-b", { ...target, kind: "project" });
    memory.writeCompactionDigest({ backendId: "memory-capable", targetId: "target-a", sessionId: "session-a",
      summary: "The private digest stays in its own scope.", reason: "manual" });
    const digest = memory.list("target-a", "digest")[0]!;
    const provider = new MakerMemoryBridgeProvider(memory);
    for (const bad of [foreign.id, digest.id]) {
      await expect(provider.callTool("memory_consolidate", { sources: [source.id, bad], target }, undefined,
        maintenanceContext(`bad-${bad}`))).rejects.toThrow(/curated memory entry in this workspace/u);
    }
    await expect(provider.callTool("memory_consolidate", { sources: [source.id], target }, undefined, {
      ...maintenanceContext("rollback"),
      partnerLearningSave: { recordSaved: () => { throw new Error("The original learning owner retired."); } }
    })).rejects.toThrow(/learning owner retired/u);
    expect(memory.list("target-a", "project")).toEqual([source]);
    expect(memory.read("target-a", digest.id)).toEqual(digest);
    expect(memory.search("target-a", "originalsource")).toHaveLength(1);
    expect(memory.search("target-a", "proposedpolicy")).toHaveLength(0);
    expect(store.getOperation("mcp-memory:rollback")).toMatchObject({ status: "failed", error: { stateMayHaveChanged: false } });
  });

  it("reviews the complete curated scope through one auxiliary plan, returns advice and replays without another request", async () => {
    const { memory, store } = createFixture();
    const input = { kind: "project", name: "workspace-policy", title: "Policy", description: "Index text", body: "workspacepolicy" } as const;
    const first = memory.write("target-a", input);
    const second = memory.write("target-a", { ...input, kind: "feedback", name: "feedback", body: "redact-me" });
    memory.write("target-b", { ...input, body: "foreignmemory" });
    memory.writeCompactionDigest({ backendId: "memory-capable", targetId: "target-a", sessionId: "session-a",
      summary: "privatecompactiondigest", reason: "manual" });
    const before = memory.list("target-a");
    const { provider, run, capture } = reviewFixture(memory);
    const call = () => provider.callTool("memory_review", {}, undefined, maintenanceContext("review"));
    const review = await call();
    expect(review.structuredContent).toEqual({ suggestions: "Review the project policy.", operation_id: "mcp-memory:review" });
    expect(await call()).toEqual(review);
    expect(capture).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    const request = run.mock.calls[0]![1];
    expect(request).toMatchObject({ maxTokens: 800, stopOnUnknownOutcome: true });
    expect(request.user).toContain(first.id);
    expect(request.user).toContain(second.id);
    expect(request.user).toContain("[redacted]");
    expect(request.user).not.toMatch(/redact-me|foreignmemory|privatecompactiondigest/u);
    expect(memory.list("target-a")).toEqual(before);
    expect(store.getOperation("mcp-memory:review")).toMatchObject({ status: "completed" });
  });

  it("replays an empty review, fences late results and records the original unknown request", async () => {
    const { memory, store } = createFixture();
    const { provider, run } = reviewFixture(memory);
    const empty = () => provider.callTool("memory_review", {}, undefined, maintenanceContext("empty"));
    const receipt = await empty();
    expect(receipt.structuredContent).toMatchObject({ suggestions: "This workspace has no curated memories to review." });
    memory.write("target-a", { kind: "project", name: "entry", title: "Entry", description: "Description", body: "Project preference." });
    expect(await empty()).toEqual(receipt);
    expect(run).not.toHaveBeenCalled();
    run.mockImplementationOnce(async (_plan, request) => {
      expect(request.stillCurrent?.()).toBe(true);
      memory.write("target-a", { kind: "project", name: "entry", title: "Entry", description: "Description", body: "Revised preference.", mode: "update" });
      expect(request.stillCurrent?.()).toBe(false);
      return { status: "ok", text: "Stale review." };
    });
    const stale = () => provider.callTool("memory_review", {}, undefined, maintenanceContext("stale"));
    await expect(stale()).rejects.toMatchObject({ publicError: { code: "EFFECT_OUTCOME_UNKNOWN", stateMayHaveChanged: true } });
    await expect(stale()).rejects.toThrow(/mcp-memory:stale/u);
    expect(run).toHaveBeenCalledOnce();
    const failed = store.getOperation("mcp-memory:stale");
    expect(failed).toMatchObject({ status: "failed", error: { code: "EFFECT_OUTCOME_UNKNOWN" } });
    expect(failed.response).toBeUndefined();
  });

  it("uses capability-assigned Backend roles without recognizing Backend IDs", () => {
    const { store, memory } = createFixture();
    expect(memory.writeCompactionDigest({
      backendId: "memory-capable",
      targetId: "target-a",
      sessionId: "session-a",
      reason: "auto",
      summary: "Remember the alpha release discussion."
    })).toBe(true);
    expect(memory.writeCompactionDigest({
      backendId: "another-memory",
      targetId: "target-b",
      sessionId: "session-b",
      reason: "manual",
      summary: "Remember the beta release discussion."
    })).toBe(true);

    const snapshot = memory.snapshot([
      { backendId: "memory-capable", role: "compaction_digest" },
      { backendId: "another-memory", role: "compaction_digest" },
      { backendId: "native-memory", role: "native_auto_memory" },
      { backendId: "native-memory-default-off", role: "native_auto_memory", defaultEnabled: false }
    ]);
    expect(snapshot.backendEntryCount).toEqual({
      "memory-capable": 1,
      "another-memory": 1,
      "native-memory": 0,
      "native-memory-default-off": 0
    });
    expect(snapshot.backendEnabled).toEqual({
      "memory-capable": true,
      "another-memory": true,
      "native-memory": true,
      "native-memory-default-off": false
    });
    expect(memory.reset("backend", "memory-capable")).toEqual({ removedEntries: 1, removedTargets: 1 });
    expect(store.countMakerMemoryEntries("digest", "another-memory")).toBe(1);
  });

  it("resets curated Maker Memory across Targets without deleting Backend digests", () => {
    const { store, memory } = createFixture();
    for (const targetId of ["target-a", "target-b"]) {
      memory.write(targetId, {
        kind: "project",
        name: `project-${targetId}`,
        title: `Project ${targetId}`,
        description: "Curated project context",
        body: "Keep this workspace-specific project fact."
      });
    }
    memory.writeCompactionDigest({
      backendId: "memory-capable",
      targetId: "target-a",
      sessionId: "session-a",
      reason: "auto",
      summary: "Private compaction history that Maker reset must retain."
    });

    expect(memory.reset("curated")).toEqual({ removedEntries: 2, removedTargets: 2 });
    expect(store.countMakerMemoryEntries("project")).toBe(0);
    expect(store.countMakerMemoryEntries("digest", "memory-capable")).toBe(1);
  });

  it("injects only curated workspace memory into a future-runtime prompt", () => {
    const { memory } = createFixture();
    memory.write("target-a", {
      kind: "project",
      name: "release-policy",
      title: "Release policy",
      description: "Green verification is required",
      body: "Run verification before release."
    });
    memory.writeCompactionDigest({
      backendId: "memory-capable",
      targetId: "target-a",
      sessionId: "session-a",
      reason: "auto",
      summary: "SECRET-DIGEST-MARKER from a compacted conversation."
    });

    const prompt = memory.runtimePrompt("target-a")!;
    expect(prompt).toContain("Release policy");
    expect(prompt).not.toContain("SECRET-DIGEST-MARKER");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(12_000);
  });

  it("returns successful body-size warnings using the final UTF-8 append size and preserves the hard limit", async () => {
    const { memory } = createFixture();
    const bridge = new MakerMemoryBridgeProvider(memory);
    const context = { sessionId: "session-a", targetId: "target-a", generation: 0 };
    const base = { type: "project", name: "sized-entry", title: "Sized entry", description: "Size boundary" };
    const body = `${"界".repeat(682)}xx`;
    expect(Buffer.byteLength(body)).toBe(2_048);
    const exact = await bridge.callTool("memory_write", { ...base, body }, undefined, context);
    expect(exact.isError).toBe(false);
    expect(exact.structuredContent?.["warning"]).toBeUndefined();
    const appended = await bridge.callTool("memory_write", { ...base, mode: "append", body: "界" }, undefined, context);
    expect(appended.structuredContent).toMatchObject({ warning: "shard-size-exceeded", warningDetail: {
      kind: "shard-size-exceeded", sizeBytes: 2_053, softLimitBytes: 2_048, hardLimitBytes: 8_192
    } });
    const hard = "x".repeat(8_192);
    await bridge.callTool("memory_write", { ...base, mode: "update", body: hard }, undefined, context);
    await expect(bridge.callTool("memory_write", { ...base, mode: "append", body: "x" }, undefined, context)).rejects.toThrow();
    expect(memory.list("target-a")[0]?.body).toBe(hard);
  });

  it("keeps the complete curated index and reports its exact soft-limit excess without exposing digests or another Target", async () => {
    const { memory } = createFixture();
    const entries = Array.from({ length: 11 }, (_, index) => memory.write("target-a", {
      kind: "project", name: `index-${index}`, title: "标".repeat(33), description: "描".repeat(66), body: "Durable content."
    }));
    const last = memory.write("target-a", { kind: "project", name: "index-boundary", title: "T", description: "x", body: "Boundary." });
    const indexText = () => memory.runtimePrompt("target-a")!.slice(memory.runtimePrompt("target-a")!.indexOf("## Current index"));
    const extra = 4_096 - Buffer.byteLength(indexText());
    expect(extra).toBeGreaterThan(0); expect(extra).toBeLessThan(199);
    const bridge = new MakerMemoryBridgeProvider(memory);
    const context = { sessionId: "session-a", targetId: "target-a", generation: 0 };
    const input = { type: "project", name: last.slug, title: "T", body: "Boundary.", mode: "update", description: "x".repeat(extra + 1) };
    const exact = await bridge.callTool("memory_write", input, undefined, context);
    expect(Buffer.byteLength(indexText())).toBe(4_096);
    expect(exact.structuredContent?.["warning"]).toBeUndefined();
    const exceeded = await bridge.callTool("memory_write", { ...input, description: `${input.description}x` }, undefined, context);
    expect(exceeded.isError).toBe(false);
    expect(exceeded.structuredContent).toMatchObject({ warning: "index-size-exceeded", warningDetail: {
      kind: "index-size-exceeded", sizeBytes: 4_097, softLimitBytes: 4_096
    } });
    expect(exceeded.structuredContent?.["warningDetail"]).not.toHaveProperty("hardLimitBytes");
    memory.write("target-b", { kind: "project", name: "foreign", title: "FOREIGN-INDEX", description: "Other target", body: "Private." });
    memory.writeCompactionDigest({ targetId: "target-a", backendId: "memory-capable", sessionId: "digest", reason: "auto", summary: "PRIVATE-DIGEST" });
    const prompt = memory.runtimePrompt("target-a")!;
    for (const entry of [...entries, last]) expect(prompt).toContain(`(id: ${entry.id})`);
    expect(prompt.match(new RegExp("描".repeat(66), "gu"))).toHaveLength(11);
    expect(Buffer.byteLength(indexText())).toBe(4_097);
    expect(prompt).not.toContain("FOREIGN-INDEX"); expect(prompt).not.toContain("PRIVATE-DIGEST");
  });

  it("returns short native-script search hits through the original scoped memory tool", async () => {
    const { memory } = createFixture();
    const input = { kind: "project" as const, name: "boundary", title: "Boundary", description: "Searchable", body: "边界索引配置说明" };
    const entry = memory.write("target-a", input); memory.write("target-b", input);
    const result = await new MakerMemoryBridgeProvider(memory).callTool("memory_search", { query: "边界", type: "project" }, undefined,
      { sessionId: "session-a", targetId: "target-a", generation: 0 });
    expect(result.structuredContent?.["hits"]).toEqual([expect.objectContaining({ id: entry.id, targetId: "target-a" })]);
  });

  it("pages every workspace memory entry past the thousand-entry boundary", { timeout: 20_000 }, async () => {
    const { memory } = createFixture();
    for (let index = 0; index < 1_001; index += 1) {
      memory.write("target-a", {
        kind: "project",
        name: `paged-${index}`,
        title: `Paged ${index}`,
        description: `Durable entry ${index}`,
        body: `Workspace fact ${index}.`
      });
    }

    expect(memory.list("target-a")).toHaveLength(1_001);
    const result = await new MakerMemoryBridgeProvider(memory).callTool("memory_list", {}, undefined, {
      sessionId: "session-a",
      targetId: "target-a",
      generation: 0
    });
    expect((result.structuredContent?.["entries"] as readonly unknown[])).toHaveLength(1_001);
  });

  it("matches a memory query term after the former sixteen-token window", () => {
    const { memory } = createFixture();
    memory.write("target-a", {
      kind: "reference",
      name: "later-token",
      title: "Later token",
      description: "Searchable reference",
      body: "lateronlyterm"
    });
    const ignoredTerms = Array.from({ length: 16 }, (_, index) => `absent${index + 1}`);
    expect(memory.search("target-a", [...ignoredTerms, "lateronlyterm"].join(" ")))
      .toEqual([expect.objectContaining({ title: "Later token" })]);
  });

  it("persists toggles before refreshing future generations and preserves active semantics", async () => {
    const refreshed = vi.fn(async () => undefined);
    const { memory } = createFixture(refreshed);

    await memory.update({ backendId: "memory-capable", backendEnabled: false });
    expect(memory.enabledForBackend("memory-capable")).toBe(false);
    expect(memory.enabledForBackend("another-memory")).toBe(true);
    expect(memory.nativeEnabledForBackend("native-memory")).toBe(false);
    expect(memory.nativeEnabledForBackend("codex-memory")).toBe(false);
    await memory.update({ makerEnabled: false });
    expect(memory.available).toBe(false);
    expect(memory.enabledForBackend("another-memory")).toBe(false);
    expect(memory.nativeEnabledForBackend("native-memory")).toBe(true);
    expect(memory.nativeEnabledForBackend("codex-memory")).toBe(true);
    await memory.update({ backendId: "codex-memory", backendEnabled: false });
    expect(memory.nativeEnabledForBackend("codex-memory")).toBe(false);
    await memory.update({ backendId: "native-memory", backendEnabled: false });
    expect(memory.nativeEnabledForBackend("native-memory")).toBe(false);
    expect(refreshed).toHaveBeenCalledTimes(4);
  });

  it("scopes bridge reads to the authenticated product Target", async () => {
    const { memory } = createFixture();
    const entry = memory.write("target-b", {
      kind: "user",
      name: "preference",
      title: "Private preference",
      description: "Only target B may read this",
      body: "Prefer target-B-specific behavior."
    });
    const provider = new MakerMemoryBridgeProvider(memory);

    await expect(provider.callTool("memory_read", { entry_id: entry.id }, undefined, {
      sessionId: "session-a",
      targetId: "target-a",
      generation: 0
    })).rejects.toThrow(/outside this workspace scope/u);
    await expect(provider.callTool("memory_read", { entry_id: entry.id }, undefined, {
      sessionId: "session-b",
      targetId: "target-b",
      generation: 0
    })).resolves.toMatchObject({ isError: false });
  });

  it("persists a digest from a previously enabled runtime while honoring a current Maker revocation", async () => {
    const { memory } = createFixture();
    const input = { backendId: "memory-capable", targetId: "target-a", sessionId: "session-a", reason: "manual", summary: "The original runtime produced this digest." };
    expect(memory.enabledForBackend(input.backendId)).toBe(true);
    await memory.update({ backendId: input.backendId, backendEnabled: false });
    expect(memory.enabledForBackend(input.backendId)).toBe(false);
    expect(memory.writeCompactionDigest(input)).toBe(true);
    expect(memory.search(input.targetId, "produced", "digest")).toHaveLength(1);

    await memory.update({ makerEnabled: false });
    expect(memory.writeCompactionDigest(input)).toBe(false);
  });

  it("rejects credential-shaped curated memory without storing or echoing it", () => {
    const { store, memory } = createFixture();
    expect(() => memory.write("target-a", {
      kind: "reference",
      name: "credential",
      title: "Provider credential",
      description: "Must never enter durable memory",
      body: "sk-abcdefghijklmnopqrstuvwxyz012345"
    })).toThrow(/credential-like content/u);
    expect(store.countMakerMemoryEntries()).toBe(0);
  });
});

function maintenanceContext(id: string): BridgeToolCallContext {
  return {
    sessionId: "session-a", targetId: "target-a", generation: 1, memoryMaintenance: { sourceOperationId: "send-input-a" },
    inputQueueItem: { id: "queue-a", runId: "run-a", attemptId: "attempt-a" },
    requestIdentity: id, requestBodyHash: `body-${id}`, assertCurrent: () => {}
  };
}

function reviewFixture(memory: MakerMemoryController) {
  const plan = { models: [], revision: 0n, runtimeRevision: "fixture-route" };
  const capture = vi.fn(() => plan);
  const run = vi.fn<AuxiliaryTextRouting["run"]>(async (_plan, input) => ({
    status: "ok", text: input.validate("  Review the project policy. ")!
  }));
  const provider = new MakerMemoryBridgeProvider(memory, {
    auxiliary: () => ({ capture, run, isCurrent: value => value === plan }),
    redact: text => text.replaceAll("redact-me", "[redacted]")
  });
  return { provider, run, capture };
}

function createFixture(onSettingsChanged?: () => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-orchestrator-memory-"));
  const store = new OperationalStore(path.join(directory, "orchestrator.db"));
  for (const id of ["workspace-adapter", "memory-capable", "another-memory", "native-memory"]) {
    store.upsertBackend({
      id,
      displayName: id,
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
  }
  for (const id of ["target-a", "target-b"]) {
    store.upsertTarget({
      id,
      backendId: "workspace-adapter",
      displayName: id,
      workspaceRoot: `D:/${id}`,
      managed: false,
      trusted: true
    });
  }
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, memory: new MakerMemoryController({ store, onSettingsChanged }) };
}
