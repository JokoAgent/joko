import { readFile } from "node:fs/promises";

/**
 * Loads the audited manager module shipped with this exact Adapter build.
 * Source-mode development reads the JavaScript-compatible `.mts` input;
 * compiled products read the emitted `.mjs` beside this module.
 */
export async function loadClaudeRemoteManagerSource(): Promise<Buffer> {
  const compiled = new URL("./remote-manager/manager.mjs", import.meta.url);
  try {
    return await readFile(compiled);
  } catch {
    return await readFile(new URL("./remote-manager/manager.mts", import.meta.url));
  }
}
