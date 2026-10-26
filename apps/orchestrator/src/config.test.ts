import { chmodSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const fixtureRoot = mkdtempSync(join(tmpdir(), "joko-orchestrator-config-"));
const workspaceRoot = join(fixtureRoot, "workspace");
const dataDirectory = join(fixtureRoot, "orchestrator-data");
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const explicitCodexExecutable = join(fixtureRoot, "codex.exe");
const apnsPrivateKey = join(fixtureRoot, "AuthKey_TEST123456.p8");
const devicePeerAuthKey = join(fixtureRoot, "device-peer-auth-key");
mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(explicitCodexExecutable, "", { flag: "wx" });
writeFileSync(apnsPrivateKey, "private-key-fixture", { flag: "wx" });
writeFileSync(devicePeerAuthKey, `${"A".repeat(43)}\n`, { flag: "wx", mode: 0o600 });
chmodSync(devicePeerAuthKey, 0o600);

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const base = {
  JOKO_BROWSER_ENABLED: "0",
  JOKO_ALLOW_INSECURE_LOOPBACK: "1",
  JOKO_DATA_DIR: dataDirectory,
  JOKO_WORKSPACE_ROOT: workspaceRoot
} satisfies NodeJS.ProcessEnv;

describe("Orchestrator network configuration", () => {
  it("requires an explicit private deployment selection for optional UDP media without replacing TURN", () => {
    expect(loadConfig(base).remoteDesktopUdp).toBeUndefined();
    expect(() => loadConfig({ ...base, JOKO_REMOTE_DESKTOP_UDP_ENTRY_ID: "entrance" })).toThrow(/private Linkspan/u);
    expect(() => loadConfig({ ...base, JOKO_REMOTE_DESKTOP_UDP_ENTRY_ID: "../invalid", JOKO_LINKSPAN_CONNECTORS_FILE: join(dataDirectory, "connectors.json") })).toThrow(/private Linkspan/u);
    const config = loadConfig({ ...base, JOKO_REMOTE_DESKTOP_UDP_ENTRY_ID: "entrance", JOKO_LINKSPAN_CONNECTORS_FILE: join(dataDirectory, "connectors.json"),
      JOKO_REMOTE_DESKTOP_TURN_KEY_ID: "existing-key", JOKO_REMOTE_DESKTOP_TURN_TOKEN_FILE: join(dataDirectory, "turn-token") });
    expect(config.remoteDesktopUdp).toEqual({ entryId: "entrance" }); expect(config.remoteDesktopTurn?.keyId).toBe("existing-key");
  });
  it("explicitly selects hosted TURN without leaking publisher credentials or replacing the external ICE broker", () => {
    const configured = { ...base, JOKO_REMOTE_DESKTOP_TURN_KEY_ID: "selected-key",
      JOKO_REMOTE_DESKTOP_TURN_TOKEN_FILE: join(dataDirectory, "turn-token") };
    expect(loadConfig(configured).remoteDesktopTurn).toEqual({ keyId: "selected-key", tokenPath: configured.JOKO_REMOTE_DESKTOP_TURN_TOKEN_FILE, ttlSeconds: 600 });
    expect(loadConfig(base).remoteDesktopTurn).toBeUndefined();
    for (const ttl of ["0", "120", "86401", "1.5", "invalid"]) {
      expect(() => loadConfig({ ...configured, JOKO_REMOTE_DESKTOP_TURN_TTL_SECONDS: ttl })).toThrow(/Hosted TURN/u);
    }
    expect(() => loadConfig({ ...configured, JOKO_REMOTE_DESKTOP_TURN_TOKEN_FILE: join(workspaceRoot, "token") })).toThrow(/Hosted TURN/u);
    expect(() => loadConfig({ ...configured, JOKO_REMOTE_DESKTOP_ICE_URL: "https://broker.example/ice",
      JOKO_REMOTE_DESKTOP_ICE_TOKEN_FILE: join(dataDirectory, "broker-token") })).toThrow(/either/u);
  });
  it("keeps remote desktop ICE deployment authentication outside public settings and workspace files", () => {
    const configured = { ...base, JOKO_REMOTE_DESKTOP_ICE_URL: "https://relay.example.test/ice-servers",
      JOKO_REMOTE_DESKTOP_ICE_TOKEN_FILE: join(dataDirectory, "ice-token") };
    expect(loadConfig(configured).remoteDesktopIce).toEqual({ url: configured.JOKO_REMOTE_DESKTOP_ICE_URL,
      tokenPath: configured.JOKO_REMOTE_DESKTOP_ICE_TOKEN_FILE });
    expect(loadConfig(base).remoteDesktopIce).toBeUndefined();
    for (const url of ["http://relay.example.test/ice", "https://token@relay.example.test/ice",
      "https://relay.example.test/ice?token=secret", "https://relay.example.test/ice#secret"]) {
      expect(() => loadConfig({ ...configured, JOKO_REMOTE_DESKTOP_ICE_URL: url })).toThrow(/Remote Desktop ICE/u);
    }
    expect(() => loadConfig({ ...configured, JOKO_REMOTE_DESKTOP_ICE_TOKEN_FILE: join(workspaceRoot, "secret") }))
      .toThrow(/Remote Desktop ICE/u);
    expect(() => loadConfig({ ...base, JOKO_REMOTE_DESKTOP_ICE_URL: configured.JOKO_REMOTE_DESKTOP_ICE_URL }))
      .toThrow(/Remote Desktop ICE/u);
  });

  it("keeps insecure loopback behind its existing explicit flag", () => {
    expect(() => loadConfig({ ...base, JOKO_ALLOW_INSECURE_LOOPBACK: "0" })).toThrow(/TLS is required/u);
    expect(loadConfig(base)).toMatchObject({
      host: "127.0.0.1",
      publicOrigin: "http://127.0.0.1:4318",
      internalOrigin: "http://127.0.0.1:4317",
      allowInsecureLoopback: true
    });
  });

  it("requires verified HTTPS at the Cloudflare origin while leaving independent LAN HTTP available", () => {
    expect(() => loadConfig({ ...base, JOKO_LINKSPAN_CLOUDFLARE: "quick", JOKO_LINKSPAN_CLOUDFLARED: process.execPath }))
      .toThrow(/Cloudflare requires.*JOKO_TLS_CERT/u);
    const certificatePath = join(fixtureRoot, "origin-certificate.pem"), privateKeyPath = join(fixtureRoot, "origin-key.pem");
    writeFileSync(certificatePath, "certificate-fixture"); writeFileSync(privateKeyPath, "private-key-fixture");
    expect(loadConfig({ ...base, JOKO_TLS_CERT: certificatePath, JOKO_TLS_KEY: privateKeyPath,
      JOKO_PUBLIC_ORIGIN: "https://node.example.test:4318", JOKO_LINKSPAN_CLOUDFLARE: "quick",
      JOKO_LINKSPAN_CLOUDFLARED: process.execPath }).linkspan).toEqual({ port: 0, cloudflaredExecutable: process.execPath,
      originCaPool: certificatePath, originServerName: "node.example.test" });
    expect(loadConfig({ ...base, JOKO_HOST: "192.168.1.20", JOKO_ALLOW_INSECURE_LAN: "1" }).allowInsecureLan).toBe(true);
  });

  it("allows private-LAN HTTP only with JOKO_ALLOW_INSECURE_LAN=1", () => {
    const lan = {
      ...base,
      JOKO_HOST: "192.168.20.10",
      JOKO_ALLOW_INSECURE_LAN: "1"
    };
    expect(loadConfig(lan)).toMatchObject({
      publicOrigin: "http://192.168.20.10:4318",
      internalOrigin: "http://127.0.0.1:4317",
      allowInsecureLan: true
    });
    expect(() => loadConfig({ ...lan, JOKO_ALLOW_INSECURE_LAN: "0" })).toThrow(/TLS is required/u);
  });

  it("requires an explicit reachable public origin for wildcard binds", () => {
    const wildcard = {
      ...base,
      JOKO_HOST: "0.0.0.0",
      JOKO_ALLOW_INSECURE_LAN: "1"
    };
    expect(() => loadConfig(wildcard)).toThrow(/JOKO_PUBLIC_ORIGIN is required/u);
    expect(loadConfig({ ...wildcard, JOKO_PUBLIC_ORIGIN: "http://192.168.20.10:4318" })).toMatchObject({
      publicOrigin: "http://192.168.20.10:4318",
      internalOrigin: "http://127.0.0.1:4317"
    });
  });

  it("rejects public HTTP, credentials, paths, queries, and wildcard advertised origins", () => {
    const lan = {
      ...base,
      JOKO_HOST: "0.0.0.0",
      JOKO_ALLOW_INSECURE_LAN: "1"
    };
    for (const publicOrigin of [
      "http://example.com:4318",
      "http://user:pass@192.168.1.2:4318",
      "http://169.254.169.254:4318",
      "http://metadata:4318",
      "http://3232235778:4318",
      "http://192.168.1.2:4318/path",
      "http://192.168.1.2:4318?query=1",
      "http://0.0.0.0:4318"
    ]) expect(() => loadConfig({ ...lan, JOKO_PUBLIC_ORIGIN: publicOrigin })).toThrow();
  });

  it("accepts only loopback or explicitly-enabled private HTTP CORS origins", () => {
    expect(loadConfig({ ...base, JOKO_CORS_ORIGINS: "http://localhost:4319" }).corsOrigins)
      .toEqual(["http://localhost:4319"]);
    expect(() => loadConfig({ ...base, JOKO_CORS_ORIGINS: "http://192.168.1.30:4319" }))
      .toThrow(/JOKO_ALLOW_INSECURE_LAN/u);
    expect(loadConfig({
      ...base,
      JOKO_ALLOW_INSECURE_LAN: "1",
      JOKO_CORS_ORIGINS: "http://192.168.1.30:4319"
    }).corsOrigins).toEqual(["http://192.168.1.30:4319"]);
    expect(() => loadConfig({
      ...base,
      JOKO_ALLOW_INSECURE_LAN: "1",
      JOKO_CORS_ORIGINS: "http://example.com:4319"
    })).toThrow(/public HTTP origin/u);
  });

  it("enables LAN discovery by default and supports an explicit off switch", () => {
    expect(loadConfig(base).lanDiscoveryEnabled).toBe(true);
    expect(loadConfig({ ...base, JOKO_LAN_DISCOVERY: "0" }).lanDiscoveryEnabled).toBe(false);
    expect(loadConfig(base).voiceDictionaryLanDiscoveryEnabled).toBe(true);
    expect(loadConfig({ ...base, JOKO_VOICE_DICTIONARY_LAN_DISCOVERY: "0" }).voiceDictionaryLanDiscoveryEnabled).toBe(false);
  });

  it("reserves a distinct loopback-only internal bridge port", () => {
    expect(loadConfig(base)).toMatchObject({ internalPort: 4317, internalOrigin: "http://127.0.0.1:4317" });
    expect(() => loadConfig({ ...base, JOKO_INTERNAL_PORT: "4318" })).toThrow(/must differ/u);
    expect(() => loadConfig({ ...base, JOKO_INTERNAL_PORT: "0" })).toThrow(/valid TCP port/u);
  });

  it("keeps native coding runtime executable overrides private to service configuration", () => {
    expect(loadConfig({
      ...base,
      JOKO_CODEX_EXECUTABLE: explicitCodexExecutable,
      JOKO_CLAUDE_CODE_EXECUTABLE: "D:/tools/claude.exe"
    })).toMatchObject({
      codexExecutable: realpathSync.native(explicitCodexExecutable),
      claudeCodeExecutable: "D:/tools/claude.exe"
    });
  });

  it("accepts only an existing local PDF helper executable and app directory", () => {
    expect(loadConfig({ ...base, JOKO_DOCUMENT_PDF_ELECTRON_EXECUTABLE: process.execPath,
      JOKO_DOCUMENT_PDF_ELECTRON_APP: process.cwd() }).pdfRendererHost)
      .toEqual({ executablePath: process.execPath, appPath: process.cwd() });
    expect(() => loadConfig({ ...base, JOKO_DOCUMENT_PDF_ELECTRON_APP: process.cwd() })).toThrow();
    expect(() => loadConfig({ ...base, JOKO_DOCUMENT_PDF_ELECTRON_EXECUTABLE: "relative/helper" })).toThrow();
  });


  it("enables APNs only from one complete bounded credential configuration", () => {
    expect(loadConfig(base).mobilePush).toBeUndefined();
    expect(loadConfig({
      ...base,
      JOKO_APNS_TEAM_ID: "TEAM123456",
      JOKO_APNS_KEY_ID: "KEYS123456",
      JOKO_APNS_PRIVATE_KEY: apnsPrivateKey,
      JOKO_APNS_TOPIC: "app.joko.mobile"
    }).mobilePush).toEqual({
      apns: {
        teamId: "TEAM123456",
        keyId: "KEYS123456",
        privateKeyPath: resolve(apnsPrivateKey),
        topic: "app.joko.mobile"
      }
    });
    expect(() => loadConfig({ ...base, JOKO_APNS_TEAM_ID: "TEAM123456" }))
      .toThrow(/must be configured together/u);
    expect(() => loadConfig({
      ...base,
      JOKO_APNS_TEAM_ID: "TEAM123456",
      JOKO_APNS_KEY_ID: "KEYS123456",
      JOKO_APNS_PRIVATE_KEY: apnsPrivateKey,
      JOKO_APNS_TOPIC: "invalid/topic"
    })).toThrow(/JOKO_APNS_TOPIC is invalid/u);
  });

  it("enables a standalone Service peer agent only from exact non-secret authority configuration", () => {
    expect(loadConfig(base).devicePeerAgent).toBeUndefined();
    const authority = {
      ...base,
      JOKO_DEVICE_PEER_CONTROLLER_ORIGIN: "https://controller.example.test",
      JOKO_DEVICE_PEER_CONTROLLER_SERVER_ID: "controller-server",
      JOKO_DEVICE_PEER_ENDPOINT_PUBLIC_KEY: `ed25519:${"c".repeat(64)}`,
      JOKO_DEVICE_PEER_CONNECTION_ID: "service-connection",
      JOKO_DEVICE_PEER_DEVICE_ID: "service-device",
      JOKO_DEVICE_PEER_AUTH_KEY_FILE: devicePeerAuthKey
    };
    expect(loadConfig(authority).devicePeerAgent).toEqual({
      controllerOrigin: "https://controller.example.test",
      controllerServerId: "controller-server",
      endpointPublicKey: authority.JOKO_DEVICE_PEER_ENDPOINT_PUBLIC_KEY,
      connectionId: "service-connection",
      deviceId: "service-device",
      credentialPath: resolve(devicePeerAuthKey),
      stateDirectory: resolve(dataDirectory, "device-peer-agent")
    });
    expect(loadConfig({ ...authority, JOKO_DEVICE_PEER_TRANSPORT_KIND: "webrtc" }).devicePeerAgent).toMatchObject({ transportKind: "webrtc" });
    const transportFile = join(dataDirectory, "service-private-transport.json");
    for (const transportKind of ["iroh", "tailcat", "http-connect"]) {
      expect(loadConfig({ ...authority, JOKO_DEVICE_PEER_TRANSPORT_KIND: transportKind, JOKO_DEVICE_PEER_TRANSPORT_FILE: transportFile }).devicePeerAgent)
        .toMatchObject({ transportKind, transportPath: transportFile });
      expect(() => loadConfig({ ...authority, JOKO_DEVICE_PEER_TRANSPORT_KIND: transportKind })).toThrow(/private transport file/u);
    }
    for (const transportKind of [undefined, "https", "webrtc", "unrecognized"]) {
      expect(() => loadConfig({ ...authority, JOKO_DEVICE_PEER_TRANSPORT_KIND: transportKind, JOKO_DEVICE_PEER_TRANSPORT_FILE: transportFile })).toThrow(/private transport file/u);
    }
    expect(() => loadConfig({ ...authority, JOKO_DEVICE_PEER_TRANSPORT_KIND: "tailcat", JOKO_DEVICE_PEER_TRANSPORT_FILE: join(workspaceRoot, "private-transport.json") })).toThrow(/source\/workspace|workspace\/source/u);
    expect(() => loadConfig({ ...authority, JOKO_DEVICE_PEER_CONTROLLER_ORIGIN: "http://127.0.0.1:4318", JOKO_DEVICE_PEER_TRANSPORT_KIND: "webrtc", JOKO_DEVICE_PEER_ENDPOINT_PUBLIC_KEY: undefined })).toThrow(/trusted deployment channel/u);
    expect(() => loadConfig({ ...authority, JOKO_DEVICE_PEER_TRANSPORT_KIND: "http-connect", JOKO_DEVICE_PEER_TRANSPORT_FILE: transportFile, JOKO_DEVICE_PEER_ENDPOINT_PUBLIC_KEY: undefined })).toThrow(/trusted deployment channel/u);
    expect(() => loadConfig({ ...authority, JOKO_DEVICE_PEER_ENDPOINT_PUBLIC_KEY: undefined }))
      .toThrow(/trusted deployment channel/u);
    expect(loadConfig({ ...authority, JOKO_ALLOW_INSECURE_LAN: "1",
      JOKO_DEVICE_PEER_CONTROLLER_ORIGIN: "http://192.168.1.40:4318", JOKO_DEVICE_PEER_ENDPOINT_PUBLIC_KEY: undefined }).devicePeerAgent)
      .toMatchObject({ controllerOrigin: "http://192.168.1.40:4318" });
    expect(() => loadConfig({
      ...base,
      JOKO_DEVICE_PEER_CONTROLLER_ORIGIN: "https://controller.example.test"
    })).toThrow(/must be configured together/u);
    expect(() => loadConfig({
      ...base,
      JOKO_DEVICE_PEER_CONTROLLER_ORIGIN: "http://192.168.1.40:4318",
      JOKO_DEVICE_PEER_CONTROLLER_SERVER_ID: "controller-server",
      JOKO_DEVICE_PEER_CONNECTION_ID: "service-connection",
      JOKO_DEVICE_PEER_DEVICE_ID: "service-device",
      JOKO_DEVICE_PEER_AUTH_KEY_FILE: devicePeerAuthKey
    })).toThrow(/JOKO_ALLOW_INSECURE_LAN/u);

    const missingCredentialPath = join(fixtureRoot, "must-not-appear-in-error", "auth-key");
    let missingCredentialError: unknown;
    try {
      loadConfig({
        ...base,
        JOKO_DEVICE_PEER_CONTROLLER_ORIGIN: "https://controller.example.test",
        JOKO_DEVICE_PEER_CONTROLLER_SERVER_ID: "controller-server",
        JOKO_DEVICE_PEER_CONNECTION_ID: "service-connection",
        JOKO_DEVICE_PEER_DEVICE_ID: "service-device",
        JOKO_DEVICE_PEER_AUTH_KEY_FILE: missingCredentialPath
      });
    } catch (error) {
      missingCredentialError = error;
    }
    expect(missingCredentialError).toEqual(new Error(
      "JOKO_DEVICE_PEER_AUTH_KEY_FILE is unavailable or unsafe."
    ));
    expect(String(missingCredentialError)).not.toContain(missingCredentialPath);

    if (process.platform !== "win32") {
      const publicCredential = join(fixtureRoot, "public-device-peer-auth-key");
      writeFileSync(publicCredential, `${"B".repeat(43)}\n`, { flag: "wx", mode: 0o644 });
      chmodSync(publicCredential, 0o644);
      expect(() => loadConfig({
        ...base,
        JOKO_DEVICE_PEER_CONTROLLER_ORIGIN: "https://controller.example.test",
        JOKO_DEVICE_PEER_CONTROLLER_SERVER_ID: "controller-server",
        JOKO_DEVICE_PEER_CONNECTION_ID: "service-connection",
        JOKO_DEVICE_PEER_DEVICE_ID: "service-device",
        JOKO_DEVICE_PEER_AUTH_KEY_FILE: publicCredential
      })).toThrow("JOKO_DEVICE_PEER_AUTH_KEY_FILE is unavailable or unsafe.");
    }
  });

  it("canonicalizes a default-scheme port without rejecting its own origin", () => {
    expect(loadConfig({ ...base, JOKO_PORT: "80", JOKO_INTERNAL_PORT: "81" }).publicOrigin)
      .toBe("http://127.0.0.1");
  });

  it("defaults to an absolute OS user-data directory outside the workspace and source tree", () => {
    const config = loadConfig({ ...base, JOKO_DATA_DIR: undefined });
    expect(isAbsolute(config.dataDirectory)).toBe(true);
    expect(isContainedBy(workspaceRoot, config.dataDirectory)).toBe(false);
    expect(isContainedBy(sourceRoot, config.dataDirectory)).toBe(false);
  });

  it("rejects a normalized data directory inside the configured workspace", () => {
    expect(() => loadConfig({
      ...base,
      JOKO_DATA_DIR: join(workspaceRoot, "nested", "..", ".joko-data")
    })).toThrow(/outside the configured workspace/u);
  });

  it("rejects a linked data directory that resolves inside the configured workspace", () => {
    const linkedWorkspace = join(fixtureRoot, "linked-workspace");
    symlinkSync(workspaceRoot, linkedWorkspace, process.platform === "win32" ? "junction" : "dir");
    expect(() => loadConfig({
      ...base,
      JOKO_DATA_DIR: join(linkedWorkspace, ".joko-data")
    })).toThrow(/outside the configured workspace/u);
  });

  it("rejects a data directory inside the Joko source tree even when serving another workspace", () => {
    expect(() => loadConfig({
      ...base,
      JOKO_DATA_DIR: resolve(sourceRoot, ".runtime", "unsafe-orchestrator-data")
    })).toThrow(/outside the Joko source tree/u);
  });
});

function isContainedBy(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child));
}
