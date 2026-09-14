import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ExtensionLibrarySqlService,
  type ExtensionLibrarySqlLimits,
  validateExtensionLibrarySql
} from "./extension-library-sql.js";
import { ExtensionLibraryVault } from "./extension-library-vault.js";

const EXTENSION_ID = `extension_${"b".repeat(32)}`;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(
  limits?: Partial<ExtensionLibrarySqlLimits>,
  requestTimeoutMilliseconds?: number,
  rootSegments: readonly string[] = []
) {
  const temporaryPath = await mkdtemp(join(tmpdir(), "joko-extension-library-sql-"));
  cleanups.push(() => rm(temporaryPath, { recursive: true, force: true }));
  const vault = new ExtensionLibraryVault({ root: join(temporaryPath, ...rootSegments, "library"), extensionId: EXTENSION_ID });
  await vault.open();
  const service = new ExtensionLibrarySqlService(vault, { limits, requestTimeoutMilliseconds });
  cleanups.push(() => service.closeAll().catch(() => undefined));
  return { root: vault.root, vault, service };
}

describe("ExtensionLibrarySqlService", () => {
  it("executes the bounded SQLite subset while rejecting additional statements and dangerous authority", async () => {
    const { service } = await fixture();
    const opened = await service.open({ path: "projects/state.sqlite", create: true });
    await service.execute(opened.handleId, "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    await service.execute(opened.handleId, "INSERT INTO notes(body) VALUES (?)", ["PRAGMA ATTACH is inert in a value"]);
    await service.execute(opened.handleId, "INSERT INTO notes(body) VALUES (?)", [Buffer.from("blob")]);
    await expect(service.execute(opened.handleId, "SELECT id, body FROM notes ORDER BY id")).resolves.toMatchObject({
      rows: [{ id: 1n, body: "PRAGMA ATTACH is inert in a value" }, { id: 2n, body: Uint8Array.from(Buffer.from("blob")) }]
    });

    for (const sql of [
      "SELECT 1; DROP TABLE notes",
      "PRAGMA user_version",
      "ATTACH DATABASE 'outside.sqlite' AS outside",
      "BEGIN",
      "CREATE TRIGGER forbidden AFTER INSERT ON notes BEGIN SELECT 1; END",
      "CREATE VIRTUAL TABLE forbidden USING fts5(body)",
      "SELECT load_extension('anything')"
    ]) {
      await expect(service.execute(opened.handleId, sql)).rejects.toMatchObject({ code: "SQL_REJECTED" });
    }
    expect(validateExtensionLibrarySql("SELECT 'DROP ATTACH PRAGMA'")).toEqual({ keyword: "SELECT", mutates: false });
    await service.closeAll();
  });

  it("rolls back mutations and batches when row, byte, or statement execution limits fail", async () => {
    const { service } = await fixture({ maximumRows: 2, maximumResultBytes: 32 });
    const opened = await service.open({ path: "bounded.sqlite", create: true });
    await service.execute(opened.handleId, "CREATE TABLE values_table(value TEXT UNIQUE)");
    await service.batch(opened.handleId, [
      { sql: "INSERT INTO values_table VALUES (?)", parameters: ["a"] },
      { sql: "INSERT INTO values_table VALUES (?)", parameters: ["b"] },
      { sql: "INSERT INTO values_table VALUES (?)", parameters: ["c"] }
    ]);
    await expect(service.execute(opened.handleId, "SELECT value FROM values_table ORDER BY value"))
      .rejects.toMatchObject({ code: "RESULT_LIMIT" });
    await expect(service.execute(opened.handleId, "INSERT INTO values_table VALUES ('d'), ('e'), ('f') RETURNING value"))
      .rejects.toMatchObject({ code: "RESULT_LIMIT" });
    await expect(service.execute(opened.handleId, "SELECT count(*) AS count FROM values_table"))
      .resolves.toMatchObject({ rows: [{ count: 3n }] });
    await expect(service.execute(opened.handleId, "SELECT ? AS payload", ["x".repeat(40)]))
      .rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(service.execute(opened.handleId, "SELECT ? AS payload", [9_223_372_036_854_775_808n]))
      .rejects.toMatchObject({ code: "SQL_REJECTED" });
    await expect(service.batch(opened.handleId, [
      { sql: "INSERT INTO values_table VALUES ('d')" },
      { sql: "INSERT INTO values_table VALUES ('a')" }
    ])).rejects.toMatchObject({ code: "SQL_FAILED" });
    await expect(service.execute(opened.handleId, "SELECT count(*) AS count FROM values_table"))
      .resolves.toMatchObject({ rows: [{ count: 3n }] });
    await service.closeAll();
  });

  it("migrates with exclusive online backup rollback, verifies backups, and honors read-only handles", async () => {
    const { service } = await fixture();
    const opened = await service.open({ path: "state.sqlite", create: true });
    await expect(service.migrate(opened.handleId, [
      { version: 1, statements: ["CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL)"] },
      { version: 2, statements: ["ALTER TABLE projects ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"] }
    ])).resolves.toBe(2);
    await expect(service.userVersion(opened.handleId)).resolves.toBe(2);
    await expect(service.check(opened.handleId)).resolves.toEqual({ ok: true });

    const competing = await service.open({ path: "state.sqlite" });
    await expect(service.migrate(opened.handleId, [
      { version: 3, statements: ["CREATE TABLE blocked(id INTEGER)"] }
    ])).rejects.toMatchObject({ code: "CONFLICT" });
    await service.close(competing.handleId);
    await expect(service.migrate(opened.handleId, [
      { version: 3, statements: ["CREATE TABLE rolled_back(id INTEGER)", "INSERT INTO missing_table VALUES (1)"] }
    ])).rejects.toMatchObject({ code: "SQL_FAILED" });
    await expect(service.userVersion(opened.handleId)).resolves.toBe(2);
    await expect(service.execute(opened.handleId, "SELECT * FROM rolled_back"))
      .rejects.toMatchObject({ code: "SQL_FAILED" });

    await expect(service.backup(opened.handleId, "backups/state.sqlite")).resolves.toEqual({
      path: "backups/state.sqlite",
      userVersion: 2
    });
    await service.close(opened.handleId);
    const readonly = await service.open({ path: "backups/state.sqlite", readonly: true });
    await expect(service.execute(readonly.handleId, "SELECT name FROM sqlite_master WHERE type = 'table'"))
      .resolves.toMatchObject({ rows: [{ name: "projects" }] });
    await expect(service.execute(readonly.handleId, "INSERT INTO projects(name) VALUES ('no')"))
      .rejects.toMatchObject({ code: "READ_ONLY" });
    await service.closeAll();
  });

  it.runIf(process.platform === "win32")("keeps database and backup operations working beyond the legacy Windows path boundary", async () => {
    const { root, service } = await fixture(undefined, undefined, ["a".repeat(90), "b".repeat(90)]);
    expect(join(root, ".joko-library", "tmp", `${"c".repeat(36)}.sqlite-backup`).length).toBeGreaterThan(260);
    const opened = await service.open({ path: "state.sqlite", create: true });
    await expect(service.migrate(opened.handleId, [
      { version: 1, statements: ["CREATE TABLE values_table(value TEXT NOT NULL)"] }
    ])).resolves.toBe(1);
    await service.execute(opened.handleId, "INSERT INTO values_table(value) VALUES (?)", ["long-path"]);
    await expect(service.backup(opened.handleId, "backups/state.sqlite")).resolves.toMatchObject({
      path: "backups/state.sqlite",
      userVersion: 1
    });
    await service.close(opened.handleId);
    const backup = await service.open({ path: "backups/state.sqlite", readonly: true });
    await expect(service.execute(backup.handleId, "SELECT value FROM values_table"))
      .resolves.toMatchObject({ rows: [{ value: "long-path" }] });
  });

  it("retires operations when an open database path is replaced", async ({ skip }) => {
    const { root, service } = await fixture();
    const opened = await service.open({ path: "identity.sqlite", create: true });
    await service.execute(opened.handleId, "CREATE TABLE values_table(value TEXT)");
    try {
      await rename(join(root, "identity.sqlite"), join(root, "identity.displaced.sqlite"));
    } catch (error) {
      if (["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) skip();
      throw error;
    }
    await writeFile(join(root, "identity.sqlite"), "replacement");
    await expect(service.execute(opened.handleId, "SELECT * FROM values_table"))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.close(opened.handleId)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps the host event loop responsive and retires a connection owner when its worker exceeds the deadline", async () => {
    const { service } = await fixture(undefined, 1_000);
    const opened = await service.open({ path: "bounded-worker.sqlite", create: true });
    const heartbeat = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 25));
    const runaway = service.execute(opened.handleId, `
      WITH RECURSIVE counter(value) AS (
        VALUES(0) UNION ALL SELECT value + 1 FROM counter WHERE value < 10000000
      ) SELECT sum(value) AS total FROM counter
    `);

    await expect(heartbeat).resolves.toBe(true);
    await expect(runaway).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(service.execute(opened.handleId, "SELECT 1 AS value"))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(service.open({ path: "bounded-worker.sqlite", readonly: true }))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
