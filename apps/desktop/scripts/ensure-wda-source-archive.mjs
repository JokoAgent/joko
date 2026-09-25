import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const resourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "ios-simulator");
const manifest = JSON.parse(await readFile(join(resourceRoot, "manifest.json"), "utf8"));
const archivePath = join(resourceRoot, manifest.archiveFileName);

function validArchive(bytes) {
  return bytes.length > 0 && bytes.length <= MAX_ARCHIVE_BYTES
    && createHash("sha256").update(bytes).digest("hex") === manifest.archiveSha256;
}

if (process.platform !== "darwin") {
  process.stdout.write("[wda-source] macOS packaging asset skipped\n");
} else {
  let existing;
  try { existing = await readFile(archivePath); } catch { /* Download the pinned archive. */ }
  if (existing && validArchive(existing)) {
    process.stdout.write("[wda-source] pinned archive verified\n");
  } else {
    const response = await fetch(manifest.archiveUrl, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error("Pinned WDA source could not be downloaded.");
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > MAX_ARCHIVE_BYTES) throw new Error("Pinned WDA source exceeded its size limit.");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (!validArchive(bytes)) throw new Error("Pinned WDA source failed integrity verification.");
    const temporary = `${archivePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, archivePath);
    } finally {
      await rm(temporary, { force: true });
    }
    process.stdout.write("[wda-source] pinned archive staged\n");
  }
}
