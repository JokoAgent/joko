// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { CollaborationDirectoryView, CollaborationScopeView } from "../model.js";
import { SkillCollaborationTools } from "./SkillCollaborationTools.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("SkillCollaborationTools", () => {
  it("creates, renames, and removes exact fenced scopes while exposing the durable actor", async () => {
    let revision = 1n;
    let scopes: readonly CollaborationScopeView[] = [];
    const directory = (): CollaborationDirectoryView => ({
      available: true,
      revision,
      actor: { id: "collaboration_actor_test", displayName: "Local owner" },
      scopes,
      recoveredFromCorruption: false
    });
    const createCollaborationScope = vi.fn(async (kind: "team" | "department", name: string, expected: bigint) => {
      expect(expected).toBe(revision);
      scopes = [{
        id: "collaboration_scope_platform",
        revision: 1n,
        kind,
        name,
        members: [{ actorId: "collaboration_actor_test", role: "administrator" }]
      }];
      revision += 1n;
    });
    const updateCollaborationScope = vi.fn(async (scope: CollaborationScopeView, name: string) => {
      scopes = [{ ...scope, revision: scope.revision + 1n, name }];
      revision += 1n;
    });
    const deleteCollaborationScope = vi.fn(async (scope: CollaborationScopeView) => {
      expect(scope).toEqual(scopes[0]);
      scopes = [];
      revision += 1n;
    });
    const controller = {
      getCollaborationDirectory: vi.fn(async () => directory()),
      createCollaborationScope,
      updateCollaborationScope,
      deleteCollaborationScope
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<SkillCollaborationTools controller={controller} t={(key, values) => translate("en", key, values)} />));
    await settle();
    expect(container.textContent).toContain("Local owner");
    expect(container.textContent).toContain("No sharing scopes");

    const createName = required([...container.querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.querySelector("span")?.textContent === "Scope name")?.querySelector<HTMLInputElement>("input"));
    await act(async () => setInputValue(createName, "Platform"));
    await act(async () => buttonWithText(container, "Create scope").click());
    await settle();
    expect(createCollaborationScope).toHaveBeenCalledWith("team", "Platform", 1n, expect.any(AbortSignal));
    expect(container.textContent).toContain("Your role: Administrator");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Rename Platform"]')).click());
    const renameDialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    const renameInput = required(renameDialog.querySelector<HTMLInputElement>("input"));
    await act(async () => setInputValue(renameInput, "Platform core"));
    await act(async () => buttonWithText(renameDialog, "Save").click());
    await settle();
    expect(updateCollaborationScope).toHaveBeenCalledWith(expect.objectContaining({ name: "Platform", revision: 1n }), "Platform core", expect.any(AbortSignal));
    expect(container.textContent).toContain("Platform core");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Remove Platform core"]')).click());
    const removeDialog = required(document.body.querySelector<HTMLElement>('[role="alertdialog"]'));
    await act(async () => buttonWithText(removeDialog, "Remove").click());
    await settle();
    expect(deleteCollaborationScope).toHaveBeenCalledWith(expect.objectContaining({ name: "Platform core", revision: 2n }), expect.any(AbortSignal));
    expect(container.textContent).toContain("No sharing scopes");
  });
});

async function settle(delay = 25): Promise<void> {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, delay)); });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
  if (button === undefined) throw new Error(`Expected button ${text}.`);
  return button;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value.");
  return value;
}
