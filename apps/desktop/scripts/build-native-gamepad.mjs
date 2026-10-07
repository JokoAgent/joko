import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "gamepad");
const defaultOutput = join(root, "dist", "native-gamepad");
const helper = "joko-macos-gamepad-helper";

export function nativeGamepadCompilerTarget(architecture) {
  const target = {
    x64: { compilerArchitecture: "x86_64", triple: "x86_64-apple-macos11.0" },
    arm64: { compilerArchitecture: "arm64", triple: "arm64-apple-macos11.0" }
  }[architecture];
  if (target === undefined) throw new Error("The native gamepad helper architecture is unsupported.");
  return Object.freeze(target);
}

export function buildNativeGamepad({
  platform = process.platform,
  architecture = process.arch,
  output = defaultOutput
} = {}) {
  const artifactOutput = resolve(output);
  mkdirSync(artifactOutput, { recursive: true });
  rmSync(join(artifactOutput, helper), { force: true });
  rmSync(join(artifactOutput, `${helper}.staged`), { force: true });
  rmSync(join(artifactOutput, "manifest.json"), { force: true });
  writeManifest(artifactOutput, platform, architecture, null, null);

  if (platform !== "darwin") return;
  if (process.platform !== "darwin") {
    throw new Error("The native gamepad helper can only be compiled on macOS.");
  }
  const target = nativeGamepadCompilerTarget(architecture);
  const cache = mkdtempSync(join(tmpdir(), "joko-native-gamepad-build-"));
  try {
    const object = join(cache, "switch2_usb.o");
    const binary = join(cache, helper);
    runXcrun([
      "--sdk", "macosx", "clang", "-c", join(source, "switch2_usb.c"), "-O2",
      "-arch", target.compilerArchitecture, "-mmacosx-version-min=11.0", "-o", object
    ], "The native gamepad Switch 2 transport requires the macOS command-line developer tools.");
    runXcrun([
      "--sdk", "macosx", "swiftc", join(source, "macos-gamepad-helper.swift"), object,
      "-O", "-target", target.triple, "-import-objc-header", join(source, "switch2_usb.h"),
      "-framework", "Foundation", "-framework", "GameController", "-framework", "IOKit",
      "-o", binary
    ], "The native gamepad helper requires the macOS Swift command-line developer tools.");

    const bytes = readFileSync(binary);
    assertMachOArchitecture(bytes, architecture);
    const staged = join(artifactOutput, `${helper}.staged`);
    copyFileSync(binary, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, join(artifactOutput, helper));
    writeManifest(artifactOutput, platform, architecture, helper,
      createHash("sha256").update(bytes).digest("hex"));
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function runXcrun(arguments_, message) {
  const result = spawnSync("xcrun", arguments_, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(message, { cause: result.error });
  }
}

function assertMachOArchitecture(bytes, architecture) {
  if (bytes.length < 32 || bytes.length > 16 * 1024 * 1024 ||
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== (architecture === "arm64" ? 0x0100000c : 0x01000007)) {
    throw new Error("The native gamepad helper does not match the build target.");
  }
}

function writeManifest(output, platform, architecture, name, sha256) {
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
    protocolVersion: 1,
    platform,
    architecture,
    helper: name,
    sha256
  }, null, 2)}\n`);
}

function directArchitecture(arguments_) {
  if (arguments_.length === 0) return process.arch;
  const requested = arguments_.map((argument) => {
    if (argument === "--x64" || argument === "--arm64") return argument.slice(2);
    if (argument.startsWith("--target-arch=")) return argument.slice("--target-arch=".length);
    throw new Error("Usage: node scripts/build-native-gamepad.mjs [--x64|--arm64|--target-arch=x64|arm64]");
  });
  const architectures = [...new Set(requested)];
  if (architectures.length !== 1 || !["x64", "arm64"].includes(architectures[0])) {
    throw new Error("A direct native gamepad build requires exactly one x64 or arm64 target.");
  }
  return architectures[0];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNativeGamepad({ architecture: directArchitecture(process.argv.slice(2)) });
}
