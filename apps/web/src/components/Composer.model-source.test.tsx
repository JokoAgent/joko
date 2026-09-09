// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { composerDocumentPlainText } from "../composer-quote-document.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type ModelView, type ProviderRuntimeView, type SessionView } from "../model.js";
import { Composer } from "./Composer.js";

vi.mock("./ComposerRichTextEditor.js", () => ({
  ComposerRichTextEditor: ({ document }: { document: JSONContent }) => <textarea aria-label="Draft" readOnly value={composerDocumentPlainText(document)} />
}));
const roots: Root[] = [];
const model: ModelView = {
  backendId: "backend-one", providerId: "source-one", providerName: "Source one", modelId: "model-one", name: "Model one",
  available: true, supportsImages: false, supportsFast: false, inputModalities: ["text"], outputModalities: ["text"],
  efforts: [], contextWindow: 8192, maximumOutputTokens: 2048, inputCostMicrosPerMillion: 0, outputCostMicrosPerMillion: 0, currencyCode: "USD"
};
const provider: ProviderRuntimeView = {
  backendId: "backend-one", id: "source-one", name: "Source one", kind: "oauth", compatibility: "native",
  authenticationState: "authenticated", endpoint: "", ownerManaged: false, supportsLogin: true, loginMethods: ["deviceCode"],
  supportsLogout: true, supportsRefresh: true, credentialSurfaces: [], capabilities: new Set()
};
const session: SessionView = { id: "task-one", backendId: model.backendId, targetId: "target-one", name: "Task one", state: "idle",
  pinned: false, archived: false, generation: 1n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 0, model };
const backend: BackendView = { id: model.backendId, name: "Backend one", version: "1", health: "healthy", capabilities: new Map([
  ["input.text", { name: "input.text", supported: true, options: [] }], ["turn.abort", { name: "turn.abort", supported: true, options: [] }]
]) };

beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("requestAnimationFrame", () => 0); });
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe("Composer model authorization", () => {
  it("gates the native default with its Backend authentication while leaving unrelated provider states out of the decision", async () => {
    const view = await mount();
    const nativeSession = { ...session, model: undefined };
    for (const authenticationState of ["signedOut", "pending", "expired", "refreshing", "error", "unknown"] as const) {
      await view.render([provider], nativeSession, { ...backend, authenticationState });
      expect(view.send().disabled, authenticationState).toBe(true);
      expect(view.host.querySelector('.composer__source-notice')?.textContent).toContain(`providerAuth.${authenticationState}`);
      expect(view.draft()).toBe("Keep this draft");
    }
    for (const authenticationState of ["authenticated", "notRequired"] as const) {
      await view.render([{ ...provider, authenticationState: "expired" }], nativeSession, { ...backend, authenticationState });
      expect(view.send().disabled, authenticationState).toBe(false);
      expect(view.host.querySelector('.composer__source-notice')).toBeNull();
    }
    expect(view.api.send).not.toHaveBeenCalled();
    await act(async () => { view.send().click(); await Promise.all(view.actions); });
    expect(view.api.send).toHaveBeenCalledOnce();
  });

  it("restores the native-default draft when its authorization expires during durable clearing", async () => {
    const view = await mount();
    const nativeSession = { ...session, model: undefined };
    await view.render([provider], nativeSession, { ...backend, authenticationState: "authenticated" });
    let release!: () => void;
    vi.mocked(view.api.saveDraft).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => view.send().click());
    await view.render([provider], nativeSession, { ...backend, authenticationState: "expired" });
    await act(async () => { release(); await Promise.all(view.actions); });
    expect(view.api.send).not.toHaveBeenCalled();
    expect(view.draft()).toBe("Keep this draft");
    await view.render([provider], nativeSession, { ...backend, authenticationState: "authenticated" });
    expect(view.send().disabled).toBe(false);
    expect(view.api.send).not.toHaveBeenCalled();
  });

  it("uses only the selected route's authentication and keeps Stop reachable while that route needs recovery", async () => {
    const view = await mount();
    await view.render([{ ...provider, backendId: "other-backend", authenticationState: "expired" }, provider]);
    expect(view.send().disabled).toBe(false);
    expect(view.host.querySelector('.composer__source-notice')).toBeNull();
    await view.render([{ ...provider, authenticationState: "refreshing" }]);
    expect(view.send().disabled).toBe(true);
    expect(view.host.querySelector('.composer__source-notice')?.textContent).toContain("providerAuth.refreshing");
    expect(view.host.querySelector<HTMLButtonElement>('.composer__source-notice button')?.disabled).toBe(true);
    expect(view.draft()).toBe("Keep this draft");
    await view.render([{ ...provider, authenticationState: "expired" }], { ...session, state: "running", activeRunId: "run-one" });
    const stop = view.host.querySelector<HTMLButtonElement>('button[aria-label="common.stop"]')!;
    expect(stop.disabled).toBe(false);
    await act(async () => stop.click());
    expect(view.stop).toHaveBeenCalledOnce();
    expect(view.api.send).not.toHaveBeenCalled();
    await view.render([{ ...provider, authenticationState: "notRequired", kind: "localKeyless" }]);
    expect(view.host.querySelector('.composer__source-notice')).toBeNull();
    expect(view.send().disabled).toBe(false);
  });

  it("retires a send when authorization expires during durable draft clearing and restores the draft", async () => {
    const view = await mount();
    let release!: () => void;
    vi.mocked(view.api.saveDraft).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => view.send().click());
    expect(view.api.send).not.toHaveBeenCalled();
    expect(view.draft()).toBe("");
    await view.render([{ ...provider, authenticationState: "expired" }]);
    await act(async () => { release(); await Promise.all(view.actions); });
    expect(view.api.send).not.toHaveBeenCalled();
    expect(view.draft()).toBe("Keep this draft");
    expect(view.api.saveDraft).toHaveBeenLastCalledWith(session.id, expect.objectContaining({ text: "Keep this draft" }));
    expect(view.send().disabled).toBe(true);
  });
});

async function mount() {
  const initial = emptySnapshot();
  const api = { state: { connectionState: "connected", snapshot: { ...initial, providers: [provider] }, preferences: DEFAULT_UI_PREFERENCES },
    readDraft: vi.fn(async () => ({ text: "Keep this draft" })), saveDraft: vi.fn(async () => undefined), send: vi.fn(async () => undefined),
    getVoiceInputCapabilities: vi.fn(async () => ({}))
  } as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const actions: Promise<unknown>[] = []; const stop = vi.fn();
  const render = async (providers: readonly ProviderRuntimeView[], currentSession = session, currentBackend = backend) => act(async () => root.render(<Composer
    controller={{ ...api, state: { ...api.state, snapshot: { ...api.state.snapshot, providers } } }} session={currentSession} backend={currentBackend}
    autoFocus={false} queue={[]} extraDirectories={[]} resources={[]} commands={[]} messageHistory={[]}
    t={(key) => key} runAction={(_key, action) => { actions.push(action().catch(() => undefined)); }} onLocalSend={() => undefined} onStop={stop} />));
  await render([provider]);
  return { api, host, render, actions, stop,
    send: () => host.querySelector<HTMLButtonElement>('.send-button')!, draft: () => host.querySelector<HTMLTextAreaElement>('textarea')!.value };
}
