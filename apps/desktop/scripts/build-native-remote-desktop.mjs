import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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
const source = join(root, "native", "remote-desktop");
const defaultOutput = join(root, "dist", "native-remote-desktop");
const macHelper = "joko-macos-remote-desktop-input";
const macCaptureHelper = "joko-macos-remote-desktop-capture";
const windowsHelper = "joko-windows-remote-desktop-input.exe";

export function nativeRemoteDesktopMacTarget(architecture) {
  const target = {
    x64: { compilerArchitecture: "x86_64", triple: "x86_64-apple-macos11.0" },
    arm64: { compilerArchitecture: "arm64", triple: "arm64-apple-macos11.0" }
  }[architecture];
  if (target === undefined) throw new Error("The Remote Desktop macOS helper architecture is unsupported.");
  return Object.freeze(target);
}

export function buildNativeRemoteDesktop({
  platform = process.platform,
  architecture = process.arch,
  output = defaultOutput
} = {}) {
  const artifactOutput = resolve(output);
  mkdirSync(artifactOutput, { recursive: true });
  for (const name of [
    macHelper,
    macCaptureHelper,
    windowsHelper,
    `${macHelper}.staged`,
    `${macCaptureHelper}.staged`,
    `${windowsHelper}.staged`
  ]) {
    rmSync(join(artifactOutput, name), { force: true });
  }
  rmSync(join(artifactOutput, "manifest.json"), { force: true });
  writeManifest(artifactOutput, platform, architecture, null, null, null, null);
  if (platform !== "darwin" && platform !== "win32") return;
  if (platform !== process.platform) {
    throw new Error("The Remote Desktop native helper must be compiled on its target operating system.");
  }

  const cache = mkdtempSync(join(tmpdir(), "joko-native-remote-desktop-build-"));
  try {
    const inputHelper = platform === "darwin" ? macHelper : windowsHelper;
    const inputBinary = join(cache, inputHelper);
    let captureBinary = null;
    if (platform === "darwin") {
      const target = nativeRemoteDesktopMacTarget(architecture);
      run("xcrun", [
        "--sdk", "macosx", "swiftc",
        join(source, "macos-caller.swift"),
        join(source, "macos-input.swift"),
        "-O", "-target", target.triple,
        "-framework", "ApplicationServices", "-framework", "AppKit", "-framework", "Security",
        "-framework", "IOKit",
        "-o", inputBinary
      ], "The Remote Desktop input helper requires the macOS Swift command-line developer tools.");
      assertMachOArchitecture(readFileSync(inputBinary), architecture);
      captureBinary = join(cache, macCaptureHelper);
      run("xcrun", [
        "--sdk", "macosx", "clang", join(source, "macos-capture.m"),
        "-O2", "-target", target.triple, "-fobjc-arc", "-fblocks",
        "-framework", "Foundation", "-framework", "AppKit", "-framework", "CoreGraphics",
        "-framework", "CoreImage", "-framework", "IOSurface", "-framework", "ImageIO",
        "-framework", "IOKit", "-o", captureBinary
      ], "The Remote Desktop capture helper requires the macOS command-line developer tools.");
      assertMachOArchitecture(readFileSync(captureBinary), architecture);
    } else {
      const target = windowsRustTarget(architecture);
      const portableCargo = resolve(root, "..", "..", ".runtime", "rust-toolchain", "bin", "cargo.exe");
      const cargo = process.env.JOKO_CARGO_EXECUTABLE
        ?? (existsSync(portableCargo) ? portableCargo : "cargo");
      const targetDirectory = join(cache, "cargo");
      run(cargo, [
        "build", "--release", "--locked",
        "--manifest-path", join(source, "windows-input", "Cargo.toml"),
        "--target", target,
        "--target-dir", targetDirectory
      ], "The Remote Desktop input helper requires the Rust MSVC toolchain.", {
        ...process.env,
        PATH: `${dirname(cargo)};${process.env.PATH ?? process.env.Path ?? ""}`
      });
      copyFileSync(join(targetDirectory, target, "release", windowsHelper), inputBinary);
      assertPortableExecutable(readFileSync(inputBinary), architecture);
    }
    const inputSha256 = stageHelper(artifactOutput, inputHelper, inputBinary);
    const captureSha256 = captureBinary === null
      ? null
      : stageHelper(artifactOutput, macCaptureHelper, captureBinary);
    writeManifest(
      artifactOutput,
      platform,
      architecture,
      inputHelper,
      inputSha256,
      captureBinary === null ? null : macCaptureHelper,
      captureSha256
    );
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function stageHelper(output, helper, binary) {
  const bytes = readFileSync(binary);
  if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024) {
    throw new Error(`The Remote Desktop ${helper} helper has an invalid size.`);
  }
  const staged = join(output, `${helper}.staged`);
  copyFileSync(binary, staged);
  chmodSync(staged, 0o755);
  renameSync(staged, join(output, helper));
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, arguments_, message, environment = process.env) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: environment
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(message, { cause: result.error });
  }
}

function windowsRustTarget(architecture) {
  const target = {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc"
  }[architecture];
  if (target === undefined) throw new Error("The Remote Desktop Windows helper architecture is unsupported.");
  return target;
}

function assertMachOArchitecture(bytes, architecture) {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf
    || bytes.readUInt32LE(4) !== (architecture === "arm64" ? 0x0100000c : 0x01000007)) {
    throw new Error("The Remote Desktop helper does not match the macOS build target.");
  }
}

function assertPortableExecutable(bytes, architecture) {
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : -1;
  const expectedMachine = architecture === "x64" ? 0x8664 : architecture === "arm64" ? 0xaa64 : -1;
  if (offset < 0 || offset + 6 > bytes.length || bytes[0] !== 0x4d || bytes[1] !== 0x5a
    || bytes.readUInt32LE(offset) !== 0x00004550 || bytes.readUInt16LE(offset + 4) !== expectedMachine) {
    throw new Error("The Remote Desktop helper does not match the Windows build target.");
  }
}

function writeManifest(
  output,
  platform,
  architecture,
  inputHelper,
  inputSha256,
  captureHelper,
  captureSha256
) {
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
    protocolVersion: 1,
    platform,
    architecture,
    inputHelper,
    inputSha256,
    captureHelper,
    captureSha256
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function directArchitecture(arguments_) {
  if (arguments_.length === 0) return process.arch;
  const requested = arguments_.map((argument) => {
    if (argument === "--x64" || argument === "--arm64") return argument.slice(2);
    if (argument.startsWith("--target-arch=")) return argument.slice("--target-arch=".length);
    throw new Error("Usage: node scripts/build-native-remote-desktop.mjs [--x64|--arm64|--target-arch=x64|arm64]");
  });
  const architectures = [...new Set(requested)];
  if (architectures.length !== 1 || !["x64", "arm64"].includes(architectures[0])) {
    throw new Error("A direct Remote Desktop helper build requires exactly one x64 or arm64 target.");
  }
  return architectures[0];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNativeRemoteDesktop({ architecture: directArchitecture(process.argv.slice(2)) });
}
