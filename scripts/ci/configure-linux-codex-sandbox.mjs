import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const profile = "/etc/apparmor.d/bwrap-userns-restrict";
const suppliedProfile = "/usr/share/apparmor/extra-profiles/bwrap-userns-restrict";
const executable = "/usr/bin/bwrap";
let phase = "environment";

async function restrictionValue() {
  const value = (await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8")).trim();
  if (value !== "0" && value !== "1") throw new Error("Unknown native sandbox restriction state.");
  return value;
}

async function assertSystemFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0
    || await realpath(path) !== path) throw new Error("Native sandbox system input is unsafe.");
}

function sudo(args) {
  return execFileSync("sudo", ["--non-interactive", ...args], { shell: false, timeout: 10_000, stdio: "pipe" });
}

try {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Native sandbox configuration requires Linux CI.");
  }
  const restriction = await restrictionValue();
  phase = "system-bubblewrap";
  await assertSystemFile(executable);
  await access(executable, constants.X_OK);
  const version = execFileSync(executable, ["--version"], { shell: false, timeout: 10_000, maxBuffer: 4096, encoding: "utf8" }).trim();
  if (!/^bubblewrap \d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/u.test(version)) throw new Error("System bubblewrap version is invalid.");
  const help = execFileSync(executable, ["--help"], { shell: false, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8" });
  if (!help.includes("--as-pid-1") || !help.includes("--perms")) throw new Error("System bubblewrap lacks the fixed runtime's required options.");
  const selected = execFileSync("which", ["bwrap"], { shell: false, timeout: 10_000, encoding: "utf8" }).trim();
  if (await realpath(selected) !== executable) throw new Error("The fixed runtime would select a different bubblewrap.");
  phase = "distribution-profile";
  const existing = await lstat(profile).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing === undefined) {
    await assertSystemFile(suppliedProfile);
    sudo(["install", "--owner=root", "--group=root", "--mode=0644", "--", suppliedProfile, profile]);
  }
  await assertSystemFile(profile);
  const profileSha256 = createHash("sha256").update(await readFile(profile)).digest("hex");
  sudo(["apparmor_parser", "--replace", profile]);
  phase = "namespace-probe";
  execFileSync(executable, ["--unshare-user", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--", "/usr/bin/true"], {
    shell: false, timeout: 10_000, maxBuffer: 64 * 1024, stdio: "pipe"
  });
  phase = "restriction-recheck";
  if (await restrictionValue() !== restriction) throw new Error("Global native sandbox restrictions changed.");
  console.log(JSON.stringify({ phase: "native-sandbox-configured", systemBubblewrap: true, version, profileSha256, distributionProfileLoaded: true,
    userAndNetworkNamespacesVerified: true, apparmorRestrictUnprivilegedUserns: Number(restriction), globalRestrictionUnchanged: true }));
} catch (error) {
  console.error(JSON.stringify({ phase: "native-sandbox-configuration-failed", step: phase,
    code: error.code, status: error.status, signal: error.signal }));
  process.exitCode = 1;
}
