import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ModelSelectionSchema, decodeModelSpeed, encodeModelSpeed, supportsModelSpeed } from "../dist/index.js";

test("keeps Standard, Fast and Ultrafast distinct through the generated selection contract", () => {
  for (const speed of [false, true, "ultrafast"]) {
    const selection = create(ModelSelectionSchema, { model: { providerId: "provider", modelId: "model" }, ...encodeModelSpeed(speed) });
    const restored = fromBinary(ModelSelectionSchema, toBinary(ModelSelectionSchema, selection));
    assert.equal(decodeModelSpeed(restored), speed);
    assert.equal(restored.fastMode, speed === true);
    assert.equal(restored.ultrafastMode, speed === "ultrafast");
  }
  assert.throws(() => decodeModelSpeed({ fastMode: true, ultrafastMode: true }), /Conflicting/);
  assert.throws(() => encodeModelSpeed("future-speed"), /Invalid/);
  assert.throws(() => decodeModelSpeed({ fastMode: "ultrafast" }), /Invalid/);
  assert.throws(() => decodeModelSpeed({ ultrafastMode: "true" }), /Invalid/);
});

test("does not infer Ultrafast from ordinary Fast capability", () => {
  assert.equal(supportsModelSpeed({ supportsFastMode: true }, "ultrafast"), false);
  assert.equal(supportsModelSpeed({ supportsUltrafastMode: true }, true), false);
  assert.equal(supportsModelSpeed({ supportsUltrafastMode: true }, "ultrafast"), true);
  assert.equal(supportsModelSpeed({}, false), true);
  assert.equal(supportsModelSpeed({ supportsFastMode: true }, "future-speed"), false);
});
