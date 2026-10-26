import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareMobileWorkspaceInputs } from "./prepare-workspace-inputs.mjs";
import { prepareMobileLinkspanNative } from "./prepare-linkspan-native.mjs";

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(mobile, "node_modules/expo/bin/cli");

async function main() {
  prepareMobileWorkspaceInputs();
  const arguments_ = process.argv.slice(2), environment = { ...process.env };
  const selectedPlatform = arguments_[0] === "run:android" ? "android" : arguments_[0] === "run:ios" ? "ios" : arguments_[0] === "prebuild" ? arguments_[arguments_.indexOf("--platform") + 1] : undefined;
  if (selectedPlatform === "android" || selectedPlatform === "ios") {
    const native = await prepareMobileLinkspanNative({ platform: selectedPlatform, environment });
    if (native.enabled && selectedPlatform === "android") environment.ORG_GRADLE_PROJECT_reactNativeArchitectures = native.targets.join(",");
  }
  const child = spawn(process.execPath, [cli, ...arguments_], { cwd: mobile, env: environment, stdio: "inherit", windowsHide: true });
  const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((accept, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => accept(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
    });
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
  }
}

void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Mobile command failed."}\n`); process.exitCode = 1; });
