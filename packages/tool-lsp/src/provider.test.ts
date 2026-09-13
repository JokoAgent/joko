import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

      const symbols = await bridge.workspaceSymbol({ workspaceRoot: fixture.root, query: "greet" });
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
