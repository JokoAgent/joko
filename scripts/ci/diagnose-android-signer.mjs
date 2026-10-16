#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  apkSignerCertificateDiagnostics,
  apkSignerCertificateSha256,
  captureAndroidArtifactCommand,
  certificateSha256FromPem,
  locateAndroidTool
} from "../../apps/mobile/scripts/release-artifact-lib.mjs";

let phase = "runner-admission";
let temporary;
let observation;
try {
  if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true"
    || !process.env.RUNNER_TEMP || !isAbsolute(process.env.RUNNER_TEMP)
    || !process.env.JAVA_HOME || !isAbsolute(process.env.JAVA_HOME)) {
    throw new Error("The diagnostic requires the Linux Actions runner and its prepared JDK.");
  }
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk || !isAbsolute(sdk)) throw new Error("The Android SDK is unavailable.");
  const androidJar = join(sdk, "platforms", "android-36", "android.jar");
  if (!existsSync(androidJar)) throw new Error("The prepared Android 36 platform is unavailable.");
  temporary = mkdtempSync(join(process.env.RUNNER_TEMP, "joko-signer-diagnostic-"));
  chmodSync(temporary, 0o700);
  const capture = (command, args, env = process.env) => captureAndroidArtifactCommand(command, args, { cwd: temporary, env });
  const text = result => `${result.stdout}\n${result.stderr}`;
  const manifest = join(temporary, "AndroidManifest.xml");
  const unsigned = join(temporary, "unsigned.apk");
  const signed = join(temporary, "signed.apk");
  const keystore = join(temporary, "diagnostic-signing.p12");
  writeFileSync(manifest, '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="app.joko.ci.signer"><uses-sdk android:minSdkVersion="24" android:targetSdkVersion="36"/><application android:hasCode="false" android:label="Joko CI signer diagnosis"/></manifest>\n', { mode: 0o600 });
  phase = "link-no-code-diagnostic-apk";
  const aapt2 = locateAndroidTool("aapt2");
  capture(aapt2, ["link", "--manifest", manifest, "-I", androidJar, "-o", unsigned,
    "--min-sdk-version", "24", "--target-sdk-version", "36", "--version-code", "1", "--version-name", "0.0.0"]);

  phase = "temporary-public-certificate";
  const password = randomBytes(32).toString("hex");
  // Actions consumes this directly. Do not tee this helper's complete stdout.
  process.stdout.write(`::add-mask::${password}\n`);
  const environment = { ...process.env, JOKO_SIGNER_DIAGNOSTIC_PASSWORD: password };
  const keytool = join(process.env.JAVA_HOME, "bin", "keytool");
  capture(keytool, ["-genkeypair", "-noprompt", "-storetype", "PKCS12", "-keystore", keystore,
    "-alias", "joko-ci-diagnostic", "-storepass:env", "JOKO_SIGNER_DIAGNOSTIC_PASSWORD",
    "-keypass:env", "JOKO_SIGNER_DIAGNOSTIC_PASSWORD", "-keyalg", "RSA", "-keysize", "2048", "-validity", "2",
    "-dname", "CN=Joko CI Signer Diagnosis, O=Joko"], environment);
  chmodSync(keystore, 0o600);
  const publicCertificate = text(capture(keytool, ["-exportcert", "-rfc", "-keystore", keystore,
    "-alias", "joko-ci-diagnostic", "-storepass:env", "JOKO_SIGNER_DIAGNOSTIC_PASSWORD"], environment));
  const expectedCertificate = certificateSha256FromPem(publicCertificate, "Diagnostic public certificate");

  phase = "sign-no-code-diagnostic-apk";
  const apksigner = locateAndroidTool("apksigner");
  capture(apksigner, ["sign", "--ks", keystore, "--ks-key-alias", "joko-ci-diagnostic",
    "--ks-pass", "env:JOKO_SIGNER_DIAGNOSTIC_PASSWORD", "--key-pass", "env:JOKO_SIGNER_DIAGNOSTIC_PASSWORD",
    "--out", signed, unsigned], environment);

  phase = "verify-no-code-diagnostic-apk";
  const verificationArguments = ["verify", "--verbose", "--print-certs", signed];
  const verified = capture(apksigner, verificationArguments);
  let version;
  try { version = text(capture(apksigner, ["version"])).trim(); }
  catch { /* Verification success and tool-version availability are separate. */ }
  const buildTools = basename(dirname(apksigner));
  // This APK and its certificate subject were created above without user data.
  // Observe only public digest labels, never full tool streams or subject DNs.
  const publicCertificateLines = ["stdout", "stderr"].flatMap(stream => verified[stream].split(/\r?\n/u)
    .flatMap(line => {
      const match = /^([A-Za-z0-9#:.(),= -]{1,160}) certificate SHA-256 digest:[ \t]*([0-9A-Fa-f]{64})[ \t]*$/u.exec(line);
      return match === null ? [] : [{ stream, label: match[1], sha256: match[2].toLowerCase() }];
    })).slice(0, 16);
  const metadata = {
    purpose: "minimal-no-code-sdk-signer-diagnostic",
    buildToolsVersion: /^[0-9]+(?:\.[0-9]+){2}(?:-[a-z0-9]+)?$/iu.test(buildTools) ? buildTools : "unavailable",
    invocation: {
      verify: verificationArguments[0] === "verify",
      verbose: verificationArguments.includes("--verbose"),
      printCertificates: verificationArguments.includes("--print-certs"),
      apkArguments: 1
    },
    apkBytes: statSync(signed).size,
    publicCertificateLines,
    ...apkSignerCertificateDiagnostics(verified, version)
  };
  phase = "pin-no-code-diagnostic-apk";
  let matched = false;
  try { matched = apkSignerCertificateSha256(text(verified), expectedCertificate) === expectedCertificate; }
  finally {
    observation = { sourceCommit: process.env.GITHUB_SHA, ...metadata, pinMatched: matched };
    process.stdout.write(`Android SDK signer diagnostic: ${JSON.stringify(observation)}\n`);
  }
  if (!matched) throw new Error("Diagnostic APK signer did not match the independent public certificate.");
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      "Minimal no-code Android SDK signing/verification diagnostic passed with an ephemeral certificate and the formal shared reader. "
      + "This is not the Joko APK, a product native build, a release artifact, or GUI evidence. The temporary APK and signer are deleted.\n");
  }
} catch {
  process.stderr.write(`Android SDK signer diagnostic failed: ${JSON.stringify({ phase, success: false })}\n`);
  process.exitCode = 1;
} finally {
  let cleanupConfirmed = temporary === undefined;
  if (temporary !== undefined) {
    try { rmSync(temporary, { recursive: true, force: true }); cleanupConfirmed = true; }
    catch { process.stderr.write("Android SDK signer diagnostic cleanup failed.\n"); process.exitCode = 1; }
  }
  if (process.env.GITHUB_ACTIONS === "true" && process.platform === "linux"
    && process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP)) {
    writeFileSync(join(process.env.RUNNER_TEMP, "joko-android-signer-diagnostic.json"),
      JSON.stringify({ ...observation, phase, success: process.exitCode !== 1, cleanupConfirmed }, null, 2) + "\n", { mode: 0o600 });
  }
}
