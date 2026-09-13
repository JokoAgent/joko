import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkWorkspaceBoundaries } from "./check-boundaries.js";

const cleanups: string[] = [];

afterEach(() => {
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace dependency boundary discovery", () => {
  it("discovers every pnpm workspace package and checks all dependency sections", () => {
    const root = fixture();
    packageJson(root, "apps/source", {
      name: "@joko/source",
      dependencies: { "@joko/runtime": "workspace:*" },
      devDependencies: { "@joko/testkit": "workspace:*" },
      peerDependencies: { "@joko/peer": "workspace:*" },
      optionalDependencies: { "@joko/optional": "workspace:*" }
    });
    for (const name of ["runtime", "testkit", "peer", "optional"]) {
      packageJson(root, `packages/${name}`, { name: `@joko/${name}` });
    }
    const allowlist = {
      "@joko/source": new Set(["@joko/runtime", "@joko/testkit", "@joko/peer", "@joko/optional"]),
      "@joko/runtime": new Set<string>(),
      "@joko/testkit": new Set<string>(),
      "@joko/peer": new Set<string>(),
      "@joko/optional": new Set<string>()
    };

    expect(checkWorkspaceBoundaries({ workspaceRoot: root, allowlist })).toEqual([]);
  });

  it("reports disallowed dependencies from every dependency section", () => {
    const root = fixture();
    packageJson(root, "apps/source", {
      name: "@joko/source",
      dependencies: { "@joko/runtime": "workspace:*" },
      devDependencies: { "@joko/testkit": "workspace:*" },
      peerDependencies: { "@joko/peer": "workspace:*" },
      optionalDependencies: { "@joko/optional": "workspace:*" }
    });
    for (const name of ["runtime", "testkit", "peer", "optional"]) {
      packageJson(root, `packages/${name}`, { name: `@joko/${name}` });
    }
    const allowlist = Object.fromEntries(
      ["source", "runtime", "testkit", "peer", "optional"].map((name) => [`@joko/${name}`, new Set<string>()])
    );

    expect(checkWorkspaceBoundaries({ workspaceRoot: root, allowlist })).toEqual(expect.arrayContaining([
      expect.stringContaining("@joko/runtime in dependencies"),
      expect.stringContaining("@joko/testkit in devDependencies"),
      expect.stringContaining("@joko/peer in peerDependencies"),
      expect.stringContaining("@joko/optional in optionalDependencies")
    ]));
  });

  it("fails closed for unmatched workspace patterns and unmapped packages", () => {
    const root = fixture(["apps/*", "packages/missing"]);
    packageJson(root, "apps/unmapped", { name: "@joko/unmapped" });

    expect(checkWorkspaceBoundaries({ workspaceRoot: root, allowlist: {} })).toEqual(expect.arrayContaining([
      expect.stringContaining("packages/missing matched no package manifests"),
      expect.stringContaining("@joko/unmapped is not present")
    ]));
  });

  it("honors pnpm exclusion patterns regardless of list order", () => {
    const root = fixture(["!apps/excluded", "apps/*"]);
    packageJson(root, "apps/included", { name: "@joko/included" });
    packageJson(root, "apps/excluded", { name: "@joko/excluded" });

    expect(checkWorkspaceBoundaries({
      workspaceRoot: root,
      allowlist: { "@joko/included": new Set<string>() }
    })).toEqual([]);
  });

  it("rejects unknown internal dependencies instead of treating them as external", () => {
    const root = fixture();
    packageJson(root, "apps/source", {
      name: "@joko/source",
      dependencies: { "@joko/not-in-workspace": "workspace:*" }
    });

    expect(checkWorkspaceBoundaries({
      workspaceRoot: root,
      allowlist: { "@joko/source": new Set(["@joko/not-in-workspace"]) }
    })).toContain("@joko/source declares unknown workspace dependency @joko/not-in-workspace in dependencies");
  });
});

function fixture(patterns: readonly string[] = ["apps/*", "packages/*"]): string {
  const root = mkdtempSync(join(tmpdir(), "joko-boundaries-"));
  cleanups.push(root);
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    `packages:\n${patterns.map((pattern) => `  - ${pattern}`).join("\n")}\n`,
    "utf8"
  );
  return root;
}

function packageJson(root: string, directory: string, manifest: Readonly<Record<string, unknown>>): void {
  const target = join(root, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), `${JSON.stringify({ private: true, ...manifest }, undefined, 2)}\n`, "utf8");
}
