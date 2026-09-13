import { describe, expect, it } from "vitest";
import type { ResourceDraft } from "./model.js";
import { normalizeResourceDraft, resourceDraftIsValid } from "./resource-draft.js";

const BASE: Omit<ResourceDraft, "source"> = {
  backendId: " pi ",
  kind: "package",
  scope: "managed",
  name: " Example ",
  version: " 1.0.0 "
};

describe("Pi resource draft validation", () => {
  it("normalizes local, npm, and Git source-specific fields", () => {
    expect(normalizeResourceDraft({ ...BASE, source: { kind: "local", serverPath: " D:\\resources\\skill " } })).toMatchObject({
      backendId: "pi",
      name: "Example",
      version: "1.0.0",
      source: { kind: "local", serverPath: "D:\\resources\\skill" }
    });
    expect(normalizeResourceDraft({ ...BASE, source: { kind: "npm", packageName: " @joko/example ", versionSpec: " ^1.2.0 " } })?.source).toEqual({
      kind: "npm",
      packageName: "@joko/example",
      versionSpec: "^1.2.0"
    });
    expect(normalizeResourceDraft({ ...BASE, source: { kind: "git", repositoryUrl: " https://example.test/org/repo.git ", ref: " main ", subdirectory: " ./packages\\agent " } })?.source).toEqual({
      kind: "git",
      repositoryUrl: "https://example.test/org/repo.git",
      ref: "main",
      subdirectory: "packages/agent"
    });
  });

  it("allows npm and Git only for package resources", () => {
    expect(resourceDraftIsValid({ ...BASE, kind: "skill", source: { kind: "npm", packageName: "example", versionSpec: "" } })).toBe(false);
    expect(resourceDraftIsValid({ ...BASE, kind: "prompt", source: { kind: "git", repositoryUrl: "https://example.test/org/repo.git", ref: "", subdirectory: "" } })).toBe(false);
    expect(resourceDraftIsValid({ ...BASE, kind: "skill", source: { kind: "local", serverPath: "D:\\skills\\example" } })).toBe(true);
    expect(resourceDraftIsValid({ ...BASE, kind: "theme", source: { kind: "local", serverPath: "D:\\themes\\night.json" } })).toBe(true);
  });

  it("rejects invalid package coordinates and credential-bearing Git URLs", () => {
    expect(resourceDraftIsValid({ ...BASE, source: { kind: "npm", packageName: "Not a package", versionSpec: "latest" } })).toBe(false);
    expect(resourceDraftIsValid({ ...BASE, source: { kind: "npm", packageName: "example", versionSpec: "https://registry.test/pkg" } })).toBe(false);
    expect(resourceDraftIsValid({ ...BASE, source: { kind: "git", repositoryUrl: "https://token@example.test/org/repo.git", ref: "", subdirectory: "" } })).toBe(false);
    expect(resourceDraftIsValid({ ...BASE, source: { kind: "git", repositoryUrl: "https://example.test/org/repo.git", ref: "-unsafe", subdirectory: "" } })).toBe(false);
    expect(resourceDraftIsValid({ ...BASE, source: { kind: "git", repositoryUrl: "https://example.test/org/repo.git", ref: "main", subdirectory: "../escape" } })).toBe(false);
  });
});
