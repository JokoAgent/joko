import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const project = new URL("../", import.meta.url);
const moduleRoot = new URL("modules/joko-remote-presentation/", project);
const config = JSON.parse(readFileSync(new URL("expo-module.config.json", moduleRoot), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("package.json", moduleRoot), "utf8"));
const binding = readFileSync(new URL("src/index.ts", moduleRoot), "utf8");
const swift = readFileSync(new URL("ios/JokoRemotePresentationModule.swift", moduleRoot), "utf8");
const size = readFileSync(new URL("ios/RemoteClipboardSize.swift", moduleRoot), "utf8");
const app = JSON.parse(readFileSync(new URL("app.json", project), "utf8")).expo;

describe("native Remote Desktop clipboard boundary", () => {
  it("autolinks one optional Joko-owned Apple module with only clipboard methods", () => {
    expect(config).toEqual({
      platforms: ["apple"],
      apple: {
        podspecPath: "./ios/JokoRemotePresentation.podspec",
        modules: ["JokoRemotePresentationModule"]
      }
    });
    expect(packageJson.name).toBe("@joko/mobile-remote-presentation");
    expect(binding).toContain('"JokoRemotePresentation"');
    expect(swift).toContain('Name("JokoRemotePresentation")');
    expect(swift).toContain('AsyncFunction("readClipboard")');
    expect(swift).toContain('AsyncFunction("writeClipboard")');
    expect(swift).not.toContain("AVFoundation");
    expect(swift).not.toContain('AsyncFunction("rotate")');
    expect(swift).not.toContain('AsyncFunction("playback")');
    expect(app.ios?.infoPlist?.UIBackgroundModes ?? []).not.toContain("audio");
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
    expect(swift).toContain("width <= 64_000_000 / height");
    expect(swift).toContain("RemoteClipboardSize.acceptsTransfer(json)");
  });
});
