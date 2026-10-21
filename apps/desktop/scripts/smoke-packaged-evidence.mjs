import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalSmokeDirectoryForRemoval } from "./smoke-packaged-helpers.mjs";

const names = ["result.txt", "result.txt.progress", "result.txt.managed-process.json",
  "result.txt.task-sharing-management.png", "result.txt.task-sharing-guest-ready.png", "result.txt.task-sharing-guest.png",
  "result.txt.task-presentation.png", "result.txt.new-task-draft-recovery.png", "result.txt.native-task-status.png"];

export async function preservePackagedSmokeEvidence(options) {
  if (!options.destination) return;
  if (!isAbsolute(options.destination)) throw new Error("Desktop smoke evidence requires an absolute destination.");
  const source = canonicalSmokeDirectoryForRemoval(options.directory, options.temporaryRoot);
  if (!source) throw new Error("The Desktop smoke evidence source is missing.");
  mkdirSync(options.destination, { recursive: true, mode: 0o700 });
  const destinationRoot = realpathSync(options.destination);
  const location = relative(source, destinationRoot);
  if (!location || (location !== ".." && !location.startsWith(`..${sep}`) && !isAbsolute(location))) {
    throw new Error("Desktop smoke evidence must survive outside its temporary profile.");
  }
  const destination = resolve(destinationRoot, basename(source));
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: options.applicationRoot, encoding: "utf8", windowsHide: true }).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit) || (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== sourceCommit)) {
    throw new Error("Desktop smoke evidence source identity does not match the checkout.");
  }
  const binaryHash = createHash("sha256");
  for await (const bytes of createReadStream(options.executable)) binaryHash.update(bytes);
  const files = [];
  for (const name of names) {
    const file = resolve(source, name);
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 8 * 1024 * 1024) {
      throw new Error("Desktop smoke evidence contains an invalid owned receipt.");
    }
    const bytes = readFileSync(file);
    if (name.endsWith(".png") && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("Desktop smoke capture did not produce a PNG.");
    }
    writeFileSync(resolve(destination, name), bytes, { flag: "wx", mode: 0o600 });
    files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const captureNames = files.filter(file => file.name.endsWith(".png")).map(file => file.name);
  const capturesComplete = ["management", "guest-ready", "guest"].every(surface => captureNames.includes(`result.txt.task-sharing-${surface}.png`));
  const passed = options.passed && (options.scope !== "full" || capturesComplete);
  writeFileSync(resolve(destination, "result.json"), JSON.stringify({ sourceCommit, platform: process.platform,
    architecture: process.arch, packaged: options.packaged, scope: options.scope, passed,
    executableSha256: binaryHash.digest("hex"), capturesComplete, files,
    limits: ["Screenshots contain only the isolated smoke profile and controlled fixture content.",
      "The provider is a local fixture; no paid account or physical device was exercised."] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (!passed && options.passed) throw new Error("Desktop smoke completed without its required operation screenshots.");
}
