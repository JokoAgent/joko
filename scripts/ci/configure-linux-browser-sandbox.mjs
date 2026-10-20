import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const destination = "/etc/apparmor.d/joko-ci-chromium";
let phase = "environment";

export function browserSandboxProfile(executable) {
  // AppArmor attachment patterns have their own expansion syntax. Accept only
  // a literal installed executable path, with no wildcard or variable syntax.
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(executable) || executable.includes("/../") || executable.includes("/./")) {
    throw new Error("Browser sandbox executable path is not literal.");
  }
  return `abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile joko-ci-chromium "${executable}" flags=(unconfined) {\n  userns,\n}\n`;
}

async function restrictionValue() {
  const value = (await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8")).trim();
  if (value !== "0" && value !== "1") throw new Error("Unknown browser sandbox restriction state.");
  return Number(value);
}

async function main() {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("Browser sandbox configuration requires Linux CI.");
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  phase = "browser-identity";
  const { chromium } = createRequire(resolve(root, "apps/e2e/package.json"))("playwright-core");
  const installed = await realpath(chromium.executablePath());
  const chrome = await realpath("/opt/google/chrome/chrome").catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const executable = await realpath(process.env.JOKO_BROWSER_EXECUTABLE ?? "");
  if (executable !== installed && executable !== chrome) {
    throw new Error("Prepared browser identity does not match the installed browser.");
  }
  const binary = await lstat(executable);
  if (!binary.isFile() || binary.isSymbolicLink()) throw new Error("Installed browser is not regular.");
  await access(executable, constants.X_OK);
  const restriction = await restrictionValue();
  if (executable === chrome && executable !== installed) {
    // Chrome can already own an OS-provided AppArmor attachment. Verify its
    // real sandbox instead of installing a second profile for the same binary.
    const browser = await chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: true, timeout: 15_000 });
    await browser.close();
    if (await restrictionValue() !== restriction) throw new Error("Browser sandbox restriction state changed.");
    console.log(JSON.stringify({ phase: "browser-sandbox-available", exactInstalledExecutable: true,
      existingSystemPolicy: true, sandboxedBrowserLaunched: true,
      apparmorRestrictUnprivilegedUserns: restriction, globalRestrictionUnchanged: true }));
    return;
  }
  const content = browserSandboxProfile(executable);
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing !== undefined) throw new Error("Browser sandbox profile already exists.");
  const directory = await mkdtemp(join(tmpdir(), "joko-browser-sandbox-"));
  try {
    const source = join(directory, "profile");
    await writeFile(source, content, { flag: "wx", mode: 0o600 });
    const sudo = (args) => execFileSync("sudo", ["--non-interactive", ...args], {
      shell: false, timeout: 10_000, stdio: "pipe"
    });
    phase = "profile-install";
    sudo(["install", "--owner=root", "--group=root", "--mode=0644", "--", source, destination]);
    phase = "profile-verify";
    const configured = await lstat(destination);
    if (!configured.isFile() || configured.isSymbolicLink() || configured.uid !== 0 || configured.gid !== 0
      || (configured.mode & 0o7777) !== 0o644 || await readFile(destination, "utf8") !== content) {
      throw new Error("Browser sandbox profile ownership or contents were not established.");
    }
    // Load only this exact executable's profile. Do not change global sysctls,
    // existing profiles, Chromium flags or the production renderer sandbox.
    phase = "profile-load";
    sudo(["apparmor_parser", "--replace", destination]);
    phase = "restriction-recheck";
    if (await restrictionValue() !== restriction) throw new Error("Browser sandbox restriction state changed.");
    console.log(JSON.stringify({ phase: "browser-sandbox-configured", exactInstalledExecutable: true,
      profileRootOwned: true, profileMode: "0644", profileLoaded: true,
      apparmorRestrictUnprivilegedUserns: restriction, globalRestrictionUnchanged: true }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => {
    // Native/parser output can contain the executable and host paths.
    console.error(JSON.stringify({ phase: "browser-sandbox-configuration-failed", step: phase }));
    process.exitCode = 1;
  });
}
