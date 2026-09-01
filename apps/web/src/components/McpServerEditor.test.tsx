// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { AppController } from "../controller.js";
import { emptySnapshot, type CredentialView, type McpServerDraft, type McpServerView } from "../model.js";
import {
  formatMcpArguments,
  McpServerEditor,
  mcpServerDraft,
  parseMcpArguments
} from "./McpServerEditor.js";
import { McpSettings } from "./SettingsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("MCP server editor", () => {
  it("round-trips the saved ID, revision, arguments, environment, and ordered bindings", async () => {
    const drafts: McpServerDraft[] = [];
    const onSave = vi.fn(async (draft: McpServerDraft) => { drafts.push(draft); });
    const { container } = await mount({ onSave });

    const idInput = inputForLabel(container, "Server ID");
    expect(idInput.value).toBe("saved-server");
    expect(idInput.disabled).toBe(true);
    expect(inputForLabel(container, "Arguments (JSON array)").value).toBe('["server.mjs","argument with spaces"]');
    expect(container.textContent).not.toContain("secret-material");

    await act(async () => required(container.querySelector<HTMLButtonElement>('button[type="submit"]')).click());

    expect(onSave).toHaveBeenCalledOnce();
    expect(drafts[0]).toMatchObject({
      id: "saved-server",
      revision: 7n,
      arguments: ["server.mjs", "argument with spaces"],
      environment: [{ name: "LOG_LEVEL", value: "info" }],
      credentialBindings: [
        { target: "environment", name: "MCP_TOKEN", credentialId: "credential-reference-token" },
        { target: "environment", name: "MCP_TENANT", credentialId: "credential-reference-tenant" }
      ]
    });
  });

  it("opens the saved server from its list Edit action", async () => {
    const snapshot = emptySnapshot();
    const configured = {
      ...snapshot,
      settings: { ...snapshot.settings, credentials, mcpServers: [server()] }
    };
    const controller = {
      saveMcpServer: vi.fn(async () => undefined),
      restartMcpServer: vi.fn(async () => undefined),
      deleteMcpServer: vi.fn(async () => undefined)
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<McpSettings
      controller={controller}
      snapshot={configured}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Edit Saved server"]')).click());
    expect(required(container.querySelector('[role="dialog"]')).textContent).toContain("Edit Saved server");
    expect(inputForLabel(container, "Server ID").value).toBe("saved-server");
    expect(inputForLabel(container, "Server ID").disabled).toBe(true);
  });

  it("keeps the editor and draft open when a revision-fenced save fails", async () => {
    const onSave = vi.fn(async () => { throw new Error("MCP server changed concurrently."); });
    const { container } = await mount({ onSave });
    const name = inputForLabel(container, "Display name");
    await changeInput(name, "Edited locally");
    await act(async () => required(container.querySelector<HTMLButtonElement>('button[type="submit"]')).click());

    expect(required(container.querySelector('[role="alert"]')).textContent).toContain("changed concurrently");
    expect(inputForLabel(container, "Display name").value).toBe("Edited locally");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("fences a pending save outcome after explicit back navigation", async () => {
    let resolveSave!: () => void;
    const pending = new Promise<void>((resolve) => { resolveSave = resolve; });
    const onSave = vi.fn(() => pending);
    const onClose = vi.fn();
    const onSaved = vi.fn();
    const { container } = await mount({ onSave, onClose, onSaved });

    await act(async () => required(container.querySelector<HTMLButtonElement>('button[type="submit"]')).click());
    const back = container.querySelector<HTMLButtonElement>('.modal__header button[aria-label="Back"]');
    await act(async () => required(back).click());
    await act(async () => resolveSave());

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("closes an untouched edit without submitting any mutation", async () => {
    const onSave = vi.fn(async () => undefined);
    const onClose = vi.fn();
    const { container } = await mount({ onSave, onClose });
    const back = container.querySelector<HTMLButtonElement>('.modal__header button[aria-label="Back"]');

    await act(async () => required(back).click());

    expect(onClose).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("uses lossless JSON argument editing and rejects non-string entries", () => {
    const args = ["", "argument with spaces", "line one\nline two"];
    expect(parseMcpArguments(formatMcpArguments(args))).toEqual({ ok: true, value: args });
    expect(parseMcpArguments('["safe", 1]')).toEqual({ ok: false });
    expect(mcpServerDraft(server())).toMatchObject({ id: "saved-server", revision: 7n, arguments: ["server.mjs", "argument with spaces"] });
  });
});

async function mount(overrides: Partial<{
  readonly onSave: (draft: McpServerDraft) => Promise<void>;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}> = {}): Promise<{ readonly container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<McpServerEditor
    server={server()}
    credentials={credentials}
    t={(key, values) => translate("en", key, values)}
    onClose={overrides.onClose ?? vi.fn()}
    onSave={overrides.onSave ?? vi.fn(async () => undefined)}
    onSaved={overrides.onSaved ?? vi.fn()}
  />));
  return { container };
}

function server(): McpServerView {
  return {
    id: "saved-server",
    name: "Saved server",
    transport: "stdio",
    endpoint: "",
    state: "connected",
    generation: 4n,
    toolCount: 2,
    credentialIds: ["credential-reference-token", "credential-reference-tenant"],
    credentialBindings: [
      { credentialId: "credential-reference-token", target: "environment", name: "MCP_TOKEN", configured: true },
      { credentialId: "credential-reference-tenant", target: "environment", name: "MCP_TENANT", configured: true }
    ],
    enabled: true,
    command: "node",
    arguments: ["server.mjs", "argument with spaces"],
    workingDirectory: "D:\\workspace",
    environment: [{ name: "LOG_LEVEL", value: "info" }],
    revision: 7n
  };
}

const credentials: readonly CredentialView[] = [{
  id: "credential-reference-token",
  name: "Token",
  kind: "headerSecret",
  providerId: "",
  configured: true
}, {
  id: "credential-reference-tenant",
  name: "Tenant",
  kind: "headerSecret",
  providerId: "",
  configured: true
}];

function inputForLabel(container: HTMLElement, text: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.querySelector("span")?.textContent === text);
  return required(label?.querySelector("input") ?? null);
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected rendered value.");
  return value;
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
