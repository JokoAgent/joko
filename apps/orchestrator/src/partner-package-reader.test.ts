import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { deserializeImportSnapshotAsync, serializeImportSnapshotAsync } from "@joko/agent-import";
import { PARTNER_PACKAGE_IDS, applyNativeLocale, canonicalPackageJson, readNativePartnerPackage } from "./partner-package-reader.js";
import { packageFiles } from "./partner-packages/index.js";

describe("bundled partner packages", () => {
  it("projects optional tools and their account authorization for all ten packages and locales", async () => {
    const expected: Record<string, readonly string[]> = {
      "ad-spend-watch": ["google-sheets", "google-gmail", "outlook-mail"],
      "apple-search-ads-review": ["google-sheets", "google-gmail", "outlook-mail"],
      cooper: ["web-search", "x-manager"],
      "engineer-bot": ["github", "gitlab", "notion"],
      "nightly-audit-engineer": ["github", "gitlab"],
      "proto-bot": ["opendesign-trial", "art", "github", "gitlab"],
      "sable-game-art": ["art", "web-search", "notion", "google-drive"],
      "seo-aeo-desk": ["web-search", "google-sheets", "notion"],
      "startup-qa-bot": ["github", "gitlab"],
      "video-editor": ["art", "google-drive"]
    };
    const noAccount = new Set(["web-search", "opendesign-trial", "art"]);
    for (const id of PARTNER_PACKAGE_IDS) {
      const { entry } = await readNativePartnerPackage(tmpdir(), id);
      expect(entry.packageVersion).toBe("0.1.0");
      for (const copy of [entry, ...Object.values(entry.locales)]) {
        expect(copy.tools.map(tool => [tool.id, tool.requiresUserAuthorization])).toEqual(
          expected[id]!.map(toolId => [toolId, !noAccount.has(toolId)])
        );
      }
      if (id === "ad-spend-watch" || id === "apple-search-ads-review") {
        expect(entry.routines[0]?.optionalToolIds).toEqual(["google-sheets", "google-gmail", "outlook-mail"]);
      }
    }
  });

  it("validates all ten packages and preserves full skills and disabled routines through the current checkpoint", async () => {
    let skills = 0; let routines = 0;
    const hashes = new Set<string>();
    for (const id of PARTNER_PACKAGE_IDS) {
      const pkg = await readNativePartnerPackage(tmpdir(), id);
      const manifest = JSON.parse(packageFiles[id]!["manifest.json"]!);
      const hash = createHash("sha256").update(canonicalPackageJson(manifest)).digest("hex");
      const identity = { packageId: id, packageVersion: "0.1.0", packageHash: hash };
      expect(manifest).toMatchObject({ packageId: id, packageVersion: "0.1.0" });
      expect(pkg.identity).toEqual(identity);
      expect(pkg.entry).toMatchObject(identity);
      expect(pkg.snapshot.nativePackage).toMatchObject(identity);
      expect(pkg.snapshot.fingerprint).toBe(hash);
      hashes.add(hash);
      expect(pkg.entry.capabilities).toHaveLength(3);
      expect(pkg.snapshot.items.find(item => item.role === "identity")?.view.category).toBe("personality");
      expect(pkg.snapshot.items.filter(item => item.view.category === "skills")).toHaveLength(3);
      skills += pkg.snapshot.items.filter(item => item.view.category === "skills").length;
      for (const item of pkg.snapshot.items.filter(item => item.automation)) {
        routines++; expect(item.view.enabled).toBe(false); expect(item.automation!.input.enabled).toBe(false);
      }
      applyNativeLocale(pkg, "en");
      const restored = await deserializeImportSnapshotAsync(await serializeImportSnapshotAsync(pkg.snapshot, () => {}), () => {});
      expect(restored.nativePackage).toEqual(pkg.snapshot.nativePackage);
      expect(restored.items.map(item => item.files?.map(file => file.bytes))).toEqual(pkg.snapshot.items.map(item => item.files?.map(file => file.bytes)));
    }
    expect(hashes.size).toBe(10); expect(skills).toBe(30); expect(routines).toBe(18);
  });
  it("refuses any changed byte and identities outside the bundled catalog", async () => {
    await expect(readNativePartnerPackage(tmpdir(), "../outside")).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
    const mutable = packageFiles as Record<string, Readonly<Record<string, string>>>;
    const original = mutable["engineer-bot"]!;
    mutable["engineer-bot"] = { ...original, "knowledge/method.md": original["knowledge/method.md"] + "changed" };
    try { await expect(readNativePartnerPackage(tmpdir(), "engineer-bot")).rejects.toMatchObject({ code: "INVALID_PACKAGE" }); }
    finally { mutable["engineer-bot"] = original; }
  });
});
