import { readFile, stat } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { verifyPackagedWebBundle } from "../src/bundle.js";
import {
  DESKTOP_CONTENT_SECURITY_POLICY,
  DESKTOP_APP_ENTRY_URL,
  canonicalExternalUrl,
  createNavigationPolicy,
  extractHtmlAssetReferences,
  isAllowedMainFrameNavigation,
  isAllowedPackagedBundleResource,
  isAllowedRendererNetworkUrl,
  isRelativeBundleAssetReference,
  isSafeExternalUrl,
  isSecureStorageBackend,
  isTrustedLocalNetworkHostname,
  isTrustedIpcSenderIdentity,
  mediaTypeForPath,
  mergeContentSecurityPolicyHeaders,
  resolvePackagedAppResource,
  validateCredentialSecret,
  validateProfileId
} from "../src/security.js";

describe("Desktop security policy", () => {
  it("allows only the privileged app entry for navigation and bundle-contained resources", () => {
    const bundle = mkdtempSync(join(tmpdir(), "joko-desktop-policy-"));
    const entry = join(bundle, "index.html");
    const asset = join(bundle, "assets", "app.js");
    const outside = join(dirname(bundle), "outside.js");
    const policy = createNavigationPolicy(entry);

    expect(isAllowedMainFrameNavigation(DESKTOP_APP_ENTRY_URL, policy)).toBe(true);
    expect(isAllowedMainFrameNavigation(`${DESKTOP_APP_ENTRY_URL}#task`, policy)).toBe(true);
    expect(isAllowedMainFrameNavigation("joko://app/assets/app.js", policy)).toBe(false);
    expect(isAllowedMainFrameNavigation(pathToFileURL(entry).href, policy)).toBe(false);
    expect(isAllowedMainFrameNavigation("https://example.test/", policy)).toBe(false);
    expect(isAllowedPackagedBundleResource("joko://app/index.html", policy)).toBe(true);
    expect(isAllowedPackagedBundleResource("joko://app/assets/app.js", policy)).toBe(true);
    expect(isAllowedPackagedBundleResource("joko://other/assets/app.js", policy)).toBe(false);
    expect(isAllowedPackagedBundleResource("joko://app/assets/%2Fetc/passwd", policy)).toBe(false);
    expect(isAllowedPackagedBundleResource(pathToFileURL(entry).href, policy)).toBe(true);
    expect(isAllowedPackagedBundleResource(pathToFileURL(asset).href, policy)).toBe(true);
    expect(isAllowedPackagedBundleResource(pathToFileURL(outside).href, policy)).toBe(false);
    expect(resolvePackagedAppResource("joko://app/assets/app.js", policy)).toBe(asset);
    expect(resolvePackagedAppResource("joko://app/index.html?debug=1", policy)).toBeUndefined();
  });

  it("allows a credential-free loopback dev origin without weakening packaged file access", () => {
    const entry = resolve(tmpdir(), "joko-desktop-dev", "index.html");
    const policy = createNavigationPolicy(entry, "http://127.0.0.1:4319/app");
    expect(isAllowedMainFrameNavigation("http://127.0.0.1:4319/another", policy)).toBe(true);
    expect(isAllowedMainFrameNavigation("http://localhost:4319/", policy)).toBe(false);
    expect(isAllowedMainFrameNavigation("https://127.0.0.1:4319/", policy)).toBe(false);
    expect(isAllowedPackagedBundleResource(pathToFileURL(entry).href, policy)).toBe(false);
    expect(isAllowedPackagedBundleResource(DESKTOP_APP_ENTRY_URL, policy)).toBe(false);
    expect(() => createNavigationPolicy(entry, "http://user:secret@127.0.0.1:4319/")).toThrow(/credential-free/u);
    expect(() => createNavigationPolicy(entry, "http://example.test:4319/")).toThrow(/loopback/u);
  });

  it("accepts only credential-free HTTP(S) external URLs", () => {
    expect(isSafeExternalUrl("https://example.test/docs?q=1")).toBe(true);
    expect(canonicalExternalUrl("https://example.test/docs?q=1")).toBe("https://example.test/docs?q=1");
    expect(isSafeExternalUrl("http://example.test/")).toBe(true);
    expect(isSafeExternalUrl("https://user:password@example.test/")).toBe(false);
    expect(isSafeExternalUrl("https://example.test/\n--unsafe")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });

  it("allows plaintext renderer traffic only to trusted local-network hosts", () => {
    for (const value of [
      "http://localhost:4318/joko.v1.ConnectionService/GetServerInfo",
      "http://orchestrator.local:4318/",
      "http://orchestrator.home.arpa:4318/",
      "http://orchestrator:4318/",
      "http://127.0.0.1:4318/",
      "http://10.20.30.40:4318/",
      "http://172.16.0.1:4318/",
      "http://172.31.255.254:4318/",
      "http://192.168.50.2:4318/",
      "http://[fd12:3456::1]:4318/",
      "http://[::ffff:192.168.1.4]:4318/",
      "ws://orchestrator.local:4318/stream"
    ]) expect(isAllowedRendererNetworkUrl(value), value).toBe(true);

    for (const value of [
      "http://example.test:4318/",
      "http://8.8.8.8:4318/",
      "http://100.64.0.1:4318/",
      "http://169.254.169.254/latest/meta-data/",
      "http://0.0.0.0:4318/",
      "http://[fe80::1]:4318/",
      "http://[::]:4318/",
      "http://user:secret@192.168.1.5:4318/",
      "http://192.168.1.5:4318/\nhttps://example.test",
      "ws://example.test/socket"
    ]) expect(isAllowedRendererNetworkUrl(value), value).toBe(false);

    expect(isAllowedRendererNetworkUrl("https://example.test/orchestrator")).toBe(true);
    expect(isAllowedRendererNetworkUrl("wss://example.test/events")).toBe(true);
    expect(isAllowedRendererNetworkUrl("ftp://192.168.1.5/file")).toBe(false);
    expect(isTrustedLocalNetworkHostname("printer.local.")).toBe(true);
    expect(isTrustedLocalNetworkHostname("public.example")).toBe(false);
  });

  it("requires the owning window, its WebContents, and its exact main frame for IPC", () => {
    const entry = resolve(tmpdir(), "joko-desktop-ipc", "index.html");
    const policy = createNavigationPolicy(entry);
    const window = {};
    const contents = {};
    const mainFrame = {};
    const trusted = {
      owner: window,
      expectedWindow: window,
      sender: contents,
      ownerContents: contents,
      senderFrame: mainFrame,
      mainFrame,
      frameUrl: DESKTOP_APP_ENTRY_URL
    };
    expect(isTrustedIpcSenderIdentity(trusted, policy)).toBe(true);
    expect(isTrustedIpcSenderIdentity({ ...trusted, owner: {} }, policy)).toBe(false);
    expect(isTrustedIpcSenderIdentity({ ...trusted, sender: {} }, policy)).toBe(false);
    expect(isTrustedIpcSenderIdentity({ ...trusted, senderFrame: {} }, policy)).toBe(false);
    expect(isTrustedIpcSenderIdentity({ ...trusted, senderFrame: undefined }, policy)).toBe(false);
    expect(isTrustedIpcSenderIdentity({ ...trusted, frameUrl: "joko://app/assets/app.js" }, policy)).toBe(false);
    expect(isTrustedIpcSenderIdentity({ ...trusted, frameUrl: "https://example.test/" }, policy)).toBe(false);
  });

  it("preserves an existing CSP as an additional policy and adds all Desktop restrictions", () => {
    const headers = mergeContentSecurityPolicyHeaders({
      "content-security-policy": ["default-src 'none'"],
      "X-Test": ["one"]
    });
    expect(headers["content-security-policy"]).toBeUndefined();
    expect(headers["X-Test"]).toEqual(["one"]);
    expect(headers["Content-Security-Policy"]).toEqual(["default-src 'none'", DESKTOP_CONTENT_SECURITY_POLICY]);
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-eval'");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("img-src 'self' data: blob: https: http:");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).not.toContain("file:");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("connect-src 'self' blob:");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("media-src 'self' data: blob:");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("http:");
  });

  it("rejects Linux safeStorage plaintext fallback and validates renderer-controlled values", () => {
    expect(isSecureStorageBackend("linux", true, "basic_text")).toBe(false);
    expect(isSecureStorageBackend("linux", true, "unknown")).toBe(false);
    expect(isSecureStorageBackend("linux", true, "gnome_libsecret")).toBe(true);
    expect(isSecureStorageBackend("win32", true, undefined)).toBe(true);
    expect(isSecureStorageBackend("darwin", false, undefined)).toBe(false);
    expect(() => validateProfileId("profile_1-ok")).not.toThrow();
    expect(() => validateProfileId("../profile")).toThrow(/profile/u);
    expect(() => validateCredentialSecret("0123456789abcdef")).not.toThrow();
    expect(() => validateCredentialSecret("short")).toThrow(/Credential/u);
    expect(() => validateCredentialSecret("x".repeat(64 * 1024 + 1))).toThrow(/Credential/u);
    expect(mediaTypeForPath("image.PNG")).toBe("image/png");
    expect(mediaTypeForPath("archive.bin")).toBe("application/octet-stream");
  });

  it("verifies the built Web index uses app-scheme-compatible relative bundle assets", async () => {
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const entries = [
      resolve(testDirectory, "..", "..", "web", "dist", "index.html"),
      resolve(testDirectory, "..", "dist", "web", "index.html")
    ];
    for (const entry of entries) {
      const html = await readFile(entry, "utf8");
      const references = extractHtmlAssetReferences(html);
      expect(references.length).toBeGreaterThan(0);
      const policy = createNavigationPolicy(entry);
      for (const reference of references) {
        expect(isRelativeBundleAssetReference(reference, entry), reference).toBe(true);
        const resourceUrl = new URL(reference, DESKTOP_APP_ENTRY_URL);
        expect(isAllowedPackagedBundleResource(resourceUrl.href, policy), reference).toBe(true);
        const resolved = resolvePackagedAppResource(resourceUrl.href, policy);
        expect(resolved, reference).toBeDefined();
        await expect(stat(resolved!), reference).resolves.toMatchObject({ size: expect.any(Number) });
      }
      await expect(verifyPackagedWebBundle(entry)).resolves.toEqual(references);
    }
  });
});
