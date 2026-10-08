import { create } from "@bufbuild/protobuf";
import { AudioArtifactKind, AudioArtifactMetadataSchema, BlobRefSchema, ImageRefSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mapMobileAudioMetadata, mobileAudioMetadataDuration, mobileAudioMetadataSourceKey } from "./mobile-audio-metadata";

describe("canonical mobile audio metadata", () => {
  it("preserves complete canonical values and independent cover identity without borrowing shared-byte metadata", () => {
    const raw = metadata();
    const mapped = mapMobileAudioMetadata(raw)!;
    expect(mapped).toMatchObject({ kind: "music", title: "Canonical title", description: "完整说明\n".repeat(1_000),
      durationSeconds: 18, artwork: { width: 4, height: 3, alt: "Independent cover",
        blob: { blobId: "cover", sha256Hex: "a".repeat(64), byteSize: 128n, mediaType: "image/png", fileName: "cover.png" } } });
    const key = mobileAudioMetadataSourceKey(mapped);
    raw.artwork!.blob!.sha256Hex = "b".repeat(64);
    expect(mapped.artwork?.blob.sha256Hex).toBe("a".repeat(64));
    expect(mobileAudioMetadataSourceKey(mapped)).toBe(key);
    expect(mobileAudioMetadataSourceKey(mapMobileAudioMetadata(raw))).not.toBe(key);
    expect(mapMobileAudioMetadata(undefined)).toBeUndefined();
    expect(mapMobileAudioMetadata(create(AudioArtifactMetadataSchema, { kind: AudioArtifactKind.GENERIC })))
      .toEqual({ kind: "generic", title: "", description: "" });
    expect(mapMobileAudioMetadata(create(AudioArtifactMetadataSchema, { kind: AudioArtifactKind.SOUND_EFFECT,
      title: "Effect", description: "Canonical detail" })))
      .toEqual({ kind: "sound_effect", title: "Effect", description: "Canonical detail" });
  });

  it("fences every content and artwork field by value and prefers measured positive duration over the hint", () => {
    const original = mapMobileAudioMetadata(metadata())!;
    const key = mobileAudioMetadataSourceKey(original);
    expect(mobileAudioMetadataSourceKey(mapMobileAudioMetadata(metadata()))).toBe(key);
    const variants = [
      { ...original, kind: "generic" as const }, { ...original, title: "Other" }, { ...original, description: "Other" },
      { ...original, durationSeconds: 19 }, { ...original, durationSeconds: undefined }, { ...original, artwork: undefined },
      ...[{ width: 5 }, { height: 4 }, { alt: "Other" }].map((change) => ({ ...original, artwork: { ...original.artwork!, ...change } })),
      ...[{ blobId: "other" }, { sha256Hex: "b".repeat(64) }, { byteSize: 129n }, { mediaType: "image/jpeg" }, { fileName: "other.png" }]
        .map((change) => ({ ...original, artwork: { ...original.artwork!, blob: create(BlobRefSchema, { ...original.artwork!.blob, ...change }) } }))
    ];
    for (const variant of variants) expect(mobileAudioMetadataSourceKey(variant)).not.toBe(key);
    for (const unknown of [undefined, null, 0, -1, NaN, Infinity]) expect(mobileAudioMetadataDuration(original, unknown)).toBe(18);
    expect(mobileAudioMetadataDuration(original, 9.5)).toBe(9.5);
    expect(mobileAudioMetadataDuration(undefined, 9.5)).toBe(9.5);
    expect(mobileAudioMetadataDuration(undefined, 0)).toBeUndefined();
  });

  it("rejects invalid canonical metadata rather than truncating text or granting a malformed cover", () => {
    const original = metadata();
    const invalid = [
      create(AudioArtifactMetadataSchema, { ...original, kind: AudioArtifactKind.UNSPECIFIED }),
      create(AudioArtifactMetadataSchema, { ...original, title: "界".repeat(1_366) }),
      create(AudioArtifactMetadataSchema, { ...original, description: "x".repeat(65_537) }),
      create(AudioArtifactMetadataSchema, { ...original, title: "bad\0title" }),
      ...[0, -1, NaN, Infinity, 86_401].map((durationSeconds) => create(AudioArtifactMetadataSchema, { ...original, durationSeconds })),
      create(AudioArtifactMetadataSchema, { ...original, artwork: create(ImageRefSchema) }),
      ...[{ widthPixels: 0 }, { heightPixels: 0 }, { widthPixels: 40_000_001, heightPixels: 1 }, { altText: "x".repeat(4_097) }]
        .map((change) => create(AudioArtifactMetadataSchema, { ...original, artwork: create(ImageRefSchema, { ...original.artwork!, ...change }) })),
      ...[{ blobId: "" }, { sha256Hex: "wrong" }, { byteSize: 0n }, { byteSize: 8_388_609n }, { mediaType: "image/svg+xml" }, { fileName: "bad\0name" }]
        .map((change) => create(AudioArtifactMetadataSchema, { ...original, artwork: create(ImageRefSchema, { ...original.artwork!,
          blob: create(BlobRefSchema, { ...original.artwork!.blob!, ...change }) }) }))
    ];
    for (const value of invalid) expect(() => mapMobileAudioMetadata(value)).toThrow("canonical audio Artifact metadata");
    expect(mapMobileAudioMetadata(create(AudioArtifactMetadataSchema, { ...original,
      title: "x".repeat(4_096), description: "x".repeat(65_536), durationSeconds: 86_400,
      artwork: create(ImageRefSchema, { widthPixels: 8_000, heightPixels: 5_000, altText: "x".repeat(4_096),
        blob: create(BlobRefSchema, { ...original.artwork!.blob!, byteSize: 8_388_608n }) }) })))
      .toBeDefined();
  });
});

function metadata() {
  return create(AudioArtifactMetadataSchema, { kind: AudioArtifactKind.MUSIC,
    title: "Canonical title", description: "完整说明\n".repeat(1_000), durationSeconds: 18,
    artwork: create(ImageRefSchema, { widthPixels: 4, heightPixels: 3, altText: "Independent cover",
      blob: create(BlobRefSchema, { blobId: "cover", sha256Hex: "a".repeat(64), byteSize: 128n,
        mediaType: "image/png", fileName: "cover.png" }) }) });
}
