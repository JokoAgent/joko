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

  it("preserves newer explicit saves when a delayed suspension or candidate creation loses its precondition", async () => {
    const fixture = await createFixture(); const knowledge = new BrowserUserKnowledgeStore(fixture.store);
    const old = { id: "search", steps: [], description: "Original" };
    const newer = { ...old, description: "Newer explicit revision" };
    await knowledge.save({ site: "example.test", recipe: old });
    await knowledge.save({ site: "example.test", recipe: newer });
    await expect(knowledge.save({ site: "example.test", recipe: { ...old, validation: { state: "suspended" } }, expectedRecipe: JSON.stringify(old) })).rejects.toThrow(/changed/u);
    await expect(knowledge.save({ site: "example.test", recipe: old, expectedRecipe: null })).rejects.toThrow(/changed/u);
    expect(knowledge.recipes).toEqual([newer]); expect(knowledge.catalogVersion).toBe(2);
    fixture.store.close();
  });

  it("rechecks revoked authority before publishing a queued save or observation", async () => {
    const fixture = await createFixture(); const knowledge = new BrowserUserKnowledgeStore(fixture.store);
    let current = true;
    const assertCurrent = () => { if (!current) throw new Error("Authority retired."); };
    const save = knowledge.save({ site: "example.test", recipe: { id: "search", steps: [] }, assertCurrent });
    const observation = knowledge.recordExperience({ site: "example.test", actions: ["navigate", "extract"] }, assertCurrent);
    current = false;
    await expect(save).rejects.toThrow(/retired/u); await expect(observation).rejects.toThrow(/retired/u);
    expect(knowledge.recipes).toEqual([]); expect(await knowledge.listExperiences("example.test")).toEqual([]);
    await knowledge.save({ site: "example.test", recipe: { id: "other", steps: [] } });
    expect(knowledge.catalogVersion).toBe(1);
    fixture.store.close();
  });

  it("restores bounded shape-only observations without changing the recipe catalog", async () => {
    const fixture = await createFixture(); const knowledge = new BrowserUserKnowledgeStore(fixture.store);
    await Promise.all(Array.from({ length: 3 }, () => knowledge.recordExperience({ site: "example.test", actions: ["navigate", "type", "extract"] }, () => undefined)));
    const rows = await knowledge.listExperiences("example.test");
    expect(rows).toEqual([{ site: "example.test", actions: ["navigate", "type", "extract"], observations: 3, updatedAt: expect.any(Number) }]);
    expect(knowledge.catalogVersion).toBe(0);
    fixture.store.close();
    const reopened = new OperationalStore(fixture.database); const restored = new BrowserUserKnowledgeStore(reopened);
    expect(await restored.listExperiences("example.test")).toEqual(rows);
    for (let index = 0; index < 32; index++) await restored.recordExperience({ site: "example.test", actions: ["navigate",
      ...Array.from({ length: 5 }, (_, bit) => index >> bit & 1 ? "click" as const : "wait" as const), "extract"] }, () => undefined);
    expect(await restored.listExperiences("example.test")).toHaveLength(32);
    expect((await restored.listExperiences("example.test")).some(row => row.actions.includes("type"))).toBe(false);
    reopened.close();
  });

  it("rejects stored observations with selectors or user records instead of exposing them as help", async () => {
    const fixture = await createFixture(); const knowledge = new BrowserUserKnowledgeStore(fixture.store);
    fixture.store.setSetting("service", "orchestrator", "settings.browser.experience:example.test", { format: 1, entries: [{
      site: "example.test", actions: ["navigate", "extract"], observations: 2, updatedAt: 1, selector: "#private-record"
    }] });
    await expect(knowledge.listExperiences("example.test")).rejects.toThrow(/invalid/u);
    fixture.store.close();
  });
});

async function createFixture(): Promise<{ readonly store: OperationalStore; readonly database: string }> {
  const directory = await mkdtemp(join(tmpdir(), "joko-browser-knowledge-"));
  directories.push(directory);
  const database = join(directory, "operational.sqlite");
  return { store: new OperationalStore(database), database };
}
