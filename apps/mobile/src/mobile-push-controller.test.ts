import { describe, expect, it, vi } from "vitest";

import type { MobilePushAuthority } from "./mobile-client";
import {
  MobilePushController,
  type MobilePushClientPort
} from "./mobile-push-controller";
import {
  MobilePushDeviceStore,
  mobilePushDeviceStoreTesting
} from "./mobile-push-device-store";
import type { NativeNotificationsApi } from "./native-notifications.types";

const granted = { status: "granted", granted: true, canAskAgain: true, expires: "never" } as const;
const denied = { status: "denied", granted: false, canAskAgain: true, expires: "never" } as const;

function authority(suffix = "1"): MobilePushAuthority {
  return {
    key: `profile-${suffix}\u001forigin-${suffix}\u001fserver-${suffix}\u001fconnection-${suffix}\u001fdevice-${suffix}\u001f7`,
    profileId: `profile-${suffix}`,
    origin: `https://node-${suffix}.example.test`,
    serverId: `server-${suffix}`,
    connectionId: `connection-${suffix}`,
    deviceId: `device-${suffix}`,
    deviceRevision: 7n
  };
}

function clientFixture(initial = authority()) {
  let current: MobilePushAuthority | undefined = initial;
  let activeProfileId: string | undefined = initial.profileId;
  const listeners = new Set<() => void>();
  const registerMobilePush = vi.fn(async (owner: MobilePushAuthority, input: {
    ticket: { serverId: string; registrationId: string; secret: string };
    environment: "sandbox" | "production";
    locale: "en" | "zh-CN" | "zh-TW" | "ja" | "ko";
    deviceToken: string;
  }) => {
    void owner;
    void input;
    return { expiresAt: 30 * 24 * 60 * 60 * 1_000 };
  });
  const unregisterMobilePush = vi.fn(async () => undefined);
  const getMobilePushCapability = vi.fn(async () => ({ supported: true }));
  const client: MobilePushClientPort = {
    get state() { return { status: current ? "connected" : "unpaired", activeProfileId }; },
    subscribe(listener) {
      listeners.add(listener);
      listener();
      return () => listeners.delete(listener);
    },
    mobilePushLifecycleScope: () => ({ ready: true, ...(activeProfileId === undefined ? {} : { activeProfileId }) }),
    mobilePushAuthority: () => current,
    getMobilePushCapability,
    registerMobilePush,
    unregisterMobilePush
  };
  return {
    client,
    registerMobilePush,
    unregisterMobilePush,
    getMobilePushCapability,
    setAuthority(next: MobilePushAuthority | undefined, nextProfileId = next?.profileId) {
      current = next;
      activeProfileId = nextProfileId;
      for (const listener of listeners) listener();
    }
  };
}

function notificationsFixture(initialPermission: typeof granted | typeof denied = granted) {
  let permission: typeof granted | typeof denied = initialPermission;
  let responseListener: ((response: never) => void) | undefined;
  let tokenListener: ((token: never) => void) | undefined;
  let lastResponse: unknown = null;
  let nativeToken = "private-native-token";
  let handler: { handleNotification(): Promise<Record<string, boolean>> } | undefined;
  const requestPermissionsAsync = vi.fn(async () => {
    permission = granted;
    return permission;
  });
  const getPermissionsAsync = vi.fn(async () => permission);
  const getDevicePushTokenAsync = vi.fn(async () => ({ type: "ios", data: nativeToken }));
  const clearLastNotificationResponseAsync = vi.fn(async () => undefined);
  const api = {
    setNotificationHandler: (value: typeof handler) => { handler = value; },
    getPermissionsAsync,
    requestPermissionsAsync,
    getDevicePushTokenAsync,
    addPushTokenListener: (listener: (token: never) => void) => {
      tokenListener = listener;
      return { remove: () => { tokenListener = undefined; } };
    },
    addNotificationResponseReceivedListener: (listener: (response: never) => void) => {
      responseListener = listener;
      return { remove: () => { responseListener = undefined; } };
    },
    getLastNotificationResponseAsync: async () => lastResponse,
    clearLastNotificationResponseAsync
  } as unknown as NativeNotificationsApi;
  return {
    api,
    requestPermissionsAsync,
    getPermissionsAsync,
    getDevicePushTokenAsync,
    clearLastNotificationResponseAsync,
    handler: () => handler,
    setLastResponse(value: unknown) { lastResponse = value; },
    emitResponse(value: unknown) { responseListener?.(value as never); },
    emitToken() {
      nativeToken = "rotated-native-token";
      tokenListener?.({ type: "ios", data: nativeToken } as never);
    }
  };
}

function deviceStoreFixture(enabled = false) {
  const plain = new Map<string, string>(enabled ? [[mobilePushDeviceStoreTesting.enabledKey, "1"]] : []);
  const secure = new Map<string, string>();
  const store = new MobilePushDeviceStore({
    getItem: async (key) => plain.get(key) ?? null,
    setItem: async (key, value) => { plain.set(key, value); }
  }, {
    isAvailable: async () => true,
    getItem: async (key) => secure.get(key) ?? null,
    setItem: async (key, value) => { secure.set(key, value); }
  });
  return { store, plain, secure };
}

function controllerFixture(options: {
  enabled?: boolean;
  permission?: typeof granted | typeof denied;
  platform?: string;
} = {}) {
  const client = clientFixture();
  const notifications = notificationsFixture(options.permission);
  const storage = deviceStoreFixture(options.enabled);
  let sequence = 0;
  const controller = new MobilePushController({
    platform: options.platform ?? "ios",
    environment: "sandbox",
    locale: "en",
    client: client.client,
    deviceStore: storage.store,
    notifications: notifications.api,
    digest: async (value) => (value === "rotated-native-token" ? "b" : "a").repeat(64),
    registrationId: () => `registration-${++sequence}`,
    revocationSecret: () => "s".repeat(43),
    now: () => 1_000
  });
  return { controller, client, notifications, storage };
}

describe("MobilePushController", () => {
  it("defaults off and requests system permission only after explicit enable", async () => {
    const fixture = controllerFixture({ permission: denied });
    await fixture.controller.start(() => true);
    expect(fixture.controller.snapshot).toMatchObject({ enabled: false, status: "disabled" });
    expect(fixture.notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(fixture.notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(fixture.client.registerMobilePush).not.toHaveBeenCalled();

    let secureAtDispatch = "";
    fixture.client.registerMobilePush.mockImplementationOnce(async (_owner, input) => {
      secureAtDispatch = fixture.storage.secure.get(mobilePushDeviceStoreTesting.registrationsKey) ?? "";
      throw new Error("response outcome unknown");
    });
    await fixture.controller.setEnabled(true);
    expect(fixture.notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(secureAtDispatch).toContain("registration-1");
    expect(secureAtDispatch).toContain("\"confirmed\":false");
    expect(secureAtDispatch).not.toContain("private-native-token");
    expect(fixture.controller.snapshot).toMatchObject({ enabled: true, status: "error", error: "sync" });

    fixture.client.registerMobilePush.mockImplementation(async () => ({
      expiresAt: 30 * 24 * 60 * 60 * 1_000
    }));
    await fixture.controller.reconcile();
    expect(fixture.controller.snapshot.status).toBe("registered");
    const confirmed = fixture.storage.secure.get(mobilePushDeviceStoreTesting.registrationsKey) ?? "";
    expect(confirmed).toContain("\"confirmed\":true");

    await fixture.controller.setEnabled(false);
    expect(fixture.client.unregisterMobilePush).toHaveBeenCalledWith(
      "https://node-1.example.test",
      { serverId: "server-1", registrationId: "registration-1", secret: "s".repeat(43) },
      expect.any(AbortSignal)
    );
    expect(fixture.storage.secure.get(mobilePushDeviceStoreTesting.registrationsKey)).toContain("\"registrations\":[]");
  });

  it("compensates an enabled preference at startup without requesting permission again", async () => {
    const fixture = controllerFixture({ enabled: true, permission: granted });
    await fixture.controller.start(() => true);
    expect(fixture.notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(fixture.client.registerMobilePush).toHaveBeenCalledTimes(1);
    expect(fixture.controller.snapshot.status).toBe("registered");
  });

  it("blocks a new profile until the exact old registration is retired", async () => {
    const fixture = controllerFixture({ enabled: true });
    await fixture.controller.start(() => true);
    expect(fixture.client.registerMobilePush).toHaveBeenCalledTimes(1);
    fixture.client.unregisterMobilePush.mockRejectedValue(new Error("offline"));
    fixture.client.setAuthority(authority("2"));
    await fixture.controller.reconcile();
    expect(fixture.client.registerMobilePush).toHaveBeenCalledTimes(1);
    expect(fixture.controller.snapshot).toMatchObject({ status: "error", error: "retirement" });

    fixture.client.unregisterMobilePush.mockResolvedValue(undefined);
    await fixture.controller.reconcile();
    expect(fixture.client.unregisterMobilePush).toHaveBeenLastCalledWith(
      "https://node-1.example.test",
      expect.objectContaining({ serverId: "server-1", registrationId: "registration-1" }),
      expect.any(AbortSignal)
    );
    expect(fixture.client.registerMobilePush).toHaveBeenCalledTimes(2);
    expect(fixture.client.registerMobilePush.mock.calls[1]?.[0]).toMatchObject({ profileId: "profile-2" });
    expect(fixture.controller.snapshot.status).toBe("registered");
  });

  it("re-registers a rotated APNs token with the same precommitted ticket", async () => {
    const fixture = controllerFixture({ enabled: true });
    await fixture.controller.start(() => true);
    const firstTicket = fixture.client.registerMobilePush.mock.calls[0]?.[1].ticket;
    fixture.notifications.emitToken();
    await fixture.controller.reconcile();
    expect(fixture.client.registerMobilePush).toHaveBeenCalledTimes(2);
    expect(fixture.client.registerMobilePush.mock.calls[1]?.[1].ticket).toEqual(firstTicket);
    expect(fixture.client.registerMobilePush.mock.calls[1]?.[1].deviceToken).toBe("rotated-native-token");
  });

  it("suppresses foreground presentation and routes cold/warm responses through one validated callback", async () => {
    const fixture = controllerFixture();
    const intent = "joko://task/session-1?message=message-1&event=event-1";
    const response = {
      notification: { request: { identifier: "push-response-unique", content: { data: { intent } }, trigger: {} } }
    };
    fixture.notifications.setLastResponse(response);
    const offered = vi.fn(() => true);
    await fixture.controller.start(offered);
    await vi.waitFor(() => expect(offered).toHaveBeenCalledWith(intent));
    fixture.notifications.emitResponse(response);
    expect(offered).toHaveBeenCalledTimes(1);
    expect(fixture.notifications.clearLastNotificationResponseAsync).toHaveBeenCalled();
    expect(await fixture.notifications.handler()!.handleNotification()).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false
    });
  });

  it("keeps Android explicitly unsupported without loading the native API", async () => {
    const fixture = controllerFixture({ platform: "android" });
    await fixture.controller.start(() => true);
    expect(fixture.controller.snapshot).toEqual({ enabled: false, saving: false, status: "unsupported-platform" });
    expect(fixture.notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(fixture.client.getMobilePushCapability).not.toHaveBeenCalled();
  });
});
