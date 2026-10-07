import { create } from "@bufbuild/protobuf";
import { ArtifactSchema, BlobRefSchema, FileKind, FileRevisionSchema, WorkspaceEntrySchema } from "@joko/contracts";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { mobileFilesDateLabel, mobileFilesGeneratedItems, mobileFilesGridColumns, mobileFilesPathLevels, mobileFilesWorkspaceItems, sortMobileWorkspaceEntries } from "./mobile-files-presentation";

function entry(name: string, kind: FileKind, bytes: bigint, modified: bigint) {
  return create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: name, displayName: name, kind,
    revision: create(FileRevisionSchema, { byteSize: bytes, opaqueRevision: name, modifiedAt: create(TimestampSchema, { seconds: modified }) }) });
}
describe("Files browse presentation", () => {
  it("keeps exact source objects, folders first, natural names and descending date or file sizes without number precision loss", () => {
    const entries = [entry("image10.png", FileKind.REGULAR, 9_007_199_254_740_993n, 30n), entry("z", FileKind.DIRECTORY, 999n, 40n),
      entry("image2.png", FileKind.REGULAR, 9_007_199_254_740_992n, 50n), entry("a", FileKind.DIRECTORY, 1n, 20n)];
    const names = (sort: "name" | "mtime" | "size") => sortMobileWorkspaceEntries(entries, sort).map((value) => value.displayName);
    expect(names("name")).toEqual(["a", "z", "image2.png", "image10.png"]);
    expect(names("mtime")).toEqual(["z", "a", "image2.png", "image10.png"]);
    expect(names("size")).toEqual(["a", "z", "image10.png", "image2.png"]);
    const items = mobileFilesWorkspaceItems(entries, "size", "en", 0);
    expect(items[2]!.source).toEqual({ kind: "workspace-entry", entry: entries[0] });
    expect((items[2]!.source as { entry: unknown }).entry).toBe(entries[0]); expect(entries[0]!.displayName).toBe("image10.png");
    const artifacts = [create(ArtifactSchema, { artifactId: "old", title: "chart", createdAt: create(TimestampSchema, { seconds: 1n }), blob: create(BlobRefSchema, { byteSize: 99n }) }),
      create(ArtifactSchema, { artifactId: "new", title: "chart", createdAt: create(TimestampSchema, { seconds: 2n }), blob: create(BlobRefSchema, { byteSize: 1n }) })];
    expect(mobileFilesGeneratedItems(artifacts, "mtime", "en", 0).map((item) => item.key)).toEqual(["artifact:new", "artifact:old"]);
    expect(mobileFilesGeneratedItems(artifacts, "size", "en", 0).map((item) => item.key)).toEqual(["artifact:old", "artifact:new"]);
  });
  it("builds canonical current-to-root navigation and adapts column counts while formatting observed metadata", () => {
    expect(mobileFilesPathLevels("src/images", "project")).toEqual([{ path: "src/images", label: "images", current: true },
      { path: "src", label: "src", current: false }, { path: "", label: "project", current: false }]);
    expect(mobileFilesPathLevels("", "project")).toEqual([{ path: "", label: "project", current: true }]);
    expect([320, 600, 800, 1200].map(mobileFilesGridColumns)).toEqual([2, 4, 6, 6]);
    const today = new Date(2026, 9, 5, 10); const yesterday = new Date(2026, 9, 4, 9);
    expect(mobileFilesDateLabel({ seconds: BigInt(today.getTime() / 1000), nanos: 0 }, "en", today.getTime())).toMatch(/^Today /u);
    expect(mobileFilesDateLabel({ seconds: BigInt(yesterday.getTime() / 1000), nanos: 0 }, "zh-TW", today.getTime())).toMatch(/^昨天 /u);
    const observed = entry("secret.txt", FileKind.REGULAR, 1536n, BigInt(today.getTime() / 1000)); observed.hidden = true; observed.ignored = true;
    expect(mobileFilesWorkspaceItems([observed], "name", "en", today.getTime())[0]!.meta).toMatch(/1.5 KB.*Hidden.*Ignored/iu);
  });
});
