// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import {
  emptySnapshot,
  type AppSnapshot,
  type MessagingConnectionView,
  type MessagingRouteView,
  type MessagingSettingsView
} from "../model.js";
import { MessagingSettings } from "./MessagingSettings.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Messaging settings", () => {
  it("renders the complete capability and runtime state, reports test failures, and saves a new-only route", async () => {
    const connection = telegramConnection({
      runtimeStatus: "conflict",
      errorCode: "telegram.poll_conflict",
      errorSummary: "Another poller owns this bot token."
    });
    const settings = messagingSettings([connection]);
    const route = messagingRoute();
    const controller = controllerFixture(settings, {
      testMessagingConnection: vi.fn(async () => ({ ok: false as const, failure: "connectionFailed" as const })),
      putMessagingRoute: vi.fn(async () => route)
    });
    const container = await renderSettings(controller, snapshot());

    expect(container.querySelectorAll(".messaging-channel")).toHaveLength(8);
    expect(container.querySelectorAll(".messaging-channel.is-available")).toHaveLength(1);
    expect(container.textContent).toContain("Conflict");
    expect(container.textContent).toContain("Another poller owns this bot token.");

    await act(async () => button(container, "Test").click());
    expect(controller.testMessagingConnection).toHaveBeenCalledWith("telegram-one");
    const testResult = required(container.querySelector<HTMLElement>(".messaging-test-result"));
    expect(testResult.classList.contains("is-error")).toBe(true);
    expect(testResult.textContent).toContain("could not be reached");

    const routeTrigger = button(container, "Set route");
    await act(async () => routeTrigger.click());
    const dialog = required(document.querySelector<HTMLElement>('[role="dialog"]'));
    expect(dialog.textContent).toContain("Route changes affect new conversations only");
    await act(async () => button(dialog, "Save").click());
    expect(controller.putMessagingRoute).toHaveBeenCalledWith({
      targetId: "target-one",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("creates Telegram, advances directly to the one-shot token form, and clears secret UI after save", async () => {
    const created = telegramConnection({ enabled: false, runtimeStatus: "idle", credentialConfigured: false });
    const saved = telegramConnection({ enabled: true, runtimeStatus: "connecting", credentialConfigured: true, revision: 8n });
    const create = vi.fn(async () => created);
    const save = vi.fn(async () => saved);
    const controller = controllerFixture(messagingSettings([]), {
      createTelegramMessagingConnection: create,
      saveMessagingCredential: save
    });
    const container = await renderSettings(controller, snapshot());
    const trigger = buttons(container, "Add Telegram")[0]!;

    await act(async () => trigger.click());
    const owner = required(document.querySelector<HTMLInputElement>('input[inputmode="numeric"]'));
    expect(document.activeElement).toBe(owner);
    await change(owner, "123456789");
    await act(async () => button(document.body, "Continue").click());
    expect(create).toHaveBeenCalledWith("123456789", {
      emojiReactions: "minimal",
      replyQuoteDm: "off",
      replyQuoteGroup: "first",
      groupActivation: {}
    });

    const token = required(document.querySelector<HTMLInputElement>('input[type="password"]'));
    expect(document.activeElement).toBe(token);
    await change(token, "telegram-secret");
    await act(async () => button(document.body, "Save").click());
    expect(save).toHaveBeenCalledWith("telegram-one", 7n, 3n, "telegram-secret", true);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toContain("telegram-secret");
    expect(container.textContent).toContain("Connecting");

    const replace = button(container, "Replace token");
    await act(async () => { replace.focus(); replace.click(); });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(replace);
  });
});

async function renderSettings(controller: AppController, currentSnapshot: AppSnapshot): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<MessagingSettings
    controller={controller}
    snapshot={currentSnapshot}
    t={(key, values) => translate("en", key, values)}
  />));
  return container;
}

function controllerFixture(settings: MessagingSettingsView, overrides: Partial<AppController> = {}): AppController {
  const unchanged = async () => telegramConnection();
  return {
    state: {
      activeProfile: { id: "profile", deviceId: "device", serverId: "server", name: "Node", origin: "https://service.example" },
      preferences: { locale: "en" }
    },
    getMessagingSettings: vi.fn(async () => settings),
    createTelegramMessagingConnection: vi.fn(async () => telegramConnection()),
    saveMessagingCredential: vi.fn(unchanged),
    clearMessagingCredential: vi.fn(unchanged),
    setMessagingConnectionEnabled: vi.fn(unchanged),
    updateTelegramMessagingConfiguration: vi.fn(unchanged),
    testMessagingConnection: vi.fn(async () => ({ ok: true as const, providerAccountId: "9001", displayName: "Joko Bot" })),
    putMessagingRoute: vi.fn(async () => messagingRoute()),
    ...overrides
  } as unknown as AppController;
}

function messagingSettings(connections: readonly MessagingConnectionView[]): MessagingSettingsView {
  return {
    connections,
    routes: [],
    channels: [
      { channel: "telegram", available: true },
      { channel: "discord", available: false, reason: "not implemented" },
      { channel: "dingtalk", available: false, reason: "not implemented" },
      { channel: "feishu", available: false, reason: "not implemented" },
      { channel: "lark", available: false, reason: "not implemented" },
      { channel: "wecom", available: false, reason: "not implemented" },
      { channel: "wechat", available: false, reason: "not implemented" },
      { channel: "slack", available: false, reason: "not implemented" }
    ]
  };
}

function telegramConnection(overrides: Partial<MessagingConnectionView> = {}): MessagingConnectionView {
  return {
    id: "telegram-one",
    channel: "telegram",
    generation: 3n,
    revision: 7n,
    enabled: true,
    runtimeStatus: "connected",
    credentialConfigured: true,
    ownerProviderUserId: "42",
    providerAccountId: "9001",
    providerUsername: "joko_test_bot",
    telegramConfiguration: {
      emojiReactions: "minimal",
      replyQuoteDm: "off",
      replyQuoteGroup: "first",
      groupActivation: { "-100": "mention" }
    },
    lastConnectedAt: Date.now() - 1_000,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides
  };
}

function messagingRoute(): MessagingRouteView {
  return {
    scopeKey: "global",
    targetId: "target-one",
    backendId: "backend-one",
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    revision: 1n
  };
}

function snapshot(): AppSnapshot {
  return {
    ...emptySnapshot(),
    targets: [{
      id: "target-one",
      revision: 1n,
      backendId: "backend-one",
      name: "Main workspace",
      workspaceId: "workspace-one",
      workspaceName: "Main workspace",
      trusted: true,
      pinned: false,
      archived: false
    }],
    models: [{
      backendId: "backend-one",
      providerId: "provider-one",
      providerName: "Provider",
      modelId: "model-one",
      name: "Model One",
      available: true,
      supportsImages: true,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsFast: true,
      efforts: ["low", "high"],
      contextWindow: 128_000,
      maximumOutputTokens: 8_192,
      inputCostMicrosPerMillion: 0,
      outputCostMicrosPerMillion: 0,
      currencyCode: "USD"
    }]
  };
}

function buttons(container: ParentNode, text: string): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) => candidate.textContent?.trim() === text);
}

function button(container: ParentNode, text: string): HTMLButtonElement {
  return required(buttons(container, text)[0]);
}

async function change(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected Messaging control.");
  return value;
}
