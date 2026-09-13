import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ClaudeCodeAdapter } from "./adapter.js";
import { scanClaudeSessionCatalog } from "./session-catalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude Code local task catalog", () => {
  test("groups normalized worktrees, falls back to profile project roots, and counts only rejected tasks", async () => {
    const fixture = await catalogFixture();
    const ids = {
      worktree: randomUUID(),
      fallback: randomUUID(),
      sidechain: randomUUID(),
      review: randomUUID(),
      internal: randomUUID(),
      child: randomUUID()
    };
    await writeTranscript(fixture, "worktree", ids.worktree, 60, [
      {
        type: "user",
        sessionId: ids.worktree,
        cwd: "C:\\stale",
        message: { content: "<ide_opened_file>context</ide_opened_file>" }
      },
      {
        type: "user",
        sessionId: ids.worktree,
        cwd: "\\\\?\\C:\\repo\\.claude\\worktrees\\topic\\src\\",
        message: { content: "private-marker newest task" }
      }
    ]);
    const projectStorage = storageName(fixture.fallbackWorkspace);
    await writeTranscript(fixture, projectStorage, ids.fallback, 50, [{
      type: "user",
      sessionId: ids.fallback,
      message: { content: "fallback task" }
    }]);
    await writeFile(join(fixture.root, ".claude.json"), JSON.stringify({
      projects: { [fixture.fallbackWorkspace]: {} }
    }), "utf8");
    await writeTranscript(fixture, "sidechain", ids.sidechain, 40, [{
      type: "user",
      sessionId: ids.sidechain,
      isSidechain: true,
      message: { content: "sidechain" }
    }]);
    await writeTranscript(fixture, "review", ids.review, 30, [{
      type: "user",
      sessionId: ids.review,
      cwd: fixture.fallbackWorkspace,
      message: { content: '<channel source="local-review">review</channel>' }
    }]);
    await writeTranscript(fixture, "internal", ids.internal, 20, [{
      type: "assistant",
      sessionId: ids.internal,
      cwd: fixture.fallbackWorkspace,
      parent_agent_id: "worker"
    }]);
    await writeTranscript(fixture, join("worktree", "subagents"), ids.child, 100, [{
      type: "user",
      sessionId: ids.child,
      cwd: fixture.fallbackWorkspace,
      message: { content: "ignored child" }
    }]);
    await writeTranscript(fixture, "duplicate", ids.fallback, 10, [{
      type: "user",
      sessionId: ids.fallback,
      cwd: "C:\\older",
      message: { content: "older duplicate" }
    }]);
    const adapter = new ClaudeCodeAdapter({
      instanceGeneration: 1,
      environment: { CLAUDE_CONFIG_DIR: fixture.configDirectory },
      redactValues: ["private-marker"]
    });

    const result = await adapter.scanNativeSessionCatalog();

    expect(result).toEqual({
      entries: [
        {
          nativeReference: `claude-code:session:${ids.worktree}`,
          nativeSessionId: ids.worktree,
          title: "[REDACTED] newest task",
          workingDirectory: "C:/repo/.claude/worktrees/topic/src",
          projectDirectory: "C:/repo",
          createdAt: 60_000,
          modifiedAt: 60_000,
          archived: false,
          placement: "project",
          existingMatch: "binding"
        },
        {
          nativeReference: `claude-code:session:${ids.fallback}`,
          nativeSessionId: ids.fallback,
          title: "fallback task",
          workingDirectory: fixture.fallbackWorkspace.replaceAll("\\", "/"),
          projectDirectory: fixture.fallbackWorkspace.replaceAll("\\", "/"),
          createdAt: 50_000,
          modifiedAt: 50_000,
          archived: false,
          placement: "project",
          existingMatch: "binding"
        }
      ],
      rejectedCount: 3
    });
    await adapter.dispose();
  });

  test("binds an unchanged scanned source and preserves its creation time", async () => {
    const fixture = await catalogFixture();
    const sessionId = randomUUID();
    await writeTranscript(fixture, "bind", sessionId, 20, [{
      type: "user",
      sessionId,
      timestamp: 5,
      cwd: fixture.fallbackWorkspace,
      message: { content: "bind task" }
    }]);
    const adapter = new ClaudeCodeAdapter({
      instanceGeneration: 1,
      environment: { CLAUDE_CONFIG_DIR: fixture.configDirectory }
    });

    const result = await adapter.scanNativeSessionCatalog();
    const entry = result.entries[0];
    expect(entry).toEqual(expect.objectContaining({
      nativeReference: `claude-code:session:${sessionId}`,
      nativeSessionId: sessionId,
      createdAt: 5_000,
      modifiedAt: 20_000
    }));
    if (entry === undefined) throw new Error("Expected a scanned catalog entry.");
    await expect(adapter.bindCatalogSession(entry, 3)).resolves.toEqual({
      opaqueRef: `claude-code:session:${sessionId}`,
      nativeSessionId: sessionId,
      generation: 3
    });
    await expect(adapter.bindCatalogSession({ ...entry, createdAt: entry.createdAt + 1 }, 3))
      .rejects.toMatchObject({
        publicError: {
          code: "CATALOG_SOURCE_CHANGED",
          retryable: true,
          stateMayHaveChanged: false
        }
      });
    await adapter.dispose();
  });

  test.each(["deleted", "appended", "replaced"] as const)(
    "rejects a catalog bind after its source is %s",
    async (mutation) => {
      const fixture = await catalogFixture();
      const sessionId = randomUUID();
      const original = {
        type: "user",
        sessionId,
        cwd: fixture.fallbackWorkspace,
        message: { content: "original" }
      };
      const file = await writeTranscript(fixture, "changed", sessionId, 30, [original]);
      const adapter = new ClaudeCodeAdapter({
        instanceGeneration: 1,
        environment: { CLAUDE_CONFIG_DIR: fixture.configDirectory }
      });
      const entry = (await adapter.scanNativeSessionCatalog()).entries[0];
      if (entry === undefined) throw new Error("Expected a scanned catalog entry.");
      expect(entry.nativeReference).toBe(`claude-code:session:${sessionId}`);

      if (mutation === "deleted") await rm(file);
      else if (mutation === "appended") {
        await appendFile(file, `${JSON.stringify({ type: "assistant", sessionId })}\n`, "utf8");
        await utimes(file, 30, 30);
      } else {
        await writeFile(file, `${JSON.stringify({
          ...original,
          message: { content: "replaced" }
        })}\n`, "utf8");
        await utimes(file, 30, 30);
      }

      const rescanned = await adapter.scanNativeSessionCatalog();
      const rescannedEntry = rescanned.entries[0];
      if (mutation === "deleted") {
        expect(rescanned.entries).toEqual([]);
      } else {
        if (rescannedEntry === undefined) throw new Error("Expected a rescanned catalog entry.");
        expect(rescannedEntry.nativeReference).toBe(`claude-code:session:${sessionId}`);
        expect(rescannedEntry.nativeReference).toBe(entry.nativeReference);
        await expect(adapter.bindCatalogSession(rescannedEntry, 2)).resolves.toEqual({
          opaqueRef: `claude-code:session:${sessionId}`,
          nativeSessionId: sessionId,
          generation: 2
        });
      }

      await expect(adapter.bindCatalogSession(entry, 2)).rejects.toMatchObject({
        publicError: {
          code: "CATALOG_SOURCE_CHANGED",
          retryable: true,
          stateMayHaveChanged: false,
          recovery: "Scan local tasks again and retry the import."
        }
      });
      await adapter.dispose();
    }
  );

  test.each([
    ["\\\\server\\share\\repo\\.worktrees\\topic\\", "//server/share/repo/.worktrees/topic", "//server/share/repo"],
    ["\\\\?\\UNC\\server\\share\\repo\\", "//server/share/repo", "//server/share/repo"],
    ["C:\\", "C:/", "C:/"]
  ])("preserves native path identity for %s", async (cwd, workingDirectory, projectDirectory) => {
    const fixture = await catalogFixture();
    const sessionId = randomUUID();
    await writeTranscript(fixture, "path", sessionId, 10, [{
      type: "user",
      sessionId,
      cwd,
      message: { content: "path task" }
    }]);

    const result = await scanClaudeSessionCatalog({ configDirectory: fixture.configDirectory });

    expect(result.summaries).toEqual([expect.objectContaining({ workingDirectory, projectDirectory })]);
    expect(result.rejectedCount).toBe(0);
  });

  test("stops at the valid result bound without counting unseen files as rejected", async () => {
    const fixture = await catalogFixture();
    for (const [index, modifiedAt] of [30, 20, 10].entries()) {
      const sessionId = randomUUID();
      await writeTranscript(fixture, `valid-${index}`, sessionId, modifiedAt, [{
        type: "user",
        sessionId,
        cwd: fixture.fallbackWorkspace,
        message: { content: `valid ${index}` }
      }]);
    }
    const result = await scanClaudeSessionCatalog({
      configDirectory: fixture.configDirectory,
      maximumEntries: 2
    });

    expect(result.summaries).toHaveLength(2);
    expect(result.rejectedCount).toBe(0);
  });

  test("uses the home fallback for unknown storage and supplies a title after bounded prompt discovery", async () => {
    const fixture = await catalogFixture();
    const sessionId = randomUUID();
    const untitledSessionId = randomUUID();
    const overLimitSessionId = randomUUID();
    const ignored = Array.from({ length: 400 }, () => ({
      type: "user",
      sessionId,
      message: { content: "<ide_opened_file>context</ide_opened_file>" }
    }));
    await writeFile(join(fixture.root, ".claude.json"), "x".repeat(2 * 1024 * 1024));
    await writeTranscript(fixture, "unknown-storage", sessionId, 10, [
      ...ignored,
      { type: "user", sessionId, message: { content: "first real prompt" } }
    ]);
    await writeTranscript(fixture, "another-unknown-storage", untitledSessionId, 9, [
      { type: "assistant", sessionId: untitledSessionId }
    ]);
    await writeTranscript(fixture, "over-limit", overLimitSessionId, 8, [
      ...Array.from({ length: 400 }, () => ({ type: "progress" })),
      { type: "user", sessionId: overLimitSessionId, message: { content: "too late" } }
    ]);

    const result = await scanClaudeSessionCatalog({ configDirectory: fixture.configDirectory });

    expect(result.summaries).toEqual([
      expect.objectContaining({
        title: "first real prompt",
        workingDirectory: homedir().replaceAll("\\", "/")
      }),
      expect.objectContaining({
        nativeSessionId: untitledSessionId,
        title: "Claude Code Session",
        workingDirectory: homedir().replaceAll("\\", "/")
      })
    ]);
    expect(result.rejectedCount).toBe(1);
  });
});

async function catalogFixture(): Promise<{
  readonly root: string;
  readonly configDirectory: string;
  readonly projectsDirectory: string;
  readonly fallbackWorkspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "joko-claude-catalog-"));
  roots.push(root);
  const configDirectory = join(root, ".claude");
  const projectsDirectory = join(configDirectory, "projects");
  const fallbackWorkspace = join(root, "workspace");
  await mkdir(projectsDirectory, { recursive: true });
  return { root, configDirectory, projectsDirectory, fallbackWorkspace };
}

async function writeTranscript(
  fixture: Awaited<ReturnType<typeof catalogFixture>>,
  storage: string,
  sessionId: string,
  modifiedSeconds: number,
  records: readonly Readonly<Record<string, unknown>>[]
): Promise<string> {
  const file = join(fixture.projectsDirectory, storage, `${sessionId}.jsonl`);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  await utimes(file, modifiedSeconds, modifiedSeconds);
  return file;
}

function storageName(path: string): string {
  return path.replace(/[\\/:]/g, "-");
}
