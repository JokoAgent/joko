import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { deserializeImportSnapshotAsync, serializeImportSnapshotAsync } from "@joko/agent-import";
import { PARTNER_PACKAGE_IDS, applyNativeLocale, readNativePartnerPackage } from "./partner-package-reader.js";
import { packageFiles } from "./partner-packages/index.js";

describe("bundled partner packages", () => {
  it("validates all ten packages and preserves full skills and disabled routines through the current checkpoint", async () => {
    let skills = 0; let routines = 0;
    for (const id of PARTNER_PACKAGE_IDS) {
      const pkg = await readNativePartnerPackage(tmpdir(), id);
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
    expect(skills).toBe(30); expect(routines).toBe(18);
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
