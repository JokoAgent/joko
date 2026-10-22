import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { WorkspaceTextPreviewCache, workspacePreviewConnectionFailure } from "./workspace-text-preview-cache.js";

const text = (path: string, value = path) => ({ path, name: path, kind: "text" as const, text: value, revision: "revision-1", truncated: false });

describe("workspace text preview cache", () => {
  it("isolates source/workspace/path and never keeps media authority", () => {
    const cache = new WorkspaceTextPreviewCache();
    cache.set("source-a", "workspace", text("a.ts"));
    expect(cache.get("source-b", "workspace", "a.ts")).toBeUndefined();
    expect(cache.get("source-a", "another-workspace", "a.ts")).toBeUndefined();
    cache.set("source-a", "workspace", { ...text("secret.svg"), blobId: "private-blob" });
    expect(cache.get("source-a", "workspace", "secret.svg")).toBeUndefined();
    const copy = cache.get("source-a", "workspace", "a.ts")!;
    Reflect.set(copy, "text", "changed by consumer");
    expect(cache.get("source-a", "workspace", "a.ts")?.text).toBe("a.ts");
  });

  it("evicts least recently used text at eight items and sixteen MiB", () => {
    const cache = new WorkspaceTextPreviewCache();
    for (let index = 0; index < 8; index++) cache.set("scope", "workspace", text(String(index)));
    cache.get("scope", "workspace", "0"); cache.set("scope", "workspace", text("8"));
    expect(cache.get("scope", "workspace", "1")).toBeUndefined();
    expect(cache.get("scope", "workspace", "0")).toBeDefined();
    cache.set("scope", "workspace", text("large", "x".repeat(8 * 1024 * 1024)));
    expect(cache.get("scope", "workspace", "0")).toBeUndefined();
    expect(cache.get("scope", "workspace", "large")).toBeDefined();
    cache.set("scope", "workspace", text("too-large", "x".repeat(8 * 1024 * 1024 + 1)));
    expect(cache.get("scope", "workspace", "too-large")).toBeUndefined();
  });

  it("invalidates renamed/deleted parent paths without clearing another workspace", () => {
    const cache = new WorkspaceTextPreviewCache();
    for (const path of ["src/a.ts", "src/nested/b.ts", "src-other/a.ts"]) cache.set("scope", "workspace", text(path));
    cache.set("scope", "other", text("src/a.ts"));
    const before = cache.revision; cache.invalidate("workspace", "src");
    expect(cache.revision).toBeGreaterThan(before);
    expect(cache.get("scope", "workspace", "src/a.ts")).toBeUndefined();
    expect(cache.get("scope", "workspace", "src/nested/b.ts")).toBeUndefined();
    expect(cache.get("scope", "workspace", "src-other/a.ts")).toBeDefined();
    expect(cache.get("scope", "other", "src/a.ts")).toBeDefined();
    cache.clear(); expect(cache.get("scope", "other", "src/a.ts")).toBeUndefined();
  });

  it("retains a preview only for connection failures, never denied/deleted/aborted reads", () => {
    expect(workspacePreviewConnectionFailure(new ConnectError("offline", Code.Unavailable))).toBe(true);
    expect(workspacePreviewConnectionFailure(new ConnectError("slow", Code.DeadlineExceeded))).toBe(true);
    for (const code of [Code.PermissionDenied, Code.Unauthenticated, Code.NotFound, Code.Canceled, Code.Internal]) {
      expect(workspacePreviewConnectionFailure(new ConnectError("unavailable", code))).toBe(false);
    }
  });
});
