#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Execute the actual receiver and clipboard budgets on macOS. Only receiver SDK
// imports are replaced; production state machines and limits are unchanged.
if (process.platform !== "darwin") {
  throw new Error("Native Remote Desktop checks require macOS with Xcode Command Line Tools.");
}
const directory = mkdtempSync(join(tmpdir(), "joko-receiver-test-"));
try {
  const source = readFileSync(new URL(
    "../modules/joko-remote-presentation/ios/RemoteDesktopReceiver.swift", import.meta.url
  ), "utf8").replace(/^import (WebRTC|UIKit)\r?\n/gm, "");
  const numbers = readFileSync(new URL(
    "../modules/joko-remote-presentation/ios/RemoteDesktopBridgeNumber.swift", import.meta.url
  ), "utf8");
  const clipboard = readFileSync(new URL(
    "../modules/joko-remote-presentation/ios/RemoteClipboardSize.swift", import.meta.url
  ), "utf8");
  const fixture = readFileSync(new URL("./fixtures/remote-desktop-receiver.swift", import.meta.url), "utf8");
  const input = join(directory, "ReceiverTests.swift");
  const executable = join(directory, "receiver-tests");
  writeFileSync(input, numbers + "\n" + clipboard + "\n" + source + "\n" + fixture);
  execFileSync("xcrun", ["swiftc", "-parse-as-library", input, "-o", executable], { stdio: "inherit" });
  execFileSync(executable, [], { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

