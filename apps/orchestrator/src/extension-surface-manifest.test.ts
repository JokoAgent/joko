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
            mainView: { html: "ui/review/index.html", title: "Review", icon: "layout" }
          }]
        }
      }
    }, entries, files)).toEqual([{
      entry: "extensions/review.ts",
      mainView: { html: "ui/review/index.html", title: "Review", icon: "layout" }
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
    ["unknown icon", { schemaVersion: 1, extensions: [{ entry: "extensions/review.ts", mainView: { html: "ui/review/index.html", icon: "reference-mark" } }] }]
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
