// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { ExtensionSourceCatalogView } from "../model.js";
import { ExtensionSourceDialog } from "./ExtensionSourceDialog.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ExtensionSourceDialog", () => {
  it("renders the real loading and empty states", async () => {
    const pending = deferred<ExtensionSourceCatalogView>();
    const listExtensionSources = vi.fn(() => pending.promise);
    await renderDialog({ listExtensionSources });

    expect(document.body.textContent).toContain("Loading extension sources");
    await act(async () => pending.resolve(emptySources()));
    await settle();
    expect(document.body.textContent).toContain("No extension sources");
    expect(document.body.querySelector(".extension-source-editor")).not.toBeNull();
  });

  it("shows a request error and retries through a new owner request", async () => {
    const listExtensionSources = vi.fn()
      .mockRejectedValueOnce(new Error("Source service unavailable"))
      .mockResolvedValueOnce(emptySources());
    await renderDialog({ listExtensionSources });
    await settle();

    expect(document.body.textContent).toContain("Source service unavailable");
    await act(async () => buttonWithText("Retry").click());
    await settle();
    expect(listExtensionSources).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("No extension sources");
  });

  it("does not let an old dialog request replace a reopened dialog", async () => {
    const first = deferred<ExtensionSourceCatalogView>();
    const second = deferred<ExtensionSourceCatalogView>();
    const listExtensionSources = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const rendered = await renderDialog({ listExtensionSources });
    await settle();
    await rendered.show(false);
    await rendered.show(true);
    await settle();

    await act(async () => second.resolve(sourceCatalog("Current catalog")));
    await settle();
    await act(async () => first.resolve(sourceCatalog("Stale catalog")));
    await settle();
    expect(document.body.textContent).toContain("Current catalog");
    expect(document.body.textContent).not.toContain("Stale catalog");
  });

  it("unlocks a reopened dialog and reloads after an earlier generation mutation completes", async () => {
    const mutation = deferred<void>();
    const listExtensionSources = vi.fn()
      .mockResolvedValueOnce(emptySources())
      .mockResolvedValueOnce(emptySources())
      .mockResolvedValueOnce(sourceCatalog("Current catalog"));
    const addExtensionSource = vi.fn(() => mutation.promise);
    const rendered = await renderDialog({ listExtensionSources, addExtensionSource });
    await settle();
    const input = document.body.querySelector<HTMLInputElement>(".extension-source-editor input");
    if (input === null) throw new Error("Expected the local source input.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "D:\\catalog");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonWithText("Discover source").click());
    expect(addExtensionSource).toHaveBeenCalledTimes(1);

    await rendered.show(false);
    await rendered.show(true);
    await settle();
    await act(async () => mutation.resolve());
    await settle();
    await settle();

    expect(listExtensionSources).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("Current catalog");
    expect(buttonWithText("Discover source").disabled).toBe(false);
  });
});

async function renderDialog(controllerOverrides: Partial<AppController>): Promise<{ readonly show: (open: boolean) => Promise<void> }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const controller = {
    listExtensionSources: async () => emptySources(),
    getExtensionSourceGitPreflight: async () => ({ available: true, version: "2.51.0", minimumVersion: "2.25" }),
    ...controllerOverrides
  } as unknown as AppController;
  const show = async (open: boolean): Promise<void> => {
    await act(async () => root.render(<ExtensionSourceDialog
      controller={controller}
      locale="en"
      open={open}
      t={(key, values) => translate("en", key, values)}
      runAction={(_key, action) => { void action(); }}
      onClose={() => undefined}
      onCatalogChanged={() => undefined}
    />));
  };
  await show(true);
  return { show };
}

function emptySources(): ExtensionSourceCatalogView {
  return { revision: 1n, sources: [], recoveredFromCorruption: false };
}

function sourceCatalog(displayName: string): ExtensionSourceCatalogView {
  const identityDigit = displayName.startsWith("Current") ? "1" : "2";
  return {
    revision: 2n,
    recoveredFromCorruption: false,
    sources: [{
      id: `extension_source_${identityDigit.repeat(32)}`,
      revision: 1n,
      kind: "local",
      location: { kind: "local", path: "D:\\extensions" },
      name: displayName.toLocaleLowerCase("en-US").replaceAll(" ", "-"),
      displayName,
      state: "ready",
      contentRevision: `sha256:${"a".repeat(64)}`,
      discoveredExtensionCount: 1,
      declaredEntryCount: 1,
      skippedEntryCount: 0,
      unreadableEntryCount: 0,
      addedAt: Date.UTC(2026, 8, 13)
    }]
  };
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected button ${text}.`);
  return button;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}
