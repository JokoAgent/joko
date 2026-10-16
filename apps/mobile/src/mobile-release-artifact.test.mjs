import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  androidToolExecutableNames,
  apkSignerCertificateDiagnostics,
  apkSignerCertificateSha256,
  assertProductionGitGate,
  buildJarsignerVerificationArgs,
  buildIosExportOptionsPlist,
  createArtifactManifest,
  IOS_EXPORT_METHODS,
  loadMobileReleaseIdentity,
  normalizeCertificateSha256,
  normalizeFingerprintHash,
  parseArgs,
  patchAndroidReleaseSigning,
  patchIosManualSigning,
  platformCommand,
  resolveAndroidArtifactKinds,
  resolveAndroidSigningEnvironment,
  resolveIosSigningConfiguration
} from "../scripts/release-artifact-lib.mjs";

const mobileDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("mobile release artifact configuration", () => {
  it("reads one explicit native identity and monotonic platform versions", () => {
    expect(loadMobileReleaseIdentity(mobileDirectory)).toEqual({
      name: "Joko",
      slug: "joko",
      scheme: "joko",
      version: "0.1.0",
      buildNumber: "1",
      versionCode: 1,
      iosBundleIdentifier: "app.joko.mobile",
      androidPackage: "app.joko.mobile",
      appGroupId: "group.app.joko.mobile",
      shareExtensionBundleIdentifier: "app.joko.mobile.expo-sharing-extension"
    });
    expect(resolveAndroidArtifactKinds(undefined)).toEqual(["apk", "aab"]);
    expect(resolveAndroidArtifactKinds("aab")).toEqual(["aab"]);
    expect(() => resolveAndroidArtifactKinds("apk,apk")).toThrow(/duplicate/u);
    expect(() => resolveAndroidArtifactKinds("debug")).toThrow(/Unsupported/u);
  });

  it("parses build arguments without duplicate or ambiguous options", () => {
    expect(parseArgs(["--execute", "--artifacts=apk,aab", "--out", "release"])).toEqual({
      _: [], execute: true, artifacts: "apk,aab", out: "release"
    });
    expect(() => parseArgs(["--out", "first", "--out", "second"])).toThrow(/Duplicate/u);
  });

  it("locates and invokes Android build-tools wrappers on Windows", () => {
    expect(androidToolExecutableNames("aapt2", "win32")).toEqual(["aapt2.exe", "aapt2.bat"]);
    expect(androidToolExecutableNames("apksigner", "linux")).toEqual(["apksigner"]);
    expect(platformCommand("C:/Android/apksigner.bat", ["version"], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "C:/Android/apksigner.bat", "version"]
    });
    expect(platformCommand("/opt/android/aapt2", ["version"], "linux")).toEqual({
      command: "/opt/android/aapt2",
      args: ["version"]
    });
  });

  it("strictly verifies AAB signatures against the external signer without exposing its password", () => {
    const args = buildJarsignerVerificationArgs("D:/release/joko.aab", "D:/signing/joko.p12");
    expect(args).toEqual([
      "-verify",
      "-strict",
      "-keystore",
      "D:/signing/joko.p12",
      "-storepass:env",
      "JOKO_ANDROID_KEYSTORE_PASSWORD",
      "D:/release/joko.aab"
    ]);
    expect(args.join(" ")).not.toContain("store-secret");
  });

  it("pins every APK signer certificate from numbered and v3.1 SDK-range output", () => {
    const certificate = "ab".repeat(32);
    expect(apkSignerCertificateSha256([
      "Verifies",
      "Number of signers: 1",
      `Signer #1 certificate SHA-256 digest: ${certificate}`,
      `Signer #1 public key SHA-256 digest: ${"cd".repeat(32)}`,
      `Source Stamp Signer certificate SHA-256 digest: ${"ef".repeat(32)}`
    ].join("\r\n"), certificate)).toBe(certificate);
    expect(apkSignerCertificateSha256([
      `Signer (minSdkVersion=33 (dev release=true), maxSdkVersion=2147483647) certificate SHA-256 digest: ${certificate.toUpperCase()}`,
      `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${certificate}`,
      `Signer #1 certificate SHA-256 digest: ${certificate}`
    ].join("\n"), certificate)).toBe(certificate);
    // These labels are from the distributed SDK 37 ApkSignerTool class.
    for (const signer of ["Signer:", "Signer #1:", "V3.0 Signer:",
      "V3.0 Signer: (minSdkVersion=24, maxSdkVersion=2147483647)",
      "V3.1 Signer: (minSdkVersion=33 (dev release=true), maxSdkVersion=2147483647)"]) {
      expect(apkSignerCertificateSha256(`${signer} certificate SHA-256 digest: ${certificate}`, certificate))
        .toBe(certificate);
    }
    expect(() => apkSignerCertificateSha256(`Signer #1 certificate SHA-256 digest: ${certificate}`, "cd".repeat(32)))
      .toThrow(/pinned release identity/u);
    expect(() => apkSignerCertificateSha256(`V3.0 Signer: certificate SHA-256 digest: ${certificate}`, "cd".repeat(32)))
      .toThrow(/pinned release identity/u);
  });

  it("rejects missing, malformed and conflicting APK signer certificates", () => {
    const certificate = "ab".repeat(32);
    expect(() => apkSignerCertificateSha256("Verifies\nNumber of signers: 0", certificate)).toThrow(/did not return/u);
    expect(() => apkSignerCertificateSha256(`Source Stamp Signer certificate SHA-256 digest: ${certificate}`, certificate))
      .toThrow(/did not return/u);
    expect(() => apkSignerCertificateSha256(`Source Stamp Signer: certificate SHA-256 digest: ${certificate}`, certificate))
      .toThrow(/did not return/u);
    for (const digest of ["", "ab".repeat(31), `${certificate}extra`, "not-a-certificate"]) {
      expect(() => apkSignerCertificateSha256(`Signer #1 certificate SHA-256 digest: ${digest}`, certificate))
        .toThrow(/64 hexadecimal/u);
      expect(() => apkSignerCertificateSha256(`V3.0 Signer: certificate SHA-256 digest: ${digest}`, certificate))
        .toThrow(/64 hexadecimal/u);
    }
    for (const signer of ["Signer #0", "Signer #0:", "Signer (minSdkVersion=33, maxSdkVersion=32)", "Signer unknown",
      "V3.0 Signer: (minSdkVersion=33, maxSdkVersion=32)",
      "V3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483648)",
      "V3.2 Hybrid PQC Signer: (minSdkVersion=24, maxSdkVersion=2147483647)"]) {
      expect(() => apkSignerCertificateSha256(`${signer} certificate SHA-256 digest: ${certificate}`, certificate))
        .toThrow(/unsupported APK signer/u);
    }
    for (const signer of ["Signer #2", "Signer #2:", "V3.0 Signer:", "Signer (minSdkVersion=33, maxSdkVersion=2147483647)",
      "V3.0 Signer: (minSdkVersion=24, maxSdkVersion=32)",
      "V3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647)"]) {
      expect(() => apkSignerCertificateSha256([
        `Signer #1 certificate SHA-256 digest: ${certificate}`,
        `${signer} certificate SHA-256 digest: ${"cd".repeat(32)}`
      ].join("\n"), certificate)).toThrow(/different signing certificates/u);
    }
    expect(() => apkSignerCertificateSha256([
      `Signer #1 certificate SHA-256 digest: ${certificate}`,
      "Signer #2 certificate SHA-256 digest: malformed"
    ].join("\n"), certificate)).toThrow(/64 hexadecimal/u);
    expect(() => apkSignerCertificateSha256([
      `V3.0 Signer: (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${certificate}`,
      "V3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: malformed"
    ].join("\n"), certificate)).toThrow(/64 hexadecimal/u);
  });

  it("limits failed APK signer diagnostics to public digests and fixed metadata", () => {
    const certificate = "ab".repeat(32);
    const subject = "CN=Uncontrolled public subject";
    const diagnosticPath = "/private/build/path";
    const stdout = [
      "Verifies",
      "Number of signers: 1",
      `Signer #1 certificate DN: ${subject}`,
      `Signer #1 certificate SHA-256 digest: ${certificate}`,
      "Signer #2 certificate SHA-256 digest: malformed"
    ].join("\r\n");
    const stderr = `Picked up JAVA_TOOL_OPTIONS: /uncontrolled/runtime/option\nWARNING: ${diagnosticPath}`;
    const diagnostic = apkSignerCertificateDiagnostics({ stdout, stderr,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) }, "0.9\n");
    expect(diagnostic).toMatchObject({
      phase: "apk-signer-certificate-read", tool: "apksigner", toolVersion: "0.9", exitCode: 0,
      hasOutput: true, signerDigestLineCount: 2,
      streams: {
        stdout: { bytes: Buffer.byteLength(stdout), characters: stdout.length, newlines: 4, carriageReturns: 4,
          nuls: 0, hasVerifies: true, hasSignerWord: true, hasCertificateWord: true, hasSha256Word: true,
          hasUsage: false, hasJavaOptionNotice: false, signerCounts: [1] },
        stderr: { bytes: Buffer.byteLength(stderr), characters: stderr.length, newlines: 1, carriageReturns: 0,
          nuls: 0, hasVerifies: false, hasSignerWord: false, hasCertificateWord: false,
          hasSha256Word: false, hasUsage: false, hasJavaOptionNotice: true, signerCounts: [] }
      },
      signerDigests: [{ signer: "#1", sha256: certificate }, { signer: "#2", validDigest: false }]
    });
    expect(diagnostic.publicCertificateLines).toEqual([{ stream: "stdout", label: "Signer #1", sha256: certificate }]);
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain(subject);
    expect(serialized).not.toContain(diagnosticPath);
    expect(serialized).not.toContain("/uncontrolled/runtime/option");
    expect(apkSignerCertificateDiagnostics({ stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 }, "uncontrolled version output")).toMatchObject({
      phase: "apk-signer-certificate-read", tool: "apksigner", toolVersion: "unavailable", exitCode: 0,
      hasOutput: false, signerDigestLineCount: 0, signerDigests: [],
      streams: { stdout: { bytes: 0, characters: 0 }, stderr: { bytes: 0, characters: 0 } }
    });
    expect(apkSignerCertificateDiagnostics({ stdout: "", stderr: "Usage: apksigner verify\n\0",
      stdoutBytes: 0, stderrBytes: 25 }, "0.9")).toMatchObject({
      hasOutput: true, signerDigestLineCount: 0,
      streams: { stdout: { bytes: 0, hasUsage: false }, stderr: { bytes: 25, hasUsage: true, nuls: 1 } }
    });
    const sdk37 = `V3.0 Signer: (minSdkVersion=24, maxSdkVersion=2147483647) certificate SHA-256 digest: ${certificate}`;
    expect(apkSignerCertificateDiagnostics({ stdout: sdk37, stderr: "",
      stdoutBytes: Buffer.byteLength(sdk37), stderrBytes: 0 }, "0.9")).toMatchObject({
      signerDigestLineCount: 1,
      signerDigests: [{ signer: "V3.0 Signer: (minSdkVersion=24, maxSdkVersion=2147483647)", sha256: certificate }]
    });
    const observedSdk37 = `V3.0 Signer: certificate SHA-256 digest: ${certificate}`;
    expect(apkSignerCertificateDiagnostics({ stdout: observedSdk37, stderr: "",
      stdoutBytes: Buffer.byteLength(observedSdk37), stderrBytes: 0 }, "0.9")).toMatchObject({
      signerDigestLineCount: 1, signerDigests: [{ signer: "V3.0 Signer:", sha256: certificate }]
    });
    const labels = ["Signer unknown:", `V3.0 ${"x".repeat(150)}`, "Signer /private/path", "Signer\u001b[31m"];
    const untrusted = labels.map(label => `${label} certificate SHA-256 digest: ${certificate}`).join("\n");
    const bounded = apkSignerCertificateDiagnostics({ stdout: untrusted,
      stderr: `V3.0 Signer: certificate SHA-256 digest: ${certificate.toUpperCase()}`,
      stdoutBytes: Buffer.byteLength(untrusted), stderrBytes: 0 }, "0.9");
    expect(bounded.publicCertificateLines).toEqual([
      { stream: "stdout", label: "Signer unknown:", sha256: certificate },
      { stream: "stderr", label: "V3.0 Signer:", sha256: certificate }
    ]);
    expect(() => apkSignerCertificateSha256(`Signer unknown: certificate SHA-256 digest: ${certificate}`, certificate))
      .toThrow(/unsupported APK signer/u);
  });

  it("keeps Android release secrets external and pins an independent certificate", () => {
    const signing = resolveAndroidSigningEnvironment({
      JOKO_ANDROID_KEYSTORE_PATH: "C:/signing/joko.jks",
      JOKO_ANDROID_KEYSTORE_PASSWORD: "store-secret",
      JOKO_ANDROID_KEY_ALIAS: "joko-upload",
      JOKO_ANDROID_KEY_PASSWORD: "key-secret",
      JOKO_ANDROID_SIGNING_CERT_SHA256: `SHA-256:${"ab:".repeat(31)}ab`
    });
    expect(signing.expectedCertificateSha256).toBe("ab".repeat(32));
    expect(signing.gradleEnvironment).toEqual({
      JOKO_ANDROID_KEYSTORE_PATH: "C:/signing/joko.jks",
      JOKO_ANDROID_KEYSTORE_PASSWORD: "store-secret",
      JOKO_ANDROID_KEY_ALIAS: "joko-upload",
      JOKO_ANDROID_KEY_PASSWORD: "key-secret"
    });
    expect(() => resolveAndroidSigningEnvironment({})).toThrow(/JOKO_ANDROID_KEYSTORE_PATH/u);
  });

  it("patches only the generated Android release signer and rejects template drift", () => {
    const source = `android {
    signingConfigs {
        debug { storeFile file('debug.keystore') }
    }
    buildTypes {
        debug { signingConfig signingConfigs.debug }
        release {
            signingConfig signingConfigs.debug
        }
    }
}`;
    const patched = patchAndroidReleaseSigning(source);
    expect(patched).toContain("storeFile file(System.getenv(\"JOKO_ANDROID_KEYSTORE_PATH\"))");
    expect(patched).toContain("signingConfig signingConfigs.release");
    expect(patchAndroidReleaseSigning(patched)).toBe(patched);
    expect(() => patchAndroidReleaseSigning("android { buildTypes {} }")).toThrow(/signingConfigs/u);
  });

  it("pins separate app and share-extension profiles in Xcode and export options", () => {
    const identity = loadMobileReleaseIdentity(mobileDirectory);
    const signing = resolveIosSigningConfiguration({
      JOKO_IOS_TEAM_ID: "ABCDE12345",
      JOKO_IOS_APP_PROFILE: "Joko App Store",
      JOKO_IOS_SHARE_PROFILE: "Joko Share App Store",
      JOKO_IOS_SIGNING_IDENTITY: "Apple Distribution: Joko LLC (ABCDE12345)",
      JOKO_IOS_SIGNING_CERT_SHA256: "cd".repeat(32),
      JOKO_IOS_EXPORT_METHOD: "app-store-connect"
    });
    const project = `/* Begin XCBuildConfiguration section */
\t\tAAA111 /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = app.joko.mobile;
\t\t\t};
\t\t\tname = Release;
\t\t};
\t\tBBB222 /* Release */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCODE_SIGN_STYLE = Automatic;
\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "app.joko.mobile.expo-sharing-extension";
\t\t\t};
\t\t\tname = Release;
\t\t};
/* End XCBuildConfiguration section */`;
    const patched = patchIosManualSigning(project, identity, signing);
    expect(patched.match(/CODE_SIGN_STYLE = "Manual";/gu)).toHaveLength(2);
    expect(patched).toContain('PROVISIONING_PROFILE_SPECIFIER = "Joko App Store";');
    expect(patched).toContain('PROVISIONING_PROFILE_SPECIFIER = "Joko Share App Store";');
    const plist = buildIosExportOptionsPlist(identity, signing);
    expect(plist).toContain("<key>app.joko.mobile</key>");
    expect(plist).toContain("<key>app.joko.mobile.expo-sharing-extension</key>");
    expect(plist).toContain("<string>Joko Share App Store</string>");
    expect(plist).toContain("<string>app-store-connect</string>");
    expect(IOS_EXPORT_METHODS).toEqual(["debugging", "release-testing", "enterprise", "app-store-connect"]);
    expect(() => resolveIosSigningConfiguration({
      JOKO_IOS_TEAM_ID: "ABCDE12345",
      JOKO_IOS_APP_PROFILE: "Joko App Store",
      JOKO_IOS_SHARE_PROFILE: "Joko Share App Store",
      JOKO_IOS_SIGNING_IDENTITY: "Apple Distribution: Joko LLC (ABCDE12345)",
      JOKO_IOS_SIGNING_CERT_SHA256: "cd".repeat(32),
      JOKO_IOS_EXPORT_METHOD: "app-store"
    })).toThrow(/must be one of/u);
    const withoutExtension = project.replace(/\t\tBBB222[\s\S]+?\n\t\t\};\n(?=\/\* End XCBuildConfiguration)/u, "");
    expect(() => patchIosManualSigning(withoutExtension, identity, signing)).toThrow(/expo-sharing-extension/u);
  });

  it("writes a path-free manifest bound to source, runtime, artifact hashes, and signer", () => {
    const identity = loadMobileReleaseIdentity(mobileDirectory);
    const manifest = createArtifactManifest({
      platform: "android",
      identity,
      source: { commit: "12".repeat(20), tree: "clean", productionGate: "passed" },
      runtimeVersion: "34".repeat(20),
      artifacts: [{
        kind: "apk",
        fileName: "C:/private/output/joko.apk",
        byteSize: 42,
        sha256: "56".repeat(32),
        signingCertificateSha256: "78".repeat(32)
      }]
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      platform: "android",
      source: { commit: "12".repeat(20), tree: "clean", productionGate: "passed" },
      application: { package: "app.joko.mobile", versionCode: 1 },
      runtimeVersion: "34".repeat(20)
    });
    expect(manifest.artifacts[0].fileName).toBe("joko.apk");
    expect(JSON.stringify(manifest)).not.toContain("C:/private");
    expect(normalizeFingerprintHash("AB".repeat(20))).toBe("ab".repeat(20));
    expect(normalizeCertificateSha256(`SHA256:${"AA:".repeat(31)}AA`)).toBe("aa".repeat(32));
  });

  it("requires main, clean, origin-aligned source for production artifacts", () => {
    const values = new Map([
      ["rev-parse --abbrev-ref HEAD", "main"],
      ["status --porcelain", ""],
      ["rev-parse HEAD", "a".repeat(40)],
      ["rev-parse origin/main", "a".repeat(40)]
    ]);
    const git = (args) => values.get(args.join(" "));
    expect(assertProductionGitGate("ignored", git)).toBe("a".repeat(40));
    values.set("status --porcelain", " M app.json");
    expect(() => assertProductionGitGate("ignored", git)).toThrow(/clean working tree/u);
  });

  it("keeps EAS profiles local-versioned and makes native directories reproducible outputs", () => {
    const eas = JSON.parse(readFileSync(resolve(mobileDirectory, "eas.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(resolve(mobileDirectory, "package.json"), "utf8"));
    const ignored = readFileSync(resolve(mobileDirectory, ".gitignore"), "utf8");
    const rootIgnored = readFileSync(resolve(mobileDirectory, "../../.gitignore"), "utf8");
    const workspace = readFileSync(resolve(mobileDirectory, "../../pnpm-workspace.yaml"), "utf8");
    expect(eas.cli.appVersionSource).toBe("local");
    expect(eas.build.preview).toMatchObject({ distribution: "internal", channel: "stable",
      android: { buildType: "apk" } });
    expect(eas.build.production).toMatchObject({ distribution: "store", channel: "stable",
      android: { buildType: "app-bundle" } });
    expect(pkg.scripts["build:native:android"]).toBe("node scripts/build-android-artifacts.mjs");
    expect(pkg.scripts["build:native:ios"]).toBe("node scripts/build-ios-artifact.mjs");
    expect(ignored.split(/\r?\n/u)).toEqual(expect.arrayContaining(["android/", "/ios/", "dist/"]));
    expect(rootIgnored.split(/\r?\n/u)).toContain("/.pnpm/");
    expect(workspace).toMatch(/^virtualStoreDir: \.pnpm$/mu);
    expect(workspace).toMatch(/^virtualStoreDirMaxLength: 32$/mu);
    expect(readFileSync(resolve(mobileDirectory, "scripts/build-android-artifacts.mjs"), "utf8"))
      .toContain('NODE_ENV: "production"');
    expect(readFileSync(resolve(mobileDirectory, "scripts/build-ios-artifact.mjs"), "utf8"))
      .toContain('NODE_ENV: "production"');
  });

  it("builds patched image modules from source instead of unpatched precompiled binaries", () => {
    const pkg = JSON.parse(readFileSync(resolve(mobileDirectory, "package.json"), "utf8"));
    expect(pkg.expo.autolinking.android.buildFromSource).toEqual(["expo-image"]);
    expect(pkg.expo.autolinking.ios.buildFromSource).toEqual(["expo-image-manipulator"]);
    expect(pkg.expo.autolinking.android.exclude).toEqual(["expo-notifications", "react-native-screens"]);
  });
});
