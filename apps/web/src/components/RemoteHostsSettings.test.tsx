// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";

import type { AppController } from "../controller.js";
import { emptySnapshot, type AppSnapshot, type CredentialDraft, type RemoteHostDraft, type RemoteHostView, type SshKeyView } from "../model.js";
import { translate } from "../i18n.js";
import { RemoteHostsSettings, saveRemoteHostDraft } from "./RemoteHostsSettings.js";

const roots: Root[] = [];
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("uses one authoritative catalog stream and keeps an edited root through snapshots and late import ACKs", async () => {
  const fixture = await mountSettings();
  const ready = { ...host(), trust: { algorithm: "ssh-ed25519", sha256Fingerprint: "SHA256:test", pinnedAt: 1 }, status: { state: "ready" as const, changedAt: 2 } };
  await fixture.publish([ready]);
  const root = input("Remote workspace path");
  await change(root, "/home/joko/unsaved");
  await fixture.render({ ...fixture.controller });
  expect(fixture.controller.watchRemoteHosts).toHaveBeenCalledTimes(1);
  expect(fixture.controller.listRemoteHosts).not.toHaveBeenCalled();
  await act(async () => button("Import SSH config").click());
  await fixture.publish([]);
  expect(root.value).toBe("/home/joko/unsaved");
  expect(button("Use remote workspace").disabled).toBe(true);
  await act(async () => fixture.importResult.resolve([ready]));
  expect(document.querySelectorAll(".remote-host-row")).toHaveLength(0);
  expect(root.value).toBe("/home/joko/unsaved");
});

it("retires target occurrences and ignores their late mutation errors without using the page action handler", async () => {
  const fixture = await mountSettings();
  await fixture.publish([host()]);
  await act(async () => button("Import SSH config").click());
  const select = document.querySelector<HTMLSelectElement>(".remote-host-target-card select")!;
  await act(async () => { select.value = "target-two"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await fixture.publish([{ ...host(), targetId: "target-two", id: "second-host" }]);
  await act(async () => { select.value = "target-one"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await fixture.publish([]);
  await act(async () => fixture.importResult.reject(new Error("Retired import failed")));
  expect(document.querySelectorAll(".remote-host-row")).toHaveLength(0);
  expect(document.body.textContent).not.toContain("Retired import failed");
  expect(fixture.runAction).not.toHaveBeenCalled();
});

it("preserves a binding draft on concurrent project change until explicitly reloaded", async () => {
  const fixture = await mountSettings();
  await fixture.publish([{ ...host(), trust: { algorithm: "ssh-ed25519", sha256Fingerprint: "SHA256:test", pinnedAt: 1 }, status: { state: "ready", changedAt: 2 } }]);
  await change(input("Remote workspace path"), "/home/joko/local-edit");
  fixture.snapshot = { ...fixture.snapshot, targets: fixture.snapshot.targets.map(target => ({ ...target, revision: 2n, remoteWorkspace: { hostId: "build-box", workspaceRoot: "/home/joko/other-window" } })) };
  await fixture.render(fixture.controller);
  expect(input("Remote workspace path").value).toBe("/home/joko/local-edit");
  expect(button("Use remote workspace").disabled).toBe(true);
  await act(async () => button("Reload latest values").click());
  expect(input("Remote workspace path").value).toBe("/home/joko/other-window");
});

it("opens a fresh authoritative stream after StrictMode cleanup and page restoration", async () => {
  const fixture = await mountSettings({ strict: true });
  await fixture.publish([host()]);
  expect(button("Add host").disabled).toBe(false);
  const before = vi.mocked(fixture.controller.watchRemoteHosts).mock.calls.length;
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(button("Add host").disabled).toBe(true);
  await act(async () => window.dispatchEvent(new Event("pageshow")));
  expect(fixture.controller.watchRemoteHosts).toHaveBeenCalledTimes(before + 1);
  await fixture.publish([host()]);
  expect(button("Add host").disabled).toBe(false);
});

it.each(["connection", "pagehide", "back", "watchEnd"] as const)("admits one credential upload and stops the host continuation after %s", async retirement => {
  const upload = deferred<void>();
  const saveCredential = vi.fn(() => upload.promise);
  const fixture = await mountSettings({ saveCredential });
  await fixture.publish([host()]);
  const edit = button("Edit");
  await act(async () => { edit.focus(); edit.click(); });
  await change(input("Hostname"), "edited.internal");
  await change(document.querySelector<HTMLTextAreaElement>("textarea")!, "fictional-private-key");
  await act(async () => {
    const form = document.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(saveCredential).toHaveBeenCalledTimes(1);
  if (retirement === "connection") {
    const watch: AppController["watchRemoteHosts"] = (...args) => fixture.controller.watchRemoteHosts(...args);
    expect(watch).not.toBe(fixture.controller.watchRemoteHosts);
    await fixture.render({ ...fixture.controller, watchRemoteHosts: watch });
  }
  else if (retirement === "watchEnd") await fixture.finishStream();
  else await act(async () => {
    if (retirement === "pagehide") window.dispatchEvent(new Event("pagehide"));
    else button("Back").click();
  });
  if (retirement !== "back") {
    expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(input("Hostname").value).toBe("edited.internal");
    expect(button("Save").disabled).toBe(true);
  }
  await act(async () => upload.resolve());
  expect(fixture.controller.createRemoteHost).not.toHaveBeenCalled();
  expect(fixture.controller.updateRemoteHost).not.toHaveBeenCalled();
  expect(fixture.runAction).not.toHaveBeenCalled();
  if (retirement === "back") expect(document.activeElement).toBe(edit);
});

it("keeps an uploaded key reference after a failed host save and retries only the host mutation", async () => {
  const fixture = await mountSettings();
  const update = vi.mocked(fixture.controller.updateRemoteHost);
  update.mockRejectedValueOnce(new Error("Concurrent host change"));
  await fixture.publish([host()]);
  const edit = button("Edit");
  await act(async () => edit.click());
  await change(document.querySelector<HTMLTextAreaElement>("textarea")!, "fictional-private-key");
  await act(async () => button("Save").click());
  expect(document.querySelector("[role=alert]")).not.toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
  const uploadedId = vi.mocked(fixture.controller.saveCredential).mock.calls[0]![0].id;
  expect(update.mock.calls[0]![3].credentialReferenceId).toBe(uploadedId);
  const savedKeyField = [...document.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent === "Saved private key");
  expect(savedKeyField?.querySelector('[role="combobox"]')?.textContent).toBe("Selected private key");
  await act(async () => button("Save").click());
  expect(fixture.controller.saveCredential).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(2);
  expect(update.mock.calls[1]![3].credentialReferenceId).toBe(uploadedId);
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(document.activeElement).toBe(edit);
});

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
      privateKey: secret,
      context: { signal: new AbortController().signal, isCurrent: () => true, onCredentialSaved: vi.fn() }
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
      privateKey: "",
      context: { signal: new AbortController().signal, isCurrent: () => true, onCredentialSaved: vi.fn() }
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

it("keeps the exact node key in a Host draft, fences draft recipes, and retries saving without copying private credentials", async () => {
  const fixture = await mountSettings();
  await fixture.publish([host()]);
  await act(async () => button("Edit").click());
  await selectNodeAuthentication();
  await act(async () => button("Work keyssh-ed25519SHA256:work").click());
  const first = deferred<string>();
  vi.mocked(fixture.controller.getSshKeyInstallCommand).mockImplementationOnce(() => first.promise);
  await act(async () => button("Show installation command").click());
  const request = vi.mocked(fixture.controller.getSshKeyInstallCommand).mock.calls[0]!;
  expect(request[0]).toEqual({ keyId: "work", expectedFingerprint: "SHA256:work", destination: { kind: "draftHost", hostname: "build.internal", user: "joko", port: 22 }, shell: "posix" });
  await change(input("Hostname"), "other.internal");
  expect(request[1].aborted).toBe(true);
  await act(async () => first.resolve("stale recipe"));
  expect(document.body.textContent).not.toContain("stale recipe");
  await act(async () => button("Show installation command").click());
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Installation command"]')?.value).toBe("current recipe");
  vi.mocked(fixture.controller.updateRemoteHost).mockRejectedValueOnce(new Error("Concurrent update"));
  await act(async () => button("Save").click());
  expect(input("Hostname").value).toBe("other.internal");
  expect(fixture.controller.saveCredential).not.toHaveBeenCalled();
  expect(vi.mocked(fixture.controller.updateRemoteHost).mock.calls[0]![3]).toMatchObject({ authentication: "nodeKey", nodeKey: { id: "work", expectedFingerprint: "SHA256:work" }, credentialReferenceId: undefined });
  await act(async () => button("Save").click());
  expect(fixture.controller.updateRemoteHost).toHaveBeenCalledTimes(2);
});

it("retains generated identity after uncertain agent loading, refreshes explicitly and never submits the surrounding Host form", async () => {
  const fixture = await mountSettings({ strict: true });
  await fixture.publish([host()]);
  await act(async () => button("Edit").click());
  await selectNodeAuthentication();
  vi.mocked(fixture.controller.addSshKeyToAgent).mockRejectedValueOnce(new ConnectError("ssh_key.outcome_unknown", Code.FailedPrecondition));
  await act(async () => { button("Generate key").focus(); button("Generate key").click(); });
  const form = document.querySelector<HTMLFormElement>(".ssh-key-form")!;
  await act(async () => form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => { submit.focus(); submit.click(); });
  expect(fixture.controller.generateSshKey).toHaveBeenCalledOnce();
  expect(fixture.controller.addSshKeyToAgent).toHaveBeenCalledWith("generated", "SHA256:generated", undefined, expect.any(AbortSignal));
  expect(fixture.controller.updateRemoteHost).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Key generated. Loading it into the SSH agent was not confirmed.");
  expect(button("Save").disabled).toBe(true);
  const selected = document.querySelector<HTMLButtonElement>('.ssh-key-choice[aria-pressed="true"]')!;
  expect(selected.textContent).toContain("Generated key");
  expect(document.activeElement).toBe(selected);
  await act(async () => button("Refresh").click());
  expect(button("Save").disabled).toBe(false);
  await act(async () => button("Save").click());
  expect(vi.mocked(fixture.controller.updateRemoteHost).mock.calls[0]![3].nodeKey).toEqual({ id: "generated", expectedFingerprint: "SHA256:generated" });
  expect(fixture.controller.generateSshKey).toHaveBeenCalledOnce();
  expect(fixture.controller.saveCredential).not.toHaveBeenCalled();
});

async function selectNodeAuthentication(): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>('.remote-host-editor select')!;
  await act(async () => { select.value = "nodeKey"; select.dispatchEvent(new Event("change", { bubbles: true })); });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mountSettings(options: { readonly strict?: boolean; readonly saveCredential?: AppController["saveCredential"] } = {}) {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container); roots.push(root);
  let deliver!: (hosts: readonly RemoteHostView[]) => void;
  let finish!: () => void;
  const importResult = deferred<readonly RemoteHostView[]>();
  const keys: SshKeyView[] = [{ id: "work", name: "Work key", algorithm: "ssh-ed25519", comment: "", sha256Fingerprint: "SHA256:work", modifiedAt: 1, inAgent: true }];
  const watchRemoteHosts = vi.fn((_targetId: string, signal?: AbortSignal) => ({
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise<IteratorResult<readonly RemoteHostView[]>>(resolve => {
      deliver = hosts => resolve({ done: false, value: hosts });
      finish = () => resolve({ done: true, value: undefined });
      if (signal?.aborted) resolve({ done: true, value: undefined });
      else signal?.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
    })
  }));
  const controller = {
    listSshKeys: vi.fn(async () => ({ keys: [...keys], agentState: "ready", generationSupported: true })),
    generateSshKey: vi.fn(async () => { const key: SshKeyView = { id: "generated", name: "Generated key", algorithm: "ssh-ed25519", comment: "", sha256Fingerprint: "SHA256:generated", modifiedAt: 2, inAgent: false }; keys.push(key); return key; }),
    addSshKeyToAgent: vi.fn(async () => undefined),
    readSshPublicKey: vi.fn(async () => "ssh-ed25519 fixture-public"),
    getSshKeyInstallCommand: vi.fn(async () => "current recipe"),
    state: { connectionState: "connected", route: { kind: "settings" }, navigationRevision: 1 },
    watchRemoteHosts,
    getRemoteHostCapabilities: vi.fn(async () => ({ catalog: true, management: true, connectionControl: true, connectionTest: true, trustReset: true, commandExecution: true, processStreaming: true, fileTransfer: true, tcpForwarding: true })),
    listRemoteHosts: vi.fn(async () => []),
    refreshRemoteHostCatalog: vi.fn(() => importResult.promise),
    updateTarget: vi.fn(async () => undefined), saveCredential: options.saveCredential ?? vi.fn(async () => undefined),
    createRemoteHost: vi.fn(async () => host()), updateRemoteHost: vi.fn(async () => host()),
    deleteRemoteHost: vi.fn(async () => undefined), connectRemoteHost: vi.fn(async () => host()),
    disconnectRemoteHost: vi.fn(async () => host()), testRemoteHostConnection: vi.fn(async () => host()), clearRemoteHostTrust: vi.fn(async () => host())
  } as unknown as AppController;
  const fixture = {
    controller, importResult,
    runAction: vi.fn((_key: string, action: () => Promise<void>) => { void action().catch(() => undefined); }),
    snapshot: { ...emptySnapshot(), targets: ["target-one", "target-two"].map(id => ({ id, revision: 1n, backendId: "runtime", name: id, workspaceId: id, workspaceName: id, trusted: true, pinned: false, archived: false })) } as AppSnapshot,
    render: (next: AppController) => act(async () => {
      const view = <RemoteHostsSettings controller={next} snapshot={fixture.snapshot} runAction={fixture.runAction} t={(key, values) => translate("en", key, values)} />;
      root.render(options.strict ? <StrictMode>{view}</StrictMode> : view);
    }),
    publish: (hosts: readonly RemoteHostView[]) => act(async () => deliver(hosts)),
    finishStream: () => act(async () => finish())
  };
  await fixture.render(controller);
  return fixture;
}

function input(label: string): HTMLInputElement {
  return [...document.querySelectorAll("label")].find(node => node.querySelector("span")?.textContent === label)!.querySelector("input")!;
}
function button(label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
  if (result === undefined) throw new Error(`Missing button ${label}`);
  return result;
}
async function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
