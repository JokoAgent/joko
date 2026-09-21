import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  androidToolExecutableNames,
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
    expect(ignored.split(/\r?\n/u)).toEqual(expect.arrayContaining(["android/", "ios/", "dist/"]));
    expect(rootIgnored.split(/\r?\n/u)).toContain("/.pnpm/");
    expect(workspace).toMatch(/^virtualStoreDir: \.pnpm$/mu);
    expect(workspace).toMatch(/^virtualStoreDirMaxLength: 32$/mu);
    expect(readFileSync(resolve(mobileDirectory, "scripts/build-android-artifacts.mjs"), "utf8"))
      .toContain('NODE_ENV: "production"');
    expect(readFileSync(resolve(mobileDirectory, "scripts/build-ios-artifact.mjs"), "utf8"))
      .toContain('NODE_ENV: "production"');
  });
});
