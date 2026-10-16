#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${String(result.status)}.`);
  return result.stdout;
}

function capture(command, args, options = {}) {
  return run(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function summary(value) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${value}\n`);
}

function build() {
  if (capture("git", ["status", "--porcelain"])) throw new Error("The CI APK requires a clean source checkout.");
  const temporary = mkdtempSync(join(resolve(process.env.RUNNER_TEMP), "joko-android-ci-"));
  const signerDirectory = join(temporary, "private-signer");
  mkdirSync(signerDirectory, { mode: 0o700 });
  const keystore = join(signerDirectory, "ci-test-signing.p12");
  const password = randomBytes(32).toString("hex");
  process.stdout.write(`::add-mask::${password}\n`);
  const environment = {
    ...process.env,
    JOKO_ANDROID_KEYSTORE_PATH: keystore,
    JOKO_ANDROID_KEYSTORE_PASSWORD: password,
    JOKO_ANDROID_KEY_ALIAS: "joko-ci-test",
    JOKO_ANDROID_KEY_PASSWORD: password,
    // The existing builder retains assembleRelease. Gradle's project-property
    // environment override selects only the actual CI emulator architecture.
    ORG_GRADLE_PROJECT_reactNativeArchitectures: "x86_64",
    // Configure the daemon, not just the lightweight Gradle launcher. Release
    // lint exhausted the template's 512 MiB metaspace and then failed to stop.
    GRADLE_OPTS: `${process.env.GRADLE_OPTS ?? ""} -Dorg.gradle.daemon=false -Dorg.gradle.workers.max=2 -Dorg.gradle.jvmargs="-Xmx2048m -XX:MaxMetaspaceSize=1024m -XX:+ExitOnOutOfMemoryError"`
  };
  const keytool = join(process.env.JAVA_HOME, "bin", "keytool");
  const output = join(temporary, "artifacts");
  try {
    capture(keytool, ["-genkeypair", "-noprompt", "-storetype", "PKCS12", "-keystore", keystore,
      "-alias", environment.JOKO_ANDROID_KEY_ALIAS, "-storepass:env", "JOKO_ANDROID_KEYSTORE_PASSWORD",
      "-keypass:env", "JOKO_ANDROID_KEY_PASSWORD", "-keyalg", "RSA", "-keysize", "2048", "-validity", "2",
      "-dname", "CN=Joko CI Test, OU=Ephemeral Actions build, O=Joko"], { env: environment });
    chmodSync(keystore, 0o600);
    const pem = capture(keytool, ["-exportcert", "-rfc", "-keystore", keystore,
      "-alias", environment.JOKO_ANDROID_KEY_ALIAS, "-storepass:env", "JOKO_ANDROID_KEYSTORE_PASSWORD"], { env: environment });
    const certificate = new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();
    environment.JOKO_ANDROID_SIGNING_CERT_SHA256 = certificate;
    run(process.execPath, ["apps/mobile/scripts/build-android-artifacts.mjs", "--execute", "--artifacts", "apk",
      "--skip-git-gate", "--out", output], { env: environment });

    const manifest = JSON.parse(readFileSync(join(output, "joko-mobile-artifact.json"), "utf8"));
    const artifact = manifest.artifacts?.find((entry) => entry.kind === "apk");
    if (manifest.platform !== "android" || manifest.source?.tree !== "clean"
      || manifest.source?.productionGate !== "bypassed" || manifest.source?.commit !== capture("git", ["rev-parse", "HEAD"])
      || manifest.application?.package !== "app.joko.mobile" || manifest.artifacts?.length !== 1
      || artifact?.signingCertificateSha256 !== certificate) {
      throw new Error("The official builder did not produce the expected clean, CI-test-signed Android artifact identity.");
    }
    const apk = join(output, artifact.fileName);
    const architectures = [...new Set(capture("unzip", ["-Z1", apk]).split(/\r?\n/u)
      .map((entry) => /^lib\/([^/]+)\/[^/]+\.so$/u.exec(entry)?.[1]).filter(Boolean))];
    if (architectures.length !== 1 || architectures[0] !== "x86_64") {
      throw new Error(`The actual CI APK has unexpected native architectures: ${architectures.join(", ")}.`);
    }
    writeFileSync(join(output, "android-ci-native-architectures.json"), `${JSON.stringify(architectures)}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `artifact-directory=${output}\napk-path=${apk}\n`);
    summary(`Android APK: x86_64 assembleRelease using an ephemeral CI test certificate (${certificate}). `
      + `The official builder verified its package, version, runtime fingerprint and signature, and emitted the original manifest `
      + `with source.productionGate=bypassed at ${manifest.source.commit}. This is a non-release test artifact; `
      + `the private test key is deleted and is never uploaded.`);
  } finally {
    rmSync(signerDirectory, { recursive: true, force: true });
  }
}

function test() {
  const serial = process.env.ANDROID_SERIAL;
  const avd = process.env.JOKO_ANDROID_TEST_AVD;
  const apk = process.env.JOKO_ANDROID_TEST_APK;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!serial || !/^emulator-\d+$/u.test(serial) || !avd?.startsWith("joko-")
    || !apk || !isAbsolute(apk) || !sdk || !isAbsolute(sdk)) {
    throw new Error("CI requires an explicit isolated Joko emulator and absolute SDK/APK paths.");
  }
  const adb = join(sdk, "platform-tools", "adb");
  if (capture(adb, ["-s", serial, "emu", "avd", "name"]).split(/\r?\n/u)[0] !== avd
    || capture(adb, ["-s", serial, "shell", "getprop", "ro.kernel.qemu"]) !== "1") {
    throw new Error("The Android CI target is not the owned Joko AVD.");
  }
  // The fresh emulator uses an unavailable loopback DNS server. Keep Private DNS
  // disabled too: the configured example update authority stays offline, while
  // the test's numeric loopback address and ADB reverse remain usable.
  run(adb, ["-s", serial, "shell", "settings", "put", "global", "private_dns_mode", "off"]);
  const directory = dirname(apk);
  const report = join(directory, "android-native-gui-result.json");
  const environment = { ...process.env, JOKO_ANDROID_TEST_SERIAL: serial, JOKO_ANDROID_ADB: adb };
  let passed = false;
  try {
    run("pnpm", ["--filter", "@joko/e2e", "exec", "vitest", "run", "--config", "vitest.config.ts",
      "src/mobile-packaged-android.e2e.test.ts", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`],
    { env: environment });
    const result = JSON.parse(readFileSync(report, "utf8"));
    if (result.numTotalTests !== 1 || result.numPassedTests !== 1 || result.numPendingTests !== 0) {
      throw new Error("The native Android GUI test must run and pass once; skipped tests are not CI evidence.");
    }
    passed = true;
  } finally {
    const logs = spawnSync(adb, ["-s", serial, "logcat", "-d", "-t", "2000"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    writeFileSync(join(directory, "android-logcat.txt"), logs.stdout ?? logs.stderr ?? "No logcat output was available.\n");
    summary(`Android native GUI ${passed ? "passed" : "did not complete successfully"} on ${avd} (${serial}). `
      + `The existing packaged E2E verifies installed APK bytes, real native pairing, rich input, canonical image/file resources, `
      + `force-stop/reopen and no duplicate dispatch against a local instrumented Orchestrator fixture. `
      + `The example update authority is offline under isolated DNS. This does not verify a physical device, provider/account service, `
      + `APK self-update installation, OTA delivery, or a production signing identity.`);
  }
}

try {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true"
    || !process.env.RUNNER_TEMP || !process.env.GITHUB_STEP_SUMMARY) {
    throw new Error("This helper only runs inside the Linux GitHub Actions Mobile job.");
  }
  if (process.argv[2] === "build" && process.env.GITHUB_OUTPUT && process.env.JAVA_HOME) build();
  else if (process.argv[2] === "test") test();
  else throw new Error("Expected build (with JAVA_HOME/GITHUB_OUTPUT) or test.");
} catch (error) {
  process.stderr.write(`Android native CI failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
}
