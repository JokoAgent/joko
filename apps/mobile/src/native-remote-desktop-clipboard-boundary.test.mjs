import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const moduleRoot = new URL("modules/joko-remote-presentation/", project);
const config = JSON.parse(readFileSync(new URL("expo-module.config.json", moduleRoot), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("package.json", moduleRoot), "utf8"));
const binding = readFileSync(new URL("src/index.ts", moduleRoot), "utf8");
const swift = readFileSync(new URL("ios/JokoRemotePresentationModule.swift", moduleRoot), "utf8");
const size = readFileSync(new URL("ios/RemoteClipboardSize.swift", moduleRoot), "utf8");
describe("native Remote Desktop clipboard boundary", () => {
  it("autolinks the optional native clipboard module on Apple and Android", () => {
    expect(config).toEqual({
      platforms: ["apple", "android"],
      apple: {
        podspecPath: "./ios/JokoRemotePresentation.podspec",
        modules: ["JokoRemotePresentationModule"]
      },
      android: { modules: ["com.joko.remotepresentation.JokoRemotePresentationModule"] }
    });
    expect(packageJson.name).toBe("@joko/mobile-remote-presentation");
    expect(binding).toContain('"JokoRemotePresentation"');
    expect(swift).toContain('Name("JokoRemotePresentation")');
    expect(swift).toContain('AsyncFunction("readClipboard")');
    expect(swift).toContain('AsyncFunction("writeClipboard")');
    expect(swift).toContain('AsyncFunction("clipboardVersion")');
    expect(swift).toContain('AsyncFunction("syncClipboard")');
    expect(swift).toContain("String(UIPasteboard.general.changeCount) != expectedVersion");
  });

  it("registers only the Android clipboard module and its non-exported managed image provider", () => {
    const android = new URL("android/", moduleRoot);
    const manifest = readFileSync(new URL("src/main/AndroidManifest.xml", android), "utf8");
    const paths = readFileSync(new URL("src/main/res/xml/joko_remote_clipboard_paths.xml", android), "utf8");
    const provider = readFileSync(new URL("src/main/java/com/joko/remotepresentation/RemoteClipboardProvider.kt", android), "utf8");
    const kotlin = readFileSync(new URL("src/main/java/com/joko/remotepresentation/JokoRemotePresentationModule.kt", android), "utf8");
    expect(manifest).toContain('android:name="com.joko.remotepresentation.RemoteClipboardProvider"');
    expect(manifest).toContain('android:exported="false"');
    expect(manifest).toContain('android:grantUriPermissions="true"');
    expect(manifest).toContain('@xml/joko_remote_clipboard_paths');
    expect(paths).toContain('path="remote-clipboard/"');
    expect(provider).toContain("class RemoteClipboardProvider : FileProvider()");
    expect(kotlin).toContain('Name("JokoRemotePresentation")');
    expect(kotlin).toContain('AsyncFunction("syncClipboard")');
    expect(kotlin).toContain("expectedVersion != null && clipboardVersion() != expectedVersion");
    expect(kotlin).toContain("appContext.currentActivity?.hasWindowFocus() != true");
  });

  it("reads and writes one foreground-fenced portable item without file or URL fetching", () => {
    expect(swift).toContain("UIApplication.shared.applicationState == .active");
    expect(swift).toContain("let version = board.changeCount");
    expect(swift).toContain("guard items.count == 1");
    expect(swift).toContain("conforms(to: .fileURL)");
    expect(swift).toContain('["http", "https"].contains');
    expect(swift).toContain('["text", "html", "rtf", "url", "png"].contains');
    expect(swift).toContain("version == board.changeCount");
    expect(swift).toContain("UIPasteboard.general.setItems([item], options: [:])");
    expect(swift).not.toContain("Data(contentsOf:");
    expect(swift).not.toContain("contentsOfFile");
  });

  it("uses the rich JSON UTF-16 budget, with a UTF-8 pre-decode bound and no 16 KiB text cap", () => {
    expect(size).toContain("static let transferLimit = 32 * 1024 * 1024");
    expect(size).toContain("string.utf16.count <= transferLimit");
    expect(size).toContain("data.count <= transferLimit * 3");
    expect(size).not.toContain("16 * 1024");
    expect(swift).toContain("RemoteClipboardSize.acceptsTransfer(json)");
  });
});
