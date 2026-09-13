import { expect, test, vi } from "vitest";
import {
  loadedClaudeTextResources,
  resolveClaudeResourceMention,
  snapshotClaudeTextResources,
  type ClaudeTextResourceSeed
} from "./resources.js";

test("copies approved text into an immutable generation and never projects private identity into prompt content", () => {
  let current = true;
  const assertCurrent = vi.fn(() => {
    if (!current) throw new Error("private authority failure");
  });
  const seed = {
    id: "resource-private-id",
    kind: "prompt" as const,
    name: "Release checklist",
    revision: "sha256:private-revision",
    resourceVersion: 12n,
    version: "2.0.0",
    content: "Check the release evidence.",
    assertCurrent
  };
  const snapshot = snapshotClaudeTextResources([seed], 9, new AbortController().signal);
  seed.content = "mutated source object";
  seed.assertCurrent = vi.fn(() => { throw new Error("mutated seed callback"); });

  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot[0])).toBe(true);
  expect(snapshot[0]!.content).toBe("Check the release evidence.");
  expect(loadedClaudeTextResources(snapshot)).toEqual([{
    id: seed.id,
    kind: "prompt",
    name: seed.name,
    source: "managed",
    state: "loaded",
    revision: seed.revision,
    resourceVersion: 12n,
    runtimeGeneration: 9,
    version: "2.0.0"
  }]);
  const resolved = resolveClaudeResourceMention({
    kind: "resource",
    label: "Release checklist",
    reference: seed.id,
    discoveredRevision: seed.revision,
    resourceVersion: "12",
    runtimeGeneration: 9
  }, snapshot);
  expect(resolved.text).toContain("Check the release evidence.");
  expect(resolved.text).toContain(JSON.stringify(seed.name));
  expect(resolved.text).not.toContain(seed.id);
  expect(resolved.text).not.toContain(seed.revision);

  current = false;
  expect(loadedClaudeTextResources(snapshot)).toEqual([]);
  expect(thrown(resolved.assertCurrent)).toMatchObject({
    publicError: { code: "RESOURCE_MENTION_STALE" }
  });
});

test.each([
  ["duplicate identity", (seed: ClaudeTextResourceSeed) => [seed, { ...seed }]],
  ["unsupported kind", (seed: ClaudeTextResourceSeed) => [{ ...seed, kind: "extension" }]],
  ["zero entity revision", (seed: ClaudeTextResourceSeed) => [{ ...seed, resourceVersion: 0n }]],
  ["control character identity", (seed: ClaudeTextResourceSeed) => [{ ...seed, revision: "bad\nrevision" }]],
  ["oversized content", (seed: ClaudeTextResourceSeed) => [{ ...seed, content: "x".repeat(256 * 1024 + 1) }]]
] as const)("rejects a %s before a native runtime can advertise the catalog", (_label, change) => {
  const seed: ClaudeTextResourceSeed = {
    id: "approved-skill",
    kind: "skill",
    name: "Approved skill",
    revision: "sha256:approved",
    resourceVersion: 1n,
    content: "Approved instructions",
    assertCurrent: vi.fn()
  };
  expect(thrown(() => snapshotClaudeTextResources(
    change(seed) as readonly ClaudeTextResourceSeed[],
    1,
    new AbortController().signal
  ))).toMatchObject({ publicError: { code: "RESOURCE_CATALOG_INVALID" } });
});

test("keeps resource support typed unsupported when no runtime snapshot exists", () => {
  expect(thrown(() => resolveClaudeResourceMention({
    kind: "resource",
    label: "Missing",
    reference: "missing-resource",
    discoveredRevision: "sha256:missing",
    resourceVersion: "1",
    runtimeGeneration: 1
  }, undefined))).toMatchObject({ publicError: { code: "MENTION_KIND_UNSUPPORTED" } });
});

test("rejects zero as a loaded runtime generation", () => {
  const seed: ClaudeTextResourceSeed = {
    id: "approved-prompt",
    kind: "prompt",
    name: "Approved prompt",
    revision: "sha256:approved",
    resourceVersion: 1n,
    content: "Approved instructions",
    assertCurrent: vi.fn()
  };
  expect(thrown(() => snapshotClaudeTextResources(
    [seed],
    0,
    new AbortController().signal
  ))).toMatchObject({ publicError: { code: "RESOURCE_CATALOG_INVALID" } });
  const snapshot = snapshotClaudeTextResources([seed], 1, new AbortController().signal);
  expect(thrown(() => resolveClaudeResourceMention({
    kind: "resource",
    label: seed.name,
    reference: seed.id,
    discoveredRevision: seed.revision,
    resourceVersion: "1",
    runtimeGeneration: 0
  }, snapshot))).toMatchObject({ publicError: { code: "RESOURCE_REFERENCE_INVALID" } });
});

function thrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to throw.");
}
