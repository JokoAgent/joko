import { describe, expect, it } from "vitest";

import { parseExtensionSurfaceManifest, validateExtensionRecommendations } from "./extension-surface-manifest.js";

const entries = ["extensions/review.ts", "extensions/search/index.js"];
const files = [...entries, "ui/review/index.html", "ui/review/app.js", "ui/search.html"];

describe("Extension surface manifest", () => {
  it("requires an explicit device sync capability and supports its resident runtime without model tools", () => {
    const manifest = (runtime: unknown) => ({ joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{ entry: entries[0], runtime }] } } });
    const runtime = { html: "ui/review/index.html", tools: [], deviceSync: true };
    expect(parseExtensionSurfaceManifest(manifest(runtime), entries, files)[0]?.runtime).toEqual(runtime);
    for (const deviceSync of [false, {}, "true"]) expect(() => parseExtensionSurfaceManifest(manifest({ ...runtime, deviceSync }), entries, files)).toThrow();
  });
  it("requires an explicit targets declaration together with managed tasks", () => {
    const manifest = (runtime: unknown) => ({ joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{ entry: entries[0], runtime }] } } });
    const runtime = { html: "ui/review/index.html", tools: [], tasks: {}, targets: true };
    expect(parseExtensionSurfaceManifest(manifest(runtime), entries, files)[0]?.runtime).toEqual(runtime);
    for (const invalid of [{ ...runtime, tasks: undefined }, { ...runtime, targets: false }, { ...runtime, targets: {} }]) {
      expect(() => parseExtensionSurfaceManifest(manifest(invalid), entries, files)).toThrow();
    }
  });
  it("admits task/text runtimes without tools and treats preferences visibility as presentation only", () => {
    const manifest = (runtime: unknown) => ({ joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{ entry: entries[0], runtime }] } } });
    const runtime = { html: "ui/review/index.html", tools: [], card: {}, tasks: { hidden: true }, text: { oneshot: true }, showTaskPreferences: false };
    expect(parseExtensionSurfaceManifest(manifest(runtime), entries, files)[0]?.runtime).toEqual(runtime);
    for (const invalid of [{ ...runtime, tasks: { hidden: false } }, { ...runtime, tasks: { hidden: true, allTasks: true } }, { ...runtime, text: { oneshot: false } },
      { ...runtime, showTaskPreferences: "false" }, { html: runtime.html, tools: [], card: {} }]) expect(() => parseExtensionSurfaceManifest(manifest(invalid), entries, files)).toThrow();
  });
  it("binds resident tools, cards, mail readers and optional continuation to inspected files", () => {
    const runtime = { html: "ui/review/index.html", tools: [{ name: "read", description: "Read mail", inputSchema: { type: "object" }, readOnly: true }], card: { externalLinks: true }, mail: true,
      mailReader: { tool: "read", hosts: ["mail.example.test"], markRead: true }, agent: true };
    const manifest = (value: unknown) => ({ joko: { extensionSurfaces: { schemaVersion: 1, extensions: [{ entry: entries[0], runtime: value }] } } });
    expect(parseExtensionSurfaceManifest(manifest(runtime), entries, files)[0]?.runtime).toEqual(runtime);
    for (const invalid of [{ ...runtime, html: "ui/missing.html" }, { ...runtime, tools: [...runtime.tools, ...runtime.tools] },
      { ...runtime, mail: false }, { ...runtime, agent: false }, { ...runtime, mailReader: { tool: "undeclared", hosts: ["mail.example.test"] } },
      { ...runtime, tools: [{ ...runtime.tools[0], inputSchema: { type: "array" } }] }, { ...runtime, privilegedNode: true }]) {
      expect(() => parseExtensionSurfaceManifest(manifest(invalid), entries, files)).toThrow();
    }
    const base = parseExtensionSurfaceManifest(manifest({ html: runtime.html, tools: runtime.tools, card: {} }), entries, files)[0]?.runtime;
    expect(base?.agent).toBeUndefined(); expect(base?.mail).toBeUndefined();
  });
  it("admits a resident event publisher only with inspected HTML and unique bounded declarations", () => {
    const binding = { entry: entries[0], routineEvents: { html: "ui/review/index.html", events: [{ type: "changed", name: "Changed", fields: ["scope"] }] } };
    const manifest = (value: unknown) => ({ joko: { extensionSurfaces: { schemaVersion: 1, extensions: [value] } } });
    expect(parseExtensionSurfaceManifest(manifest(binding), entries, files)).toEqual([binding]);
    for (const routineEvents of [{ ...binding.routineEvents, html: "ui/missing/index.html" },
      { ...binding.routineEvents, events: [binding.routineEvents.events[0], binding.routineEvents.events[0]] },
      { ...binding.routineEvents, events: [{ type: "changed", name: "Changed", fields: ["scope", "scope"] }] }]) {
      expect(() => parseExtensionSurfaceManifest(manifest({ ...binding, routineEvents }), entries, files)).toThrow();
    }
  });
  it("accepts the single strict v1 shape and exact discovered entry", () => {
    expect(parseExtensionSurfaceManifest({
      joko: {
        extensionSurfaces: {
          schemaVersion: 1,
          extensions: [{
            entry: "extensions/review.ts",
            mainView: { html: "ui/review/index.html", title: "Review", icon: "layout" },
            library: { schemaVersion: 1 }
          }]
        }
      }
    }, entries, files)).toEqual([{
      entry: "extensions/review.ts",
      mainView: { html: "ui/review/index.html", title: "Review", icon: "layout" },
      library: { schemaVersion: 1 }
    }]);
  });

  it("accepts a Library-only declaration bound to a discovered Extension", () => {
    expect(parseExtensionSurfaceManifest({
      joko: {
        extensionSurfaces: {
          schemaVersion: 1,
          extensions: [{ entry: "extensions/search/index.js", library: { schemaVersion: 1 } }]
        }
      }
    }, entries, files)).toEqual([{
      entry: "extensions/search/index.js",
      library: { schemaVersion: 1 }
    }]);
  });

  it("accepts a recommendation-only binding with exact commands and localized author text", () => {
    expect(parseExtensionSurfaceManifest({
      joko: {
        extensionSurfaces: {
          schemaVersion: 1,
          extensions: [{
            entry: "extensions/review.ts",
            recommendations: [{
              id: "review-changes",
              label: "Review changes",
              prompt: "Review the current changes.\nCall out risky behavior.",
              command: "review",
              locales: {
                "zh-CN": { label: "审查改动", prompt: "审查当前改动。\n指出有风险的行为。" }
              }
            }]
          }]
        }
      }
    }, entries, files)).toEqual([{
      entry: "extensions/review.ts",
      recommendations: [{
        id: "review-changes",
        label: "Review changes",
        prompt: "Review the current changes.\nCall out risky behavior.",
        command: "review",
        locales: {
          "zh-CN": { label: "审查改动", prompt: "审查当前改动。\n指出有风险的行为。" }
        }
      }]
    }]);
  });

  it("fails an invalid optional recommendation set closed without dropping valid surfaces", () => {
    expect(parseExtensionSurfaceManifest({
      joko: {
        extensionSurfaces: {
          schemaVersion: 1,
          extensions: [{
            entry: "extensions/review.ts",
            mainView: { html: "ui/review/index.html" },
            recommendations: [{ id: "review", label: "Review", prompt: "Review this", command: "not/a-slug" }]
          }]
        }
      }
    }, entries, files)).toEqual([{
      entry: "extensions/review.ts",
      mainView: { html: "ui/review/index.html" },
      recommendations: []
    }]);
  });

  it("validates bounded exact recommendation sets and preserves an explicit empty withdrawal", () => {
    expect(validateExtensionRecommendations([])).toEqual({ ok: true, items: [] });
    expect(parseExtensionSurfaceManifest({
      joko: {
        extensionSurfaces: {
          schemaVersion: 1,
          extensions: [{ entry: "extensions/review.ts", recommendations: [] }]
        }
      }
    }, entries, files)).toEqual([{ entry: "extensions/review.ts", recommendations: [] }]);
    for (const invalid of [
      [{ id: "same", label: "One", prompt: "First" }, { id: "same", label: "Two", prompt: "Second" }],
      [{ id: "upper-CASE", label: "Label", prompt: "Prompt" }],
      [{ id: "task", label: "Bad\nlabel", prompt: "Prompt" }],
      [{ id: "task", label: "Label", prompt: "Bad\rprompt" }],
      [{ id: "task", label: "Label", prompt: "Prompt", locales: { fr: { label: "Tâche", prompt: "Faire" } } }],
      [{ id: "task", label: "Label", prompt: "Prompt", extra: true }],
      Array.from({ length: 25 }, (_unused, index) => ({ id: `task-${index}`, label: "Label", prompt: "Prompt" })),
      [{ id: "task", label: "Label", prompt: "x".repeat(8_001) }],
      Array.from({ length: 9 }, (_unused, index) => ({ id: `task-${index}`, label: "Label", prompt: "x".repeat(7_500) }))
    ]) expect(validateExtensionRecommendations(invalid).ok).toBe(false);
  });

  it("treats packages without a Joko declaration as having no surfaces", () => {
    expect(parseExtensionSurfaceManifest({ name: "headless" }, entries, files)).toEqual([]);
  });

  it.each([
    ["unknown schema", { schemaVersion: 2, extensions: [] }],
    ["unknown manifest key", { schemaVersion: 1, extensions: [], legacyViews: [] }],
    ["empty declarations", { schemaVersion: 1, extensions: [] }],
    ["entry alias", { schemaVersion: 1, extensions: [{ entry: "./extensions/review.ts", mainView: { html: "ui/review/index.html" } }] }],
    ["undiscovered entry", { schemaVersion: 1, extensions: [{ entry: "extensions/other.ts", mainView: { html: "ui/review/index.html" } }] }],
    ["escaping HTML", { schemaVersion: 1, extensions: [{ entry: "extensions/review.ts", mainView: { html: "../index.html" } }] }],
    ["root HTML", { schemaVersion: 1, extensions: [{ entry: "extensions/review.ts", mainView: { html: "index.html" } }] }],
    ["unknown icon", { schemaVersion: 1, extensions: [{ entry: "extensions/review.ts", mainView: { html: "ui/review/index.html", icon: "reference-mark" } }] }],
    ["empty capability declaration", { schemaVersion: 1, extensions: [{ entry: "extensions/review.ts" }] }],
    ["boolean Library alias", { schemaVersion: 1, extensions: [{ entry: "extensions/review.ts", library: true }] }],
    ["unknown Library version", { schemaVersion: 1, extensions: [{ entry: "extensions/review.ts", library: { schemaVersion: 2 } }] }],
    ["unknown Library field", { schemaVersion: 1, extensions: [{ entry: "extensions/review.ts", library: { schemaVersion: 1, legacyPath: true } }] }]
  ])("rejects %s", (_label, extensionSurfaces) => {
    expect(() => parseExtensionSurfaceManifest({ joko: { extensionSurfaces } }, entries, files)).toThrow();
  });

  it("rejects duplicate declarations and non-regular HTML", () => {
    const declaration = { entry: "extensions/review.ts", mainView: { html: "ui/review/index.html" } };
    expect(() => parseExtensionSurfaceManifest({
      joko: { extensionSurfaces: { schemaVersion: 1, extensions: [declaration, declaration] } }
    }, entries, files)).toThrow(/more than once/u);
    expect(() => parseExtensionSurfaceManifest({
      joko: { extensionSurfaces: { schemaVersion: 1, extensions: [declaration] } }
    }, entries, entries)).toThrow(/not an inspected regular/u);
  });
});
