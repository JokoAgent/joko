import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native", "hardware", "windows-micro-helper");
const output = join(root, "dist", "native-hardware");
const helper = "joko-windows-micro-helper.exe";
mkdirSync(output, { recursive: true });
// Clear only this build's fixed binary; a failed build must not retain a usable identity.
rmSync(join(output, helper), { force: true });
writeManifest(null, null);

if (process.platform === "win32") {
  const target = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" }[process.arch];
  if (target === undefined) throw new Error("The native USB helper architecture is unsupported.");
  const portableCargo = resolve(root, "..", "..", ".runtime", "rust-toolchain", "bin", "cargo.exe");
  const cargo = process.env.JOKO_CARGO_EXECUTABLE ?? (existsSync(portableCargo) ? portableCargo : "cargo");
  const cache = join(root, "dist", ".native-hardware-build");
  const result = spawnSync(cargo, ["build", "--locked", "--release", "--manifest-path",
    join(source, "Cargo.toml"), "--target", target, "--target-dir", cache], {
    cwd: root, stdio: "inherit", windowsHide: true,
    env: { ...process.env, PATH: `${dirname(cargo)};${process.env.PATH ?? process.env.Path ?? ""}` }
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("The native USB helper requires Rust (MSVC toolchain) and Visual Studio C++ build tools.",
      { cause: result.error });
  }
  const binary = join(cache, target, "release", helper);
  const bytes = readFileSync(binary);
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d || offset > bytes.length - 6 ||
      bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 4) !== (process.arch === "arm64" ? 0xaa64 : 0x8664)) {
    throw new Error("The native USB helper does not match the build target.");
  }
  copyFileSync(binary, join(output, helper));
  writeManifest(helper, createHash("sha256").update(bytes).digest("hex"));
}

function writeManifest(name, sha256) {
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify({ protocolVersion: 1,
    platform: process.platform, architecture: process.arch, helper: name, sha256 }, null, 2)}\n`);
}
