import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { scanCodexSessionCatalog } from "./session-catalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex local task catalog", () => {
  test("merges bounded state and rollout metadata without reopening database-known history", async () => {
    const profile = await profileFixture();
    const ids = {
      dialogue: randomUUID(),
      project: randomUUID(),
      rollout: randomUUID(),
      agent: randomUUID(),
      exec: randomUUID(),
      rolloutAgent: randomUUID()
    };
    writeStateDatabase(profile, [
      row(ids.dialogue, "\\\\server\\share\\chat\\", "dialogue", 5_000, "user", "vscode"),
      row(ids.agent, "C:\\repo", "agent", 4_500, "subagent", "vscode"),
      row(ids.exec, "C:\\repo", "exec", 4_000, "user", JSON.stringify({ kind: "codex_exec" })),
      row(ids.project, "\\\\?\\C:\\repo\\.worktrees\\topic\\src\\", "project", 3_000, "user", "vscode")
    ]);
    await writeFile(join(profile, ".codex-global-state.json"), JSON.stringify({
      "projectless-thread-ids": [ids.dialogue]
    }), "utf8");
    await writeRollout(profile, "sessions", ids.dialogue, "not-json", 90);
    await writeRollout(profile, "sessions", ids.agent, "not-json", 80);
    await writeRollout(profile, "archived_sessions", ids.project, "not-json", 70);
    await writeRollout(profile, "sessions", ids.rollout, metadata({
      id: ids.rollout,
      cwd: "C:\\rollout\\",
      title: "rollout",
      thread_source: "user",
      timestamp: 4
    }), 60);
    await writeRollout(profile, "sessions", ids.rolloutAgent, metadata({
      id: ids.rolloutAgent,
      cwd: "C:\\agent",
      thread_source: "agent_created_thread",
      timestamp: 6
    }), 50);
    await writeFile(join(profile, "session_index.jsonl"), `${JSON.stringify({
      id: ids.rollout,
      thread_name: "rollout",
      updated_at: 4
    })}\n`, "utf8");

    const result = await scanCodexSessionCatalog({ profileDirectories: [profile] });

    expect({
      ...result,
      summaries: result.summaries.map(({ source: _source, observedProfileKeys: _profiles, ...summary }) => summary)
    }).toEqual({
      summaries: [
        {
          nativeSessionId: ids.dialogue,
          title: "dialogue",
          workingDirectory: "//server/share/chat",
          createdAt: 5_000,
          modifiedAt: 5_000,
          archived: false,
          placement: "dialogue"
        },
        {
          nativeSessionId: ids.rollout,
          title: "rollout",
          workingDirectory: "C:/rollout",
          projectDirectory: "C:/rollout",
          createdAt: 4_000,
          modifiedAt: 4_000,
          archived: false,
          placement: "project"
        },
        {
          nativeSessionId: ids.project,
          title: "project",
          workingDirectory: "C:/repo/.worktrees/topic/src",
          projectDirectory: "C:/repo",
          createdAt: 3_000,
          modifiedAt: 3_000,
          archived: true,
          placement: "project"
        }
      ],
      rejectedCount: 3
    });
  });

  test("deduplicates profile roots and keeps the newest cross-profile identity with sticky archive state", async () => {
    const first = await profileFixture();
    const second = await profileFixture();
    const nativeSessionId = randomUUID();
    writeStateDatabase(first, [row(nativeSessionId, "C:\\older", "older", 1_000, "user", "vscode", 1)]);
    writeStateDatabase(second, [row(nativeSessionId, "C:\\newer", "newer", 2_000, "user", "vscode")]);

    const result = await scanCodexSessionCatalog({
      profileDirectories: [first, second, first]
    });

    expect(result.summaries).toEqual([expect.objectContaining({
      nativeSessionId,
      title: "newer",
      workingDirectory: "C:/newer",
      archived: true
    })]);
    expect(result.rejectedCount).toBe(0);
  });

  test("keeps the active profile authoritative when a newer external profile repeats the identity", async () => {
    const active = await profileFixture();
    const external = await profileFixture();
    const nativeSessionId = randomUUID();
    writeStateDatabase(active, [row(nativeSessionId, "C:\\active", "active", 1_000, "user", "vscode")]);
    writeStateDatabase(external, [row(nativeSessionId, "C:\\external", "external", 2_000, "user", "vscode", 1)]);

    const result = await scanCodexSessionCatalog({
      activeProfileDirectory: active,
      profileDirectories: [external]
    });

    expect(result.summaries).toEqual([expect.objectContaining({
      nativeSessionId,
      title: "active",
      workingDirectory: "C:/active",
      createdAt: 1_000,
      modifiedAt: 1_000,
      archived: true
    })]);
  });

  test("applies bounds per profile before the explicit merged bound", async () => {
    const profiles = await Promise.all([profileFixture(), profileFixture(), profileFixture()]);
    profiles.forEach((profile, index) => {
      writeStateDatabase(profile, [
        row(randomUUID(), `C:\\profile-${index}`, `profile-${index}`, (index + 1) * 1_000, "user", "vscode")
      ]);
    });

    const all = await scanCodexSessionCatalog({
      profileDirectories: profiles,
      maximumEntries: 1,
      maximumTotalEntries: 3
    });
    const bounded = await scanCodexSessionCatalog({
      profileDirectories: profiles,
      maximumEntries: 1,
      maximumTotalEntries: 2
    });

    expect(all.summaries).toHaveLength(3);
    expect(bounded.summaries.map((entry) => entry.modifiedAt)).toEqual([3_000, 2_000]);
  });

  test("keeps counting rejected database tasks after the candidate bound and excludes broken rollout files", async () => {
    const profile = await profileFixture();
    const accepted = randomUUID();
    const rejected = randomUUID();
    const broken = randomUUID();
    writeStateDatabase(profile, [
      row(accepted, "C:\\repo", "accepted", 2_000, "user", "vscode"),
      row(rejected, "C:\\repo", "rejected", 1_000, "subagent", "vscode")
    ]);
    await writeRollout(profile, "sessions", broken, "not-json", 3);

    const result = await scanCodexSessionCatalog({
      profileDirectories: [profile],
      maximumEntries: 1
    });

    expect(result.summaries.map((entry) => entry.nativeSessionId)).toEqual([accepted]);
    expect(result.rejectedCount).toBe(1);
  });

  test("orders mixed timestamp columns by the first available value", async () => {
    const profile = await profileFixture();
    const newest = randomUUID();
    const older = randomUUID();
    const database = new DatabaseSync(join(profile, "state_5.sqlite"));
    try {
      database.exec(`
        CREATE TABLE threads (
          id TEXT NOT NULL,
          cwd TEXT,
          title TEXT,
          updated_at_ms INTEGER,
          updated_at INTEGER,
          created_at INTEGER,
          thread_source TEXT,
          source TEXT,
          archived INTEGER
        )
      `);
      const insert = database.prepare(`
        INSERT INTO threads (id, cwd, title, updated_at_ms, updated_at, created_at, thread_source, source, archived)
        VALUES (?, ?, ?, ?, ?, ?, 'user', 'vscode', 0)
      `);
      insert.run(newest, "C:\\newest", "newest", null, 3_000, 500);
      insert.run(older, "C:\\older", "older", 2_000_000, 2_000, 400);
    } finally {
      database.close();
    }

    const result = await scanCodexSessionCatalog({ profileDirectories: [profile], maximumEntries: 1 });

    expect(result.summaries).toEqual([expect.objectContaining({
      nativeSessionId: newest,
      createdAt: 500_000,
      modifiedAt: 3_000_000
    })]);
  });

  test.each([
    ["\\\\server\\share\\repo\\.worktrees\\topic\\", "//server/share/repo/.worktrees/topic", "//server/share/repo"],
    ["\\\\?\\UNC\\server\\share\\repo\\", "//server/share/repo", "//server/share/repo"],
    ["C:\\", "C:/", "C:/"]
  ])("preserves native path identity for %s", async (cwd, workingDirectory, projectDirectory) => {
    const profile = await profileFixture();
    const nativeSessionId = randomUUID();
    writeStateDatabase(profile, [row(nativeSessionId, cwd, "path", 1_000, "user", "vscode")]);

    const result = await scanCodexSessionCatalog({ profileDirectories: [profile] });

    expect(result.summaries).toEqual([expect.objectContaining({ workingDirectory, projectDirectory })]);
  });
});

async function profileFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-codex-catalog-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

interface StateRow {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly threadSource: string;
  readonly source: string;
  readonly archived: number;
}

function row(
  id: string,
  cwd: string,
  title: string,
  updatedAt: number,
  threadSource: string,
  source: string,
  archived = 0
): StateRow {
  return { id, cwd, title, updatedAt, threadSource, source, archived };
}

function writeStateDatabase(profile: string, rows: readonly StateRow[]): void {
  const database = new DatabaseSync(join(profile, "state_5.sqlite"));
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT NOT NULL,
        cwd TEXT,
        title TEXT,
        updated_at_ms INTEGER,
        thread_source TEXT,
        source TEXT,
        archived INTEGER
      )
    `);
    const insert = database.prepare(`
      INSERT INTO threads (id, cwd, title, updated_at_ms, thread_source, source, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const value of rows) {
      insert.run(
        value.id,
        value.cwd,
        value.title,
        value.updatedAt,
        value.threadSource,
        value.source,
        value.archived
      );
    }
  } finally {
    database.close();
  }
}

async function writeRollout(
  profile: string,
  directory: "sessions" | "archived_sessions",
  nativeSessionId: string,
  firstLine: string,
  modifiedSeconds: number
): Promise<void> {
  const file = join(profile, directory, "2026", "08", `rollout-2026-08-30T00-00-00-${nativeSessionId}.jsonl`);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${firstLine}\n`, "utf8");
  await utimes(file, modifiedSeconds, modifiedSeconds);
}

function metadata(payload: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ type: "session_meta", payload });
}
