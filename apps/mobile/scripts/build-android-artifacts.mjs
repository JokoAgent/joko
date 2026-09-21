#!/usr/bin/env node

import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  androidToolExecutableNames,
  assertAllowedArgs,
  assertProductionGitGate,
  buildJarsignerVerificationArgs,
  certificateSha256FromPem,
  createArtifactManifest,
  loadMobileReleaseIdentity,
  normalizeCertificateSha256,
  parseArgs,
  patchAndroidReleaseSigning,
  platformCommand,
  readAndroidRuntimeVersion,
  readGitSource,
  resolveAndroidArtifactKinds,
  resolveAndroidSigningEnvironment,
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
  const invocation = platformCommand(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: MOBILE_DIRECTORY, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options
  });
  if (result.error?.code === "ENOENT") throw new Error(`${invocation.command} is not installed or not on PATH.`);
  if (result.error) throw new Error(`${invocation.command} could not start (${result.error.code ?? "unknown error"}).`);
  if (result.status !== 0) throw new Error(`${command} failed while validating the Android artifact.`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function uniqueArtifact(directory, extension, label) {
  const matches = existsSync(directory)
    ? readdirSync(directory).filter((file) => file.endsWith(extension)).sort()
    : [];
  if (matches.length !== 1) throw new Error(`${label} produced ${matches.length} ${extension} files; expected exactly one.`);
  return join(directory, matches[0]);
}

function locateAndroidTool(name) {
  const executables = androidToolExecutableNames(name);
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    const root = join(sdk, "build-tools");
    if (existsSync(root)) {
      for (const version of readdirSync(root).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))) {
        for (const executable of executables) {
          const candidate = join(root, version, executable);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  for (const executable of executables) {
    const invocation = platformCommand(executable, ["version"]);
    const probe = spawnSync(invocation.command, invocation.args, { encoding: "utf8" });
    if (probe.status === 0) return executable;
  }
  throw new Error(`${name} was not found in the Android SDK build-tools directory.`);
}

function locateJavaTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidate = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", executable) : executable;
  const probe = spawnSync(candidate, ["-help"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") throw new Error(`${name} was not found in JAVA_HOME or PATH.`);
  return candidate;
}

function validateApk(path, identity, expectedCertificateSha256) {
  const aapt2 = locateAndroidTool("aapt2");
  const badging = capture(aapt2, ["dump", "badging", path]);
  const application = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']*)'/mu);
  if (!application) throw new Error("aapt2 did not return APK package metadata.");
  if (application[1] !== identity.androidPackage
    || application[2] !== String(identity.versionCode)
    || application[3] !== identity.version) {
    throw new Error("APK package, versionCode, or versionName does not match app.json.");
  }
  const apksigner = locateAndroidTool("apksigner");
  const signature = capture(apksigner, ["verify", "--verbose", "--print-certs", path]);
  const actual = signature.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)/iu)?.[1];
  if (!actual) throw new Error("apksigner did not return the APK signing certificate.");
  const certificate = normalizeCertificateSha256(actual, "APK signing certificate");
  if (certificate !== expectedCertificateSha256) throw new Error("APK signing certificate does not match the pinned release identity.");
  return certificate;
}

function validateAab(path, androidDirectory, identity, signing) {
  const metadata = findJson(androidDirectory, "output-metadata.json");
  const bundle = metadata.find((entry) => entry.value?.artifactType?.type === "BUNDLE"
    && entry.value?.applicationId === identity.androidPackage);
  const manifest = metadata.find((entry) => entry.value?.applicationId === identity.androidPackage
    && entry.value?.elements?.some((element) => String(element.versionCode) === String(identity.versionCode)
      && String(element.versionName ?? "") === identity.version));
  if (!bundle || !manifest) throw new Error("Gradle metadata does not prove the AAB package and version.");
  const bundleFiles = bundle.value.elements?.map((element) => basename(String(element.outputFile ?? ""))) ?? [];
  if (!bundleFiles.includes(basename(path))) throw new Error("Gradle bundle metadata does not name the produced AAB.");
  const jarsigner = locateJavaTool("jarsigner");
  capture(jarsigner, buildJarsignerVerificationArgs(
    path,
    signing.gradleEnvironment.JOKO_ANDROID_KEYSTORE_PATH
  ), { env: { ...process.env, ...signing.gradleEnvironment } });
  const keytool = locateJavaTool("keytool");
  const certificateOutput = capture(keytool, ["-printcert", "-jarfile", path, "-rfc"]);
  const certificate = certificateSha256FromPem(certificateOutput, "AAB signing certificate");
  if (certificate !== signing.expectedCertificateSha256) {
    throw new Error("AAB signing certificate does not match the pinned release identity.");
  }
  return certificate;
}

function findJson(root, fileName) {
  const results = [];
  const visit = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === fileName) {
        try { results.push({ path, value: JSON.parse(readFileSync(path, "utf8")) }); }
        catch { throw new Error(`Generated Gradle metadata is invalid JSON: ${path}`); }
      }
    }
  };
  visit(join(root, "app", "build", "intermediates"));
  return results;
}

function materializeArtifacts(paths, identity, source, runtimeVersion, certificates, outputArg) {
  const outputDirectory = outputArg
    ? resolve(String(outputArg))
    : resolve(MOBILE_DIRECTORY, "dist/native/android", `${source.commit.slice(0, 12)}-${runtimeVersion.slice(0, 12)}`);
  if (existsSync(outputDirectory)) throw new Error(`Artifact output already exists: ${outputDirectory}`);
  mkdirSync(outputDirectory, { recursive: true });
  const records = [];
  for (const [kind, path] of Object.entries(paths)) {
    const extension = kind === "apk" ? ".apk" : ".aab";
    const fileName = `joko-mobile-${identity.version}-${identity.versionCode}${extension}`;
    const destination = join(outputDirectory, fileName);
    copyFileSync(path, destination, constants.COPYFILE_EXCL);
    records.push({
      kind,
      fileName,
      byteSize: statSync(destination).size,
      sha256: sha256File(destination),
      signingCertificateSha256: certificates[kind]
    });
  }
  const manifest = createArtifactManifest({ platform: "android", identity, source, runtimeVersion, artifacts: records });
  const manifestPath = join(outputDirectory, "joko-mobile-artifact.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { outputDirectory, manifestPath, records };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertAllowedArgs(args, ["execute", "artifacts", "out", "skipGitGate"]);
  if (args.execute !== undefined && args.execute !== true) throw new Error("--execute does not accept a value.");
  if (args.skipGitGate !== undefined && args.skipGitGate !== true) throw new Error("--skip-git-gate does not accept a value.");
  const identity = loadMobileReleaseIdentity(MOBILE_DIRECTORY);
  const artifactKinds = resolveAndroidArtifactKinds(args.artifacts);
  process.stdout.write([
    "",
    `target: Android release artifacts (${artifactKinds.join(" + ")})`,
    `identity: ${identity.androidPackage}`,
    `version: ${identity.version} (${identity.versionCode})`,
    "steps: clean prebuild -> external release signing -> Gradle -> package/version/runtime/signature verification",
    "secrets: keystore and passwords are read only from JOKO_ANDROID_* environment variables",
    ""
  ].join("\n"));
  if (!args.execute) {
    process.stdout.write("dry-run: pass --execute to build APK/AAB artifacts.\n");
    return;
  }

  const productionGate = args.skipGitGate ? "bypassed" : "passed";
  if (!args.skipGitGate) assertProductionGitGate(REPOSITORY_DIRECTORY);
  else process.stderr.write("  warning: production Git gate bypassed; the artifact manifest will record this.\n");
  const source = readGitSource(REPOSITORY_DIRECTORY, productionGate);
  const signing = resolveAndroidSigningEnvironment(process.env);
  if (!existsSync(signing.gradleEnvironment.JOKO_ANDROID_KEYSTORE_PATH)
    || !statSync(signing.gradleEnvironment.JOKO_ANDROID_KEYSTORE_PATH).isFile()) {
    throw new Error("JOKO_ANDROID_KEYSTORE_PATH does not name a regular file.");
  }
  const environment = { ...process.env, NODE_ENV: "production", ...signing.gradleEnvironment };
  run(process.execPath, [EXPO_CLI, "prebuild", "--platform", "android", "--clean", "--no-install"], { env: environment });
  const androidDirectory = resolve(MOBILE_DIRECTORY, "android");
  const gradlePath = join(androidDirectory, "app", "build.gradle");
  if (!existsSync(gradlePath)) throw new Error("Expo prebuild did not produce android/app/build.gradle.");
  writeFileSync(gradlePath, patchAndroidReleaseSigning(readFileSync(gradlePath, "utf8")));
  const tasks = artifactKinds.map((kind) => kind === "apk" ? "assembleRelease" : "bundleRelease");
  if (process.platform === "win32") run("cmd.exe", ["/d", "/s", "/c", "gradlew.bat", ...tasks], {
    cwd: androidDirectory, env: environment
  });
  else run("./gradlew", tasks, { cwd: androidDirectory, env: environment });

  const paths = {};
  if (artifactKinds.includes("apk")) paths.apk = uniqueArtifact(join(androidDirectory, "app/build/outputs/apk/release"), ".apk", "assembleRelease");
  if (artifactKinds.includes("aab")) paths.aab = uniqueArtifact(join(androidDirectory, "app/build/outputs/bundle/release"), ".aab", "bundleRelease");
  const certificates = {};
  const runtimeVersions = {};
  for (const [kind, path] of Object.entries(paths)) {
    runtimeVersions[kind] = readAndroidRuntimeVersion(path, kind);
    certificates[kind] = kind === "apk"
      ? validateApk(path, identity, signing.expectedCertificateSha256)
      : validateAab(path, androidDirectory, identity, signing);
  }
  const distinctRuntimeVersions = [...new Set(Object.values(runtimeVersions))];
  if (distinctRuntimeVersions.length !== 1) throw new Error("APK and AAB contain different Expo runtime fingerprints.");
  const result = materializeArtifacts(
    paths,
    identity,
    source,
    distinctRuntimeVersions[0],
    certificates,
    typeof args.out === "string" ? args.out : undefined
  );
  process.stdout.write([
    "",
    "Android artifacts verified.",
    `output: ${result.outputDirectory}`,
    `runtimeVersion: ${distinctRuntimeVersions[0]}`,
    `manifest: ${result.manifestPath}`,
    ...result.records.map((record) => `${record.kind}: ${record.fileName} (${record.byteSize} bytes, sha256 ${record.sha256})`),
    ""
  ].join("\n"));
}

try { main(); }
catch (error) {
  process.stderr.write(`Android artifact build failed: ${error instanceof Error ? error.message : "unknown failure"}\n`);
  process.exitCode = 1;
}
