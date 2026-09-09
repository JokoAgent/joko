import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileSshConfigPort,
  parseSshConfig,
  serializeSshConfig
} from "./config.js";
import { RemoteSshError } from "./errors.js";
import type { RemoteSshConfigHost } from "./types.js";

const temporaryDirectories: string[] = [];
const scope = Object.freeze({ ownerId: "owner-a", targetId: "target-a" });

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("SSH config document", () => {
  it("round-trips comments, whitespace, unknown directives, and CRLF exactly", () => {
    const source = [
      "# global",
      "Host alpha",
      "\tHostName host.example",
      "  User deploy",
      "  ProxyJump bastion",
      "  ServerAliveInterval = 15",
      "",
      "Match all",
      "  Compression yes",
      ""
    ].join("\r\n");
    expect(serializeSshConfig(parseSshConfig(source))).toBe(source);
    const unicodeSeparator = "# preserved\u2028content\nHost alpha\n  User deploy";
    expect(serializeSshConfig(parseSshConfig(unicodeSeparator))).toBe(unicodeSeparator);
  });

  it("imports every concrete alias while skipping wildcard and negated patterns", () => {
    const document = parseSshConfig([
      "Host one two *.internal !blocked",
      "  HostName shared.example",
      "  PORT 2201",
      "Host ?ingle !never",
      "  User ignored",
      "Host fallback",
      ""
    ].join("\n"));
    expect(document.concreteHosts({ ...scope, defaultUser: "local-user" })).toEqual([
      {
        ...scope,
        id: "one",
        hostname: "shared.example",
        port: 2201,
        user: "local-user",
        source: "ssh_config"
      },
      {
        ...scope,
        id: "two",
        hostname: "shared.example",
        port: 2201,
        user: "local-user",
        source: "ssh_config"
      },
      {
        ...scope,
        id: "fallback",
        hostname: "fallback",
        port: 22,
        user: "local-user",
        source: "ssh_config"
      }
    ]);
  });

  it("resolves global and wildcard first values, negation, quoted values, and duplicate aliases", () => {
    const document = parseSshConfig('User global\nHost *.internal !private.internal\n  Port 2222\nHost build.internal\n  HostName "build.example"\n  User overridden\nHost private.internal\n  Port 2200\nHost build.internal\n  Port 23\n');
    expect(document.concreteHosts({ ...scope, defaultUser: "local" }).map(({ id, hostname, user, port }) => ({ id, hostname, user, port }))).toEqual([
      { id: "build.internal", hostname: "build.example", user: "global", port: 2222 },
      { id: "private.internal", hostname: "private.internal", user: "global", port: 2200 }
    ]);
  });

  it.each([
    "ProxyJump bastion", "ProxyCommand ssh -W %h:%p bastion", "IdentityFile ~/.ssh/private",
    "IdentitiesOnly yes", "IdentityAgent another-agent", "CanonicalizeHostname yes", "HostKeyAlias different-host",
    "Port invalid", "HostName %h.example", "Include other.conf", "Match all",
    "ProxyCommand no", "IdentityFile none\n IdentityFile ~/.ssh/required", "HostKeyAlias none"
  ])("rejects unsupported routing or invalid connection semantics: %s", (directive) => {
    const document = parseSshConfig(`Host alpha\n  ${directive}\n`);
    expect(() => document.concreteHosts({ ...scope, defaultUser: "local" })).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID", retryable: false }));
  });

  it("does not let an unrelated host's proxy block a directly connectable alias", () => {
    const document = parseSshConfig("Host *.private\n ProxyJump bastion\nHost public\n HostName example.test\n");
    expect(document.concreteHosts({ ...scope, defaultUser: "local" })).toEqual([expect.objectContaining({ id: "public", hostname: "example.test" })]);
  });

  it("rejects malformed Host patterns instead of partially importing them", () => {
    expect(() => parseSshConfig('Host "unterminated\n  User deploy\n')).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID", retryable: false })
    );
  });

  it("updates owned directives and preserves unknown lines in place", () => {
    const source = [
      "Host alpha",
      "  HostName old.example # retained line comment",
      "  User old-user",
      "  Port 2022",
      "  ProxyJump bastion",
      "  IdentityFile ~/.ssh/example_identity",
      "  # custom note",
      ""
    ].join("\n");
    const output = parseSshConfig(source).withHost(host({
      id: "alpha",
      hostname: "new.example",
      user: "new-user",
      port: 22
    })).toString();
    expect(output).toContain("HostName new.example # retained line comment");
    expect(output).toContain("User new-user");
    expect(output).not.toMatch(/^\s*Port\s/mu);
    expect(output).toContain("  ProxyJump bastion\n");
    expect(output).toContain("  IdentityFile ~/.ssh/example_identity\n");
    expect(output).toContain("  # custom note\n");
  });

  it("separates appended owned directives from a final unknown line without a newline", () => {
    const output = parseSshConfig("Host alpha\n  ProxyJump bastion").withHost(host({
      id: "alpha",
      hostname: "alpha.example",
      user: "deploy",
      port: 22
    })).toString();
    expect(output).toBe([
      "Host alpha",
      "  ProxyJump bastion",
      "  HostName alpha.example",
      "  User deploy",
      ""
    ].join("\n"));
  });

  it("splits a concrete alias from a shared block without changing the remaining directives", () => {
    const output = parseSshConfig([
      "Host alpha beta *.example",
      "  HostName shared.example",
      "  ProxyJump bastion",
      ""
    ].join("\n")).withHost(host({
      id: "alpha",
      hostname: "alpha.example",
      user: "deploy",
      port: 2222
    })).toString();
    expect(output).toContain("Host beta *.example\n  HostName shared.example\n  ProxyJump bastion\n");
    expect(output).toContain("Host alpha\n  HostName alpha.example\n  User deploy\n  Port 2222\n");
  });

  it("removes only the selected alias and preserves the rest of a shared block", () => {
    const output = parseSshConfig([
      "Host alpha beta",
      "  ProxyCommand helper --safe",
      "Host gamma",
      "  HostName gamma.example",
      ""
    ].join("\n")).withoutHost("alpha").toString();
    expect(output).toContain("Host beta\n  ProxyCommand helper --safe\n");
    expect(output).toContain("Host gamma\n  HostName gamma.example\n");
    expect(output).not.toContain("Host alpha");
  });
});

describe("file SSH config port", () => {
  it("creates an atomic private config and imports it with the requested owner scope", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, ".ssh", "config");
    const port = new FileSshConfigPort({ filePath });
    await port.upsert(host({ id: "alpha", hostname: "alpha.example", user: "deploy", port: 2200 }));
    const imported = await port.importHosts({ ...scope, defaultUser: "fallback" });
    expect(imported).toEqual([{
      ...scope,
      id: "alpha",
      hostname: "alpha.example",
      port: 2200,
      user: "deploy",
      source: "ssh_config"
    }]);
    expect(await fs.readdir(join(root, ".ssh"))).toEqual(["config"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(join(root, ".ssh"))).mode & 0o777).toBe(0o700);
    }
  });

  it("serializes concurrent in-process mutations without losing either host", async () => {
    const root = await temporaryDirectory();
    const port = new FileSshConfigPort({ filePath: join(root, ".ssh", "config") });
    await Promise.all([
      port.upsert(host({ id: "alpha", hostname: "alpha.example" })),
      port.upsert(host({ id: "beta", hostname: "beta.example" }))
    ]);
    expect((await port.importHosts({ ...scope, defaultUser: "fallback" })).map((entry) => entry.id)).toEqual([
      "alpha",
      "beta"
    ]);
  });

  it("fails closed when the config target is not a regular file", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, ".ssh", "config");
    await fs.mkdir(filePath, { recursive: true });
    const port = new FileSshConfigPort({ filePath });
    await expect(port.upsert(host({ id: "alpha", hostname: "alpha.example" }))).rejects.toEqual(
      expect.objectContaining<Partial<RemoteSshError>>({ code: "CONFIG_IO", retryable: false })
    );
  });
});

function host(overrides: Partial<RemoteSshConfigHost> = {}): RemoteSshConfigHost {
  return {
    ...scope,
    id: "alpha",
    hostname: "alpha.example",
    port: 22,
    user: "deploy",
    source: "manual",
    ...overrides
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), "joko-remote-ssh-config-"));
  temporaryDirectories.push(path);
  return path;
}
