import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { compareGeneratedTrees } from "./check-codegen.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generated contract freshness", () => {
  it("accepts equivalent checkout line endings", async () => {
    const [expected, actual] = await fixtureRoots();
    await writeFile(join(expected, "service_pb.ts"), "export const value = 1;\r\n", "utf8");
    await writeFile(join(actual, "service_pb.ts"), "export const value = 1;\n", "utf8");
    await expect(compareGeneratedTrees(expected, actual)).resolves.toEqual([]);
  });

  it("fails closed for stale, missing, and extra generated files", async () => {
    const [expected, actual] = await fixtureRoots();
    await writeFile(join(expected, "stale.ts"), "old\n", "utf8");
    await writeFile(join(actual, "stale.ts"), "new\n", "utf8");
    await writeFile(join(expected, "missing.ts"), "expected\n", "utf8");
    await writeFile(join(actual, "extra.ts"), "unexpected\n", "utf8");
    await expect(compareGeneratedTrees(expected, actual)).resolves.toEqual(["extra.ts", "missing.ts", "stale.ts"]);
  });
});

async function fixtureRoots(): Promise<readonly [string, string]> {
  const root = await mkdtemp(join(tmpdir(), "joko-codegen-fixture-"));
  roots.push(root);
  const expected = join(root, "expected");
  const actual = join(root, "actual");
  await Promise.all([mkdir(expected), mkdir(actual)]);
  return [expected, actual];
}
