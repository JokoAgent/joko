import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectTypeScriptProject } from "./detection.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("detectTypeScriptProject", () => {
  it.each([
    ["tsconfig.json", "{}"],
    ["pnpm-workspace.yaml", "packages:\n  - packages/*\n"],
    ["lerna.json", "{}"],
    ["nx.json", "{}"],
    ["turbo.json", "{}"],
    ["rush.json", "{}"]
  ])("detects the project marker %s", async (file, contents) => {
    const root = await temporaryRoot();
    await writeFile(join(root, file), contents, "utf8");
    expect(detectTypeScriptProject(root)).toBe(true);
  });

  it.each(["dependencies", "devDependencies", "peerDependencies"])(
    "detects a TypeScript %s declaration",
    async (field) => {
      const root = await temporaryRoot();
      await writeFile(join(root, "package.json"), JSON.stringify({ [field]: { typescript: "5.9.3" } }), "utf8");
      expect(detectTypeScriptProject(root)).toBe(true);
    }
  );

  it("detects package workspaces and rejects ordinary or malformed packages", async () => {
    const monorepo = await temporaryRoot();
    await writeFile(join(monorepo, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }), "utf8");
    expect(detectTypeScriptProject(monorepo)).toBe(true);

    const ordinary = await temporaryRoot();
    await writeFile(join(ordinary, "package.json"), JSON.stringify({ dependencies: { react: "19" } }), "utf8");
    expect(detectTypeScriptProject(ordinary)).toBe(false);

    const malformed = await temporaryRoot();
    await writeFile(join(malformed, "package.json"), "{", "utf8");
    expect(detectTypeScriptProject(malformed)).toBe(false);
  });

  it("fails closed for absent, invalid, directory, and oversized package metadata", async () => {
    expect(detectTypeScriptProject("")).toBe(false);
    expect(detectTypeScriptProject("bad\0root")).toBe(false);

    const absent = await temporaryRoot();
    expect(detectTypeScriptProject(absent)).toBe(false);

    const directory = await temporaryRoot();
    await mkdir(join(directory, "package.json"));
    expect(detectTypeScriptProject(directory)).toBe(false);

    const oversized = await temporaryRoot();
    await writeFile(join(oversized, "package.json"), `{"padding":"${"x".repeat(1024 * 1024)}"}`, "utf8");
    expect(detectTypeScriptProject(oversized)).toBe(false);
  });

  it("freezes one root's detection result for later Session snapshots", async () => {
    const root = await temporaryRoot();
    expect(detectTypeScriptProject(root)).toBe(false);
    await writeFile(join(root, "tsconfig.json"), "{}", "utf8");
    expect(detectTypeScriptProject(root)).toBe(false);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-language-detection-"));
  roots.push(root);
  return root;
}
