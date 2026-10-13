import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.dirname(fileURLToPath(import.meta.url));
const [outputArgument] = process.argv.slice(2);
if (!outputArgument || !path.isAbsolute(outputArgument)) throw new Error("Absolute output directory required");
if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("The privacy plugin must be compiled on its target Linux architecture.");
}
const output = path.resolve(outputArgument);
const targetArchitecture = process.env.JOKO_NATIVE_TARGET_ARCH ?? process.arch;
if (targetArchitecture !== process.arch) throw new Error("The privacy plugin cannot be cross-compiled.");
fs.mkdirSync(output, { recursive: true });
const temporary = path.join(output, `privacy-${process.pid}.so`);
const plugin = path.join(output, "joko-hyprland-privacy.so");
const metadata = path.join(output, "joko-hyprland-privacy.json");
// Failed or unsupported builds cannot leave earlier plugin inputs behind.
for (const target of [plugin, metadata, temporary]) fs.rmSync(target, { force: true });

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64_000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}

const version = run("pkg-config", ["--modversion", "hyprland"]);
// Internal render/input hooks are deliberately version-bound, never best-effort.
if (version !== "0.56.2") throw new Error("Unsupported Hyprland headers");
const header = fs.readFileSync("/usr/include/hyprland/src/version.h", "utf8");
const hash = header.match(/#define GIT_COMMIT_HASH\s+"([a-f0-9]{40})"/)?.[1];
const dirty = header.match(/#define GIT_DIRTY\s+"([^"]*)"/)?.[1];
if (!hash || dirty !== "") throw new Error("A clean Hyprland build identity is required.");
const flags = run("pkg-config", ["--cflags", "hyprland"]).split(/\s+/).filter(Boolean);
const digest = createHash("sha256");
for (const name of ["main.cpp", "gate.hpp", "build.mjs"]) {
  digest.update(fs.readFileSync(path.join(root, name)));
}
// Embed self-owned complete Hero/icon resources. The compositor reads no files or network.
const assetRoot = path.resolve(root, "../../../../../packages/brand-assets/src");
const artwork = [];
for (const [symbol, name, edge] of [
  ["heroLight", "landing-artwork/jogging-light.svg", 1200],
  ["heroDark", "landing-artwork/jogging-dark.svg", 1200],
  ["iconLight", "icon-light.svg", 256],
  ["iconDark", "icon-dark.svg", 256]
]) {
  const bytes = fs.readFileSync(path.join(assetRoot, name));
  digest.update(bytes);
  const png = await sharp(bytes).resize({ width: edge, height: edge, fit: "inside" }).png().toBuffer();
  artwork.push(`static const unsigned char ${symbol}Png[] = {${Array.from(png).join(",")}};`);
}
fs.writeFileSync(path.join(output, "privacy-artwork.hpp"), artwork.join("\n"));
const source = digest.digest("hex");
try {
  run("c++", [
    "-std=c++26",
    "-shared",
    "-fPIC",
    "-O2",
    "-Wall",
    "-Wextra",
    `-DJOKO_PRIVACY_SOURCE="${source}"`,
    "-Wno-unused-parameter",
    "-Wno-missing-field-initializers",
    ...flags,
    "-I",
    output,
    path.join(root, "main.cpp"),
    "-ljson-c",
    "-o",
    temporary
  ]);
  // The Linux build machine must match the plugin's advertised ELF target.
  const bytes = fs.readFileSync(temporary);
  const machine = process.arch === "x64" ? 62 : 183;
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes.subarray(1, 4).toString("ascii") !== "ELF"
    || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== machine) {
    throw new Error("The privacy plugin ELF target does not match its Linux architecture.");
  }
  fs.renameSync(temporary, plugin);
  fs.writeFileSync(metadata, JSON.stringify({ version, hash, source }));
} finally {
  fs.rmSync(temporary, { force: true });
}
