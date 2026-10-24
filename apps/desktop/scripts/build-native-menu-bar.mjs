import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nativeArtifacts from "./native-helper-artifacts.cjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "menu-bar", "macos-menu-bar-helper.swift");
const brandAssets = resolve(root, "..", "..", "packages", "brand-assets", "src");
const artifact = nativeArtifacts.SIMPLE_NATIVE_ARTIFACTS.menuBar;
const helper = artifact.helpers.darwin;

export function nativeMenuBarCompilerTarget(architecture) {
  const target = {
    x64: "x86_64-apple-macos14.0",
    arm64: "arm64-apple-macos14.0"
  }[architecture];
  if (target === undefined) throw new Error("The native menu bar helper architecture is unsupported.");
  return target;
}

export function buildNativeMenuBar({ platform = process.platform, architecture = process.arch,
  output = join(root, "dist", artifact.directory) } = {}) {
  const artifactOutput = resolve(output);
  mkdirSync(artifactOutput, { recursive: true });
  rmSync(join(artifactOutput, helper), { force: true });
  rmSync(join(artifactOutput, `${helper}.staged`), { force: true });
  writeManifest(artifactOutput, platform, architecture, null, null);
  if (platform !== "darwin") return;
  if (process.platform !== "darwin") throw new Error("The native menu bar helper can only be compiled on macOS.");
  const target = nativeMenuBarCompilerTarget(architecture);
  const cache = mkdtempSync(join(tmpdir(), "joko-native-menu-bar-build-"));
  try {
    const entry = join(cache, "main.swift");
    const icons = [["Dark", "icon-dark.svg"], ["Light", "icon-light.svg"]]
      .map(([name, file]) => `let jokoMenuBar${name}Svg = "${readFileSync(join(brandAssets, file)).toString("base64")}"`);
    writeFileSync(entry, `${icons.join("\n")}\n${readFileSync(source, "utf8")}`);
    const binary = join(cache, helper);
    const result = spawnSync("xcrun", ["--sdk", "macosx", "swiftc", entry, "-parse-as-library", "-O", "-target", target,
      "-framework", "AppKit", "-framework", "SwiftUI", "-framework", "Charts", "-framework", "Combine", "-framework", "CoreText",
      "-o", binary], { cwd: root, stdio: "inherit", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error("The native menu bar helper requires the macOS Swift command-line developer tools.", { cause: result.error });
    }
    const bytes = readFileSync(binary);
    if (bytes.length < 32 || bytes.length > artifact.maximumBytes || bytes.readUInt32LE(0) !== 0xfeedfacf
      || bytes.readUInt32LE(4) !== (architecture === "arm64" ? 0x0100000c : 0x01000007)) {
      throw new Error("The native menu bar helper does not match the build target.");
    }
    const staged = join(artifactOutput, `${helper}.staged`);
    copyFileSync(binary, staged);
    chmodSync(staged, 0o755);
    renameSync(staged, join(artifactOutput, helper));
    writeManifest(artifactOutput, platform, architecture, helper, createHash("sha256").update(bytes).digest("hex"));
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

function writeManifest(output, platform, architecture, name, sha256) {
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify({ protocolVersion: 1, platform, architecture,
    helper: name, sha256 }, null, 2)}\n`);
}

function directArchitecture(arguments_) {
  if (arguments_.length === 0) return process.arch;
  const requested = arguments_.map((argument) => {
    if (argument === "--x64" || argument === "--arm64") return argument.slice(2);
    if (argument.startsWith("--target-arch=")) return argument.slice("--target-arch=".length);
    throw new Error("Usage: node scripts/build-native-menu-bar.mjs [--x64|--arm64|--target-arch=x64|arm64]");
  });
  const architectures = [...new Set(requested)];
  if (architectures.length !== 1 || !["x64", "arm64"].includes(architectures[0])) {
    throw new Error("A direct native menu bar build requires exactly one x64 or arm64 target.");
  }
  return architectures[0];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildNativeMenuBar({ architecture: directArchitecture(process.argv.slice(2)) });
}
