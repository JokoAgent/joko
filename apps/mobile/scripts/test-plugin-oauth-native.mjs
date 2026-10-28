import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The actual Network.framework callback receiver check requires macOS.");
const directory = mkdtempSync(join(tmpdir(), "joko-plugin-oauth-"));
try {
  const executable = join(directory, "receiver-check");
  execFileSync("xcrun", ["swiftc", "-swift-version", "5", "-parse-as-library",
    fileURLToPath(new URL("../modules/joko-plugin-oauth/ios/PluginOauthProtocol.swift", import.meta.url)),
    fileURLToPath(new URL("../modules/joko-plugin-oauth/ios/PluginOauthReceiver.swift", import.meta.url)),
    fileURLToPath(new URL("./fixtures/plugin-oauth-native.swift", import.meta.url)), "-o", executable], { stdio: "inherit", timeout: 60_000 });
  execFileSync(executable, [], { stdio: "inherit", timeout: 30_000 });
} finally { rmSync(directory, { recursive: true, force: true }); }
