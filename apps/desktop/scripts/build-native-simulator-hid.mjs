import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { selectSimulatorHidArchitectures } from "./native-simulator-hid-build-policy.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(desktopRoot, "..", "..", "packages", "tool-ios-simulator",
  "native", "joko-simulator-hid.swift");
const outputRoot = join(desktopRoot, "dist", "native-simulator-hid");
const output = join(outputRoot, "joko-simulator-hid");
mkdirSync(outputRoot, { recursive: true });
if (existsSync(output)) rmSync(output);

let helper = null;
let manifestArchitecture = process.arch;
if (process.platform === "darwin") {
  const developerDir = tryRun("xcode-select", ["-p"])?.trim();
  const simulatorKitRoot = developerDir?.startsWith("/")
    ? join(developerDir, "Library", "PrivateFrameworks") : null;
  const simulatorKitBinary = simulatorKitRoot === null ? null
    : join(simulatorKitRoot, "SimulatorKit.framework", "SimulatorKit");
  const available = simulatorKitBinary === null ? null
    : tryRun("xcrun", ["lipo", "-archs", simulatorKitBinary]);
  const decision = selectSimulatorHidArchitectures(available ?? "", process.arch);
  manifestArchitecture = decision.manifestArchitecture;
  const slices = decision.architectures.map(architecture => {
    const slice = join(outputRoot, `joko-simulator-hid-${architecture}`);
    if (existsSync(slice)) rmSync(slice);
    run("xcrun", ["swiftc", source, "-O", "-target", `${architecture}-apple-macos14.0`,
      "-F", "/Library/Developer/PrivateFrameworks", "-framework", "CoreSimulator",
      "-F", simulatorKitRoot, "-framework", "SimulatorKit",
      "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/PrivateFrameworks",
      "-Xlinker", "-rpath", "-Xlinker", simulatorKitRoot, "-o", slice]);
    return slice;
  });
  if (slices.length > 1) run("xcrun", ["lipo", "-create", ...slices, "-output", output]);
  else if (slices.length === 1) renameSync(slices[0], output);
  for (const slice of slices) { if (existsSync(slice)) rmSync(slice); }
  if (slices.length > 0) helper = "joko-simulator-hid";
}

writeFileSync(join(outputRoot, "manifest.json"), `${JSON.stringify({
  architecture: manifestArchitecture,
  helper, platform: process.platform, protocolVersion: 1
}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktopRoot, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, maxBuffer: 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || "Native Simulator HID build failed.").trim());
  }
  return result.stdout;
}

function tryRun(command, args) {
  const result = spawnSync(command, args, { cwd: desktopRoot, encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 4_096 });
  return result.error === undefined && result.status === 0 ? result.stdout : null;
}
