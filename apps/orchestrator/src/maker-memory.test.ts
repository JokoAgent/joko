import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import path from "node:path";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MakerMemoryBridgeProvider, MakerMemoryController } from "./maker-memory.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("MakerMemoryController", () => {
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

    expect(memory.snapshot([
      { backendId: "memory-capable", role: "compaction_digest" },
      { backendId: "another-memory", role: "compaction_digest" }
    ]).backendEntryCount).toEqual({ "memory-capable": 1, "another-memory": 1 });
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

  it("injects only curated workspace memory into a bounded future-runtime prompt", () => {
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
    await memory.update({ makerEnabled: false });
    expect(memory.available).toBe(false);
    expect(memory.enabledForBackend("another-memory")).toBe(false);
    expect(refreshed).toHaveBeenCalledTimes(2);
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

function createFixture(onSettingsChanged?: () => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-orchestrator-memory-"));
  const store = new OperationalStore(path.join(directory, "orchestrator.db"));
  for (const id of ["workspace-adapter", "memory-capable", "another-memory"]) {
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
