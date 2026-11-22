import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { camplusDownloadHash, restoreCamplusPooling, speakerModels } from "@joko/voice-speaker";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class DesktopSpeakerModels {
  #download?: Promise<void>;

  constructor(private readonly directory: () => string) {}

  async paths(): Promise<{ vad: string; embedding: string } | undefined> {
    const vad = join(this.directory(), speakerModels[0].name);
    const embedding = join(this.directory(), speakerModels[1].name);
    const checked = await Promise.all([verified(vad, speakerModels[0]), verified(embedding, speakerModels[1])]);
    return checked.every(Boolean) ? { vad, embedding } : undefined;
  }

  async download(signal: AbortSignal): Promise<void> {
    while (this.#download) await this.#download.catch(() => undefined);
    signal.throwIfAborted();
    const pending = this.#download = this.#fetch(signal);
    try { await pending; }
    finally { if (this.#download === pending) this.#download = undefined; }
  }

  async #fetch(signal: AbortSignal): Promise<void> {
    const directory = this.directory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const asset of speakerModels) {
      signal.throwIfAborted();
      const filename = join(directory, asset.name);
      if (await verified(filename, asset)) continue;
      const embedding = asset.role === "embedding";
      const received = await receiveModel(asset.url, asset.size + Number(embedding), AbortSignal.any([signal, AbortSignal.timeout(120_000)]));
      if (digest(received) !== (embedding ? camplusDownloadHash : asset.sha)) throw new Error("Voice model integrity check failed.");
      const verifiedBytes = embedding ? restoreCamplusPooling(received) : received;
      if (verifiedBytes.length !== asset.size || digest(verifiedBytes) !== asset.sha) throw new Error("Voice model integrity check failed.");
      const temporary = join(directory, `.${asset.name}.${randomUUID()}`);
      try {
        await writeFile(temporary, verifiedBytes, { flag: "wx", mode: 0o600 });
        signal.throwIfAborted();
        await rename(temporary, filename);
      } finally { await rm(temporary, { force: true }); }
    }
  }
}

async function verified(path: string, expected: { size: number; sha: string }): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isFile() && entry.size === expected.size && digest(await readFile(path)) === expected.sha;
  } catch { return false; }
}

async function receiveModel(url: string, size: number, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error("The voice model download failed.");
  const model = new Uint8Array(size);
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > size) throw new Error("Voice model exceeded its published size.");
      model.set(value, received);
      received += value.length;
    }
    if (received !== size) throw new Error("Voice model download is incomplete.");
    return model;
  } finally { await reader.cancel().catch(() => undefined); }
}
