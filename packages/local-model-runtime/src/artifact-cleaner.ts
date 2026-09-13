import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { runtimeRoot } from "./installer.js";
import { assertPathWithin, isSafeDigest } from "./security.js";

export interface CancelledPullArtifactCleaner {
  cleanup(input: { readonly digests: readonly string[]; readonly keepDigests: ReadonlySet<string> }): Promise<void>;
}

export class ManagedSidecarArtifactCleaner implements CancelledPullArtifactCleaner {
  constructor(private readonly dataRoot: string) {}

  async cleanup(input: { readonly digests: readonly string[]; readonly keepDigests: ReadonlySet<string> }): Promise<void> {
    const blobRoot = join(runtimeRoot(this.dataRoot), "models", "blobs");
    for (const digest of new Set(input.digests)) {
      if (!isSafeDigest(digest) || input.keepDigests.has(digest)) continue;
      const file = join(blobRoot, digest.replace(":", "-"));
      assertPathWithin(blobRoot, file);
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        await unlink(file);
      } catch {
        // A missing or locked partial is safe to leave for the runtime's own GC.
      }
    }
  }
}
