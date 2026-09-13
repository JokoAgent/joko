import { join } from "node:path";
import { tmpdir } from "node:os";
import { rm } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";

import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_USER_KNOWLEDGE_SETTING_KEY,
  BrowserUserKnowledgeStore
} from "./browser-user-knowledge-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BrowserUserKnowledgeStore", () => {
  it("atomically persists recipes and site guides in one service setting", async () => {
    const fixture = await createFixture();
    const knowledge = new BrowserUserKnowledgeStore(fixture.store);
    await knowledge.save({
      site: "example.test",
      recipe: { id: "example-search", steps: [{ action: "navigate", url: "https://example.test" }] },
      siteGuide: { site: "example.test", recipes: ["example-search"] }
    });

    const setting = fixture.store.getSetting<Record<string, unknown>>(
      "service",
      "orchestrator",
      BROWSER_USER_KNOWLEDGE_SETTING_KEY
    );
    expect(setting.value).toMatchObject({ format: 1, catalogVersion: 1 });
    expect(knowledge.recipes).toEqual([{ id: "example-search", steps: [{ action: "navigate", url: "https://example.test" }] }]);
    expect(knowledge.siteGuides).toEqual([{ site: "example.test", recipes: ["example-search"] }]);

    fixture.store.close();
    const reopened = new OperationalStore(fixture.database);
    const restored = new BrowserUserKnowledgeStore(reopened);
    expect(restored.catalogVersion).toBe(1);
    expect(restored.recipes[0]).toMatchObject({ id: "example-search" });
    reopened.close();
  });

  it("serializes concurrent upserts without losing either recipe", async () => {
    const fixture = await createFixture();
    const knowledge = new BrowserUserKnowledgeStore(fixture.store);
    await Promise.all([
      knowledge.save({ site: "one.test", recipe: { id: "one", steps: [] } }),
      knowledge.save({ site: "two.test", recipe: { id: "two", steps: [] } })
    ]);
    expect(knowledge.catalogVersion).toBe(2);
    expect(knowledge.recipes.map((recipe) => recipe["id"])).toEqual(["one", "two"]);
    fixture.store.close();
  });

  it("rejects malformed durable catalogs before they reach the Browser bridge", async () => {
    const fixture = await createFixture();
    fixture.store.setSetting("service", "orchestrator", BROWSER_USER_KNOWLEDGE_SETTING_KEY, {
      format: 1,
      catalogVersion: 1,
      recipes: [{ id: "same", steps: [] }, { id: "same", steps: [] }],
      siteGuides: []
    });
    expect(() => new BrowserUserKnowledgeStore(fixture.store)).toThrow("duplicate");
    fixture.store.close();
  });
});

async function createFixture(): Promise<{ readonly store: OperationalStore; readonly database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "joko-browser-knowledge-"));
  directories.push(directory);
  const database = join(directory, "operational.sqlite");
  return { store: new OperationalStore(database), database };
}
