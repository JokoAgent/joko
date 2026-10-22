import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import type { ApprovedDirectory } from "@joko/core";

export function hostedDirectoryId(directory: ApprovedDirectory): string {
  return createHash("sha256").update(JSON.stringify([directory.id, directory.path])).digest("hex");
}
export function hostedDirectoryPath(root: string, id: string): string {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("The Source directory identity is invalid.");
  return (/^[A-Za-z]:|^\\\\/u.test(root) ? win32 : posix).join(root, "additional", `approved-${id}`);
}
