import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const {
  generateJokoNativeBrandAsync,
  nativeBrandFileNames
} = require("../with-joko-native-brand.cjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native brand packaging adapter", () => {
  it("keeps mobile brand derivatives out of the checked-in source layout", () => {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    expect(existsSync(path.join(projectRoot, "assets"))).toBe(false);
    for (const fileName of Object.values(nativeBrandFileNames)) {
      expect(existsSync(path.join(projectRoot, "scripts", fileName))).toBe(false);
    }
    expect(existsSync(path.join(projectRoot, ".expo", "joko-native-brand"))).toBe(false);
  });

  it("derives both platform inputs from canonical SVGs outside the source tree", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "joko-native-brand-"));
    temporaryDirectories.push(outputRoot);
    const projectRoot = path.resolve(import.meta.dirname, "..");
    const output = await generateJokoNativeBrandAsync(projectRoot, outputRoot);

    expect(path.relative(outputRoot, output.light).startsWith("..")).toBe(false);
    expect(path.relative(outputRoot, output.dark).startsWith("..")).toBe(false);
    expect(path.basename(output.light)).toBe(nativeBrandFileNames.lightOutput);
    expect(path.basename(output.dark)).toBe(nativeBrandFileNames.darkOutput);

    const [lightMetadata, darkMetadata, lightBytes, darkBytes] = await Promise.all([
      sharp(output.light).metadata(),
      sharp(output.dark).metadata(),
      readFile(output.light),
      readFile(output.dark)
    ]);
    expect(lightMetadata).toMatchObject({ format: "png", width: 1024, height: 1024 });
    expect(darkMetadata).toMatchObject({ format: "png", width: 1024, height: 1024 });
    expect(lightBytes.equals(darkBytes)).toBe(false);
  });
});
