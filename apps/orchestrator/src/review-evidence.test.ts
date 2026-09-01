import { describe, expect, it } from "vitest";

import {
  buildReviewEvidence,
  compareReviewFreshness,
  isSensitiveReviewPath,
  type BuildReviewEvidenceInput
} from "./review-evidence.js";

const hash = (character: string): string => character.repeat(64);

function source(overrides: Partial<BuildReviewEvidenceInput> = {}): BuildReviewEvidenceInput {
  return {
    conversation: {
      sessionId: "session-1",
      sessionGeneration: 2,
      nativeBindingIdentity: "native-binding-1",
      messages: [
        { id: "m1", ordinal: 1, role: "user", text: "build it" },
        { id: "m2", ordinal: 2, role: "assistant", text: "done" }
      ]
    },
    workspace: {
      workspaceId: "workspace-1",
      files: [
        { relativePath: "src/b.ts", sha256: hash("b"), byteLength: 2 },
        { relativePath: "src/a.ts", sha256: hash("a"), byteLength: 1 }
      ],
      git: { headOid: "a".repeat(40), indexTreeOid: "b".repeat(40), worktreeRevision: "dirty-1", baseOid: "c".repeat(40), mergeBaseOid: "d".repeat(40) },
      changeSet: { id: "change-1", revision: "revision-1" }
    },
    workspaceEvidence: {
      dirty: true,
      totalFiles: 2,
      stagedFiles: 1,
      unstagedFiles: 1,
      untrackedFiles: 0,
      diffs: [
        { relativePath: "src/b.ts", source: "unstaged", status: "modified", additions: 1, deletions: 0, patch: "+b" },
        { relativePath: "src/a.ts", source: "staged", status: "modified", additions: 1, deletions: 0, patch: "+a" }
      ]
    },
    changeSetEvidence: null,
    artifacts: [{
      kind: "file",
      displayName: "Report 文档.txt",
      blob: { id: "blob-1", sha256: hash("e"), byteLength: 3, mimeType: "text/plain", fileName: "report.txt" },
      excerpt: { format: "text", coverage: "full", content: "result" }
    }],
    ...overrides
  };
}

describe("review evidence", () => {
  it("builds deterministic canonical aliases and set-sorted seals", () => {
    const first = buildReviewEvidence(source());
    const reordered = source({
      workspace: { ...source().workspace, files: [...source().workspace.files].reverse() }
    });
    const second = buildReviewEvidence(reordered);
    expect(first).toEqual(buildReviewEvidence(source()));
    expect(first.freshness.filesSha256).toBe(second.freshness.filesSha256);
    expect(first.promptInput.workspace?.diffs.map((diff) => diff.path)).toEqual([
      "src/a.ts",
      "src/b.ts"
    ]);
    expect(first.promptInput.artifacts[0]?.alias).toBe("[review-artifact]/01-Report 文档.txt");
  });

  it("sorts artifact sets before assigning ordinal aliases and sealing", () => {
    const one = source().artifacts[0]!;
    const two = { ...one, displayName: "image.png", kind: "image" as const, blob: { ...one.blob, id: "blob-2", sha256: hash("f"), mimeType: "image/png", fileName: "image.png" } };
    const first = buildReviewEvidence(source({ artifacts: [two, one] }));
    const second = buildReviewEvidence(source({ artifacts: [one, two] }));
    expect(first.freshness.artifactsSha256).toBe(second.freshness.artifactsSha256);
    expect(first.promptInput.artifacts).toEqual(second.promptInput.artifacts);
    expect(first.promptInput.artifacts.map((artifact) => artifact.alias)).toEqual([
      "[review-artifact]/01-Report 文档.txt",
      "[review-artifact]/02-image.png"
    ]);
  });

  it("keeps conversation order sensitive and rejects ambiguous order", () => {
    const first = buildReviewEvidence(source());
    const changed = source({ conversation: { ...source().conversation, messages: [
      { id: "m2", ordinal: 1, role: "assistant", text: "done" },
      { id: "m1", ordinal: 2, role: "user", text: "build it" }
    ] } });
    expect(compareReviewFreshness(first.freshness, buildReviewEvidence(changed).freshness)).toBe("source-conversation-changed");
    expect(() => buildReviewEvidence(source({ conversation: { ...source().conversation, messages: [
      { id: "m1", ordinal: 2, role: "user", text: "a" },
      { id: "m2", ordinal: 1, role: "assistant", text: "b" }
    ] } }))).toThrow(/increasing/u);
  });

  it.each([
    ["conversation", (value: BuildReviewEvidenceInput): BuildReviewEvidenceInput => ({ ...value, conversation: { ...value.conversation, sessionGeneration: 3 } }), "source-conversation-changed"],
    ["workspace", (value: BuildReviewEvidenceInput): BuildReviewEvidenceInput => ({ ...value, workspace: { ...value.workspace, git: { ...value.workspace.git!, headOid: "f".repeat(40) } } }), "source-workspace-changed"],
    ["files", (value: BuildReviewEvidenceInput): BuildReviewEvidenceInput => ({ ...value, workspace: { ...value.workspace, files: value.workspace.files.map((file, index) => index === 0 ? { ...file, sha256: hash("f") } : file) } }), "source-files-changed"],
    ["artifact", (value: BuildReviewEvidenceInput): BuildReviewEvidenceInput => ({ ...value, artifacts: value.artifacts.map((artifact) => ({ ...artifact, blob: { ...artifact.blob, sha256: hash("f") } })) }), "artifact-changed"]
  ] as const)("classifies a %s freshness change", (_name, mutate, expected) => {
    const before = buildReviewEvidence(source()).freshness;
    const after = buildReviewEvidence(mutate(source())).freshness;
    expect(compareReviewFreshness(before, after)).toBe(expected);
  });

  it("filters sensitive current and old paths and reports the coverage loss", () => {
    const value = source();
    const built = buildReviewEvidence(source({
      workspaceEvidence: {
        ...value.workspaceEvidence!,
        totalFiles: 4,
        stagedFiles: 3,
        diffs: [
          ...value.workspaceEvidence!.diffs,
          { relativePath: ".env.production", source: "staged", status: "modified", additions: 1, deletions: 0, patch: "TOKEN=x" },
          { relativePath: "src/public.ts", oldRelativePath: ".ssh/id_ed25519", source: "staged", status: "renamed", additions: 1, deletions: 1, patch: "secret" }
        ]
      }
    }));
    expect(built.promptInput.workspace?.sensitiveFilesOmitted).toBe(2);
    expect(JSON.stringify(built.promptInput)).not.toMatch(/\.env|id_ed25519|TOKEN=x|secret/u);
    expect(isSensitiveReviewPath("config/.npmrc")).toBe(true);
    expect(isSensitiveReviewPath("keys/client.pem")).toBe(true);
  });

  it("counts sensitive paths removed from capped summaries", () => {
    const value = source();
    const built = buildReviewEvidence(source({
      workspaceEvidence: {
        ...value.workspaceEvidence!,
        totalFiles: 3,
        capped: [{
          reason: "large",
          fileCount: 1,
          totalChangedLines: 2,
          files: [{ relativePath: "config/.pypirc", status: "modified", additions: 1, deletions: 1 }]
        }]
      }
    }));
    expect(built.promptInput.workspace?.sensitiveFilesOmitted).toBe(1);
    expect(JSON.stringify(built.promptInput)).not.toContain(".pypirc");
  });

  it("never returns service absolute paths in aliases or the durable seal", () => {
    expect(() => buildReviewEvidence(source({
      workspace: { ...source().workspace, files: [{ relativePath: "D:\\service-secret\\a.ts", sha256: hash("a"), byteLength: 1 }] }
    }))).toThrow(/relative/u);
    expect(() => buildReviewEvidence(source({
      workspaceEvidence: { ...source().workspaceEvidence!, diffs: [{ relativePath: "/srv/private/a.ts", source: "staged", status: "modified", additions: 1, deletions: 0 }] }
    }))).toThrow(/relative/u);
    const built = buildReviewEvidence(source());
    expect(JSON.stringify(built.freshness)).not.toContain("workspace-1");
    expect(JSON.stringify(built.freshness)).not.toContain("src/a.ts");
    expect(Object.values(built.freshness).filter((value): value is string => typeof value === "string").every((value) => /^[a-f0-9]{64}$/u.test(value))).toBe(true);
  });

  it("fails closed on traversal, canonical path collisions, duplicate artifacts, and forbidden BlobRef fields", () => {
    expect(() => buildReviewEvidence(source({ workspace: { ...source().workspace, files: [{ relativePath: "src/../secret", sha256: hash("a"), byteLength: 1 }] } }))).toThrow(/traversal/u);
    expect(() => buildReviewEvidence(source({ workspace: { ...source().workspace, files: [
      { relativePath: "src\\a.ts", sha256: hash("a"), byteLength: 1 },
      { relativePath: "src/a.ts", sha256: hash("b"), byteLength: 1 }
    ] } }))).toThrow(/collision/u);
    expect(() => buildReviewEvidence(source({ artifacts: [source().artifacts[0]!, source().artifacts[0]!] }))).toThrow(/Duplicate/u);
    const unsafe = { ...source().artifacts[0]!.blob, path: "D:\\secret" };
    expect(() => buildReviewEvidence(source({ artifacts: [{ ...source().artifacts[0]!, blob: unsafe }] }))).toThrow(/forbidden/u);
  });
});
