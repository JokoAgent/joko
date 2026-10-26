import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const buildArguments = ["--filter", "@joko/connection-transport...", "--filter", "@joko/remote-desktop-sync", "--if-present", "build"];

/** Client inputs consume the Linkspan source packages prepared before installation. */
export function prepareMobileWorkspaceInputs() {
  const manager = process.env.npm_execpath || (process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  let command = manager, args = buildArguments, windowsVerbatimArguments = false;
  if (/\.[cm]?js$/iu.test(manager)) { command = process.execPath; args = [manager, ...buildArguments]; }
  else if (/\.(?:cmd|bat)$/iu.test(manager)) {
    if (/["\r\n%]/u.test(manager)) throw new Error("The pnpm wrapper path is invalid. Run through the configured pnpm command.");
    command = "cmd.exe";
    // Arguments are fixed above; the only path is quoted inside cmd's outer pair.
    args = ["/d", "/s", "/v:off", "/c", `""${manager}" ${buildArguments.join(" ")}"`];
    windowsVerbatimArguments = true;
  }
  const result = spawnSync(command, args, { cwd: repository, stdio: "inherit", windowsHide: true, windowsVerbatimArguments });
  if (result.error) throw new Error("The configured pnpm command could not prepare Mobile workspace inputs.", { cause: result.error });
  if (result.status !== 0) throw new Error(`Mobile workspace preparation failed (${result.status ?? result.signal ?? "unknown"}).`);
  const runtimes = spawnSync(process.execPath, [resolve(repository, 'apps/mobile/scripts/prepare-linkspan-runtimes.mjs')], {
    cwd: repository, stdio: 'inherit', windowsHide: true
  });
  if (runtimes.error || runtimes.status !== 0) throw new Error('Mobile connection runtime preparation failed.', { cause: runtimes.error });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareMobileWorkspaceInputs();
