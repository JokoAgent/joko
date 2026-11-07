import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { EXTENSION_SECRET_CHECK_FAILED, ExtensionAuthorizationPhase, ExtensionNetworkService, ExtensionOAuthService, ExtensionService, type ExtensionSettingsHost } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { executeExtensionSettingsCall, ExtensionSettingsRejected, type ExtensionSettingsClient, type ExtensionSettingsProjection } from "./extension-settings-client.js";

const extension: ExtensionSettingsProjection = { extensionId: "installed", revision: 3n, name: "Plugin", permissions: [],
  setup: { state: "required", fields: [{ fieldId: "permission", label: "Workspace", description: "Read selected files", kind: "confirmation", configured: false }] } };
function fixture(overrides: Partial<ExtensionSettingsClient<ExtensionSettingsProjection>> = {}) {
  let live = true;
  const transport = createRouterTransport(router => router.service(ExtensionService, {}));
  const client: ExtensionSettingsClient<ExtensionSettingsProjection> = {
    surface: { surfaceId: "original-surface" }, api: createClient(ExtensionService, transport), current: () => { if (!live) throw new Error("Owner changed"); },
    fresh: vi.fn(async () => extension), upload: vi.fn(async () => "uploaded-ticket"), submit: vi.fn(async () => undefined),
    begin: vi.fn(async () => ({ extension })), field: vi.fn(async () => ({ extension })), secret: vi.fn(async () => ({ extension })),
    complete: vi.fn(async () => ({ extension })), ...overrides
  };
  const host: ExtensionSettingsHost = { confirm: vi.fn(async () => true), authorize: vi.fn(async () => ({ state: "state", code: "code" })), openLibrary: vi.fn(async () => undefined) };
  return { client, host, retire: () => { live = false; } };
}

describe("author settings shared client", () => {
  it("rejects a declined connection before opening a credential ticket and still reads connections", async () => {
    const beginCredential = vi.fn(), commitCredential = vi.fn();
    const get = vi.fn(() => ({ state: { extensionId: "installed", slots: [] } }));
    const transport = createRouterTransport(router => router.service(ExtensionNetworkService, { beginCredential, commitCredential, get }));
    const f = fixture({ connections: createClient(ExtensionNetworkService, transport) });
    vi.mocked(f.host.confirm).mockResolvedValue(false);
    const signal = new AbortController().signal;

    await expect(executeExtensionSettingsCall(f.client, { kind: "connections.set", key: "api", host: "api.example.com", value: "candidate" }, f.host, signal))
      .rejects.toBeInstanceOf(ExtensionSettingsRejected);
    expect(beginCredential).not.toHaveBeenCalled(); expect(f.client.upload).not.toHaveBeenCalled(); expect(commitCredential).not.toHaveBeenCalled();
    await expect(executeExtensionSettingsCall(f.client, { kind: "connections.get" }, f.host, signal)).resolves.toMatchObject({ extensionId: "installed" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("keeps directory paths in the native host and submits exactly its original typed choice", async () => {
    const expiresAt = { seconds: BigInt(Math.floor(Date.now() / 1000) + 110), nanos: 0 };
    const picker = { pickerId: "original-picker", extensionId: "installed", expiresAt };
    const directory = { entryId: "selected-directory", name: "Reports", displayPath: "/private/reports", parentEntryId: "parent" };
    const close = vi.fn((_request: unknown) => ({ closed: true })), browse = vi.fn((_request: unknown) => ({ page: { picker, directory, entries: [], nextPageToken: "" } }));
    const transport = createRouterTransport(router => router.service(ExtensionService, {
      openExtensionDirectoryPicker: () => ({ page: { picker, entries: [directory], nextPageToken: "" } }),
      browseExtensionDirectoryPicker: browse, closeExtensionDirectoryPicker: close
    }));
    const pickDirectory = vi.fn<NonNullable<ExtensionSettingsClient<ExtensionSettingsProjection>["pickDirectory"]>>(async () => ({
      $typeName: "joko.v1.ExtensionPickedDirectoryDeposit", token: "deposit", fileCount: 1, totalBytes: 4n, relativePaths: ["report.txt"],
      expiresAt: { $typeName: "google.protobuf.Timestamp", seconds: BigInt(Math.floor(Date.now() / 1000) + 599), nanos: 0 }
    }));
    const f = fixture({ api: createClient(ExtensionService, transport), pickDirectory });
    f.host.chooseDirectory = vi.fn(async (choice) => {
      expect(choice.initialPage.entries[0]?.displayPath).toBe("/private/reports");
      const page = await choice.browse({ entryId: "selected-directory" }); return page.directory!.entryId;
    });
    const result = await executeExtensionSettingsCall(f.client, { kind: "directory.pick", title: "Read reports" }, f.host, new AbortController().signal);
    expect(result).toMatchObject({ name: "Reports", dir_deposit: { token: "deposit", file_count: 1, rel_paths: ["report.txt"] } });
    expect(JSON.stringify(result)).not.toContain("/private"); expect(pickDirectory).toHaveBeenCalledOnce();
    expect(pickDirectory.mock.calls[0]?.[1]).toMatchObject({ payload: { case: "pickExtensionDirectory", value: { pickerId: "original-picker", entryId: "selected-directory", expectedRevision: { value: 3n } } } });
    expect(browse.mock.calls[0]?.[0]).toMatchObject({ pickerId: "original-picker", entryId: "selected-directory" });
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(expect.objectContaining({ pickerId: "original-picker" }), expect.anything()));
  });

  it.each(["cancel", "retire", "unknown"])("does not choose again when the original directory request is %s", async reason => {
    const picker = { pickerId: "original-picker", extensionId: "installed", expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 110), nanos: 0 } };
    const close = vi.fn((_request: unknown) => ({ closed: true }));
    const transport = createRouterTransport(router => router.service(ExtensionService, {
      openExtensionDirectoryPicker: () => ({ page: { picker, entries: [], nextPageToken: "" } }), closeExtensionDirectoryPicker: close
    }));
    const pickDirectory = vi.fn<NonNullable<ExtensionSettingsClient<ExtensionSettingsProjection>["pickDirectory"]>>(async () => { throw new Error("Original operation unknown"); });
    const f = fixture({ api: createClient(ExtensionService, transport), pickDirectory });
    f.host.chooseDirectory = vi.fn(async () => { if (reason === "retire") f.retire(); return reason === "cancel" ? undefined : "chosen"; });
    const request = executeExtensionSettingsCall(f.client, { kind: "directory.pick" }, f.host, new AbortController().signal);
    if (reason === "cancel") await expect(request).resolves.toEqual({ cancelled: true }); else await expect(request).rejects.toThrow();
    expect(pickDirectory).toHaveBeenCalledTimes(reason === "unknown" ? 1 : 0); expect(f.host.chooseDirectory).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });

  it.each(["retired", "aborted"])("rechecks the original owner after async permission consent: %s", async reason => {
    let accept!: (accepted: boolean) => void;
    const f = fixture(), abort = new AbortController();
    f.host.confirm = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
    const saving = executeExtensionSettingsCall(f.client, { kind: "setup.field", fieldId: "permission", value: true }, f.host, abort.signal);
    await vi.waitFor(() => expect(f.host.confirm).toHaveBeenCalledOnce());
    if (reason === "retired") f.retire(); else abort.abort();
    accept(true); await expect(saving).rejects.toThrow();
    expect(f.client.begin).not.toHaveBeenCalled(); expect(f.client.field).not.toHaveBeenCalled(); expect(f.client.submit).not.toHaveBeenCalled();
  });

  it("records newly confirmed permissions on the active attempt even when an old authorization projects them as configured", async () => {
    const replacing: ExtensionSettingsProjection = { ...extension, setup: { state: "inProgress",
      fields: extension.setup.fields.map(field => ({ ...field, configured: true })) } };
    const confirmed = { ...replacing, revision: replacing.revision + 1n };
    const field = vi.fn<ExtensionSettingsClient<ExtensionSettingsProjection>["field"]>(async () => ({ extension: confirmed }));
    const complete = vi.fn<ExtensionSettingsClient<ExtensionSettingsProjection>["complete"]>(async current => {
      if (current !== confirmed) throw new Error("The current attempt is missing its confirmation.");
      return { extension: { ...current, setup: { ...current.setup, state: "ready" } } };
    });
    const f = fixture({ fresh: async () => replacing, field, complete });
    const signal = new AbortController().signal;
    await expect(executeExtensionSettingsCall(f.client, { kind: "setup.complete" }, f.host, signal)).resolves.toMatchObject({ state: "ready" });
    expect(f.client.begin).not.toHaveBeenCalled();
    expect(field).toHaveBeenCalledExactlyOnceWith(replacing, "permission", true, signal);
    expect(complete).toHaveBeenCalledExactlyOnceWith(confirmed, signal);
  });

  it("uploads a secret candidate only through its private ticket and returns a validation marker", async () => {
    const begin = vi.fn((_request: unknown) => ({ ticket: { ticketId: "candidate", relativeEndpoint: "/private-upload", maximumBytes: 8192n } }));
    const check = vi.fn((_request: unknown) => ({ valid: true }));
    const transport = createRouterTransport(router => router.service(ExtensionService, { beginExtensionSecretCheck: begin, checkExtensionSecret: check }));
    const f = fixture({ api: createClient(ExtensionService, transport) });
    const result = await executeExtensionSettingsCall(f.client, { kind: "secret.check", key: "token", value: "private-candidate" }, f.host, new AbortController().signal);
    expect(result).toEqual({ valid: true }); expect(f.client.upload).toHaveBeenCalledWith(expect.objectContaining({ ticketId: "candidate" }), "private-candidate", expect.any(AbortSignal));
    expect(check.mock.calls[0]?.[0]).toMatchObject({ surfaceId: "original-surface", secretKey: "token", credentialUploadTicketId: "uploaded-ticket" });
    const publicRequests = [...begin.mock.calls, ...check.mock.calls].map(([request]) => request);
    expect(JSON.stringify(publicRequests)).not.toContain("private-candidate");
    expect(f.client.secret).not.toHaveBeenCalled(); expect(f.client.submit).not.toHaveBeenCalled();
  });

  it("reports the known candidate check failure without submitting or looking up an operation", async () => {
    const check = vi.fn(() => { throw new ConnectError(EXTENSION_SECRET_CHECK_FAILED, Code.FailedPrecondition); });
    const transport = createRouterTransport(router => router.service(ExtensionService, {
      beginExtensionSecretCheck: () => ({ ticket: { ticketId: "candidate", relativeEndpoint: "/private-upload", maximumBytes: 8192n } }),
      checkExtensionSecret: check
    }));
    const f = fixture({ api: createClient(ExtensionService, transport) });
    const result = executeExtensionSettingsCall(f.client, { kind: "secret.check", key: "token", value: "fixture-candidate" }, f.host, new AbortController().signal);
    await expect(result).rejects.toBeInstanceOf(ExtensionSettingsRejected);
    await expect(result).rejects.toThrow(EXTENSION_SECRET_CHECK_FAILED);
    expect(f.client.upload).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledOnce();
    expect(f.client.submit).not.toHaveBeenCalled();
  });

  it("keeps an unknown original routing operation and does not resubmit or report success", async () => {
    const submit = vi.fn<ExtensionSettingsClient<ExtensionSettingsProjection>["submit"]>(async () => { throw new Error("Original operation outcome is unknown"); });
    const f = fixture({ submit });
    await expect(executeExtensionSettingsCall(f.client, { kind: "routing.set", revision: "4", dataJson: '{"route":"selected"}' }, f.host, new AbortController().signal)).rejects.toThrow("unknown");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]?.[1]).toMatchObject({ payload: { case: "setExtensionSettingsRoutingData", value: {
      extensionId: "installed", surfaceId: "original-surface", expectedRoutingRevision: "4", expectedRevision: { value: 3n }
    } } });
  });

  it.each(["flow", "expiry"])("rejects a substituted OAuth %s and cancels only the original flow", async change => {
    const expiresAt = { seconds: BigInt(Math.floor(Date.now() / 1000) + 120), nanos: 0 };
    const flow = { flowId: "original", extensionId: "installed", slotKey: "account", phase: ExtensionAuthorizationPhase.AUTHORIZING, expiresAt,
      authorization: { authorizeUrl: "https://accounts.example/authorize", callbackUrl: "https://callback.example", state: "state" } };
    const cancelFlow = vi.fn((_request: unknown) => ({})), beginCallback = vi.fn((_request: unknown) => ({ ticket: { ticketId: "callback", relativeEndpoint: "/private", maximumBytes: 8192n } }));
    const transport = createRouterTransport(router => router.service(ExtensionOAuthService, {
      start: () => ({ flow }), beginCallback,
      completeCallback: () => ({ flow: { ...flow, phase: ExtensionAuthorizationPhase.COMPLETE,
        ...(change === "flow" ? { flowId: "foreign" } : { expiresAt: { ...expiresAt, seconds: expiresAt.seconds + 1n } }) } }), cancelFlow
    }));
    const f = fixture({ oauth: createClient(ExtensionOAuthService, transport) });
    await expect(executeExtensionSettingsCall(f.client, { kind: "oauth.connect", key: "account" }, f.host, new AbortController().signal)).rejects.toThrow("owner changed");
    await vi.waitFor(() => expect(cancelFlow).toHaveBeenCalledOnce());
    expect(cancelFlow.mock.calls[0]?.[0]).toMatchObject({ flowId: "original" });
    expect(beginCallback.mock.calls[0]?.[0]).toMatchObject({ flowId: "original" });
  });
});
