import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OperationalStore, StoreError } from "./index.js";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

describe("task tags", () => {
  it("owns the twelve current-v1 presets and persists catalog mutations plus exact durable events", () => {
    const fixture = persistentFixture();
    let store = fixture.open();
    seedOwner(store);

    const initial = store.getTaskTagCatalog();
    expect(initial.revision).toBe(0n);
    expect(initial.tags.map(({ presetKey, color, nameCustomized, sortOrder }) => ({
      presetKey, color, nameCustomized, sortOrder
    }))).toEqual([
      { presetKey: "red", color: "red", nameCustomized: false, sortOrder: 0 },
      { presetKey: "orange", color: "orange", nameCustomized: false, sortOrder: 1 },
      { presetKey: "yellow", color: "yellow", nameCustomized: false, sortOrder: 2 },
      { presetKey: "green", color: "green", nameCustomized: false, sortOrder: 3 },
      { presetKey: "blue", color: "blue", nameCustomized: false, sortOrder: 4 },
      { presetKey: "purple", color: "purple", nameCustomized: false, sortOrder: 5 },
      { presetKey: "important", color: "coral", nameCustomized: false, sortOrder: 6 },
      { presetKey: "follow-up", color: "pink", nameCustomized: false, sortOrder: 7 },
      { presetKey: "work", color: "indigo", nameCustomized: false, sortOrder: 8 },
      { presetKey: "life", color: "teal", nameCustomized: false, sortOrder: 9 },
      { presetKey: "ideas", color: "white", nameCustomized: false, sortOrder: 10 },
      { presetKey: "reference", color: "gray", nameCustomized: false, sortOrder: 11 }
    ]);

    const created = store.createTaskTag({
      originSessionId: "session-a",
      name: "  Release  ",
      color: "teal",
      expectedCatalogRevision: initial.revision,
      createdAt: 10
    });
    expect(created).toMatchObject({ name: "Release", color: "teal", nameCustomized: true, sortOrder: 12 });
    expect(() => store.createTaskTag({
      originSessionId: "session-a",
      name: "release",
      color: "blue",
      expectedCatalogRevision: store.getTaskTagCatalog().revision
    })).toThrow(StoreError);

    const updated = store.updateTaskTag({
      originSessionId: "session-a",
      tagId: created.id,
      expectedRevision: created.revision,
      name: "Launch",
      color: "indigo",
      updatedAt: 11
    });
    expect(updated).toMatchObject({ name: "Launch", color: "indigo", sortOrder: 12 });
    const work = store.getTaskTag("preset:work");
    expect(store.updateTaskTag({
      originSessionId: "session-a",
      tagId: work.id,
      expectedRevision: work.revision,
      name: "Deep work",
      updatedAt: 12
    })).toMatchObject({ presetKey: "work", name: "Deep work", nameCustomized: true });

    const beforeReorder = store.getTaskTagCatalog();
    const order = beforeReorder.tags.map((tag) => tag.id).reverse();
    const reordered = store.reorderTaskTags({
      originSessionId: "session-a",
      tagIds: order,
      expectedCatalogRevision: beforeReorder.revision,
      updatedAt: 13
    });
    expect(reordered.tags.map((tag) => tag.id)).toEqual(order);
    const expected = reordered.tags.map(({ id, name, color, presetKey, nameCustomized, sortOrder }) => ({
      id, name, color, presetKey, nameCustomized, sortOrder
    }));
    const eventCatalogs = store.listEvents({ limit: 100 })
      .filter((event) => event.payload.type === "task_tag_catalog_changed")
      .map((event) => event.payload.type === "task_tag_catalog_changed" ? event.payload.catalog : undefined);
    expect(eventCatalogs).toHaveLength(4);
    expect(eventCatalogs.at(-1)?.tags.map((tag) => tag.id)).toEqual(order);

    store.close();
    store = fixture.open();
    expect(store.getTaskTagCatalog().tags.map(({ id, name, color, presetKey, nameCustomized, sortOrder }) => ({
      id, name, color, presetKey, nameCustomized, sortOrder
    }))).toEqual(expected);
    expect(store.listEvents({ limit: 100 }).filter((event) => event.payload.type === "task_tag_catalog_changed"))
      .toHaveLength(4);
  });

  it("includes archived tasks in deletion previews and invalidates only target metadata or associations", () => {
    const store = memoryFixture();
    seedOwner(store);
    const work = store.getTaskTag("preset:work");
    store.setSessionTaskTags({
      originSessionId: "session-a",
      sessionIds: ["session-a", "session-b"],
      tagIds: [work.id],
      attached: true,
      updatedAt: 20
    });
    const preview = store.previewTaskTagDeletion(work.id);
    expect(preview.affectedSessionCount).toBe(2);
    expect(store.findSessionsByTaskTag(work.id).sessions.map((session) => ({
      id: session.descriptor.id,
      archived: session.descriptor.archived
    }))).toEqual(expect.arrayContaining([
      { id: "session-a", archived: false },
      { id: "session-b", archived: true }
    ]));

    const red = store.getTaskTag("default:red");
    store.updateTaskTag({
      originSessionId: "session-a",
      tagId: red.id,
      expectedRevision: red.revision,
      color: "orange",
      updatedAt: 21
    });
    expect(() => store.deleteTaskTag({ originSessionId: "session-a", ...preview, deletedAt: 22 })).not.toThrow();
    expect(store.getSession("session-b").descriptor.archived).toBe(true);
    expect(store.listSessionTaskTags("session-a")).toEqual([]);
    expect(store.listSessionTaskTags("session-b")).toEqual([]);

    const life = store.getTaskTag("preset:life");
    store.setSessionTaskTags({
      originSessionId: "session-a",
      sessionIds: ["session-a"],
      tagIds: [life.id],
      attached: true,
      updatedAt: 23
    });
    const associationPreview = store.previewTaskTagDeletion(life.id);
    store.setSessionTaskTags({
      originSessionId: "session-a",
      sessionIds: ["session-b"],
      tagIds: [life.id],
      attached: true,
      updatedAt: 24
    });
    expect(() => store.deleteTaskTag({ originSessionId: "session-a", ...associationPreview }))
      .toThrow(/preview is stale/u);

    const metadataPreview = store.previewTaskTagDeletion(life.id);
    const currentLife = store.getTaskTag(life.id);
    store.updateTaskTag({
      originSessionId: "session-a",
      tagId: life.id,
      expectedRevision: currentLife.revision,
      name: "Personal",
      updatedAt: 25
    });
    expect(() => store.deleteTaskTag({ originSessionId: "session-a", ...metadataPreview }))
      .toThrow(/preview is stale/u);

    const fresh = store.previewTaskTagDeletion(life.id);
    expect(fresh.affectedSessionCount).toBe(2);
    store.deleteTaskTag({ originSessionId: "session-a", ...fresh, deletedAt: 26 });
    expect(store.listSessionTaskTags("session-a")).toEqual([]);
    expect(store.listSessionTaskTags("session-b")).toEqual([]);
  });

  it("publishes one bounded catalog event for metadata, order, and deletion changes", () => {
    const store = memoryFixture();
    seedOwner(store);
    const work = store.getTaskTag("preset:work");
    store.setSessionTaskTags({
      originSessionId: "session-a",
      sessionIds: ["session-a", "session-b"],
      tagIds: [work.id],
      attached: true,
      updatedAt: 30
    });
    const sessionRevisions = [store.getSession("session-a").revision, store.getSession("session-b").revision];

    let cursor = store.listEvents().at(-1)?.globalCursor ?? 0n;
    const updated = store.updateTaskTag({
      originSessionId: "session-a",
      tagId: work.id,
      expectedRevision: work.revision,
      color: "purple",
      updatedAt: 31
    });
    expect(store.listEvents({ afterCursor: cursor, limit: 100 }).map((event) => event.payload.type))
      .toEqual(["task_tag_catalog_changed"]);
    expect([store.getSession("session-a").revision, store.getSession("session-b").revision]).toEqual(sessionRevisions);

    cursor = store.listEvents().at(-1)?.globalCursor ?? 0n;
    const catalog = store.getTaskTagCatalog();
    store.reorderTaskTags({
      originSessionId: "session-a",
      tagIds: catalog.tags.map((tag) => tag.id).reverse(),
      expectedCatalogRevision: catalog.revision,
      updatedAt: 32
    });
    expect(store.listEvents({ afterCursor: cursor, limit: 100 }).map((event) => event.payload.type))
      .toEqual(["task_tag_catalog_changed"]);
    expect([store.getSession("session-a").revision, store.getSession("session-b").revision]).toEqual(sessionRevisions);

    cursor = store.listEvents().at(-1)?.globalCursor ?? 0n;
    const preview = store.previewTaskTagDeletion(updated.id);
    store.deleteTaskTag({ originSessionId: "session-a", ...preview, deletedAt: 33 });
    expect(store.listEvents({ afterCursor: cursor, limit: 100 }).map((event) => event.payload.type))
      .toEqual(["task_tag_catalog_changed"]);
    expect([store.getSession("session-a").revision, store.getSession("session-b").revision]).toEqual(sessionRevisions);
    expect(store.listSessionTaskTags("session-a")).toEqual([]);
    expect(store.listSessionTaskTags("session-b")).toEqual([]);
  });

  it("enforces the 32-tag task limit atomically against existing associations", () => {
    const store = memoryFixture();
    seedOwner(store);
    const tagIds = store.listTaskTags().map((tag) => tag.id);
    while (tagIds.length < 33) {
      const catalog = store.getTaskTagCatalog();
      tagIds.push(store.createTaskTag({
        originSessionId: "session-a",
        name: `Custom ${tagIds.length}`,
        color: "blue",
        expectedCatalogRevision: catalog.revision
      }).id);
    }
    store.setSessionTaskTags({
      originSessionId: "session-a",
      sessionIds: ["session-a"],
      tagIds: tagIds.slice(0, 32),
      attached: true
    });
    expect(store.listSessionTaskTags("session-a")).toHaveLength(32);
    expect(() => store.setSessionTaskTags({
      originSessionId: "session-a",
      sessionIds: ["session-a"],
      tagIds: [tagIds[32]!],
      attached: true
    })).toThrow(/more than 32/u);
    expect(store.listSessionTaskTags("session-a")).toHaveLength(32);
  });
});

function memoryFixture(): OperationalStore {
  let sequence = 0;
  const store = new OperationalStore(":memory:", {
    now: () => 100 + sequence,
    idFactory: () => `task-tag-generated-${++sequence}`
  });
  cleanup.push(() => store.close());
  return store;
}

function persistentFixture(): { readonly open: () => OperationalStore } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-task-tags-"));
  const file = path.join(directory, "operational.sqlite");
  let sequence = 0;
  const stores: OperationalStore[] = [];
  cleanup.push(() => {
    for (const store of stores) {
      try { store.close(); } catch { /* already closed */ }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    open: () => {
      const store = new OperationalStore(file, {
        now: () => 100 + sequence,
        idFactory: () => `task-tag-generated-${++sequence}`
      });
      stores.push(store);
      return store;
    }
  };
}

function seedOwner(store: OperationalStore): void {
  store.upsertBackend({
    id: "backend-a",
    displayName: "Backend",
    version: "1",
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
  store.upsertTarget({
    id: "target-a",
    backendId: "backend-a",
    displayName: "Target",
    workspaceRoot: "D:/task-tags",
    managed: false,
    trusted: true
  });
  for (const [id, archived, at] of [["session-a", false, 1], ["session-b", true, 2]] as const) {
    store.createSession({
      id,
      backendId: "backend-a",
      targetId: "target-a",
      title: id,
      binding: { opaqueRef: `native/${id}`, generation: 1 },
      pinned: false,
      archived,
      permissionMode: "ask",
      planMode: false,
      fastMode: false,
      createdAt: at,
      updatedAt: at
    });
  }
}
