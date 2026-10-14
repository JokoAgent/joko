import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "remote-desktop");
const defaultOutput = join(root, "dist", "native-remote-desktop");
const macHelper = "joko-macos-remote-desktop-input";
const macCaptureHelper = "joko-macos-remote-desktop-capture";
const macCredentialHelper = "joko-macos-remote-credentials";
const credentialBundle = "JokoRemoteCredentials_JokoRemoteCredentials.bundle";
const windowsHelper = "joko-windows-remote-desktop-input.exe";
const windowsHostService = "joko-windows-remote-desktop-host.exe";
const windowsHostAddon = "joko-windows-remote-desktop-host.node";
const linuxHelper = "joko-linux-remote-desktop-input";
const linuxCaptureHelper = "joko-linux-remote-desktop-capture";
const linuxClipboardHelper = "joko-linux-remote-desktop-clipboard";
const linuxViewerScript = "linux-viewer-display.py";
const linuxPrivacyPlugin = "joko-hyprland-privacy.so";
const linuxPrivacyMetadata = "joko-hyprland-privacy.json";
const linuxCredentialDirectory = "linux-credentials";
const linuxCredentialNames = ["main.py", "channel.py", "host.py", "storage.py", "platform_linux.py", "requirements.txt"];

export function nativeRemoteDesktopMacTarget(architecture) {
  const target = {
    x64: { compilerArchitecture: "x86_64", triple: "x86_64-apple-macos11.0" },
    arm64: { compilerArchitecture: "arm64", triple: "arm64-apple-macos11.0" }
  }[architecture];
  if (target === undefined) throw new Error("The Remote Desktop macOS helper architecture is unsupported.");
  return Object.freeze(target);
}

export function assertNativeRemoteDesktopBuildTarget(platform, architecture) {
  if (["darwin", "win32", "linux"].includes(platform) && platform !== process.platform) {
    throw new Error("The Remote Desktop native helper must be compiled on its target operating system.");
  }
  if (platform === "linux" && (!["x64", "arm64"].includes(architecture) || architecture !== process.arch)) {
    throw new Error("The Remote Desktop Linux helpers must be compiled on their target architecture.");
  }
}

export function buildNativeRemoteDesktop({
  platform = process.platform,
  architecture = process.arch,
  output = defaultOutput
} = {}) {
  assertNativeRemoteDesktopBuildTarget(platform, architecture);
  const artifactOutput = resolve(output);
  mkdirSync(artifactOutput, { recursive: true });
  for (const name of [
    macHelper,
    macCaptureHelper,
    macCredentialHelper,
    windowsHelper,
    windowsHostService,
    windowsHostAddon,
    linuxHelper,
    linuxCaptureHelper,
    linuxClipboardHelper,
    linuxViewerScript,
    linuxPrivacyPlugin,
    linuxPrivacyMetadata,
    `${macHelper}.staged`,
    `${macCaptureHelper}.staged`,
    `${macCredentialHelper}.staged`,
    `${windowsHelper}.staged`,
    `${windowsHostService}.staged`,
    `${windowsHostAddon}.staged`,
    `${linuxHelper}.staged`,
    `${linuxCaptureHelper}.staged`,
    `${linuxClipboardHelper}.staged`,
    `${linuxViewerScript}.staged`,
    `${linuxPrivacyPlugin}.staged`,
    `${linuxPrivacyMetadata}.staged`
  ]) {
    rmSync(join(artifactOutput, name), { force: true });
  }
  const credentialResources = resolve(artifactOutput, credentialBundle);
  if (!credentialResources.startsWith(`${artifactOutput}${sep}`)) throw new Error("Invalid native resource path.");
  rmSync(credentialResources, { recursive: true, force: true });
  const linuxCredentials = resolve(artifactOutput, linuxCredentialDirectory);
  if (!linuxCredentials.startsWith(`${artifactOutput}${sep}`)) throw new Error("Invalid native resource path.");
  rmSync(linuxCredentials, { recursive: true, force: true });
  rmSync(join(artifactOutput, "manifest.json"), { force: true });
  writeManifest(artifactOutput, platform, architecture, null, null, null, null, null, null, null, null, null);
  if (!["darwin", "win32", "linux"].includes(platform)) return;

  const cache = mkdtempSync(join(tmpdir(), "joko-native-remote-desktop-build-"));
  try {
    const inputHelper = platform === "darwin" ? macHelper : platform === "linux" ? linuxHelper : windowsHelper;
    const captureHelper = platform === "darwin" ? macCaptureHelper : linuxCaptureHelper;
    const inputBinary = join(cache, inputHelper);
    let captureBinary = null;
    let clipboardBinary = null;
    let credentialBinary = null;
    let resourceDigest = null;
    let privacyBinary = null;
    let privacyMetadata = null;
    let linuxCredentialFiles = null;
    let hostServiceBinary = null;
    let hostAddonBinary = null;
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
        "-framework", "IOKit", "-framework", "ScreenCaptureKit",
        "-framework", "CoreMedia", "-framework", "CoreVideo", "-o", captureBinary
      ], "The Remote Desktop capture helper requires the macOS command-line developer tools.");
      assertMachOArchitecture(readFileSync(captureBinary), architecture);
      const packagePath = resolve(root, "..", "..", "packages", "remote-credentials-native");
      const credentialTriple = `${target.compilerArchitecture}-apple-macosx12.0`;
      const arguments_ = ["build", "--package-path", packagePath, "--scratch-path", join(cache, "swift"),
        "--configuration", "release", "--triple", credentialTriple, "--product", macCredentialHelper,
        "--disable-automatic-resolution"];
      run("swift", arguments_, "The native credential helper requires the macOS Swift developer tools and its pinned JOSESwift dependency.");
      const location = spawnSync("swift", [...arguments_, "--show-bin-path"], { cwd: root, encoding: "utf8", windowsHide: true });
      if (location.error !== undefined || location.status !== 0 || !location.stdout.trim().startsWith("/")) {
        throw new Error("The native credential helper build output is unavailable.");
      }
      const swiftOutput = location.stdout.trim();
      credentialBinary = join(swiftOutput, macCredentialHelper);
      assertMachOArchitecture(readFileSync(credentialBinary), architecture);
      cpSync(join(swiftOutput, credentialBundle), join(artifactOutput, credentialBundle), { recursive: true });
      resourceDigest = credentialResourceDigest(join(artifactOutput, credentialBundle));
    } else if (platform === "linux") {
      const inputOutput = join(cache, "linux-input"), captureOutput = join(cache, "linux-capture"),
        clipboardOutput = join(cache, "linux-clipboard");
      run(process.execPath, [join(source, "linux-input", "build.mjs"), inputOutput],
        "The Remote Desktop Linux input helper requires cc, wayland-scanner, pkg-config, wayland-client, xkbcommon and json-c.");
      run(process.execPath, [join(source, "linux-capture", "build.mjs"), captureOutput],
        "The Remote Desktop Linux capture helper requires cc, wayland-scanner, pkg-config, wayland-client, libturbojpeg and libpng.");
      run(process.execPath, [join(source, "linux-clipboard", "build.mjs"), clipboardOutput],
        "The Remote Desktop Linux clipboard helper requires cc, wayland-scanner, pkg-config, wayland-client and json-c.");
      copyFileSync(join(inputOutput, linuxHelper), inputBinary);
      captureBinary = join(captureOutput, linuxCaptureHelper);
      clipboardBinary = join(clipboardOutput, linuxClipboardHelper);
      assertLinuxRemoteDesktopElf(readFileSync(inputBinary), architecture);
      assertLinuxRemoteDesktopElf(readFileSync(captureBinary), architecture);
      assertLinuxRemoteDesktopElf(readFileSync(clipboardBinary), architecture);
      const credentialsStaged = join(cache, linuxCredentialDirectory);
      mkdirSync(credentialsStaged);
      linuxCredentialFiles = {};
      for (const name of linuxCredentialNames) {
        const file = join(source, linuxCredentialDirectory, name);
        const metadata = lstatSync(file);
        const bytes = readFileSync(file);
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!metadata.isFile() || metadata.isSymbolicLink() || bytes.length < 1
          || bytes.length > (name === "requirements.txt" ? 4_096 : 128_000) || text.includes("\0")
          || (name === "main.py" && !text.startsWith("#!/usr/bin/python3\n"))) {
          throw new Error("The Remote Desktop Linux credential source is invalid.");
        }
        linuxCredentialFiles[name] = stageHelper(credentialsStaged, name, file, 0o644);
      }
      renameSync(credentialsStaged, linuxCredentials);
      const headers = spawnSync("pkg-config", ["--modversion", "hyprland"], {
        cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 4_096
      });
      if (headers.error === undefined && headers.status === 0 && headers.stdout.trim() === "0.56.2") {
        run(process.execPath, [join(source, "hyprland-privacy", "build.mjs"), cache],
          "The Remote Desktop Linux privacy plugin build failed for its pinned Hyprland headers.");
        privacyBinary = join(cache, linuxPrivacyPlugin);
        privacyMetadata = join(cache, linuxPrivacyMetadata);
        const bytes = readFileSync(privacyBinary);
        assertLinuxRemoteDesktopElf(bytes, architecture);
        if (bytes.readUInt16LE(16) !== 3) throw new Error("The Remote Desktop privacy plugin must be a shared object.");
        assertPrivacyMetadata(readFileSync(privacyMetadata));
      }
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
      assertWindowsHostArtifact(readFileSync(inputBinary), architecture, false);
      run(cargo, [
        "build", "--release", "--locked",
        "--manifest-path", join(source, "windows-host", "Cargo.toml"),
        "--target", target, "--target-dir", targetDirectory
      ], "The Remote Desktop Windows system service requires the Rust MSVC toolchain.", {
        ...process.env, PATH: `${dirname(cargo)};${process.env.PATH ?? process.env.Path ?? ""}`
      });
      hostServiceBinary = join(targetDirectory, target, "release", windowsHostService);
      hostAddonBinary = join(targetDirectory, target, "release", "joko_windows_remote_desktop_host.dll");
      assertWindowsHostArtifact(readFileSync(hostServiceBinary), architecture, false);
      assertWindowsHostArtifact(readFileSync(hostAddonBinary), architecture, true);
    }
    const inputSha256 = stageHelper(artifactOutput, inputHelper, inputBinary);
    const captureSha256 = captureBinary === null
      ? null
      : stageHelper(artifactOutput, captureHelper, captureBinary);
    const credentialSha256 = credentialBinary === null ? null : stageHelper(artifactOutput, macCredentialHelper, credentialBinary);
    writeManifest(
      artifactOutput,
      platform,
      architecture,
      inputHelper,
      inputSha256,
      captureBinary === null ? null : captureHelper,
      captureSha256,
      credentialBinary === null ? null : macCredentialHelper,
      credentialSha256,
      resourceDigest,
      clipboardBinary === null ? null : linuxClipboardHelper,
      clipboardBinary === null ? null : stageHelper(artifactOutput, linuxClipboardHelper, clipboardBinary),
      platform === "linux" ? stageHelper(artifactOutput, linuxViewerScript, join(source, linuxViewerScript)) : null,
      privacyBinary === null ? null : stageHelper(artifactOutput, linuxPrivacyPlugin, privacyBinary),
      privacyMetadata === null ? null : stageHelper(artifactOutput, linuxPrivacyMetadata, privacyMetadata, 0o644),
      linuxCredentialFiles,
      hostServiceBinary === null ? null : stageHelper(artifactOutput, windowsHostService, hostServiceBinary),
      hostAddonBinary === null ? null : stageHelper(artifactOutput, windowsHostAddon, hostAddonBinary)
    );
  } finally {
    const temporaryRoot = resolve(tmpdir());
    if (!resolve(cache).startsWith(`${temporaryRoot}${sep}`)) throw new Error("Invalid native build cache path.");
    rmSync(cache, { recursive: true, force: true });
  }
}

function credentialResourceDigest(root) {
  const hash = createHash("sha256");
  let count = 0;
  let size = 0;
  function visit(path, relative) {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error("The native credential resources contain a symbolic link.");
    if (metadata.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (!/^[A-Za-z0-9_.-]+$/u.test(entry)) throw new Error("The native credential resource name is invalid.");
        visit(join(path, entry), relative.length === 0 ? entry : `${relative}/${entry}`);
      }
    } else {
      if (!metadata.isFile() || ++count > 16 || (size += metadata.size) > 1024 * 1024) throw new Error("The native credential resources are invalid.");
      hash.update(relative).update("\0").update(readFileSync(path));
    }
  }
  visit(root, "");
  if (count === 0) throw new Error("The native credential resources are missing.");
  return hash.digest("hex");
}

function stageHelper(output, helper, binary, mode = 0o755) {
  const bytes = readFileSync(binary);
  if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024) {
    throw new Error(`The Remote Desktop ${helper} helper has an invalid size.`);
  }
  const staged = join(output, `${helper}.staged`);
  copyFileSync(binary, staged);
  chmodSync(staged, mode);
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

export function assertWindowsHostArtifact(bytes, architecture, addon) {
  assertPortableExecutable(bytes, architecture);
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 24 > bytes.length || Boolean(bytes.readUInt16LE(offset + 22) & 0x2000) !== addon) {
    throw new Error("The Remote Desktop Windows host artifact does not match its executable or addon role.");
  }
}

export function assertLinuxRemoteDesktopElf(bytes, architecture) {
  const machine = architecture === "x64" ? 62 : architecture === "arm64" ? 183 : -1;
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes.toString("ascii", 1, 4) !== "ELF"
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1
    || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== machine
    || bytes.readUInt32LE(20) !== 1 || bytes.readUInt16LE(52) !== 64) {
    throw new Error("The Remote Desktop helper does not match the Linux build target.");
  }
}

function writeManifest(
  output,
  platform,
  architecture,
  inputHelper,
  inputSha256,
  captureHelper,
  captureSha256,
  credentialHelper,
  credentialSha256,
  credentialBundleSha256,
  clipboardHelper,
  clipboardSha256,
  viewerDisplaySha256 = null,
  privacySha256 = null,
  privacyMetadataSha256 = null,
  linuxCredentialFiles = null,
  windowsHostServiceSha256 = null,
  windowsHostAddonSha256 = null
) {
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
    protocolVersion: 1,
    platform,
    architecture,
    inputHelper,
    inputSha256,
    captureHelper,
    captureSha256,
    credentialHelper,
    credentialSha256,
    credentialBundle: credentialHelper === null ? null : credentialBundle,
    credentialBundleSha256,
    clipboardHelper,
    clipboardSha256,
    viewerDisplayScript: viewerDisplaySha256 === null ? null : linuxViewerScript,
    viewerDisplaySha256,
    viewerDisplayInterpreter: viewerDisplaySha256 === null ? null : "/usr/bin/python3",
    privacyPlugin: privacySha256 === null ? null : linuxPrivacyPlugin,
    privacySha256,
    privacyMetadata: privacyMetadataSha256 === null ? null : linuxPrivacyMetadata,
    privacyMetadataSha256,
    linuxCredentialDirectory: linuxCredentialFiles === null ? null : linuxCredentialDirectory,
    linuxCredentialInterpreter: linuxCredentialFiles === null ? null : "/usr/bin/python3",
    linuxCredentialFiles,
    windowsHostService: windowsHostServiceSha256 === null ? null : windowsHostService,
    windowsHostServiceSha256,
    windowsHostAddon: windowsHostAddonSha256 === null ? null : windowsHostAddon,
    windowsHostAddonSha256,
    windowsHostNodeApiVersion: windowsHostAddonSha256 === null ? null : 6
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertPrivacyMetadata(bytes) {
  if (bytes.length < 1 || bytes.length > 4_096) throw new Error("The Remote Desktop privacy metadata is invalid.");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "hash,source,version"
    || value.version !== "0.56.2" || typeof value.hash !== "string" || !/^[a-f0-9]{40}$/u.test(value.hash)
    || typeof value.source !== "string" || !/^[a-f0-9]{64}$/u.test(value.source)) {
    throw new Error("The Remote Desktop privacy metadata does not match its pinned build identity.");
  }
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
