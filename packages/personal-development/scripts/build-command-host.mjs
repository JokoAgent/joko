import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function buildDevelopmentCommandHost({ platform = process.platform, architecture = process.arch,
  output = join(packageRoot, "dist", "native-command-host") } = {}) {
  if (platform !== process.platform || architecture !== process.arch) throw new Error("Personal command helpers must be built on their exact target host.");
  const destination = resolve(output); mkdirSync(destination, { recursive: true });
  const manifestPath = join(destination, "manifest.json");
  if (platform !== "win32") {
    writeFileSync(manifestPath, `${JSON.stringify({ format: 1, platform, architecture, helper: null })}\n`); return;
  }
  if (architecture !== "x64") throw new Error("Personal development supports only Windows x64.");
  const source = join(packageRoot, "native", "windows-command-host");
  const digest = createHash("sha256");
  for (const file of ["Cargo.toml", "Cargo.lock", "src/main.rs"]) digest.update(file).update("\0").update(readFileSync(join(source, file)));
  const sourceDigest = digest.digest("hex"); const executable = join(destination, "joko-command-host.exe");
  try {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (previous.format === 1 && previous.sourceDigest === sourceDigest && previous.helper?.sha256 === hash(readFileSync(executable))) return;
  } catch { /* An absent or changed build input requires an actual compilation. */ }
  const portable = resolve(packageRoot, "..", "..", ".runtime", "rust-toolchain", "bin", "cargo.exe");
  const cargo = process.env.JOKO_CARGO_EXECUTABLE ?? (existsSync(portable) ? portable : "cargo");
  const cache = mkdtempSync(join(tmpdir(), "joko-personal-command-build-"));
  try {
    const result = spawnSync(cargo, ["build", "--release", "--locked", "--target", "x86_64-pc-windows-msvc", "--manifest-path", join(source, "Cargo.toml"), "--target-dir", cache], {
      env: { ...process.env, JOKO_COMMAND_HOST_SOURCE_DIGEST: sourceDigest, PATH: `${dirname(cargo)};${process.env.PATH ?? process.env.Path ?? ""}` }, windowsHide: true, stdio: "inherit"
    });
    if (result.error || result.status !== 0) throw new Error("Personal command helper requires the Rust MSVC toolchain and Visual Studio C++ Build Tools.");
    const compiled = join(cache, "x86_64-pc-windows-msvc", "release", "joko-command-host.exe"); const bytes = readFileSync(compiled);
    const offset = bytes.readUInt32LE(0x3c);
    if (bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error("Personal command helper is not a Windows x64 PE artifact.");
    copyFileSync(compiled, executable);
    writeFileSync(manifestPath, `${JSON.stringify({ format: 1, platform, architecture, sourceDigest,
      helper: { file: "joko-command-host.exe", sha256: hash(bytes), bytes: bytes.length } })}\n`);
  } finally {
    const absolute = resolve(cache); const rel = relative(resolve(tmpdir()), absolute);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && absolute === cache) rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildDevelopmentCommandHost();
