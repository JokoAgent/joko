import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONNECTION_ARTWORK_GROUP_IDS,
  CONNECTION_ARTWORK_THEMES,
  CONNECTION_ARTWORK_VARIANTS
} from "../src/connection-artwork.ts";

const sourceRoot = new URL("../src/", import.meta.url);
const artworkRoot = new URL("../src/landing-artwork/", import.meta.url);
const rootAssetNames = [
  "avatar-dark.svg",
  "avatar-light.svg",
  "icon-dark.svg",
  "icon-light.svg",
  "loading-dark.svg",
  "loading-light.svg"
];
const artworkNames = CONNECTION_ARTWORK_GROUP_IDS.flatMap((group) =>
  CONNECTION_ARTWORK_THEMES.flatMap((theme) => CONNECTION_ARTWORK_VARIANTS.map((variant) =>
    `${group}-${theme}${variant === "alt" ? "-alt" : ""}.svg`))
).sort();

test("brand assets have one exact canonical SVG inventory", async () => {
  const rootEntries = (await readdir(sourceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".svg"))
    .map((entry) => entry.name)
    .sort();
  const actualArtworkNames = (await readdir(artworkRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(rootEntries, rootAssetNames);
  assert.deepEqual(actualArtworkNames, artworkNames);
});

test("every canonical asset is self-contained, script-free, and distinct", async () => {
  const sources = await Promise.all([
    ...rootAssetNames.map((name) => readFile(new URL(name, sourceRoot), "utf8")),
    ...artworkNames.map((name) => readFile(new URL(name, artworkRoot), "utf8"))
  ]);
  const digests = new Set();
  for (const source of sources) {
    assert.match(source, /<svg\b/iu);
    assert.doesNotMatch(source, /<(?:script|image|use|foreignObject|iframe|object|embed)\b/iu);
    assert.doesNotMatch(source, /\b(?:href|xlink:href|on[a-z]+)\s*=/iu);
    assert.doesNotMatch(source, /\b(?:javascript:|data:)/iu);
    digests.add(createHash("sha256").update(source).digest("hex"));
  }
  assert.equal(digests.size, sources.length);
});
