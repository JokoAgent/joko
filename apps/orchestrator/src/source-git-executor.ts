import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolatedProcessEnvironment } from "./resource-acquisition.js";

export interface SourceGitExecutionOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Catalog discovery never borrows the service account's Git or SSH login. */
export async function executeSourceGit(args: readonly string[], options: SourceGitExecutionOptions): Promise<{ readonly stdout: string; readonly stderr: string }> {
  options.signal?.throwIfAborted();
  const home = await mkdtemp(join(tmpdir(), "joko-source-git-"));
  try {
    const hooks = join(home, "hooks");
    await mkdir(hooks, { mode: 0o700 });
    options.signal?.throwIfAborted();
    return await new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
      let result: { readonly stdout: string; readonly stderr: string } | undefined;
      let failure: Error | undefined;
      const child = execFile("git", ["-c", "core.longpaths=true", "-c", "credential.helper=", "-c", `core.hooksPath=${hooks.replaceAll("\\", "/")}`, ...args], {
        cwd: options.cwd ?? home,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        env: isolatedProcessEnvironment(home)
      }, (error, stdout, stderr) => {
        result = { stdout, stderr };
        if (error !== null) failure = Object.assign(error, { stderr });
      });
      // Abort/error callbacks can precede OS retirement. Keep the private HOME
      // until the captured child has actually closed, then clean it once.
      child.once("close", () => {
        if (options.signal?.aborted) reject(options.signal.reason);
        else if (failure !== undefined) reject(failure);
        else if (result === undefined) reject(new Error("Git source acquisition exited without a result."));
        else resolve(result);
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
}
