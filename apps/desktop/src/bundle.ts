import { fileURLToPath, pathToFileURL } from "node:url";

import { readRegularFileSnapshot } from "./secure-files.js";
import { extractHtmlAssetReferences, isRelativeBundleAssetReference } from "./security.js";

const MAXIMUM_ENTRY_BYTES = 4 * 1024 * 1024;
const MAXIMUM_REFERENCED_ASSET_BYTES = 64 * 1024 * 1024;

/** Verify the staged entry and every static HTML reference before app-scheme load. */
export async function verifyPackagedWebBundle(entryPath: string): Promise<readonly string[]> {
  const entryBytes = await readRegularFileSnapshot(entryPath, MAXIMUM_ENTRY_BYTES);
  const html = new TextDecoder("utf-8", { fatal: true }).decode(entryBytes);
  const references = extractHtmlAssetReferences(html);
  if (references.length === 0) throw new Error("The packaged Web entry contains no static bundle references.");
  for (const reference of references) {
    if (!isRelativeBundleAssetReference(reference, entryPath)) {
      throw new Error("The packaged Web entry contains a non-relative asset reference.");
    }
    const assetPath = fileURLToPath(new URL(reference, pathToFileURL(entryPath)));
    await readRegularFileSnapshot(assetPath, MAXIMUM_REFERENCED_ASSET_BYTES);
  }
  return references;
}
