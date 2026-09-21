#!/usr/bin/env node

import { X509Certificate } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  assertAllowedArgs,
  assertProductionGitGate,
  buildIosExportOptionsPlist,
  createArtifactManifest,
  loadMobileReleaseIdentity,
  normalizeCertificateSha256,
  parseArgs,
  patchIosManualSigning,
  readGitSource,
  readIosRuntimeVersion,
  resolveIosSigningConfiguration,
  sha256File
} from "./release-artifact-lib.mjs";

const MOBILE_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_DIRECTORY = resolve(MOBILE_DIRECTORY, "../..");
const EXPO_CLI = resolve(MOBILE_DIRECTORY, "node_modules/expo/bin/cli");

function run(command, args, options = {}) {
  process.stderr.write(`  $ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { cwd: MOBILE_DIRECTORY, stdio: "inherit", ...options });
  if (result.error?.code === "ENOENT") throw new Error(`${command} is not installed or not on PATH.`);
  if (result.error) throw new Error(`${command} could not start (${result.error.code ?? "unknown error"}).`);
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${String(result.status)}.`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: MOBILE_DIRECTORY, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error?.code === "ENOENT") throw new Error(`${command} is not installed or not on PATH.`);
  if (result.error) throw new Error(`${command} could not start (${result.error.code ?? "unknown error"}).`);
  if (result.status !== 0) throw new Error(`${command} failed while validating the iOS artifact.`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function uniqueChild(directory, suffix, label) {
  const matches = existsSync(directory) ? readdirSync(directory).filter((entry) => entry.endsWith(suffix)).sort() : [];
  if (matches.length !== 1) throw new Error(`${label} expected one ${suffix} entry and found ${matches.length}.`);
  return join(directory, matches[0]);
}

function parsePlist(path) {
  const output = capture("plutil", ["-convert", "json", "-o", "-", path]);
  try { return JSON.parse(output.trim()); }
  catch { throw new Error(`plutil returned invalid JSON for ${basename(path)}.`); }
}

function installProfileIfProvided(path, label) {
  if (!path) return;
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} does not name a provisioning profile file.`);
  const decoded = capture("security", ["cms", "-D", "-i", path]);
  const temporary = join(mkdtempSync(join(tmpdir(), "joko-profile-")), "profile.plist");
  writeFileSync(temporary, decoded);
  const profile = parsePlist(temporary);
  const uuid = typeof profile.UUID === "string" ? profile.UUID.trim() : "";
  if (!/^[0-9A-Fa-f-]{36}$/u.test(uuid)) throw new Error(`${label} has no valid UUID.`);
  const directory = join(homedir(), "Library/MobileDevice/Provisioning Profiles");
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${uuid}.mobileprovision`);
  if (existsSync(destination)) {
    if (sha256File(destination) !== sha256File(path)) throw new Error(`${label} conflicts with an installed profile using UUID ${uuid}.`);
    return;
  }
  copyFileSync(path, destination, constants.COPYFILE_EXCL);
}

function projectPaths() {
  const ios = resolve(MOBILE_DIRECTORY, "ios");
  const workspace = uniqueChild(ios, ".xcworkspace", "Expo prebuild");
  const project = uniqueChild(ios, ".xcodeproj", "Expo prebuild");
  return {
    ios,
    workspace,
    scheme: basename(workspace, ".xcworkspace"),
    pbxProject: join(project, "project.pbxproj")
  };
}

function signingCertificate(path) {
  const directory = mkdtempSync(join(tmpdir(), "joko-codesign-cert-"));
  const prefix = join(directory, "certificate");
  capture("codesign", ["-d", "--extract-certificates", prefix, path]);
  const certificatePath = `${prefix}0`;
  if (!existsSync(certificatePath)) throw new Error(`codesign did not extract a signer certificate from ${basename(path)}.`);
  return normalizeCertificateSha256(new X509Certificate(readFileSync(certificatePath)).fingerprint256, "iOS signing certificate");
}

function entitlements(path) {
  const output = capture("codesign", ["-d", "--entitlements", ":-", path]);
  const plist = output.match(/<\?xml[\s\S]+<\/plist>/u)?.[0];
  if (!plist) throw new Error(`codesign did not return entitlements for ${basename(path)}.`);
  const temporary = join(mkdtempSync(join(tmpdir(), "joko-entitlements-")), "entitlements.plist");
  writeFileSync(temporary, plist);
  return parsePlist(temporary);
}

function validateEntitlements(value, bundleIdentifier, identity, signing, extension) {
  const applicationIdentifier = value["application-identifier"] ?? value["com.apple.application-identifier"];
  if (applicationIdentifier !== `${signing.teamId}.${bundleIdentifier}`
    || value["com.apple.developer.team-identifier"] !== signing.teamId) {
    throw new Error(`${extension ? "Share extension" : "App"} signing entitlement identity is invalid.`);
  }
  const groups = value["com.apple.security.application-groups"];
  if (!Array.isArray(groups) || groups.length !== 1 || groups[0] !== identity.appGroupId) {
    throw new Error(`${extension ? "Share extension" : "App"} does not contain the exact Joko App Group entitlement.`);
  }
  if (!extension) {
    const expectedPush = signing.exportMethod === "debugging" ? "development" : "production";
    if (value["aps-environment"] !== expectedPush) throw new Error("App push entitlement does not match the export method.");
    if (value["com.apple.developer.networking.multicast"] !== true) throw new Error("App multicast entitlement is missing.");
  }
}

function validateIpa(ipa, identity, signing, extractionDirectory) {
  run("ditto", ["-x", "-k", ipa, extractionDirectory]);
  const app = uniqueChild(join(extractionDirectory, "Payload"), ".app", "IPA");
  const extension = uniqueChild(join(app, "PlugIns"), ".appex", "IPA share extension");
  run("codesign", ["--verify", "--deep", "--strict", app]);
  run("codesign", ["--verify", "--strict", extension]);
  const appInfo = parsePlist(join(app, "Info.plist"));
  const extensionInfo = parsePlist(join(extension, "Info.plist"));
  if (appInfo.CFBundleIdentifier !== identity.iosBundleIdentifier
    || appInfo.CFBundleShortVersionString !== identity.version
    || String(appInfo.CFBundleVersion) !== identity.buildNumber) {
    throw new Error("IPA app identity or version does not match app.json.");
  }
  if (extensionInfo.CFBundleIdentifier !== identity.shareExtensionBundleIdentifier
    || extensionInfo.CFBundleShortVersionString !== identity.version
    || String(extensionInfo.CFBundleVersion) !== identity.buildNumber) {
    throw new Error("IPA share extension identity or version does not match app.json.");
  }
  validateEntitlements(entitlements(app), identity.iosBundleIdentifier, identity, signing, false);
  validateEntitlements(entitlements(extension), identity.shareExtensionBundleIdentifier, identity, signing, true);
  const appCertificate = signingCertificate(app);
  const extensionCertificate = signingCertificate(extension);
  if (appCertificate !== signing.expectedCertificateSha256
    || extensionCertificate !== signing.expectedCertificateSha256) {
    throw new Error("IPA signer does not match the independently pinned iOS signing certificate.");
  }
  return appCertificate;
}

function materializeArtifact(ipa, identity, source, runtimeVersion, certificate, outputArg) {
  const outputDirectory = outputArg
    ? resolve(String(outputArg))
    : resolve(MOBILE_DIRECTORY, "dist/native/ios", `${source.commit.slice(0, 12)}-${runtimeVersion.slice(0, 12)}`);
  if (existsSync(outputDirectory)) throw new Error(`Artifact output already exists: ${outputDirectory}`);
  mkdirSync(outputDirectory, { recursive: true });
  const fileName = `joko-mobile-${identity.version}-${identity.buildNumber}.ipa`;
  const destination = join(outputDirectory, fileName);
  copyFileSync(ipa, destination, constants.COPYFILE_EXCL);
  const record = {
    kind: "ipa",
    fileName,
    byteSize: statSync(destination).size,
    sha256: sha256File(destination),
    signingCertificateSha256: certificate
  };
  const manifest = createArtifactManifest({
    platform: "ios",
    identity,
    source,
    runtimeVersion,
    artifacts: [record]
  });
  const manifestPath = join(outputDirectory, "joko-mobile-artifact.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { outputDirectory, manifestPath, record };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertAllowedArgs(args, ["execute", "out", "skipGitGate"]);
  if (args.execute !== undefined && args.execute !== true) throw new Error("--execute does not accept a value.");
  if (args.skipGitGate !== undefined && args.skipGitGate !== true) throw new Error("--skip-git-gate does not accept a value.");
  const identity = loadMobileReleaseIdentity(MOBILE_DIRECTORY);
  process.stdout.write([
    "",
    "target: signed iOS IPA with the Joko share extension",
    `identity: ${identity.iosBundleIdentifier} + ${identity.shareExtensionBundleIdentifier}`,
    `version: ${identity.version} (${identity.buildNumber})`,
    "steps: clean prebuild -> exact per-target signing -> archive/export -> identity/runtime/entitlement/signature verification",
    "signing: certificate and provisioning profiles remain outside the repository",
    ""
  ].join("\n"));
  if (!args.execute) {
    process.stdout.write("dry-run: pass --execute on macOS to build an IPA.\n");
    return;
  }
  if (process.platform !== "darwin") throw new Error("iOS artifact execution requires macOS and Xcode.");
  const productionGate = args.skipGitGate ? "bypassed" : "passed";
  if (!args.skipGitGate) assertProductionGitGate(REPOSITORY_DIRECTORY);
  else process.stderr.write("  warning: production Git gate bypassed; the artifact manifest will record this.\n");
  const source = readGitSource(REPOSITORY_DIRECTORY, productionGate);
  const signing = resolveIosSigningConfiguration(process.env);
  const environment = { ...process.env, NODE_ENV: "production" };
  installProfileIfProvided(signing.appProfilePath, "JOKO_IOS_APP_PROFILE_PATH");
  installProfileIfProvided(signing.shareProfilePath, "JOKO_IOS_SHARE_PROFILE_PATH");

  run(process.execPath, [EXPO_CLI, "prebuild", "--platform", "ios", "--clean", "--no-install"], { env: environment });
  const paths = projectPaths();
  if (!existsSync(paths.pbxProject)) throw new Error("Expo prebuild did not produce an Xcode project file.");
  writeFileSync(paths.pbxProject, patchIosManualSigning(readFileSync(paths.pbxProject, "utf8"), identity, signing));
  run("pod", ["install", "--project-directory=ios"], { env: environment });

  const buildDirectory = mkdtempSync(join(tmpdir(), "joko-ios-artifact-"));
  const archive = join(buildDirectory, "Joko.xcarchive");
  const exportDirectory = join(buildDirectory, "export");
  const exportOptions = join(buildDirectory, "ExportOptions.plist");
  writeFileSync(exportOptions, buildIosExportOptionsPlist(identity, signing));
  run("xcodebuild", [
    "-workspace", paths.workspace,
    "-scheme", paths.scheme,
    "-configuration", "Release",
    "-sdk", "iphoneos",
    "-archivePath", archive,
    "archive"
  ], { env: environment });
  run("xcodebuild", [
    "-exportArchive",
    "-archivePath", archive,
    "-exportOptionsPlist", exportOptions,
    "-exportPath", exportDirectory
  ], { env: environment });
  const ipa = uniqueChild(exportDirectory, ".ipa", "xcodebuild export");
  const runtimeVersion = readIosRuntimeVersion(ipa);
  const certificate = validateIpa(ipa, identity, signing, join(buildDirectory, "verified"));
  const result = materializeArtifact(
    ipa,
    identity,
    source,
    runtimeVersion,
    certificate,
    typeof args.out === "string" ? args.out : undefined
  );
  process.stdout.write([
    "",
    "iOS artifact verified.",
    `output: ${result.outputDirectory}`,
    `runtimeVersion: ${runtimeVersion}`,
    `manifest: ${result.manifestPath}`,
    `ipa: ${result.record.fileName} (${result.record.byteSize} bytes, sha256 ${result.record.sha256})`,
    ""
  ].join("\n"));
}

try { main(); }
catch (error) {
  process.stderr.write(`iOS artifact build failed: ${error instanceof Error ? error.message : "unknown failure"}\n`);
  process.exitCode = 1;
}
