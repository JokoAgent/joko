import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuthorizationError, OperationalStore } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("private Artifact source authority", () => {
  it("binds the first local source proof and never replaces it during deduplication", () => {
    const fixture = createFixture();
    const input = {
      artifactId: "artifact",
      sessionId: "session",
      targetId: "target",
      generation: 3,
      authorityHash: `sha256:${"a".repeat(64)}`,
      workspaceRoot: fixture.workspaceRoot,
      relativePath: "outputs/first.png"
    } as const;

    const first = fixture.store.putArtifactSource(input);
    const repeated = fixture.store.putArtifactSource({
      ...input,
      authorityHash: `sha256:${"b".repeat(64)}`,
      relativePath: "outputs/second.png"
    });

    expect(repeated).toEqual(first);
    expect(fixture.store.hasArtifactSource("artifact")).toBe(true);
    expect(fixture.store.getArtifactSource("artifact")).toMatchObject({
      authorityHash: input.authorityHash,
      relativePath: input.relativePath
    });
  });

  it("rejects authority that does not belong to the current local Session", () => {
    const fixture = createFixture();
    const base = {
      artifactId: "artifact",
      sessionId: "session",
      targetId: "target",
      authorityHash: `sha256:${"a".repeat(64)}`,
      workspaceRoot: fixture.workspaceRoot,
      relativePath: "output.txt"
    } as const;
    expect(() => fixture.store.putArtifactSource({ ...base, generation: 2 })).toThrow(/active Session/u);
    expect(() => fixture.store.putArtifactSource({ ...base, generation: 3, relativePath: "../output.txt" }))
      .toThrow(/relative path/u);
  });
});

describe("private Desktop host authorization", () => {
  it("binds an exact active Desktop connection without exposing a raw key", () => {
    const fixture = createFixture();
    fixture.store.createConnection({
      id: "desktop-connection",
      deviceId: "desktop-device",
      device: { name: "Desktop", kind: "desktop", platform: "win32", appVersion: "1" },
      name: "Desktop local instance",
      authKeyDigest: "c".repeat(64)
    });
    const authorization = fixture.store.putDesktopHostAuthorization({
      connectionId: "desktop-connection",
      authKeyDigest: "d".repeat(64)
    });
    expect(authorization).toMatchObject({
      connectionId: "desktop-connection",
      authKeyDigest: "d".repeat(64)
    });
    expect(fixture.store.putDesktopHostAuthorization({
      connectionId: "desktop-connection",
      authKeyDigest: "d".repeat(64)
    })).toEqual(authorization);
    expect(() => fixture.store.putDesktopHostAuthorization({
      connectionId: "desktop-connection",
      authKeyDigest: "e".repeat(64)
    })).toThrow(/different authority/u);
  });

  it("refuses non-Desktop and revoked connection authority", () => {
    const fixture = createFixture();
    fixture.store.createConnection({
      id: "web-connection",
      deviceId: "web-device",
      device: { name: "Web", kind: "web", platform: "browser", appVersion: "1" },
      name: "Web",
      authKeyDigest: "c".repeat(64)
    });
    expect(() => fixture.store.putDesktopHostAuthorization({
      connectionId: "web-connection",
      authKeyDigest: "d".repeat(64)
    })).toThrow(AuthorizationError);
  });
});

function createFixture(): { readonly store: OperationalStore; readonly workspaceRoot: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "joko-artifact-source-store-"));
  const workspaceRoot = path.join(directory, "workspace");
  const store = new OperationalStore(path.join(directory, "operational.sqlite"), { now: () => 10 });
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.upsertBackend({
    id: "backend", displayName: "Backend", version: "1", health: "healthy", adapterKind: "fixture",
    instanceGeneration: 0, installationState: "installed", authenticationState: "not_required",
    capabilities: new Map(), models: [], tools: [], diagnostics: []
  });
  store.upsertTarget({
    id: "target", backendId: "backend", displayName: "Workspace", workspaceRoot,
    managed: false, trusted: true
  });
  store.createSession({
    id: "session", backendId: "backend", targetId: "target", title: "Session",
    binding: { opaqueRef: "native/session", generation: 3 }, pinned: false, archived: false,
    permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1
  });
  store.putArtifact({
    id: "artifact", sha256: "1".repeat(64), byteLength: 1, mimeType: "image/png",
    fileName: "output.png", storageKey: "sha256/11", sessionId: "session"
  });
  return { store, workspaceRoot };
}
