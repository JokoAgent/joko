import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LspToolError } from "./errors.js";
import { TypeScriptLspBridge } from "./provider.js";
import { MAXIMUM_LSP_FILE_BYTES } from "./workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TypeScript LSP safety boundaries", () => {
  it("filters .gitignore and dependency discovery results without denying explicit source queries", async () => {
    const root = await temporaryRoot("ignore");
    await writeFile(join(root, ".gitignore"), "ignored.ts\nignored-dir/\n", "utf8");
    await writeFile(join(root, "visible.ts"), "export function visibleSymbol() {}\n", "utf8");
    await writeFile(join(root, "ignored.ts"), "export function hiddenSymbol() {}\n", "utf8");
    await mkdir(join(root, "ignored-dir"));
    await writeFile(join(root, "ignored-dir", "nested.ts"), "export function ignoredNestedSymbol() {}\n", "utf8");
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "dependency.ts"), "export function dependencySymbol() {}\n", "utf8");
    const bridge = new TypeScriptLspBridge();
    try {
      await expect(bridge.workspaceSymbol({ workspaceRoot: root, anchorFile: "visible.ts", query: "visibleSymbol" }))
        .resolves.toMatchObject({ items: [expect.objectContaining({ name: "visibleSymbol" })] });
      await expect(bridge.workspaceSymbol({ workspaceRoot: root, anchorFile: "visible.ts", query: "hiddenSymbol" }))
        .resolves.toMatchObject({ items: [] });
      await expect(bridge.workspaceSymbol({ workspaceRoot: root, anchorFile: "visible.ts", query: "ignoredNestedSymbol" }))
        .resolves.toMatchObject({ items: [] });
      await expect(bridge.workspaceSymbol({ workspaceRoot: root, anchorFile: "visible.ts", query: "dependencySymbol" }))
        .resolves.toMatchObject({ items: [] });
      await expect(bridge.hover({ workspaceRoot: root, file: "ignored.ts", line: 1, column: 17 }))
        .resolves.toMatchObject({ items: [expect.objectContaining({ display: expect.stringContaining("hiddenSymbol") })] });
    } finally {
      bridge.dispose();
    }
  });

  it("loads only requested dependency files and applies the total file limit to them", async () => {
    const root = await temporaryRoot("dependency-count");
    const packageRoot = join(root, "node_modules", "selected-lib");
    await mkdir(packageRoot, { recursive: true });
    for (let index = 0; index < 8; index += 1) {
      const unused = join(root, "node_modules", `unused-${index}`);
      await mkdir(unused);
      await writeFile(join(unused, "index.d.ts"), "export const unused: number;\n");
    }
    await writeFile(join(root, "main.ts"), 'import { selected } from "selected-lib";\nselected;\n');
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ types: "index.d.ts" }));
    await writeFile(join(packageRoot, "index.d.ts"), "export const selected: number;\n");
    const bridge = new TypeScriptLspBridge({ maximumWorkspaceFiles: 4 });
    const request = { workspaceRoot: root, file: "main.ts", line: 2, column: 1 };
    try {
      expect((await bridge.hover(request)).items[0]?.display).toContain("number");
      await writeFile(join(packageRoot, "index.d.ts"), 'export { selected } from "./first.js";\n');
      await writeFile(join(packageRoot, "first.d.ts"), 'export { selected } from "./second.js";\n');
      await writeFile(join(packageRoot, "second.d.ts"), "export const selected: string;\n");
      await expect(bridge.hover(request)).rejects.toMatchObject({ code: "FILE_LIMIT_EXCEEDED" });
    } finally { bridge.dispose(); }
  });

  it("does not follow package metadata or imports outside the authenticated workspace", async () => {
    const root = await temporaryRoot("dependency-boundary");
    const outside = await temporaryRoot("outside-dependency");
    await writeFile(join(outside, "index.d.ts"), 'export const secret: "outside-value";\n');
    const packageRoot = join(root, "node_modules", "outside-lib");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ types: join(outside, "index.d.ts") }));
    await writeFile(join(root, "main.ts"), 'import { secret } from "outside-lib";\nsecret;\n');
    const bridge = new TypeScriptLspBridge();
    const request = { workspaceRoot: root, file: "main.ts", line: 2, column: 1 };
    try {
      expect(JSON.stringify(await bridge.hover(request))).not.toContain("outside-value");
      expect((await bridge.gotoDefinition(request)).items).toEqual([]);
      await writeFile(join(root, "main.ts"), `import { secret } from ${JSON.stringify(join(outside, "index.d.ts").replaceAll("\\", "/"))};\nsecret;\n`);
      expect(JSON.stringify(await bridge.hover(request))).not.toContain("outside-value");
      expect((await bridge.gotoDefinition(request)).items).toEqual([]);
    } finally { bridge.dispose(); }
  });

  it("does not read linked dependency declarations", async () => {
    const root = await temporaryRoot("dependency-links");
    const outside = await temporaryRoot("linked-dependency");
    await writeFile(join(outside, "index.d.ts"), 'export const secret: "linked-value";\n');
    await mkdir(join(root, "node_modules"));
    const linked = join(root, "node_modules", "linked-lib");
    try {
      await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!isSymlinkUnavailable(error)) throw error;
      return;
    }
    await writeFile(join(root, "main.ts"), 'import { secret } from "linked-lib";\nsecret;\n');
    const bridge = new TypeScriptLspBridge();
    const request = { workspaceRoot: root, file: "main.ts", line: 2, column: 1 };
    try {
      expect(JSON.stringify(await bridge.hover(request))).not.toContain("linked-value");
      expect((await bridge.gotoDefinition(request)).items).toEqual([]);
      await expect(bridge.outline({ workspaceRoot: root, file: "node_modules/linked-lib/index.d.ts" }))
        .rejects.toMatchObject({ code: "FILE_UNSAFE" });
    } finally { bridge.dispose(); }
  });

  it("does not read oversized dependency declarations", async () => {
    const root = await temporaryRoot("dependency-size");
    const large = join(root, "node_modules", "large-lib");
    await mkdir(large, { recursive: true });
    await writeFile(join(large, "index.d.ts"), 'export const secret: "large-value";\n');
    await truncate(join(large, "index.d.ts"), MAXIMUM_LSP_FILE_BYTES + 1);
    await writeFile(join(root, "main.ts"), 'import { secret } from "large-lib";\nsecret;\n');
    const bridge = new TypeScriptLspBridge();
    const request = { workspaceRoot: root, file: "main.ts", line: 2, column: 1 };
    try {
      expect(JSON.stringify(await bridge.hover(request))).not.toContain("large-value");
      await expect(bridge.outline({ workspaceRoot: root, file: "node_modules/large-lib/index.d.ts" }))
        .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    } finally { bridge.dispose(); }
  });

  it("rejects traversal, invalid one-based positions, oversized files, and unsafe roots", async () => {
    const root = await temporaryRoot("bounds");
    await writeFile(join(root, "safe.ts"), "export const safe = 1;\n", "utf8");
    const outside = join(root, "..", `outside-${Date.now()}.ts`);
    await writeFile(outside, "export const outside = 1;\n", "utf8");
    roots.push(outside);
    const large = join(root, "large.ts");
    await writeFile(large, "");
    await truncate(large, MAXIMUM_LSP_FILE_BYTES + 1);
    const bridge = new TypeScriptLspBridge();
    try {
      await expect(bridge.hover({ workspaceRoot: root, file: outside, line: 1, column: 1 }))
        .rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
      await expect(bridge.hover({ workspaceRoot: root, file: "safe.ts", line: 0, column: 1 }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(bridge.hover({ workspaceRoot: root, file: "safe.ts", line: 99, column: 1 }))
        .rejects.toMatchObject({ code: "POSITION_OUT_OF_RANGE" });
      await expect(bridge.outline({ workspaceRoot: root, file: "large.ts" }))
        .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
      await expect(bridge.outline({ workspaceRoot: `${root}${sep}`, file: "safe.ts" }))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      bridge.dispose();
    }
  });

  it("rejects workspace and file symlinks when the host supports creating them", async () => {
    const root = await temporaryRoot("symlink");
    await writeFile(join(root, "target.ts"), "export const target = 1;\n", "utf8");
    const alias = resolve(`${root}-alias`);
    try {
      await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
      roots.push(alias);
      const bridge = new TypeScriptLspBridge();
      try {
        await expect(bridge.outline({ workspaceRoot: alias, file: "target.ts" }))
          .rejects.toMatchObject({ code: "WORKSPACE_UNSAFE" });
      } finally {
        bridge.dispose();
      }

      const actual = join(root, "actual");
      const linked = join(root, "linked");
      await mkdir(actual);
      await writeFile(join(actual, "inside.ts"), "export const inside = 1;\n", "utf8");
      await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
      const fileBridge = new TypeScriptLspBridge();
      try {
        await expect(fileBridge.outline({ workspaceRoot: root, file: "linked/inside.ts" }))
          .rejects.toMatchObject({ code: "FILE_UNSAFE" });
      } finally {
        fileBridge.dispose();
      }
    } catch (error) {
      if (!isSymlinkUnavailable(error)) throw error;
    }
  });

  it("enforces file-count and serialized-output ceilings", async () => {
    const root = await temporaryRoot("ceilings");
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(root, `file-${index}.ts`), `export function item${index}() {}\n`, "utf8");
    }
    const fileBound = new TypeScriptLspBridge({ maximumWorkspaceFiles: 2 });
    try {
      await expect(fileBound.workspaceSymbol({ workspaceRoot: root, anchorFile: "file-0.ts", query: "item" }))
        .rejects.toMatchObject({ code: "FILE_LIMIT_EXCEEDED" });
    } finally {
      fileBound.dispose();
    }

    const outputBound = new TypeScriptLspBridge({ maximumOutputCharacters: 500 });
    try {
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ include: ["*.ts"] }), "utf8");
      const result = await outputBound.workspaceSymbol({ workspaceRoot: root, anchorFile: "file-0.ts", query: "item", maxResults: 100_000 });
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(500);
    } finally {
      outputBound.dispose();
    }
  });

  it("honors AbortSignal, absolute deadlines, and idle workspace disposal", async () => {
    const root = await temporaryRoot("lifecycle");
    await writeFile(join(root, "index.ts"), "export const value = 1;\n", "utf8");
    const bridge = new TypeScriptLspBridge({ idleDisposeMs: 10 });
    try {
      const aborted = new AbortController();
      aborted.abort();
      await expect(bridge.outline({ workspaceRoot: root, file: "index.ts" }, { signal: aborted.signal }))
        .rejects.toMatchObject({ code: "ABORTED" });
      await expect(bridge.outline(
        { workspaceRoot: root, file: "index.ts" },
        { deadlineAtMs: Date.now() - 1 }
      )).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });

      await bridge.outline({ workspaceRoot: root, file: "index.ts" });
      expect(bridge.workspaceCount).toBe(1);
      await eventually(() => bridge.workspaceCount === 0);
    } finally {
      bridge.dispose();
    }
  });

  it("uses a typed error class with a bounded serialization surface", () => {
    const error = new LspToolError("INVALID_ARGUMENT", "Invalid value.", { field: "line", minimum: 1 });
    expect(error.toJSON()).toEqual({
      code: "INVALID_ARGUMENT",
      message: "Invalid value.",
      details: { field: "line", minimum: 1 }
    });
  });
});

async function temporaryRoot(label: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), `joko-lsp-${label}-`));
  roots.push(created);
  return realpath(created);
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not become true.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function isSymlinkUnavailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP");
}
