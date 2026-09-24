import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { parseWdaSourceArchive, prepareWdaSourceForManifest, type WdaSourceManifest } from "./wda-source.js";
import { WDA_SOURCE_PIN } from "./wda-source-pin.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function hash(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }

it("keeps the Desktop resource manifest and license on the runtime's fixed pin", async () => {
  const resources = new URL("../../../apps/desktop/resources/ios-simulator/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", resources), "utf8")) as unknown;
  expect(manifest).toEqual(WDA_SOURCE_PIN);
  expect(hash(await readFile(new URL("LICENSE.appium-webdriveragent", resources)))).toBe(WDA_SOURCE_PIN.licenseSha256);
});
function padded(value: number, size: number): string { return value.toString(8).padStart(size - 1, "0") + "\0"; }
function tarEntry(name: string, kind: string, bytes: Buffer = Buffer.alloc(0), mode = 0o644): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "ascii");
  header.write(padded(mode, 8), 100, "ascii");
  header.write(padded(0, 8), 108, "ascii");
  header.write(padded(0, 8), 116, "ascii");
  header.write(padded(bytes.length, 12), 124, "ascii");
  header.write(padded(0, 12), 136, "ascii");
  header.fill(0x20, 148, 156);
  header.write(kind, 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write(padded(header.reduce((sum, byte) => sum + byte, 0), 8), 148, "ascii");
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

function fixture(extra: readonly [string, string, Buffer?][] = [], project = Buffer.from("project")): {
  readonly archive: Buffer;
  readonly manifest: WdaSourceManifest;
} {
  const revision = "a".repeat(40);
  const license = Buffer.from("BSD test license\n");
  const global = Buffer.from(`52 comment=${revision}\n`);
  const archive = gzipSync(Buffer.concat([
    tarEntry("pax_global_header", "g", global),
    tarEntry("WebDriverAgent-1.2.3/", "5"),
    tarEntry("WebDriverAgent-1.2.3/LICENSE", "0", license),
    tarEntry("WebDriverAgent-1.2.3/WebDriverAgent.xcodeproj/", "5"),
    tarEntry("WebDriverAgent-1.2.3/WebDriverAgent.xcodeproj/project.pbxproj", "0", project),
    ...extra.map(([name, type, bytes]) => tarEntry(name, type, bytes)),
    Buffer.alloc(1024)
  ]));
  return { archive, manifest: { tag: "v1.2.3", revision, archiveSha256: hash(archive), licenseSha256: hash(license) } };
}

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "joko-wda-source-"));
  roots.push(root);
  return root;
}

it("preflights a local archive, publishes a complete checkout, and verifies cached bytes", async () => {
  const root = await temp();
  const { archive, manifest } = fixture();
  const archivePath = join(root, "source.tar.gz");
  const cacheRoot = join(root, "cache");
  await writeFile(archivePath, archive);
  const prepared = await prepareWdaSourceForManifest({ archivePath, cacheRoot }, manifest);
  expect(prepared).toEqual({ checkoutPath: join(cacheRoot, manifest.revision),
    projectPath: join(cacheRoot, manifest.revision, "WebDriverAgent.xcodeproj"),
    revision: manifest.revision, fromCache: false });
  expect((await readFile(join(prepared.projectPath, "project.pbxproj"))).toString()).toBe("project");
  expect((await prepareWdaSourceForManifest({ archivePath, cacheRoot }, manifest)).fromCache).toBe(true);
  await writeFile(join(prepared.projectPath, "project.pbxproj"), "modified");
  await expect(prepareWdaSourceForManifest({ archivePath, cacheRoot }, manifest))
    .rejects.toMatchObject({ code: "CACHE_CONFLICT" });
  expect((await readFile(join(prepared.projectPath, "project.pbxproj"))).toString()).toBe("modified");
  expect((await readdir(cacheRoot)).filter(name => name.startsWith(".extract-"))).toEqual([]);
});

it("rejects untrusted tar paths, links, malformed headers, and mismatched source or license", () => {
  const traverse = fixture([["WebDriverAgent-1.2.3/../outside", "0", Buffer.from("bad")]]);
  expect(() => parseWdaSourceArchive(traverse.archive, traverse.manifest))
    .toThrowError(/malformed or unsafe/u);
  const link = fixture([["WebDriverAgent-1.2.3/link", "2", Buffer.alloc(0)]]);
  expect(() => parseWdaSourceArchive(link.archive, link.manifest)).toThrowError(/malformed or unsafe/u);
  const malformed = fixture();
  const badTar = Buffer.from(gunzipSync(malformed.archive));
  badTar[0] = 0x58;
  const broken = gzipSync(badTar);
  expect(() => parseWdaSourceArchive(broken, { ...malformed.manifest, archiveSha256: hash(broken) }))
    .toThrowError(/malformed or unsafe/u);
  expect(() => parseWdaSourceArchive(malformed.archive, { ...malformed.manifest, archiveSha256: "b".repeat(64) }))
    .toThrowError(/integrity/u);
  expect(() => parseWdaSourceArchive(malformed.archive, { ...malformed.manifest, licenseSha256: "b".repeat(64) }))
    .toThrowError(/malformed or unsafe/u);
});

it("cleans a partly extracted checkout on cancellation and never overwrites a valid revision", async () => {
  const root = await temp();
  const first = fixture();
  const second = fixture([], Buffer.from("different project"));
  const archivePath = join(root, "source.tar.gz");
  const cacheRoot = join(root, "cache");
  await writeFile(archivePath, first.archive);
  const signal = new AbortController();
  await expect(prepareWdaSourceForManifest({ archivePath, cacheRoot, signal: signal.signal }, first.manifest, {
    beforeEntry: (path) => { if (path === "WebDriverAgent.xcodeproj") signal.abort(); }
  })).rejects.toMatchObject({ code: "CANCELLED" });
  expect(await readdir(cacheRoot)).toEqual([]);
  const prepared = await prepareWdaSourceForManifest({ archivePath, cacheRoot }, first.manifest);
  await writeFile(archivePath, second.archive);
  await expect(prepareWdaSourceForManifest({ archivePath, cacheRoot }, second.manifest))
    .rejects.toMatchObject({ code: "CACHE_CONFLICT" });
  await writeFile(archivePath, first.archive);
  expect((await prepareWdaSourceForManifest({ archivePath, cacheRoot }, first.manifest)).fromCache).toBe(true);
  expect((await readFile(join(prepared.projectPath, "project.pbxproj"))).toString()).toBe("project");
});
