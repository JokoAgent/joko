import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Only this import runtime's newly allocated temporary directories are removable. */
export async function removePrivateImportDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  if (resolved !== directory || path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !["joko-import-skills-", "joko-import-check-", "joko-import-run-"].some(prefix => path.basename(resolved).startsWith(prefix))) {
    throw new Error("Private import cleanup is outside its allocated directory");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}
