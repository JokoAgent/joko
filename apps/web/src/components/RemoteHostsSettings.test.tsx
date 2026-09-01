import { describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { CredentialDraft, RemoteHostDraft, RemoteHostView } from "../model.js";
import { saveRemoteHostDraft } from "./RemoteHostsSettings.js";

describe("Remote Host settings", () => {
  it("uploads a private key only through the credential channel and projects only its reference", async () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nraw-secret-material\n-----END PRIVATE KEY-----";
    const savedHost = host();
    const saveCredential = vi.fn(async (_draft: CredentialDraft): Promise<void> => undefined);
    const createRemoteHost = vi.fn(async (_targetId: string, _draft: RemoteHostDraft): Promise<RemoteHostView> => savedHost);
    const updateRemoteHost = vi.fn(async (
      _targetId: string,
      _hostId: string,
      _expectedRevision: bigint,
      _draft: RemoteHostDraft
    ): Promise<RemoteHostView> => savedHost);
    const controller = { saveCredential, createRemoteHost, updateRemoteHost } satisfies Pick<
      AppController,
      "saveCredential" | "createRemoteHost" | "updateRemoteHost"
    >;

    await expect(saveRemoteHostDraft({
      controller,
      targetId: "target-one",
      draft: {
        id: "build-box",
        hostname: "build.internal",
        port: 22,
        user: "joko",
        authentication: "privateKey"
      },
      privateKey: secret
    })).resolves.toBe(savedHost);

    expect(saveCredential).toHaveBeenCalledOnce();
    expect(saveCredential.mock.calls[0]![0]).toMatchObject({ kind: "sshPrivateKey", secret });
    expect(createRemoteHost).toHaveBeenCalledOnce();
    const durableDraft = createRemoteHost.mock.calls[0]![1];
    expect(durableDraft.credentialReferenceId).toMatch(/^ssh-key-/u);
    expect(JSON.stringify(createRemoteHost.mock.calls)).not.toContain(secret);
    expect(updateRemoteHost).not.toHaveBeenCalled();
  });

  it("removes stale private-key references when switching to the system agent", async () => {
    const savedHost = host();
    const saveCredential = vi.fn(async (_draft: CredentialDraft): Promise<void> => undefined);
    const createRemoteHost = vi.fn(async (_targetId: string, _draft: RemoteHostDraft): Promise<RemoteHostView> => savedHost);
    const controller = {
      saveCredential,
      createRemoteHost,
      updateRemoteHost: vi.fn(async (
        _targetId: string,
        _hostId: string,
        _expectedRevision: bigint,
        _draft: RemoteHostDraft
      ): Promise<RemoteHostView> => savedHost)
    } satisfies Pick<AppController, "saveCredential" | "createRemoteHost" | "updateRemoteHost">;

    await saveRemoteHostDraft({
      controller,
      targetId: "target-one",
      draft: {
        id: "build-box",
        hostname: "build.internal",
        port: 22,
        user: "joko",
        authentication: "systemAgent",
        credentialReferenceId: "stale-key"
      },
      privateKey: ""
    });

    expect(saveCredential).not.toHaveBeenCalled();
    expect(createRemoteHost.mock.calls[0]![1].credentialReferenceId).toBeUndefined();
  });
});

function host(): RemoteHostView {
  return {
    targetId: "target-one",
    id: "build-box",
    hostname: "build.internal",
    port: 22,
    user: "joko",
    source: "manual",
    authentication: "privateKey",
    credentialReferenceId: "ssh-key-reference",
    status: { state: "disconnected", changedAt: 1 },
    revision: 1n
  };
}
