import assert from "node:assert/strict";
import test from "node:test";

import {
  createManagedOutboundProxyResolver,
  decodeManagedOutboundProxySnapshot,
  encodeManagedOutboundProxySnapshot,
  hasManagedOutboundProxyEnvironment
} from "../dist/managed-outbound-proxy.js";

test("managed outbound proxy snapshots resolve only fixed exact and prefix routes", () => {
  const encoded = encodeManagedOutboundProxySnapshot({
    "android-platform-tools-linux": "socks5://proxy.example:1080",
    "computer-driver-tags": null
  });
  assert.equal(typeof encoded, "string");
  const resolve = createManagedOutboundProxyResolver(encoded);
  assert.equal(
    resolve("https://dl.google.com/android/repository/platform-tools-latest-linux.zip"),
    "socks5://proxy.example:1080"
  );
  assert.equal(
    resolve("https://api.github.com/repos/trycua/cua/git/matching-refs/tags/cua-driver-rs-v?per_page=100"),
    null
  );
  assert.equal(resolve("https://api.github.com/user"), undefined);
  assert.equal(resolve("https://dl.google.com/android/repository/other.zip"), undefined);
});

test("managed outbound proxy snapshots reject credentials, unknown routes, and unbounded input", () => {
  assert.throws(() => encodeManagedOutboundProxySnapshot({
    "android-platform-tools-linux": "http://person:secret@proxy.example:8080"
  }), /proxy URL is invalid/u);
  assert.throws(() => encodeManagedOutboundProxySnapshot({
    "android-platform-tools-linux": "socks5://person:secret@proxy.example:1080"
  }), /proxy URL is invalid/u);
  assert.throws(() => encodeManagedOutboundProxySnapshot({
    "android-platform-tools-linux": "socks5h://proxy.example:1080"
  }), /proxy URL is invalid/u);
  assert.throws(() => encodeManagedOutboundProxySnapshot({
    "android-platform-tools-linux": "socks5://proxy.example:0"
  }), /proxy URL is invalid/u);
  assert.equal(decodeManagedOutboundProxySnapshot(JSON.stringify({
    version: 1,
    routes: { unknown: "http://proxy.example:8080" }
  })), undefined);
  assert.equal(decodeManagedOutboundProxySnapshot("x".repeat(20_000)), undefined);
});

test("explicit proxy environment detection ignores NO_PROXY alone", () => {
  assert.equal(hasManagedOutboundProxyEnvironment({ NO_PROXY: "*" }), false);
  assert.equal(hasManagedOutboundProxyEnvironment({ HTTPS_PROXY: "http://proxy.example:8080" }), true);
  assert.equal(hasManagedOutboundProxyEnvironment({ https_proxy: "   " }), false);
});
