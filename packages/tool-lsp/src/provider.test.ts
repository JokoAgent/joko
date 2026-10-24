import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TypeScriptLspBridge } from "./provider.js";
import { LSP_TOOL_ACTIONS } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TypeScript LSP bridge capabilities", () => {
  it.each(["tsconfig.json", "jsconfig.json"])("uses %s for position queries and switches between configured projects", async (configName) => {
    const fixture = await workspaceFixture();
    const extension = configName === "jsconfig.json" ? "js" : "ts";
    const main = 'import { configuredValue } from "@app/value";\nexport function run() { return configuredValue(); }';
    for (const name of ["first", "second"]) {
      await mkdir(join(fixture.root, name, "src"), { recursive: true });
      await writeFile(join(fixture.root, name, configName), JSON.stringify({
        compilerOptions: { allowJs: true, strict: true, module: "ESNext", moduleResolution: "Bundler",
          baseUrl: ".", paths: { "@app/*": ["src/*"] } }, include: [`**/*.${extension}`]
      }));
      await writeFile(join(fixture.root, name, `main.${extension}`), main);
      await writeFile(join(fixture.root, name, "src", `value.${extension}`),
        `export function configuredValue() { return "${name}"; }`);
    }
    const bridge = new TypeScriptLspBridge();
    try {
      for (const name of ["first", "second", "first"]) {
        const request = { workspaceRoot: fixture.root, file: `${name}/main.${extension}`, ...oneBased(main, "configuredValue()") };
        expect((await bridge.hover(request)).items[0]?.display).toContain("string");
        expect((await bridge.gotoDefinition(request)).items.some((item) => item.location.path === `${name}/src/value.${extension}`)).toBe(true);
        const declaration = { workspaceRoot: fixture.root, file: `${name}/src/value.${extension}`, line: 1, column: 17 };
        expect((await bridge.findReferences(declaration)).items.some((item) => item.location.path === `${name}/main.${extension}`)).toBe(true);
        expect((await bridge.incomingCalls(declaration)).items.some((item) => item.from.location.path === `${name}/main.${extension}`)).toBe(true);
      }
    } finally { bridge.dispose(); }
  });

  it("refreshes a cached workspace after additions, renames, deletions and ignore changes", async () => {
    const fixture = await workspaceFixture();
    await writeFile(join(fixture.root, "tsconfig.json"), JSON.stringify({ include: ["**/*.ts"] }));
    const bridge = new TypeScriptLspBridge();
    const symbols = () => bridge.workspaceSymbol({ workspaceRoot: fixture.root, anchorFile: "main.ts", query: "addedValue" });
    try {
      expect((await symbols()).items).toEqual([]);
      await mkdir(join(fixture.root, "new"));
      await writeFile(join(fixture.root, "new", "added.ts"), "export const addedValue = 1;");
      expect((await symbols()).items.map((item) => item.location.path)).toEqual(["new/added.ts"]);
      expect((await bridge.hover({ workspaceRoot: fixture.root, file: "new/added.ts", line: 1, column: 14 })).items).toHaveLength(1);
      await rename(join(fixture.root, "new", "added.ts"), join(fixture.root, "renamed.ts"));
      expect((await symbols()).items.map((item) => item.location.path)).toEqual(["renamed.ts"]);
      await expect(bridge.outline({ workspaceRoot: fixture.root, file: "new/added.ts" })).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
      await writeFile(join(fixture.root, ".gitignore"), "renamed.ts\n");
      expect((await symbols()).items).toEqual([]);
      await expect(bridge.outline({ workspaceRoot: fixture.root, file: "renamed.ts" })).rejects.toMatchObject({ code: "FILE_IGNORED" });
      await writeFile(join(fixture.root, ".gitignore"), "");
      expect((await symbols()).items.map((item) => item.location.path)).toEqual(["renamed.ts"]);
      await rm(join(fixture.root, "renamed.ts"));
      expect((await symbols()).items).toEqual([]);
      expect(bridge.workspaceCount).toBe(1);
    } finally { bridge.dispose(); }
  });
  it("filters declaration locations and selects the anchor's configured project for empty and named queries", async () => {
    const fixture = await workspaceFixture();
    for (const name of ["first", "second"]) {
      await mkdir(join(fixture.root, name));
      await writeFile(join(fixture.root, name, "tsconfig.json"), JSON.stringify({ files: ["main.ts", "extra.ts"] }));
      await writeFile(join(fixture.root, name, "main.ts"), `export const ${name}Main = 1;`);
      await writeFile(join(fixture.root, name, "extra.ts"), `export const ${name}Extra = 2;`);
    }
    const bridge = new TypeScriptLspBridge();
    try {
      const position = oneBased(fixture.librarySource, "greet");
      const request = { workspaceRoot: fixture.root, file: "lib.ts", ...position };
      const without = await bridge.findReferences(request);
      const withDeclaration = await bridge.findReferences({ ...request, includeDeclaration: true });
      expect(without.items.some((item) => item.location.path === "lib.ts" && item.location.range.start.line === position.line)).toBe(false);
      expect(withDeclaration.items.some((item) => item.location.path === "lib.ts" && item.location.range.start.line === position.line)).toBe(true);
      const first = await bridge.workspaceSymbol({ workspaceRoot: fixture.root, anchorFile: "first/main.ts" });
      expect(first.items.map((item) => item.name)).toEqual(expect.arrayContaining(["firstMain", "firstExtra"]));
      expect(first.items.every((item) => item.location.path.startsWith("first/"))).toBe(true);
      const second = await bridge.workspaceSymbol({ workspaceRoot: fixture.root, anchorFile: "second/main.ts", query: "" });
      expect(second.items.map((item) => item.name)).toEqual(expect.arrayContaining(["secondMain", "secondExtra"]));
      expect(second.items.every((item) => item.location.path.startsWith("second/"))).toBe(true);
      expect((await bridge.workspaceSymbol({ workspaceRoot: fixture.root, anchorFile: "second/main.ts", query: "first" })).items).toEqual([]);
      await expect(bridge.workspaceSymbol({ workspaceRoot: fixture.root, anchorFile: "../outside.ts" })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    } finally { bridge.dispose(); }
  });
  it("advertises the six stable bridge actions", () => {
    expect(LSP_TOOL_ACTIONS).toEqual([
      "hover",
      "goto_definition",
      "find_references",
      "outline",
      "workspace_symbol",
      "incoming_calls"
    ]);
  });

  it("serves hover, definition, references, outline, workspace symbols, and incoming calls", async () => {
    const fixture = await workspaceFixture();
    const bridge = new TypeScriptLspBridge({ idleDisposeMs: 5_000 });
    try {
      const callPosition = oneBased(fixture.mainSource, "greet");
      const declarationPosition = oneBased(fixture.librarySource, "greet");

      const hover = await bridge.hover({
        workspaceRoot: fixture.root,
        file: "main.ts",
        ...callPosition
      });
      expect(hover.items).toHaveLength(1);
      expect(hover.items[0]?.display).toContain("greet");
      expect(hover.items[0]?.range.start.line).toBe(callPosition.line);

      const definition = await bridge.gotoDefinition({
        workspaceRoot: fixture.root,
        file: "main.ts",
        ...callPosition
      });
      expect(definition.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "greet", location: expect.objectContaining({ path: "lib.ts" }) })
      ]));

      const references = await bridge.findReferences({
        workspaceRoot: fixture.root,
        file: "lib.ts",
        ...declarationPosition
      });
      expect(references.items.some((item) => item.location.path === "main.ts")).toBe(true);

      const outline = await bridge.outline({ workspaceRoot: fixture.root, file: "lib.ts" });
      expect(outline.items.map((item) => item.name)).toEqual(expect.arrayContaining(["User", "greet", "format"]));
      expect(outline.items.every((item) => item.location.path === "lib.ts")).toBe(true);

      const symbols = await bridge.workspaceSymbol({ workspaceRoot: fixture.root, anchorFile: "main.ts", query: "greet" });
      expect(symbols.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "greet", location: expect.objectContaining({ path: "lib.ts" }) })
      ]));

      const incoming = await bridge.incomingCalls({
        workspaceRoot: fixture.root,
        file: "lib.ts",
        ...declarationPosition
      });
      expect(incoming.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          from: expect.objectContaining({ name: "run", location: expect.objectContaining({ path: "main.ts" }) })
        })
      ]));
      expect(bridge.workspaceCount).toBe(1);
    } finally {
      bridge.dispose();
    }
  });

  it("returns a structured bridge envelope without leaking internal failures", async () => {
    const fixture = await workspaceFixture();
    const bridge = new TypeScriptLspBridge();
    try {
      const response = await bridge.call({
        action: "hover",
        workspaceRoot: fixture.root,
        file: "main.ts",
        line: 0,
        column: 1
      });
      expect(response).toEqual({
        ok: false,
        error: expect.objectContaining({ code: "INVALID_ARGUMENT" })
      });
      expect(JSON.stringify(response)).not.toContain(fixture.root);
    } finally {
      bridge.dispose();
    }
  });
});

async function workspaceFixture() {
  const created = await mkdtemp(join(tmpdir(), "joko-lsp-capabilities-"));
  roots.push(created);
  const root = await realpath(created);
  const librarySource = [
    "export interface User { name: string; }",
    "export function greet(user: User): string {",
    "  return format(user.name);",
    "}",
    "export function format(value: string): string {",
    "  return `Hello ${value}`;",
    "}",
    ""
  ].join("\n");
  const mainSource = [
    'import { greet } from "./lib.js";',
    "export function run(): string {",
    '  return greet({ name: "Ada" });',
    "}",
    ""
  ].join("\n");
  await writeFile(join(root, "lib.ts"), librarySource, "utf8");
  await writeFile(join(root, "main.ts"), mainSource, "utf8");
  return { root, librarySource, mainSource };
}

function oneBased(source: string, needle: string): { readonly line: number; readonly column: number } {
  const offset = source.indexOf(needle);
  if (offset < 0) throw new Error("Fixture token was not found.");
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}
