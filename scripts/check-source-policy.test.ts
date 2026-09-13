import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkSourcePolicy } from "./check-source-policy.js";

const cleanups: string[] = [];

afterEach(() => {
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("source policy boundaries", () => {
  it("allows the generated contracts as the Web UI workspace dependency", () => {
    const root = fixture();
    source(root, "apps/web/src/view.ts", 'import type { Snapshot } from "@joko/contracts";\nexport type View = Snapshot;\n');

    expect(checkSourcePolicy({ workspaceRoot: root })).toEqual([]);
  });

  it("rejects direct Web imports from implementation packages", () => {
    const root = fixture();
    source(root, "apps/web/src/view.ts", 'import { Store } from "@joko/store";\nvoid Store;\n');

    expect(checkSourcePolicy({ workspaceRoot: root })).toEqual([
      expect.stringContaining("Web UI may import only @joko/contracts")
    ]);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "joko-source-policy-"));
  cleanups.push(root);
  return root;
}

function source(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents, "utf8");
}
