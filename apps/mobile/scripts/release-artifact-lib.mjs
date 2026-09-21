import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const ANDROID_ARTIFACT_KINDS = Object.freeze(["apk", "aab"]);

export function androidToolExecutableNames(name, platform = process.platform) {
  return platform === "win32" ? [`${name}.exe`, `${name}.bat`] : [name];
}

export function platformCommand(command, args, platform = process.platform) {
  return platform === "win32" && command.toLowerCase().endsWith(".bat")
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", command, ...args] }
    : { command, args };
}

export function buildJarsignerVerificationArgs(artifactPath, keystorePath) {
  const artifact = requiredText(artifactPath, "AAB path");
  const keystore = requiredText(keystorePath, "Android signing keystore path");
  return Object.freeze([
    "-verify",
    "-strict",
    "-keystore",
    keystore,
    "-storepass:env",
    "JOKO_ANDROID_KEYSTORE_PASSWORD",
    artifact
  ]);
}

export const IOS_EXPORT_METHODS = Object.freeze(["debugging", "release-testing", "enterprise", "app-store-connect"]);
export const MOBILE_ARTIFACT_SCHEMA_VERSION = 1;

export function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (!argument.startsWith("--")) {
      parsed._.push(argument);
      continue;
    }
    const [rawKey, inlineValue] = argument.slice(2).split(/=(.*)/su, 2);
    const key = rawKey.replace(/-+([a-z0-9])/gu, (_match, character) => character.toUpperCase());
    if (!key || Object.hasOwn(parsed, key)) throw new Error(`Duplicate or empty option: --${rawKey}`);
    const following = argv[index + 1];
    if (inlineValue !== undefined) parsed[key] = inlineValue;
    else if (following !== undefined && !following.startsWith("--")) {
      parsed[key] = following;
      index += 1;
    } else parsed[key] = true;
  }
  return parsed;
}

export function assertAllowedArgs(args, allowed) {
  if (args._.length > 0) throw new Error(`Unexpected positional arguments: ${args._.join(", ")}`);
  const unknown = Object.keys(args).filter((key) => key !== "_" && !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown options: ${unknown.map((key) => `--${key}`).join(", ")}`);
}

export function loadMobileReleaseIdentity(mobileDirectory) {
  const app = JSON.parse(readFileSync(resolve(mobileDirectory, "app.json"), "utf8"));
  const expo = app?.expo;
  if (!expo || typeof expo !== "object") throw new Error("app.json must contain an Expo configuration.");
  const version = requiredText(expo.version, "expo.version");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("expo.version must be an explicit semantic version.");
  }
  const buildNumber = requiredText(expo.ios?.buildNumber, "expo.ios.buildNumber");
  if (!/^[1-9]\d*$/u.test(buildNumber)) throw new Error("expo.ios.buildNumber must be a positive decimal string.");
  const versionCode = expo.android?.versionCode;
  if (!Number.isInteger(versionCode) || versionCode <= 0 || versionCode > 2_100_000_000) {
    throw new Error("expo.android.versionCode must be a positive Android version code.");
  }
  const iosBundleIdentifier = bundleIdentifier(expo.ios?.bundleIdentifier, "expo.ios.bundleIdentifier");
  const androidPackage = bundleIdentifier(expo.android?.package, "expo.android.package");
  const scheme = requiredText(expo.scheme, "expo.scheme");
  if (!/^[a-z][a-z0-9+.-]*$/u.test(scheme)) throw new Error("expo.scheme must be a canonical lowercase URI scheme.");
  const sharing = (expo.plugins ?? []).find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-sharing");
  const sharingIos = sharing?.[1]?.ios;
  const appGroupId = bundleIdentifier(sharingIos?.appGroupId, "expo-sharing ios.appGroupId");
  const shareExtensionBundleIdentifier = bundleIdentifier(
    sharingIos?.extensionBundleIdentifier ?? `${iosBundleIdentifier}.expo-sharing-extension`,
    "expo-sharing ios.extensionBundleIdentifier"
  );
  if (!shareExtensionBundleIdentifier.startsWith(`${iosBundleIdentifier}.`)) {
    throw new Error("The share extension bundle identifier must be a child of the app bundle identifier.");
  }
  return Object.freeze({
    name: requiredText(expo.name, "expo.name"),
    slug: requiredText(expo.slug, "expo.slug"),
    scheme,
    version,
    buildNumber,
    versionCode,
    iosBundleIdentifier,
    androidPackage,
    appGroupId,
    shareExtensionBundleIdentifier
  });
}

export function resolveAndroidArtifactKinds(raw) {
  const source = raw === undefined ? "apk,aab" : String(raw).trim();
  if (!source || raw === true) throw new Error("--artifacts must be apk, aab, or apk,aab.");
  const requested = source.split(",").map((item) => item.trim()).filter(Boolean);
  if (new Set(requested).size !== requested.length) throw new Error("--artifacts contains a duplicate kind.");
  const unknown = requested.filter((kind) => !ANDROID_ARTIFACT_KINDS.includes(kind));
  if (unknown.length > 0) throw new Error(`Unsupported Android artifact kind: ${unknown.join(", ")}`);
  return ANDROID_ARTIFACT_KINDS.filter((kind) => requested.includes(kind));
}

export function patchAndroidReleaseSigning(source) {
  if (typeof source !== "string" || !source) throw new Error("Generated Android build.gradle is empty.");
  if (source.includes("signingConfigs.release")) return source;
  const signingBlock = /signingConfigs\s*\{/u;
  if (!signingBlock.test(source)) throw new Error("Generated Android build.gradle has no signingConfigs block.");
  const snippet = `
        release {
            storeFile file(System.getenv("JOKO_ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("JOKO_ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("JOKO_ANDROID_KEY_ALIAS")
            keyPassword System.getenv("JOKO_ANDROID_KEY_PASSWORD")
        }
`;
  let patched = source.replace(signingBlock, (match) => `${match}${snippet}`);
  const releaseSigning = /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?signingConfig\s+signingConfigs\.)debug/u;
  if (!releaseSigning.test(patched)) {
    throw new Error("Generated Android release build type is no longer signed by signingConfigs.debug as expected.");
  }
  patched = patched.replace(releaseSigning, "$1release");
  return patched;
}

export function normalizeCertificateSha256(raw, label = "signing certificate SHA-256") {
  const normalized = String(raw ?? "").trim().replace(/^sha-?256\s*:/iu, "").replace(/[\s:]/gu, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error(`${label} must be 64 hexadecimal characters.`);
  return normalized;
}

export function certificateSha256FromPem(raw, label = "signing certificate") {
  const pem = String(raw ?? "").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u)?.[0];
  if (!pem) throw new Error(`${label} output did not contain a certificate.`);
  return normalizeCertificateSha256(new X509Certificate(pem).fingerprint256, label);
}

export function resolveAndroidSigningEnvironment(environment) {
  const names = [
    "JOKO_ANDROID_KEYSTORE_PATH",
    "JOKO_ANDROID_KEYSTORE_PASSWORD",
    "JOKO_ANDROID_KEY_ALIAS",
    "JOKO_ANDROID_KEY_PASSWORD",
    "JOKO_ANDROID_SIGNING_CERT_SHA256"
  ];
  const values = Object.fromEntries(names.map((name) => [name, cleanEnvironmentValue(environment[name], name)]));
  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0) throw new Error(`Android release signing is missing: ${missing.join(", ")}.`);
  return Object.freeze({
    gradleEnvironment: Object.freeze({
      JOKO_ANDROID_KEYSTORE_PATH: values.JOKO_ANDROID_KEYSTORE_PATH,
      JOKO_ANDROID_KEYSTORE_PASSWORD: values.JOKO_ANDROID_KEYSTORE_PASSWORD,
      JOKO_ANDROID_KEY_ALIAS: values.JOKO_ANDROID_KEY_ALIAS,
      JOKO_ANDROID_KEY_PASSWORD: values.JOKO_ANDROID_KEY_PASSWORD
    }),
    expectedCertificateSha256: normalizeCertificateSha256(
      values.JOKO_ANDROID_SIGNING_CERT_SHA256,
      "JOKO_ANDROID_SIGNING_CERT_SHA256"
    )
  });
}

export function resolveIosSigningConfiguration(environment) {
  const teamId = cleanEnvironmentValue(environment.JOKO_IOS_TEAM_ID, "JOKO_IOS_TEAM_ID");
  const appProfile = cleanEnvironmentValue(environment.JOKO_IOS_APP_PROFILE, "JOKO_IOS_APP_PROFILE");
  const shareProfile = cleanEnvironmentValue(environment.JOKO_IOS_SHARE_PROFILE, "JOKO_IOS_SHARE_PROFILE");
  const identity = cleanEnvironmentValue(environment.JOKO_IOS_SIGNING_IDENTITY, "JOKO_IOS_SIGNING_IDENTITY");
  const expectedCertificateSha256 = cleanEnvironmentValue(
    environment.JOKO_IOS_SIGNING_CERT_SHA256,
    "JOKO_IOS_SIGNING_CERT_SHA256"
  );
  const exportMethod = cleanEnvironmentValue(environment.JOKO_IOS_EXPORT_METHOD, "JOKO_IOS_EXPORT_METHOD")
    || "app-store-connect";
  const missing = [
    ["JOKO_IOS_TEAM_ID", teamId],
    ["JOKO_IOS_APP_PROFILE", appProfile],
    ["JOKO_IOS_SHARE_PROFILE", shareProfile],
    ["JOKO_IOS_SIGNING_IDENTITY", identity],
    ["JOKO_IOS_SIGNING_CERT_SHA256", expectedCertificateSha256]
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) throw new Error(`iOS release signing is missing: ${missing.join(", ")}.`);
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) throw new Error("JOKO_IOS_TEAM_ID must be a 10-character Apple team identifier.");
  if (!IOS_EXPORT_METHODS.includes(exportMethod)) {
    throw new Error(`JOKO_IOS_EXPORT_METHOD must be one of ${IOS_EXPORT_METHODS.join(", ")}.`);
  }
  if (!/^[0-9A-Fa-f]{40}$/u.test(identity) && !/^.+: .+ \([A-Z0-9]{4,}\)$/u.test(identity)) {
    throw new Error("JOKO_IOS_SIGNING_IDENTITY must be a full certificate name or a 40-character SHA-1 identity.");
  }
  return Object.freeze({
    teamId,
    appProfile,
    shareProfile,
    identity,
    expectedCertificateSha256: normalizeCertificateSha256(
      expectedCertificateSha256,
      "JOKO_IOS_SIGNING_CERT_SHA256"
    ),
    exportMethod,
    appProfilePath: cleanEnvironmentValue(environment.JOKO_IOS_APP_PROFILE_PATH, "JOKO_IOS_APP_PROFILE_PATH"),
    shareProfilePath: cleanEnvironmentValue(environment.JOKO_IOS_SHARE_PROFILE_PATH, "JOKO_IOS_SHARE_PROFILE_PATH")
  });
}

export function patchIosManualSigning(source, identity, signing) {
  let patched = source;
  for (const target of [
    { bundleIdentifier: identity.iosBundleIdentifier, profile: signing.appProfile },
    { bundleIdentifier: identity.shareExtensionBundleIdentifier, profile: signing.shareProfile }
  ]) {
    const sectionStart = patched.indexOf("/* Begin XCBuildConfiguration section */");
    const sectionEnd = patched.indexOf("/* End XCBuildConfiguration section */");
    if (sectionStart < 0 || sectionEnd <= sectionStart) throw new Error("Generated Xcode project has no XCBuildConfiguration section.");
    const section = patched.slice(sectionStart, sectionEnd);
    const blockPattern = /\t\t[A-F0-9]+ \/\* Release \*\/ = \{[\s\S]*?\n\t\t\};/gu;
    const matches = [...section.matchAll(blockPattern)].filter((match) =>
      buildSettingValue(match[0], "PRODUCT_BUNDLE_IDENTIFIER") === target.bundleIdentifier
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one Release build configuration for ${target.bundleIdentifier}, found ${matches.length}.`);
    }
    const original = matches[0][0];
    let replacement = original;
    for (const [key, value] of [
      ["CODE_SIGN_IDENTITY", signing.identity],
      ["CODE_SIGN_STYLE", "Manual"],
      ["DEVELOPMENT_TEAM", signing.teamId],
      ["PROVISIONING_PROFILE_SPECIFIER", target.profile]
    ]) replacement = setPbxBuildSetting(replacement, key, value);
    patched = patched.slice(0, sectionStart + matches[0].index)
      + replacement
      + patched.slice(sectionStart + matches[0].index + original.length);
  }
  return patched;
}

export function buildIosExportOptionsPlist(identity, signing) {
  const profileEntries = [
    [identity.iosBundleIdentifier, signing.appProfile],
    [identity.shareExtensionBundleIdentifier, signing.shareProfile]
  ].map(([bundleId, profile]) => `        <key>${xml(bundleId)}</key>\n        <string>${xml(profile)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>${xml(signing.exportMethod)}</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>teamID</key>
    <string>${xml(signing.teamId)}</string>
    <key>signingCertificate</key>
    <string>${xml(signing.identity)}</string>
    <key>provisioningProfiles</key>
    <dict>
${profileEntries}
    </dict>
    <key>compileBitcode</key>
    <false/>
    <key>stripSwiftSymbols</key>
    <true/>
</dict>
</plist>
`;
}

export function normalizeFingerprintHash(raw, label = "embedded runtimeVersion") {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error(`${label} must be a 40-character Expo fingerprint.`);
  return value;
}

export function readAndroidRuntimeVersion(artifactPath, kind) {
  const entry = kind === "apk" ? "assets/fingerprint" : kind === "aab" ? "base/assets/fingerprint" : null;
  if (!entry) throw new Error(`Unsupported Android artifact kind: ${kind}`);
  return normalizeFingerprintHash(readZipEntry(artifactPath, entry), `${kind.toUpperCase()} runtimeVersion`);
}

export function readIosRuntimeVersion(ipaPath) {
  const entries = listZipEntries(ipaPath);
  const matches = entries.filter((entry) => /(^|\/)EXUpdates\.bundle\/(?:Contents\/Resources\/)?fingerprint$/u.test(entry))
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  if (matches.length === 0) throw new Error("IPA does not contain EXUpdates.bundle/fingerprint.");
  return normalizeFingerprintHash(readZipEntry(ipaPath, matches[0]), "IPA runtimeVersion");
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function createArtifactManifest({ platform, identity, source, runtimeVersion, artifacts }) {
  if (platform !== "android" && platform !== "ios") throw new Error("Artifact manifest platform must be android or ios.");
  const normalizedSource = {
    commit: String(source.commit ?? "").trim().toLowerCase(),
    tree: source.tree === "clean" ? "clean" : "dirty",
    productionGate: source.productionGate === "passed" ? "passed" : "bypassed"
  };
  if (!/^[0-9a-f]{40}$/u.test(normalizedSource.commit)) throw new Error("Artifact source commit must be a full Git SHA.");
  const normalizedArtifacts = [...artifacts].map((artifact) => ({
    kind: artifact.kind,
    fileName: basename(artifact.fileName),
    byteSize: artifact.byteSize,
    sha256: normalizeCertificateSha256(artifact.sha256, `${artifact.kind} SHA-256`),
    signingCertificateSha256: normalizeCertificateSha256(
      artifact.signingCertificateSha256,
      `${artifact.kind} signing certificate SHA-256`
    )
  })).sort((left, right) => left.kind.localeCompare(right.kind));
  if (normalizedArtifacts.length === 0 || normalizedArtifacts.some((artifact) =>
    !/^[a-z]+$/u.test(artifact.kind) || !artifact.fileName || !Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0
  )) throw new Error("Artifact manifest contains an invalid artifact record.");
  return Object.freeze({
    schemaVersion: MOBILE_ARTIFACT_SCHEMA_VERSION,
    platform,
    source: normalizedSource,
    application: {
      name: identity.name,
      version: identity.version,
      ...(platform === "android" ? {
        package: identity.androidPackage,
        versionCode: identity.versionCode
      } : {
        bundleIdentifier: identity.iosBundleIdentifier,
        shareExtensionBundleIdentifier: identity.shareExtensionBundleIdentifier,
        appGroupId: identity.appGroupId,
        buildNumber: identity.buildNumber
      })
    },
    runtimeVersion: normalizeFingerprintHash(runtimeVersion),
    artifacts: normalizedArtifacts
  });
}

export function assertProductionGitGate(repositoryDirectory, runGit = defaultGit) {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repositoryDirectory);
  if (branch !== "main") throw new Error(`Production artifacts require the main branch; current branch is ${branch}.`);
  if (runGit(["status", "--porcelain"], repositoryDirectory)) {
    throw new Error("Production artifacts require a clean working tree.");
  }
  const commit = runGit(["rev-parse", "HEAD"], repositoryDirectory);
  const origin = runGit(["rev-parse", "origin/main"], repositoryDirectory);
  if (commit !== origin) throw new Error("Production artifacts require HEAD to match the local origin/main reference.");
  return commit;
}

export function readGitSource(repositoryDirectory, productionGate, runGit = defaultGit) {
  return Object.freeze({
    commit: runGit(["rev-parse", "HEAD"], repositoryDirectory),
    tree: runGit(["status", "--porcelain"], repositoryDirectory) ? "dirty" : "clean",
    productionGate
  });
}

function bundleIdentifier(value, label) {
  const text = requiredText(value, label);
  if (!/^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/u.test(text)) throw new Error(`${label} is not a valid application identifier.`);
  return text;
}

function requiredText(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[\u0000-\u001f\u007f]/u.test(text)) throw new Error(`${label} must be a non-empty safe string.`);
  return text;
}

function cleanEnvironmentValue(value, name) {
  const text = typeof value === "string" ? value.trim() : "";
  if (/[\r\n\u0000]/u.test(text)) throw new Error(`${name} contains forbidden control characters.`);
  return text;
}

function buildSettingValue(block, key) {
  const match = block.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|([^;]*))\\s*;`, "mu"));
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function setPbxBuildSetting(block, key, value) {
  const quoted = `"${String(value).replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"`;
  const pattern = new RegExp(`^(\\s*)${key}\\s*=.*;$`, "mu");
  if (pattern.test(block)) return block.replace(pattern, `$1${key} = ${quoted};`);
  const anchor = /(^\s*buildSettings\s*=\s*\{\s*$)/mu;
  if (!anchor.test(block)) throw new Error(`Xcode build configuration has no buildSettings block for ${key}.`);
  return block.replace(anchor, `$1\n\t\t\t\t${key} = ${quoted};`);
}

function xml(value) {
  return String(value).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function spawnZip(unzipArgs, tarArgs) {
  let result = spawnSync("unzip", unzipArgs, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") {
    result = spawnSync("tar", tarArgs, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.error?.code === "ENOENT") throw new Error("Reading a native artifact requires unzip or tar.");
  }
  return result;
}

function readZipEntry(path, entry) {
  const result = spawnZip(["-p", path, entry], ["-xOf", path, entry]);
  if (result.status !== 0) throw new Error(`Could not read ${entry} from ${basename(path)}.`);
  return result.stdout ?? "";
}

function listZipEntries(path) {
  const result = spawnZip(["-Z1", path], ["-tf", path]);
  if (result.status !== 0) throw new Error(`Could not list ${basename(path)}.`);
  const entries = (result.stdout ?? "").split(/\r?\n/gu).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error(`${basename(path)} is empty or not a valid archive.`);
  return entries;
}

function defaultGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed.`);
  return result.stdout.trim();
}
