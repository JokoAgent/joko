import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const withJokoIncomingShare = require("../with-joko-incoming-share.cjs");
const { withDangerousMod } = require("expo/config-plugins");
const expoSharingRoot = dirname(require.resolve("expo-sharing/package.json"));
const createShareInfoPlist = require(join(
  expoSharingRoot,
  "plugin/build/ios/createInfoPlistFile.js"
)).default;
const project = new URL("../", import.meta.url);
const app = JSON.parse(readFileSync(new URL("app.json", project), "utf8")).expo;
const plugin = readFileSync(new URL("with-joko-incoming-share.cjs", project), "utf8");
const extension = readFileSync(new URL("native/ios/ShareIntoViewController.swift", project), "utf8");
const moduleSource = readFileSync(
  new URL("modules/joko-incoming-share/ios/JokoIncomingShareModule.swift", project),
  "utf8"
);
const moduleConfig = JSON.parse(readFileSync(
  new URL("modules/joko-incoming-share/expo-module.config.json", project),
  "utf8"
));
const nativeIntent = readFileSync(new URL("src/mobile-native-intent.ts", project), "utf8");
const surface = readFileSync(new URL("src/App.tsx", project), "utf8");

describe("iOS incoming-share native boundary", () => {
  it("declares the bounded iOS text, web URL, file, and image target and composes the Joko source as the final dangerous mod", () => {
    const sharingIndex = app.plugins.findIndex((entry) => Array.isArray(entry) && entry[0] === "expo-sharing");
    const boundaryIndex = app.plugins.indexOf("./with-joko-incoming-share.cjs");
    expect(sharingIndex).toBeGreaterThanOrEqual(0);
    // Expo composes normal/dangerous mods inside-out: the first registration is the final pass.
    expect(boundaryIndex).toBeLessThan(sharingIndex);
    expect(app.plugins[sharingIndex][1]).toEqual({
      ios: {
        enabled: true,
        appGroupId: "group.app.joko.mobile",
        activationRule: {
          supportsText: true,
          supportsWebUrlWithMaxCount: 20,
          supportsImageWithMaxCount: 20,
          supportsFileWithMaxCount: 20
        }
      },
      android: { enabled: false }
    });
    expect(plugin).toContain('path.join(projectRoot, "native", "ios", "ShareIntoViewController.swift")');
    expect(plugin).toContain('path.join(platformProjectRoot, extensionTargetName, "ShareIntoViewController.swift")');
    expect(plugin).toContain("expo-sharing must generate the iOS share extension");
    expect(plugin).toContain("fs.copyFileSync(source, destination)");
  });

  it("actually overwrites the generated expo-sharing controller on the composed dangerous-mod pass", async () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "joko-incoming-share-"));
    try {
      let config = withJokoIncomingShare({ name: "Joko", slug: "joko" });
      config = withDangerousMod(config, ["ios", async (next) => {
        const target = join(next.modRequest.platformProjectRoot, "expo-sharing-extension");
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "ShareIntoViewController.swift"), "generated single-slot source");
        return next;
      }]);
      await config.mods.ios.dangerous({
        ...config,
        modResults: {},
        modRequest: {
          projectRoot: fileURLToPath(project),
          platformProjectRoot: nativeRoot,
          platform: "ios",
          modName: "dangerous",
          introspect: false
        }
      });
      expect(readFileSync(
        join(nativeRoot, "expo-sharing-extension", "ShareIntoViewController.swift"),
        "utf8"
      )).toBe(extension);
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it("generates an extension plist with bounded supported activation types", () => {
    const nativeRoot = mkdtempSync(join(tmpdir(), "joko-share-plist-"));
    try {
      createShareInfoPlist(nativeRoot, "group.app.joko.mobile", "joko", {
        supportsText: true,
        supportsWebUrlWithMaxCount: 20,
        supportsImageWithMaxCount: 20,
        supportsFileWithMaxCount: 20
      });
      const info = readFileSync(join(nativeRoot, "Info.plist"), "utf8");
      expect(info).toContain("NSExtensionActivationSupportsText");
      expect(info).toContain("NSExtensionActivationSupportsWebURLWithMaxCount");
      expect(info).toContain("NSExtensionActivationSupportsImageWithMaxCount");
      expect(info).toContain("NSExtensionActivationSupportsFileWithMaxCount");
      expect(info).toContain("group.app.joko.mobile");
      expect(info).toContain("joko");
      expect(info).not.toMatch(/Supports(Movie|WebPage|Attachments)/u);
    } finally {
      rmSync(nativeRoot, { recursive: true, force: true });
    }
  });

  it("persists each invocation as one atomic unique-directory batch without a mutable defaults slot", () => {
    expect(extension).toContain("private var processing = false");
    expect(extension).toContain("guard !processing else { return }");
    expect(extension).toContain('private let maximumItems = 20');
    expect(extension).toContain('private let maximumItemBytes = 30 * 1024 * 1024');
    expect(extension).toContain('private let maximumTextItemBytes = 32 * 1024');
    expect(extension).toContain('private let maximumURLItemBytes = 8 * 1024');
    expect(extension).toContain('private let maximumTextBatchBytes = 128 * 1024');
    expect(extension).toContain('root.appendingPathComponent("staging-\\(batchId)"');
    expect(extension).toContain('.appendingPathComponent(itemId, isDirectory: true)');
    expect(extension).toContain('let relativePath = "items/\\(itemId)/\\(stored.fileName)"');
    expect(extension).toContain("manifestData.write");
    expect(extension).toContain("options: .atomic");
    expect(extension).toContain("fileManager.moveItem(at: staging, to: final)");
    expect(extension).toContain("SHA256.hash(data: data)");
    expect(extension).not.toContain("UserDefaults");
    expect(extension).not.toMatch(/credential|accessToken|refreshToken|draft/iu);
  });

  it("accepts bounded exact text and HTTP(S) URLs while isolating rejected providers", () => {
    expect(extension).toContain("provider.loadItem(forTypeIdentifier: type.identifier, options: nil)");
    expect(extension).toContain('return .readyText(kind: kind, text: text, byteSize: bytes.count, sha256Hex: digest)');
    expect(extension).toContain('!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty');
    expect(extension).toContain('text.hasPrefix("http://") || text.hasPrefix("https://")');
    expect(extension).toContain('let scheme = components.scheme, ["http", "https"].contains(scheme)');
    expect(extension).toContain('!text.unicodeScalars.contains(where: { $0.value == 0 })');
    expect(extension).toContain("type.conforms(to: .audio)");
    expect(extension).toContain("type.conforms(to: .movie)");
    expect(extension).toContain("type.conforms(to: .url) && !type.conforms(to: .fileURL)");
    expect(extension).toContain('state: "rejected"');
    expect(extension).toContain("providers.prefix(maximumItems)");
    expect(extension).toContain("providers.count - maximumItems");
    expect(extension).toContain("try? FileManager.default.removeItem(at: itemDirectory)");
    expect(extension).not.toContain('print(');
  });

  it("autolinks the Apple implementation that revalidates App Group containment, file identity, MIME, and SHA", () => {
    expect(moduleConfig).toEqual({
      platforms: ["apple", "android"],
      apple: {
        podspecPath: "./ios/JokoIncomingShare.podspec",
        modules: ["JokoIncomingShareModule"]
      },
      android: {
        modules: ["app.joko.incomingshare.JokoIncomingShareModule"]
      }
    });
    expect(moduleSource).toContain('Name("JokoIncomingShare")');
    expect(moduleSource).toContain('"ExpoShareIntoAppGroupId"');
    expect(moduleSource).toContain('private let incomingShareRootName = "JokoIncomingShareV1"');
    expect(moduleSource).toContain("standardizedFileURL.resolvingSymlinksInPath()");
    expect(moduleSource).toContain("values.isRegularFile == true");
    expect(moduleSource).toContain("values.isSymbolicLink != true");
    expect(moduleSource).toContain('relativePath == "items/\\(item.itemId)/\\(fileName)"');
    expect(moduleSource).toContain("digest == sha256Hex");
    expect(moduleSource).toContain("assertMediaType(mediaType, matches: fileURL)");
    expect(moduleSource).toContain('textBatchBytes <= incomingShareMaximumTextBatchBytes');
    expect(moduleSource).toContain('if kind == "url" { try assertWebURL(text) }');
    expect(moduleSource).toContain('"text": text');
    expect(moduleSource).toContain('claim.acceptedItemProofs == (try acceptedProofs(');
  });

  it("durably profile-binds before consumption and removes only an exact batch after ack or discard", () => {
    expect(moduleSource).toContain('private let incomingShareBindingName = "binding.json"');
    expect(moduleSource).toContain('private let incomingShareClaimName = "claim.json"');
    expect(moduleSource).toContain("options: [.atomic, .withoutOverwriting]");
    expect(moduleSource).toContain('AsyncFunction("claimBatch")');
    expect(moduleSource).toContain('AsyncFunction("acknowledgeBatch")');
    expect(moduleSource).toContain('AsyncFunction("discardBatch")');
    expect(moduleSource).toContain("batch.binding?.profileId == profileId");
    expect(moduleSource).toContain("batch.claim?.claimId == claimId");
    expect(moduleSource).toContain("claim.surfaceOwnerKey == surfaceOwnerKey");
    expect(moduleSource).toContain('CharacterSet(charactersIn: "\\u{001e}\\u{001f}")');
    expect(moduleSource).toContain("claim.destinationKind == destinationKind");
    expect(moduleSource).toContain("claim.sessionId == sessionId");
    expect(moduleSource).toContain("claim.acceptedItemIds == acceptedItemIds");
    expect(moduleSource).toContain("try assertContainedRegularDirectory(directory, root: root)");
    expect(moduleSource).toContain("FileManager.default.removeItem(at: directory)");
    expect(moduleSource).not.toMatch(/removeItem\(at:\s*(root|container)\)/u);
  });

  it("keeps the native share handoff distinct from public task links", () => {
    expect(extension).toContain('url = URL(string: "\\(hostAppScheme)://expo-sharing")');
    expect(surface).toContain("void mobileIncomingShare.refresh()");
    expect(surface).toContain('AppState.addEventListener("change"');
    expect(surface).toContain("installMobileNativeIntentLinking(Linking, offerUrl)");
    expect(surface).toContain("isMobileIncomingShareUrl(url)");
    expect(surface).toContain("nativeIntentDeliveryRef.current!.invalidate()");
    expect(nativeIntent).toContain('source.addEventListener("url"');
    expect(nativeIntent).toContain("source.getInitialURL()");
    expect(nativeIntent).toContain("acceptedWarmUrlBeforeInitial");
  });
});
