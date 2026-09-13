import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("OperationalStore Maker Memory", () => {
  it("persists curated memory, searches it, and never returns digest in a curated listing", () => {
    const store = createStore();
    store.putMakerMemoryEntry({
      targetId: "target-1",
      kind: "project",
      slug: "release-policy",
      title: "Release policy",
      description: "Remember the workspace release gate",
      body: "All releases require a green verification run."
    });
    store.putMakerMemoryEntry({
      targetId: "target-1",
      kind: "digest",
      backendId: "memory-capable",
      slug: "digest-session-a",
      title: "Compaction digest",
      description: "Earlier private conversation summary",
      body: "The release policy was discussed before compaction."
    });

    expect(store.listMakerMemoryEntries({ targetId: "target-1" })).toHaveLength(2);
    expect(store.listMakerMemoryEntries({ targetId: "target-1", kind: "project" }))
      .toMatchObject([{ kind: "project" }]);
    expect("backendId" in store.listMakerMemoryEntries({ targetId: "target-1", kind: "project" })[0]!).toBe(false);
    expect(store.searchMakerMemory("target-1", "release policy").map((hit) => hit.kind).sort())
      .toEqual(["digest", "project"]);
  });

  it("isolates backend digest resets by capability-assigned backend ID", () => {
    const store = createStore();
    for (const [backendId, slug] of [["memory-capable", "digest-a"], ["another-memory", "digest-b"]] as const) {
      store.putMakerMemoryEntry({
        targetId: "target-1",
        kind: "digest",
        backendId,
        slug,
        title: `${backendId} digest`,
        description: "Private compression history",
        body: `Compression summary owned by ${backendId}.`
      });
    }
    store.putMakerMemoryEntry({
      targetId: "target-1",
      kind: "user",
      slug: "preference",
      title: "Preference",
      description: "Stable user preference",
      body: "Prefer concise status reports."
    });
    store.putMakerMemoryEntry({
      targetId: "target-2",
      kind: "reference",
      slug: "release-notes",
      title: "Release notes",
      description: "Stable cross-workspace reference",
      body: "Use the release handbook."
    });

    expect(store.resetMakerMemory("digest", "memory-capable"))
      .toEqual({ removedEntries: 1, removedTargets: 1 });
    expect(store.countMakerMemoryEntries("digest", "memory-capable")).toBe(0);
    expect(store.countMakerMemoryEntries("digest", "another-memory")).toBe(1);
    expect(store.countMakerMemoryEntries("user")).toBe(1);
    expect(store.resetMakerMemory("curated"))
      .toEqual({ removedEntries: 2, removedTargets: 2 });
    expect(store.countMakerMemoryEntries("user")).toBe(0);
    expect(store.countMakerMemoryEntries("reference")).toBe(0);
    expect(store.countMakerMemoryEntries("digest", "another-memory")).toBe(1);
  });

  it("rejects credential-shaped bytes before durable storage", () => {
    const store = createStore();
    expect(() => store.putMakerMemoryEntry({
      targetId: "target-1",
      kind: "reference",
      slug: "provider",
      title: "Provider",
      description: "Credential must not persist",
      body: "Bearer abcdefghijklmnopqrstuvwxyz"
    })).toThrow(/credential-like content/u);
    expect(store.countMakerMemoryEntries()).toBe(0);
  });

  it("requires Backend ownership exactly for system digests", () => {
    const store = createStore();
    expect(() => store.putMakerMemoryEntry({
      targetId: "target-1",
      kind: "digest",
      slug: "missing-owner",
      title: "Digest",
      description: "Missing Backend ownership",
      body: "No Backend ID was supplied."
    })).toThrow(/Backend ID is required/u);
    expect(() => store.putMakerMemoryEntry({
      targetId: "target-1",
      kind: "project",
      backendId: "memory-capable",
      slug: "wrong-owner",
      title: "Project",
      description: "Curated memory has no Backend owner",
      body: "This write must be rejected."
    })).toThrow(/Backend ID is required/u);
  });
});

function createStore(): OperationalStore {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-maker-memory-"));
  let nextId = 0;
  const store = new OperationalStore(path.join(directory, "operational.sqlite"), {
    idFactory: () => `memory-${++nextId}`,
    now: () => 1_000 + nextId
  });
  for (const id of ["workspace-adapter", "memory-capable", "another-memory"]) {
    store.upsertBackend({
      id,
      displayName: id,
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
  }
  for (const id of ["target-1", "target-2"]) {
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
  return store;
}
