import { loadSpeakerModels, sha256File } from "./native";
import { camplusDownloadHash, restoreCamplusPooling, speakerModels as assets } from "@joko/voice-speaker";
export const SPEAKER_DOWNLOAD_BYTES = assets.reduce((total, asset) => total + transferSize(asset), 0);
export const SPEAKER_DOWNLOAD_MB = Math.ceil(SPEAKER_DOWNLOAD_BYTES / 1_000_000);

function transferSize(asset: typeof assets[number]): number {
  return asset.size + Number(asset.role === "embedding");
}

async function files() {
  const { Directory, File, Paths } = await import("expo-file-system");
  const dir = new Directory(Paths.cache, "voice-models-v1");
  return {
    dir, File,
    entries: assets.map(asset => ({ asset, file: new File(dir, asset.name) }))
  };
}

export async function mobileSpeakerModelsPresent(): Promise<boolean> {
  for (const { asset, file } of (await files()).entries) {
    if (!file.exists || file.size !== asset.size || await sha256File(file.uri).catch(() => undefined) !== asset.sha) return false;
  }
  return true;
}

let download: Promise<void> | undefined;
export async function downloadMobileSpeakerModels(signal: AbortSignal, onProgress: (bytes: number) => void): Promise<void> {
  while (download) await download.catch(() => undefined);
  signal.throwIfAborted();
  const operation = download = downloadModels(signal, onProgress);
  try { await operation; }
  finally { if (download === operation) download = undefined; }
}

async function downloadModels(signal: AbortSignal, onProgress: (bytes: number) => void): Promise<void> {
  const { dir, File, entries } = await files();
  signal.throwIfAborted();
  dir.create({ intermediates: true, idempotent: true });
  let completed = 0;
  for (const { asset, file } of entries) {
    const size = transferSize(asset);
    signal.throwIfAborted();
    if (file.exists && file.size === asset.size && await sha256File(file.uri).catch(() => undefined) === asset.sha) {
      signal.throwIfAborted();
      completed += size;
      onProgress(completed);
      continue;
    }
    signal.throwIfAborted();
    const temporary = new File(dir, `${asset.name}.download`);
    const verified = new File(dir, `${asset.name}.verified`);
    const transfer = new AbortController();
    const cancel = () => transfer.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 120_000);
    try {
      if (temporary.exists) temporary.delete();
      if (verified.exists) verified.delete();
      const received = await File.downloadFileAsync(asset.url, temporary, {
        signal: transfer.signal, onProgress: ({ bytesWritten }) => {
          if (bytesWritten > size) cancel();
          else if (!transfer.signal.aborted) onProgress(completed + bytesWritten);
        }
      });
      transfer.signal.throwIfAborted();
      if (asset.role === "embedding") {
        if (received.size !== asset.size + 1 || await sha256File(received.uri) !== camplusDownloadHash) {
          throw new Error("The downloaded speaker model failed integrity verification.");
        }
        const bytes = restoreCamplusPooling(await received.bytes());
        transfer.signal.throwIfAborted();
        verified.create();
        verified.write(bytes);
      } else received.move(verified);
      if (verified.size !== asset.size || await sha256File(verified.uri) !== asset.sha) {
        throw new Error("The speaker model failed integrity verification.");
      }
      transfer.signal.throwIfAborted();
      if (file.exists) file.delete();
      verified.move(file);
      loaded = undefined;
      completed += size;
      onProgress(completed);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      const staleDownload = new File(dir, `${asset.name}.download`);
      const staleVerification = new File(dir, `${asset.name}.verified`);
      if (staleDownload.exists) staleDownload.delete();
      if (staleVerification.exists) staleVerification.delete();
    }
  }
}

let loaded: Promise<void> | undefined;
export async function prepareMobileSpeakerModels(): Promise<void> {
  const { entries } = await files();
  if (entries.some(({ asset, file }) => !file.exists || file.size !== asset.size)) {
    loaded = undefined;
    throw new Error("Download verified speaker models before recording a voiceprint.");
  }
  const operation = loaded ??= (async () => {
    for (const { asset, file } of entries) {
      if (!file.exists || file.size !== asset.size || await sha256File(file.uri) !== asset.sha) {
        throw new Error("Download verified speaker models before recording a voiceprint.");
      }
    }
    await loadSpeakerModels({ vad: entries[0]!.file.uri, embedding: entries[1]!.file.uri });
  })();
  try { await operation; }
  catch (error) { if (loaded === operation) loaded = undefined; throw error; }
}
