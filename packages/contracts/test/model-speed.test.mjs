import assert from "node:assert/strict";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ModelSelectionSchema, decodeModelSpeed, encodeModelSpeed, supportsModelSpeed,
  DesktopSpeechModelSchema, DesktopSpeechSelectionSchema, desktopSpeechModelSpeedRange,
  reconcileDesktopSpeechSelection, speechSpeedRange, isSpeechSpeedSupported } from "../dist/index.js";

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

test("keeps absent, unsupported and verified speech route ranges distinct through the generated wire", () => {
  const identity = { backendId: "backend", providerId: "provider", modelId: "tts" };
  const selected = create(DesktopSpeechSelectionSchema, { ...identity, protocol: "openai", voice: "alloy", speed: 3 });
  for (const [speedSupport, expectedRange, expectedSpeed] of [
    [undefined, undefined, 3],
    [{ case: "speedUnsupported", value: true }, null, undefined],
    [{ case: "speedRange", value: { min: 0.5, max: 2 } }, { min: 0.5, max: 2 }, 2],
  ]) {
    const model = fromBinary(DesktopSpeechModelSchema, toBinary(DesktopSpeechModelSchema,
      create(DesktopSpeechModelSchema, { ...identity, ...(speedSupport ? { speedSupport } : {}) })));
    assert.deepEqual(desktopSpeechModelSpeedRange(model), expectedRange);
    const resolved = reconcileDesktopSpeechSelection(selected, [model]);
    assert.equal(resolved.speed, expectedSpeed);
    assert.equal(selected.speed, 3);
    assert.equal(reconcileDesktopSpeechSelection(create(DesktopSpeechSelectionSchema, { ...selected, speed: undefined }), [model]).speed, undefined);
  }
  assert.equal(reconcileDesktopSpeechSelection(selected, []), selected);
  assert.equal(reconcileDesktopSpeechSelection(undefined, []), undefined);
  assert.deepEqual(speechSpeedRange("tts", "openai"), { min: 0.25, max: 4 });
  assert.equal(speechSpeedRange("tts", "openai", null), null);
  assert.equal(isSpeechSpeedSupported("tts", "openai", 1, null), false);
  assert.equal(isSpeechSpeedSupported("tts", "openai", undefined, null), true);
  for (const range of [{ min: 0, max: 2 }, { min: 2, max: 1 }, { min: Number.NaN, max: 2 }]) {
    assert.equal(desktopSpeechModelSpeedRange(create(DesktopSpeechModelSchema, { speedSupport: { case: "speedRange", value: range } })), null);
  }
});

test("retains the verified exact Qwen speech model bounds without applying them to other versions", () => {
  assert.deepEqual(speechSpeedRange("qwen/qwen-audio-3.1-tts-plus", "openai"), { min: 0.5, max: 2 });
  assert.equal(isSpeechSpeedSupported("qwen/qwen-audio-3.1-tts-plus", "openai", 0.25), false);
  assert.equal(isSpeechSpeedSupported("qwen/qwen-audio-3.1-tts-plus", "openai", 2), true);
  assert.deepEqual(speechSpeedRange("qwen/qwen-audio-future", "openai"), { min: 0.25, max: 4 });
});
