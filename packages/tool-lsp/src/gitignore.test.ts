import { describe, expect, it } from "vitest";

import { isGitIgnored, parseGitIgnore } from "./gitignore.js";

describe(".gitignore projection", () => {
  it("supports ordered negation, anchored rules, recursive globs, and nested bases", () => {
    const rootRules = parseGitIgnore([
      "*.generated.ts",
      "!keep.generated.ts",
      "/root-only.ts",
      "build/**",
      ""
    ].join("\n"), "");
    expect(isGitIgnored("nested/drop.generated.ts", false, rootRules)).toBe(true);
    expect(isGitIgnored("keep.generated.ts", false, rootRules)).toBe(false);
    expect(isGitIgnored("root-only.ts", false, rootRules)).toBe(true);
    expect(isGitIgnored("nested/root-only.ts", false, rootRules)).toBe(false);
    expect(isGitIgnored("build/output/index.ts", false, rootRules)).toBe(true);

    const nestedRules = [...rootRules, ...parseGitIgnore("private/\n", "src")];
    expect(isGitIgnored("src/private", true, nestedRules)).toBe(true);
    expect(isGitIgnored("src/private/key.ts", false, nestedRules)).toBe(true);
    expect(isGitIgnored("private/key.ts", false, nestedRules)).toBe(false);
  });
});
