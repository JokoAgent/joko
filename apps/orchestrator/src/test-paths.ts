import { mkdtempSync as createTemporaryDirectorySync, realpathSync } from "node:fs";
import { mkdtemp as createTemporaryDirectory, realpath } from "node:fs/promises";

export const mkdtemp: (prefix: string) => Promise<string> = process.env.GITHUB_ACTIONS === "true"
  ? async (prefix) => realpath(await createTemporaryDirectory(prefix))
  : createTemporaryDirectory;

export const mkdtempSync: (prefix: string) => string = process.env.GITHUB_ACTIONS === "true"
  ? (prefix) => realpathSync.native(createTemporaryDirectorySync(prefix))
  : createTemporaryDirectorySync;
