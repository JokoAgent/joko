/// <reference types="node" />

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  copyModelViewerAssets,
  MODEL_VIEWER_ASSET_FILES,
  MODEL_VIEWER_ASSET_SOURCE_ROOT
} from "../../model-viewer-assets.js";

const outputs: string[] = [];

afterEach(async () => {
  await Promise.all(outputs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("model viewer bundled assets", () => {
  it("copies only the pinned local decoder surface into the Web bundle", async () => {
    const output = await mkdtemp(join(tmpdir(), "joko-model-assets-"));
    outputs.push(output);
    await copyModelViewerAssets(MODEL_VIEWER_ASSET_SOURCE_ROOT, output);
    for (const [directory, names] of Object.entries(MODEL_VIEWER_ASSET_FILES)) {
      for (const name of names) {
        expect((await readFile(join(output, "model-viewer-assets", directory, name))).byteLength).toBeGreaterThan(0);
      }
    }
  });
});
