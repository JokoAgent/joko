import { spawnSync } from "node:child_process";
import { buildDevelopmentCommandHost } from "./build-command-host.mjs";

buildDevelopmentCommandHost();
const result = spawnSync(process.execPath, ["../../node_modules/vitest/vitest.mjs", "run", "src/supervised-process.test.ts"], {
  cwd: new URL("..", import.meta.url), env: { ...process.env, JOKO_TEST_PERSONAL_COMMAND_HOST: "1" }, windowsHide: true, stdio: "inherit"
});
process.exitCode = result.status ?? 1;
