import { describe, expect, it } from "vitest";

import { parseExtensionSurfaceManifest } from "./extension-surface-manifest.js";

const entries = ["extensions/review.ts", "extensions/search/index.js"];
const files = [...entries, "ui/review/index.html", "ui/review/app.js", "ui/search.html"];

describe("Extension surface manifest", () => {
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
