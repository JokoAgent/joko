import { mkdtemp as createTemporaryDirectory, realpath } from "node:fs/promises";

export const mkdtemp: (prefix: string) => Promise<string> = process.env.GITHUB_ACTIONS === "true"
  ? async (prefix) => realpath(await createTemporaryDirectory(prefix))
  : createTemporaryDirectory;
