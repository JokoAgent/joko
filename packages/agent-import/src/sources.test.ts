import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createImportSourceReader, discoverImportSources, inspectImportSource, type SourceReaderDeps } from "./sources.js";
import { readOpenClawCronDatabase } from "./nativeCron.js";
import { previewImportRedactions } from "./environmentSelection.js";
import { redactEnvironmentValues } from "./process.js";
import type { ImportedRoutineInput } from "./types.js";

const temporaryBase = resolve(tmpdir()); const roots: string[] = [];
async function fixture(): Promise<string> { const root = await mkdtemp(join(temporaryBase, "joko-import-sources-")); roots.push(root); return root; }
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== temporaryBase || !basename(root).startsWith("joko-import-sources-")) throw new Error("Source test cleanup is outside its allocated directory");
    await rm(root, { recursive: true, force: true });
  }
});
function reader(home: string, overrides: Partial<SourceReaderDeps> = {}): SourceReaderDeps {
  return { home, env: {}, assertOwner: () => {}, parseRoutineInput: value => value as ImportedRoutineInput,
    readCronDatabase: input => readOpenClawCronDatabase(input, () => {}), ...overrides };
}

describe("installed source capture", () => {
  it("discovers native profiles and captures all five categories without shortening skill or document originals", async () => {
    const home = await fixture(); const root = join(home, ".hermes");
    await mkdir(join(root, "profiles", "research"), { recursive: true }); await mkdir(join(root, "cron"));
    await mkdir(join(root, "skills", "reports"), { recursive: true }); await mkdir(join(root, "memories", ".archive"), { recursive: true });
    await writeFile(join(root, "config.yaml"), "$include: extra.yaml\nname: Analyst\n");
    await writeFile(join(root, "extra.yaml"), "mcp_servers:\n  reports:\n    command: reports\n    env:\n      ACCESS_TOKEN: ${REPORT_TOKEN}\n");
    await writeFile(join(root, "profiles", "research", "config.yaml"), "name: Research\n");
    await writeFile(join(root, ".env"), "REPORT_TOKEN=fake-source-secret-abcdef\nRETRY_COUNT=3\n");
    const document = "---\ntitle: Archive\n---\n\n  Full retained original\n日本語\n";
    await writeFile(join(root, "SOUL.md"), "Identity uses fake-source-secret-abcdef\n");
    await writeFile(join(root, "memories", ".archive", "notes.backup"), document);
    await writeFile(join(root, "memories", "marker"), "");
    const skill = "---\nname: Reports\ndescription: Read reports\n---\n" + "Native instruction.\n".repeat(5000);
    await writeFile(join(root, "skills", "reports", "SKILL.md"), skill);
    await writeFile(join(root, "skills", "reports", "query.py"), "print('report')\n");
    await writeFile(join(root, "cron", "jobs.json"), JSON.stringify([{ id: "weekly", name: "Weekly", prompt: "Use Reports", skill: "Reports", enabled: false,
      schedule: { kind: "cron", expr: "0 9 * * 1" } }]));
    const deps = reader(home); const sources = await discoverImportSources(deps);
    expect(sources.map(source => [source.kind, source.agentId, source.name])).toEqual([["hermes", "default", "Analyst"], ["hermes", "research", "Research"]]);
    const snapshot = await inspectImportSource(sources[0]!, deps);
    expect(new Set(snapshot.items.map(item => item.view.category))).toEqual(new Set(["personality", "memory", "skills", "connections", "automations"]));
    expect(snapshot.items.find(item => item.view.name === ".archive/notes.backup")?.text).toBe(document);
    expect(snapshot.items.find(item => item.view.name === "memories/marker")?.asset?.bytes.length).toBe(0);
    expect(snapshot.items.find(item => item.view.name === "Reports")?.files?.find(file => file.name === "SKILL.md")?.bytes.toString("utf8")).toBe(skill);
    expect(snapshot.items.find(item => item.view.name === "Reports")?.files?.some(file => file.name === "query.py")).toBe(true);
    expect(snapshot.items.find(item => item.automation)?.view.enabled).toBe(false);
    const secrets = previewImportRedactions(snapshot.items);
    expect(redactEnvironmentValues(snapshot.items[0]!.text!, secrets)).not.toContain("fake-source-secret-abcdef");
    expect(snapshot.items.find(item => item.mcp)?.mcp?.env?.ACCESS_TOKEN).toBe("${REPORT_TOKEN}");
    expect(snapshot.items.every((item, index) => item.sourceIndex === index)).toBe(true);
  });
  it("reads current native SQLite including WAL with exact agent ownership and never substitutes a stale JSON store", async () => {
    const home = await fixture(); const root = join(home, ".openclaw"); await mkdir(join(root, "state"), { recursive: true }); await mkdir(join(root, "cron"));
    await writeFile(join(root, "openclaw.json"), "{agents: {entries: [{id:'main', default:true}, {id:'worker'}]}}");
    const storeKey = join(root, "cron", "jobs.json");
    await writeFile(storeKey, JSON.stringify({ jobs: [{ id: "stale", agentId: "main" }] }));
    const db = new DatabaseSync(join(root, "state", "openclaw.sqlite"));
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE cron_jobs (store_key TEXT, agent_id TEXT, owner_agent_id TEXT, sort_order INTEGER, job_json TEXT, state_json TEXT)");
      const insert = db.prepare("INSERT INTO cron_jobs VALUES (?, ?, NULL, ?, ?, ?)");
      const native = (id: string) => JSON.stringify({ id, name: id, payload: { kind: "agentTurn", message: "Read report" }, schedule: { kind: "every", everyMs: 60_000 } });
      insert.run(storeKey, null, 0, native("default"), JSON.stringify({ runningAtMs: 123 })); insert.run(storeKey, "worker", 1, native("worker"), "{}");
      const deps = reader(home); const sources = await discoverImportSources(deps);
      const snapshot = await inspectImportSource(sources.find(source => source.agentId === "main")!, deps);
      expect(snapshot.items.filter(item => item.automation).map(item => item.automation?.sourceId)).toEqual(["default"]);
      expect(snapshot.items.find(item => item.automation)?.automation?.original.state).toEqual({ runningAtMs: 123 });
      db.exec("DROP TABLE cron_jobs");
      await expect(inspectImportSource(sources[0]!, deps)).rejects.toMatchObject({ code: "SOURCE_DATABASE_UNAVAILABLE" });
    } finally { db.close(); }
  });
  it("rejects recursive configuration includes and retires an interrupted metadata read under its original owner", async () => {
    const home = await fixture(); const root = join(home, ".hermes"); await mkdir(root);
    await writeFile(join(root, "config.yaml"), "$include: loop.yaml\n"); await writeFile(join(root, "loop.yaml"), "$include: config.yaml\n");
    await expect(discoverImportSources(reader(home))).rejects.toMatchObject({ code: "SOURCE_CONFIG_INCLUDE_CYCLE" });
    await writeFile(join(root, "config.yaml"), "name: Analyst\n");
    let current = true; const deps = reader(home, { assertOwner: () => { if (!current) throw new Error("owner retired"); } });
    const metadata = createImportSourceReader(deps); current = false;
    await expect(metadata.readConfig(root, join(root, "config.yaml"))).rejects.toThrow("owner retired");
  });
});
