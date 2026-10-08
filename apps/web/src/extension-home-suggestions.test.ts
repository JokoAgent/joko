import { describe, expect, it } from "vitest";

import {
  buildHomeTaskCatalog,
  extensionSuggestionCategory,
  markHomeTaskBatchDisplayed,
  nextHomeTaskBatch,
  type ExtensionCatalogEntryWithRecommendations,
  type HomeTaskSuggestion,
  visibleHomeTaskSuggestions
} from "./extension-home-suggestions.js";

const t = (key: string): string => key;

describe("Extension home suggestions", () => {
  it("builds localized install, enable, setup, and commandless tasks from exact entries", () => {
    const catalog = buildHomeTaskCatalog([
      extension({
        id: "extension_source",
        installed: false,
        enabled: false,
        owner: sourceOwner(),
        recommendations: [recommendation("mail", "Review mail", "Review my inbox", "mail-review")]
      }),
      extension({
        id: "extension_disabled",
        enabled: false,
        recommendations: [recommendation("photos", "Sort photos", "Sort my photos")]
      }),
      extension({
        id: "extension_setup",
        setup: setup("required"),
        recommendations: [recommendation("calendar", "Plan meetings", "Plan my calendar", "calendar-plan")]
      }),
      extension({
        id: "extension_ready",
        recommendations: [{
          ...recommendation("documents", "Review files", "Review my documents"),
          locales: { "zh-CN": { label: "整理文件", prompt: "整理我的文件。" } }
        }]
      })
    ], "zh-CN", t);

    const dynamic = catalog.filter((item) => item.extensionId !== undefined);
    expect(dynamic).toHaveLength(4);
    expect(dynamic[0]).toMatchObject({
      id: "extension:extension_source:mail",
      recommendationId: "mail",
      command: "mail-review",
      guide: "install",
      needsInstall: true,
      category: "email"
    });
    expect(dynamic[1]).toMatchObject({ guide: "enable", category: "photos" });
    expect(dynamic[2]).toMatchObject({ guide: "setup", category: "calendar" });
    expect(dynamic[3]).toMatchObject({ label: "整理文件", prompt: "整理我的文件。", category: "documents" });
    expect(dynamic[3]).not.toHaveProperty("command");
    expect(dynamic[3]?.owner).toEqual(resourceOwner());
  });

  it("uses host-owned categories across base and localized author text", () => {
    expect(extensionSuggestionCategory(recommendation("one", "Anything", "Please inspect this Git repo"))).toBe("development");
    expect(extensionSuggestionCategory({
      ...recommendation("two", "Anything", "Do this task"),
      locales: { "zh-CN": { label: "整理相册", prompt: "整理照片" } }
    })).toBe("photos");
    expect(extensionSuggestionCategory(recommendation("three", "Anything", "Do a specialized task"))).toBe("extensionTasks");
  });

  it("gives each Extension one ticket and enforces category, Extension, and guide quotas", () => {
    const catalog = buildHomeTaskCatalog([
      extension({
        id: "extension_many",
        enabled: false,
        recommendations: [
          recommendation("mail", "Mail", "Review email"),
          recommendation("docs", "Docs", "Review documents"),
          recommendation("code", "Code", "Review code")
        ]
      }),
      extension({
        id: "extension_install",
        installed: false,
        enabled: false,
        owner: sourceOwner(),
        recommendations: [recommendation("calendar", "Calendar", "Review calendar")]
      }),
      extension({
        id: "extension_ready",
        recommendations: [recommendation("photos", "Photos", "Review photos")]
      })
    ], "en", t);
    const batch = nextHomeTaskBatch(catalog, { newlyInstalledId: "extension_ready" }, null, 4, () => 0);
    const extensions = batch.items.filter((item) => item.extensionId !== undefined);

    expect(new Set(batch.items.map(({ category }) => category)).size).toBe(batch.items.length);
    expect(new Set(extensions.map(({ extensionId }) => extensionId)).size).toBe(extensions.length);
    expect(batch.items.filter(({ guide }) => guide !== undefined).length).toBeLessThanOrEqual(1);
    expect(batch.items.some(({ builtinId }) => builtinId !== undefined)).toBe(true);
    expect(batch.items.slice(0, 2).some(({ builtinId }) => builtinId !== undefined)).toBe(true);
    expect(batch.items[0]?.extensionId).toBe("extension_ready");
  });

  it("prefers recent Extensions modestly without reserving a permanent slot", () => {
    const catalog = buildHomeTaskCatalog([
      extension({
        id: "extension_recent",
        recommendations: [recommendation("mail", "Mail", "Review email")]
      }),
      extension({
        id: "extension_other",
        recommendations: [recommendation("photos", "Photos", "Review photos")]
      })
    ], "en", t);
    const promoted = nextHomeTaskBatch(catalog, { recentIds: ["extension_recent"] }, null, 4, () => 0);
    expect(promoted.items[0]?.extensionId).toBe("extension_recent");
  });

  it("trims withdrawn history, prefers unseen tasks, and excludes the adjacent visible batch", () => {
    const catalog = buildHomeTaskCatalog([
      extension({
        id: "extension_tasks",
        recommendations: [
          recommendation("mail", "Mail", "Review email"),
          recommendation("photos", "Photos", "Review photos")
        ]
      })
    ], "en", t);
    const first = nextHomeTaskBatch(catalog, {}, null, 2, seeded(7));
    const widened = markHomeTaskBatchDisplayed(first, 4);
    expect(visibleHomeTaskSuggestions(widened, 4)).toEqual(first.items);

    const withdrawnId = first.items[0]!.id;
    const withoutWithdrawn = catalog.filter(({ id }) => id !== withdrawnId);
    const next = nextHomeTaskBatch(withoutWithdrawn, {}, first, 2, seeded(8));
    expect(next.seenIds).not.toContain(withdrawnId);
    expect(next.items.some(({ id }) => first.items.slice(0, 2).some((item) => item.id === id))).toBe(false);
  });
});

function recommendation(id: string, label: string, prompt: string, command?: string) {
  return { id, label, prompt, ...(command === undefined ? {} : { command }) };
}

function extension(
  overrides: Partial<ExtensionCatalogEntryWithRecommendations> = {}
): ExtensionCatalogEntryWithRecommendations {
  return {
    id: "extension_default",
    revision: 3n,
    owner: resourceOwner(),
    source: "local",
    installed: true,
    installState: "installed",
    name: "Example",
    description: "Example Extension",
    enabled: true,
    sidebarSupported: false,
    sidebarVisible: false,
    tools: [],
    permissions: [],
    commands: [],
    setup: setup("notRequired"),
    useSupported: false,
    recommendations: [],
    ...overrides
  };
}

function setup(state: ExtensionCatalogEntryWithRecommendations["setup"]["state"]): ExtensionCatalogEntryWithRecommendations["setup"] {
  return { state, revision: state === "notRequired" ? 0n : 1n, fields: [] };
}

function resourceOwner(): Extract<ExtensionCatalogEntryWithRecommendations["owner"], { readonly kind: "resource" }> {
  return {
    kind: "resource",
    resourceId: "resource_example",
    discoveredRevision: `sha256:${"a".repeat(64)}`,
    resourceRevision: 2n
  };
}

function sourceOwner(): Extract<ExtensionCatalogEntryWithRecommendations["owner"], { readonly kind: "source" }> {
  return {
    kind: "source",
    sourceId: "extension_source_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceRevision: 2n,
    entryId: "extension_source_entry_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    contentRevision: `sha256:${"c".repeat(64)}`
  };
}

function seeded(seed: number): () => number {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}
