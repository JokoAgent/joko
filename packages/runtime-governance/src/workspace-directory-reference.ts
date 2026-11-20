import { lstatSync, realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** Resolve only the selected directory identity. No directory content is read. */
export async function prepareWorkspaceDirectoryReference(workspaceRoot: string, reference: string): Promise<{
  readonly path: string;
  readonly assertCurrent: () => void;
}> {
  const parts = reference.split("/");
  if (!isAbsolute(workspaceRoot) || Buffer.byteLength(reference, "utf8") > 4_096
    || /[\\:\u0000-\u001f\u007f]/u.test(reference) || parts.some(part => part === "" || part === "." || part === "..")) {
    throw new Error("The directory reference must use a bounded relative path within its workspace.");
  }
  const path = resolve(workspaceRoot, ...parts);
  const [root, directory] = await Promise.all([lstat(workspaceRoot, { bigint: true }), lstat(path, { bigint: true })]);
  const assertCurrent = () => {
    const currentRoot = lstatSync(workspaceRoot, { bigint: true });
    const currentDirectory = lstatSync(path, { bigint: true });
    if (!root.isDirectory() || !currentRoot.isDirectory() || root.dev !== currentRoot.dev || root.ino !== currentRoot.ino
      || !directory.isDirectory() || !currentDirectory.isDirectory() || directory.dev !== currentDirectory.dev || directory.ino !== currentDirectory.ino
      || relative(workspaceRoot, realpathSync(workspaceRoot)) !== "" || relative(path, realpathSync(path)) !== "") {
      throw new Error("The selected workspace directory changed identity.");
    }
  };
  assertCurrent();
  return { path, assertCurrent };
}
