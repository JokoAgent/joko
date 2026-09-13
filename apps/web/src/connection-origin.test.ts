import { describe, expect, it } from "vitest";
import { isInsecureLanOrigin, isLocalOrPrivateHostname, normalizeOrchestratorOrigin } from "./connection-origin.js";

describe("Orchestrator connection origins", () => {
  it.each([
    ["http://127.0.0.1:4318", "http://127.0.0.1:4318"],
    ["http://127.42.0.1:4318/", "http://127.42.0.1:4318"],
    ["http://10.20.30.40:4318", "http://10.20.30.40:4318"],
    ["http://172.31.2.4:4318", "http://172.31.2.4:4318"],
    ["http://192.168.50.4:4318", "http://192.168.50.4:4318"],
    ["http://[fd00::42]:4318", "http://[fd00::42]:4318"],
    ["http://orchestrator.local:4318", "http://orchestrator.local:4318"],
    ["http://orchestrator.home.arpa:4318", "http://orchestrator.home.arpa:4318"],
    ["http://orchestrator-box:4318", "http://orchestrator-box:4318"],
    ["https://orchestrator.example.com", "https://orchestrator.example.com"]
  ])("accepts trusted origin %s", (input, expected) => expect(normalizeOrchestratorOrigin(input)).toBe(expected));

  it.each([
    "http://example.com:4318",
    "http://8.8.8.8:4318",
    "http://172.32.0.1:4318",
    "http://192.169.0.1:4318",
    "http://100.64.1.2:4318",
    "http://169.254.169.254",
    "http://[fe80::42]:4318",
    "http://0.0.0.0:4318",
    "http://[::]:4318",
    "ftp://192.168.1.2",
    "https://user:secret@orchestrator.example.com",
    "https://orchestrator.example.com/api",
    "https://orchestrator.example.com?token=secret",
    "not a URL"
  ])("rejects unsafe origin %s", (input) => expect(() => normalizeOrchestratorOrigin(input)).toThrow());

  it("distinguishes unencrypted LAN from loopback development", () => {
    expect(isInsecureLanOrigin("http://192.168.1.5:4318")).toBe(true);
    expect(isInsecureLanOrigin("http://localhost:4318")).toBe(false);
    expect(isInsecureLanOrigin("https://192.168.1.5:4318")).toBe(false);
  });

  it("recognizes private IPv4-mapped IPv6 and rejects public ranges", () => {
    expect(isLocalOrPrivateHostname("::ffff:a00:1")).toBe(true);
    expect(isLocalOrPrivateHostname("2001:4860:4860::8888")).toBe(false);
  });
});
