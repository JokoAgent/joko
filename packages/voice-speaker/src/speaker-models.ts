const release = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export const speakerModels = [
  { role: "vad", name: "silero-vad.onnx", size: 643_854,
    sha: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    url: `${release}/asr-models/silero_vad.onnx` },
  { role: "embedding", name: "campplus-zh-en-advanced.onnx", size: 28_281_164,
    sha: "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2",
    url: `${release}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` }
] as const;
export const camplusDownloadHash = "53cab20ba8f2eb2f6e2d89ecc18e88ef3222169b61b4419cbc13666744a4574b";
export const SPEAKER_EMBEDDING_SHA256 = speakerModels[1].sha;

// Applied only to the SHA-256 verified upstream export. Preserve the CAM++
// pooling behavior used by the filtering thresholds.
export function restoreCamplusPooling(source: Uint8Array): Uint8Array {
  const normalized = new Uint8Array(source.length - 1);
  // The pinned protobuf begins with producer_version "2.14.1". Retain the
  // "2.4.1" exporter metadata of the model whose output is verified.
  normalized.set(source.subarray(0, 15));
  normalized[12] = 5;
  normalized.set(source.subarray(16), 15);
  const attribute = new Uint8Array([10, 17, ...new TextEncoder().encode("count_include_pad"), 24, 0, 160, 1, 2]);
  const valueOffset = attribute.length - 4;
  let restored = 0;
  for (let start = 0; start <= normalized.length - attribute.length; start++) {
    if (normalized[start] !== attribute[0]) continue;
    if (!attribute.every((byte, offset) => normalized[start + offset] === byte)) continue;
    normalized[start + valueOffset] = 1;
    restored++;
  }
  if (restored !== 52) throw new Error("The speaker model export is incompatible.");
  return normalized;
}
