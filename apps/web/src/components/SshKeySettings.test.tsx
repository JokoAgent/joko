// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConnectError, Code } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type RemoteHostView, type SshKeyCatalogView, type SshKeyView } from "../model.js";
import { translate } from "../i18n.js";
import { SshKeySettings } from "./SshKeySettings.js";

const roots: Root[] = [];
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("submits one encrypted generation, clears the form secret and observes the resulting catalog", async () => {
  const fixture = await mount();
  expect(document.body.textContent).toContain("Keys belong to the service user on Build node");
  await act(async () => button("Generate key").click());
  await act(async () => input("Add to the SSH agent after generating").click());
  expect(submitButton().disabled).toBe(true);
  await change(input("Passphrase"), "test-only-passphrase");
  await change(input("Confirm passphrase"), "different");
  expect(submitButton().disabled).toBe(true);
  await change(input("Confirm passphrase"), "test-only-passphrase");
  const result = deferred<SshKeyView>(); fixture.generate.mockImplementationOnce(() => result.promise);
  await act(async () => submitButton().focus());
  await submitTwice();
  expect(fixture.generate).toHaveBeenCalledOnce();
  expect(fixture.add).not.toHaveBeenCalled();
  expect(fixture.generate.mock.calls[0]![0]).toEqual({ name: "", comment: "", passphrase: "test-only-passphrase" });
  expect(input("Passphrase").value).toBe("");
  expect(input("Confirm passphrase").value).toBe("");
  fixture.catalog = { ...fixture.catalog, keys: [key(), key("created")] };
  const observed = deferred<SshKeyCatalogView>(); fixture.list.mockImplementationOnce(() => observed.promise);
  await act(async () => result.resolve(key("created")));
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(fixture.list).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(document.querySelector(".ssh-key-settings"));
  expect([...document.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toContain("Key generated.");
  await act(async () => observed.resolve(fixture.catalog));
  expect(document.querySelector('.ssh-key-choice[aria-pressed="true"]')?.textContent).toContain("created");
  expect(document.activeElement).toBe(document.querySelector('.ssh-key-choice[aria-pressed="true"]'));
  expect(document.body.textContent).not.toContain("The list is being refreshed");
  expect([...document.querySelectorAll('[role="status"]')].map((node) => node.textContent)).not.toContain("Loading…");
  await fixture.render({ ...fixture.controller });
  expect(fixture.list).toHaveBeenCalledTimes(2);
});

it("loads the confirmed generated identity with the same action secret and reports both results", async () => {
  const fixture = await mount();
  const generated = deferred<SshKeyView>(); fixture.generate.mockImplementationOnce(() => generated.promise);
  const added = deferred<undefined>(); fixture.add.mockImplementationOnce(() => added.promise);
  await act(async () => button("Generate key").click());
  expect(input("Add to the SSH agent after generating").checked).toBe(true);
  await change(input("Passphrase"), "one-action-secret"); await change(input("Confirm passphrase"), "one-action-secret");
  await act(async () => submitButton().focus()); await submitTwice();
  expect(fixture.add).not.toHaveBeenCalled();
  expect(input("Passphrase").value).toBe("");
  await act(async () => generated.resolve(key("new-identity")));
  expect(fixture.add).toHaveBeenCalledExactlyOnceWith("new-identity", "SHA256:new-identity", "one-action-secret", fixture.generate.mock.calls[0]![1]);
  expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toBe("Key generated. Adding it to the SSH agent…");
  expect(submitButton().disabled).toBe(true);
  fixture.catalog = { ...fixture.catalog, keys: [{ ...key("new-identity"), inAgent: true }] };
  await act(async () => added.resolve(undefined));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain("Key generated and added to the SSH agent.");
  expect(document.activeElement).toBe(document.querySelector('.ssh-key-choice[aria-pressed="true"]'));
  expect(fixture.generate).toHaveBeenCalledOnce();
});

it.each(["agent_failed", "outcome_unknown"] as const)("preserves generation success when the following agent action reports %s", async (failure) => {
  const fixture = await mount();
  fixture.catalog = { ...fixture.catalog, keys: [key("created")] };
  fixture.add.mockRejectedValueOnce(new ConnectError(`ssh_key.${failure}`, Code.FailedPrecondition));
  await act(async () => button("Generate key").click());
  await change(input("Passphrase"), "one-action-secret"); await change(input("Confirm passphrase"), "one-action-secret");
  await submitTwice();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('.ssh-key-choice[aria-pressed="true"]')?.textContent).toContain("created");
  expect(document.body.textContent).toContain("Key generated. Loading it into the SSH agent was not confirmed.");
  expect(button("Generate key").disabled).toBe(failure === "outcome_unknown");
  await act(async () => button("Refresh").click());
  expect(button("Generate key").disabled).toBe(false);
  expect(fixture.generate).toHaveBeenCalledOnce(); expect(fixture.add).toHaveBeenCalledOnce();
});

it("retires the agent step on close without replaying the completed generation", async () => {
  const fixture = await mount();
  const added = deferred<undefined>(); fixture.add.mockImplementationOnce(() => added.promise);
  await act(async () => button("Generate key").click());
  await change(input("Passphrase"), "one-action-secret"); await change(input("Confirm passphrase"), "one-action-secret");
  await submitTwice();
  expect(fixture.generate).toHaveBeenCalledOnce(); expect(fixture.add).toHaveBeenCalledOnce();
  const signal = fixture.add.mock.calls[0]![3]; const reads = fixture.list.mock.calls.length;
  await act(async () => button("Close", document.querySelector('[role="dialog"]')!).click());
  expect(signal.aborted).toBe(true);
  expect(document.querySelector('.ssh-key-choice[aria-pressed="true"]')?.textContent).toContain("created");
  expect([...document.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toContain("Key generated.");
  expect(button("Generate key").disabled).toBe(true);
  await act(async () => added.resolve(undefined));
  expect(fixture.list).toHaveBeenCalledTimes(reads);
  expect(document.body.textContent).not.toContain("Key generated and added");
  expect(fixture.generate).toHaveBeenCalledOnce(); expect(fixture.add).toHaveBeenCalledOnce();
});

it.each(["stay", "moveDuringMutation", "moveDuringRefresh", "changeOwner"] as const)("continues agent success focus only while the original action still owns it: %s", async (transition) => {
  const fixture = await mount();
  const mutation = deferred<undefined>(); fixture.add.mockImplementationOnce(() => mutation.promise);
  const observed = deferred<SshKeyCatalogView>(); fixture.list.mockImplementationOnce(() => observed.promise);
  await act(async () => { const trigger = button("Add to agent"); trigger.focus(); trigger.click(); });
  await change(input("Passphrase"), "test-only-passphrase");
  await act(async () => submitButton().focus()); await submitTwice();
  if (transition === "moveDuringMutation") await act(async () => button("Close", document.querySelector('[role="dialog"]')!).focus());
  await act(async () => mutation.resolve(undefined));
  const external = document.body.appendChild(document.createElement("button")); external.textContent = "Other action";
  if (transition === "moveDuringRefresh" || transition === "changeOwner") await act(async () => external.focus());
  if (transition === "changeOwner") await fixture.render({ ...fixture.controller, listSshKeys: vi.fn(async (): Promise<SshKeyCatalogView> => ({ keys: [], agentState: "ready", generationSupported: true })) });
  await act(async () => observed.resolve({ ...fixture.catalog, keys: [{ ...key(), inAgent: true }] }));
  const selected = document.querySelector('.ssh-key-choice[aria-pressed="true"]');
  if (transition === "stay") {
    expect(document.activeElement).toBe(selected);
    expect([...document.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toContain("Key added to the SSH agent.");
  } else if (transition === "moveDuringMutation") expect(document.activeElement).not.toBe(selected);
  else expect(document.activeElement).toBe(external);
});

it("requires an explicit unprotected choice and keeps empty, failed and unavailable states actionable", async () => {
  const fixture = await mount({ keys: [], agentState: "unavailable", generationSupported: true });
  expect(document.body.textContent).toContain("has no SSH keys");
  expect(document.body.textContent).toContain("SSH agent is unavailable");
  await act(async () => button("Generate key").click());
  await act(async () => input("Protect the new key with a passphrase").click());
  expect(document.body.textContent).toContain("without passphrase protection");
  await submitTwice();
  expect(fixture.generate).toHaveBeenCalledExactlyOnceWith({ name: "", comment: "" }, expect.any(AbortSignal));
  expect(fixture.add).not.toHaveBeenCalled();
  fixture.list.mockRejectedValueOnce(new Error("raw-private-output"));
  await act(async () => button("Refresh").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
  expect(document.body.textContent).not.toContain("raw-private-output");
  expect(button("Refresh").disabled).toBe(false);
});

it.each(["network", "outcome_unknown"] as const)("lets a rejected passphrase be reentered but requires observation after %s", async (failure) => {
  const fixture = await mount();
  fixture.add.mockRejectedValueOnce(new ConnectError("ssh_key.bad_passphrase", Code.InvalidArgument));
  await act(async () => button("Add to agent").click());
  await change(input("Passphrase"), "first-try"); await submitTwice();
  expect(fixture.add).toHaveBeenCalledExactlyOnceWith("key-one", "SHA256:key-one", "first-try", expect.any(AbortSignal));
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("not accepted");
  expect(input("Passphrase").value).toBe("");
  fixture.add.mockRejectedValueOnce(failure === "network" ? new Error("untrusted subprocess output") : new ConnectError("ssh_key.outcome_unknown", Code.FailedPrecondition));
  await change(input("Passphrase"), "second-try"); await submitTwice();
  expect(fixture.add).toHaveBeenCalledTimes(2);
  expect(document.body.textContent).not.toContain("untrusted subprocess output");
  await change(input("Passphrase"), "third-try");
  expect(submitButton().disabled).toBe(true);
  await act(async () => button("Close", document.querySelector('[role="dialog"]')!).click());
  expect(button("Add to agent").disabled).toBe(true);
  await act(async () => button("Refresh").click());
  expect(button("Add to agent").disabled).toBe(false);
  expect(fixture.add).toHaveBeenCalledTimes(2);
});

it.each(["api", "disconnect", "pagehide", "close"] as const)("retires a pending secret and never replays it after %s", async (retirement) => {
  const fixture = await mount(); const result = deferred<SshKeyView>(); fixture.generate.mockImplementationOnce(() => result.promise);
  await act(async () => button("Generate key").click());
  const secret = input("Passphrase"); await change(secret, "test-secret"); await change(input("Confirm passphrase"), "test-secret");
  await submitTwice(); const signal = fixture.generate.mock.calls[0]![1];
  if (retirement === "api") await fixture.render({ ...fixture.controller, listSshKeys: vi.fn(async (): Promise<SshKeyCatalogView> => ({ keys: [], agentState: "ready", generationSupported: true })) });
  else if (retirement === "disconnect") await fixture.render({ ...fixture.controller, state: { ...fixture.controller.state, connectionState: "disconnected" } });
  else await act(async () => retirement === "pagehide" ? window.dispatchEvent(new Event("pagehide")) : button("Close", document.querySelector('[role="dialog"]')!).click());
  expect(signal.aborted).toBe(true); expect(secret.value).toBe(""); expect(document.querySelector('[role="dialog"]')).toBeNull();
  const reads = fixture.list.mock.calls.length;
  await act(async () => result.resolve(key("late-created")));
  expect(fixture.list).toHaveBeenCalledTimes(reads); expect(document.body.textContent).not.toContain("late-created");
  if (retirement === "pagehide") await act(async () => window.dispatchEvent(new Event("pageshow")));
  else if (retirement === "disconnect") await fixture.render(fixture.controller);
  expect(fixture.generate).toHaveBeenCalledOnce();
  expect(fixture.add).not.toHaveBeenCalled();
});

it("uses fresh scopes after StrictMode and hides cross-service keys immediately", async () => {
  const fixture = await mount(undefined, true);
  expect(button("Generate key").disabled).toBe(false);
  const pending = deferred<SshKeyCatalogView>();
  await fixture.render({ ...fixture.controller, listSshKeys: vi.fn(() => pending.promise) });
  expect(document.body.textContent).not.toContain("SHA256:key-one");
  expect(button("Generate key").disabled).toBe(true);
  await act(async () => pending.resolve({ keys: [], agentState: "failed", generationSupported: false }));
  expect(document.body.textContent).toContain("does not support key generation");
  expect(document.body.textContent).toContain("agent could not be read");
});

it("fences copied public keys and installation commands by the selected key, live host revision and component lifetime", async () => {
  const fixture = await mount();
  const writeText = vi.fn(async () => undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await act(async () => document.querySelector<HTMLButtonElement>(".ssh-key-choice")!.click());
  expect(fixture.publicKey).toHaveBeenCalledExactlyOnceWith("key-one", "SHA256:key-one", expect.any(AbortSignal));
  await act(async () => button("Copy public key").click()); expect(writeText).toHaveBeenCalledExactlyOnceWith("ssh-ed25519 AAAA public-comment");
  await fixture.publish([host()]); await select("Remote host", "joko@build.internal:22"); await select("Client shell", "PowerShell");
  const pending = deferred<string>(); fixture.command.mockImplementationOnce(() => pending.promise);
  await act(async () => button("Show installation command").click());
  expect(fixture.command.mock.calls[0]![0]).toEqual({ keyId: "key-one", expectedFingerprint: "SHA256:key-one", destination: { kind: "savedHost", targetId: "project", hostId: "build-box", expectedRevision: 1n }, shell: "powershell" });
  const signal = fixture.command.mock.calls[0]![1];
  await fixture.publish([{ ...host(), revision: 2n }]); expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve("stale-command")); expect(document.body.textContent).not.toContain("stale-command");
  await act(async () => button("Show installation command").click());
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Installation command"]')?.value).toBe("fixture-install-command");
  await act(async () => button("Copy command").click()); expect(writeText).toHaveBeenLastCalledWith("fixture-install-command");
  await fixture.publish([{ ...host(), revision: 3n }]); expect(document.querySelector('textarea[aria-label="Installation command"]')).toBeNull();
  const late = deferred<string>(); fixture.command.mockImplementationOnce(() => late.promise);
  await act(async () => button("Show installation command").click()); const lateSignal = fixture.command.mock.calls.at(-1)![1];
  await act(async () => button("Refresh").click()); expect(lateSignal.aborted).toBe(true);
  await act(async () => late.resolve("unmounted-command")); expect(document.body.textContent).not.toContain("unmounted-command");
});

function key(id = "key-one"): SshKeyView { return { id, name: id, algorithm: "ssh-ed25519", comment: "Work key", sha256Fingerprint: `SHA256:${id}`, modifiedAt: 1000, inAgent: false }; }
function host(): RemoteHostView { return { id: "build-box", targetId: "project", hostname: "build.internal", port: 22, user: "joko", source: "manual", authentication: "systemAgent", status: { state: "disconnected", changedAt: 1 }, revision: 1n }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { resolve, promise }; }
async function mount(initial: SshKeyCatalogView = { keys: [key()], agentState: "ready", generationSupported: true }, strict = false) {
  const root = createRoot(document.body.appendChild(document.createElement("div"))); roots.push(root);
  let deliver!: (values: readonly RemoteHostView[]) => void;
  const watchRemoteHosts = vi.fn((_targetId: string, signal: AbortSignal) => ({
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise<IteratorResult<readonly RemoteHostView[]>>((resolve) => {
      deliver = (value) => resolve({ done: false, value });
      if (signal.aborted) resolve({ done: true, value: undefined });
      else signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
    })
  }));
  const list = vi.fn(async (_signal: AbortSignal) => fixture.catalog);
  const generate = vi.fn(async (_draft: Parameters<AppController["generateSshKey"]>[0], _signal: AbortSignal) => key("created"));
  const add = vi.fn(async (_keyId: string, _fingerprint: string, _passphrase: string | undefined, _signal: AbortSignal) => undefined);
  const publicKey = vi.fn(async (_keyId: string, _fingerprint: string, _signal: AbortSignal) => "ssh-ed25519 AAAA public-comment");
  const command = vi.fn(async (_draft: Parameters<AppController["getSshKeyInstallCommand"]>[0], _signal: AbortSignal) => "fixture-install-command");
  const controller = {
    state: { connectionState: "connected", activeProfile: { id: "node", serverId: "service", name: "Build node" }, snapshot: { ...emptySnapshot(), targets: [{ id: "project", name: "Project", archived: false }] } },
    listSshKeys: list, generateSshKey: generate, addSshKeyToAgent: add, readSshPublicKey: publicKey, getSshKeyInstallCommand: command, watchRemoteHosts
  } as unknown as AppController;
  const fixture = { catalog: initial, controller, list, generate, add, publicKey, command,
    render: (next: AppController) => act(async () => { const view = <SshKeySettings controller={next} t={(key, values) => translate("en", key, values)} />; root.render(strict ? <StrictMode>{view}</StrictMode> : view); }),
    publish: (values: readonly RemoteHostView[]) => act(async () => deliver(values))
  };
  await fixture.render(controller); return fixture;
}
function button(label: string, owner: ParentNode = document): HTMLButtonElement {
  const found = [...owner.querySelectorAll("button")].find((node) => node.textContent === label || node.getAttribute("aria-label") === label);
  if (found === undefined) throw new Error(`Missing button ${label}`); return found;
}
function input(label: string): HTMLInputElement {
  return [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === label)!.querySelector("input")!;
}
function submitButton(): HTMLButtonElement { return document.querySelector('form button[type="submit"]')!; }
async function submitTwice() { await act(async () => { const form = document.querySelector("form")!; for (let index = 0; index < 2; index++) form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); }
async function change(element: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }
async function select(label: string, option: string) {
  await act(async () => [...document.querySelectorAll("label")].find((node) => node.querySelector("span")?.textContent === label)!.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent === option)!.click());
}
