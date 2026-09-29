import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadClaudeRemoteManagerSource } from "../dist/remote-manager-source.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(packageRoot, "dist/remote-manager/device-peer-manager.mjs");
const temporary = `${destination}.tmp-${process.pid}`;
const bytes = await loadClaudeRemoteManagerSource("compiled");
if (bytes.byteLength === 0 || bytes.byteLength > 512 * 1024) {
  throw new Error("The Device peer Claude manager bundle is invalid.");
}
await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
await rm(temporary, { force: true });
try {
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
  await rename(temporary, destination);
} finally {
  bytes.fill(0);
  await rm(temporary, { force: true });
}
