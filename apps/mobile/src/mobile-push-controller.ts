import type { MobilePushAuthority, MobilePushLifecycleScope } from "./mobile-client";
import type { MobilePushRevocationTicket } from "./network";
import type { NativeNotificationsApi } from "./native-notifications.types";
import {
  MobilePushDeviceStore,
  type MobilePushStoredEnvironment,
  type MobilePushStoredLocale,
  type MobilePushStoredRegistration
} from "./mobile-push-device-store";
import {
  mobileNotificationResponseKey,
  parseMobileNotificationResponseIntent
} from "./mobile-notification-intent";

const RETIRE_TIMEOUT_MS = 5_000;
const REGISTER_TIMEOUT_MS = 10_000;
const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const CONSUMED_RESPONSE_LIMIT = 256;
const consumedResponseKeys = new Set<string>();

export type MobilePushControllerStatus =
  | "loading"
  | "disabled"
  | "waiting"
  | "syncing"
  | "registered"
  | "permission-denied"
  | "unsupported-platform"
  | "unsupported-node"
  | "error";

export type MobilePushControllerError = "storage" | "token" | "sync" | "retirement";

export interface MobilePushControllerState {
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly status: MobilePushControllerStatus;
  readonly error?: MobilePushControllerError;
}

export interface MobilePushClientPort {
  readonly state: { readonly status: string; readonly activeProfileId?: string };
  subscribe(listener: () => void): () => void;
  mobilePushLifecycleScope(): MobilePushLifecycleScope;
  mobilePushAuthority(): MobilePushAuthority | undefined;
  getMobilePushCapability(authority: MobilePushAuthority, signal?: AbortSignal): Promise<{
    readonly supported: boolean;
    readonly unavailableReasonCode?: string;
  }>;
  registerMobilePush(authority: MobilePushAuthority, input: {
    readonly environment: MobilePushStoredEnvironment;
    readonly locale: MobilePushStoredLocale;
    readonly deviceToken: string;
    readonly ticket: MobilePushRevocationTicket;
  }, signal?: AbortSignal): Promise<{ readonly expiresAt: number }>;
  unregisterMobilePush(origin: string, ticket: MobilePushRevocationTicket, signal?: AbortSignal): Promise<void>;
}

export interface MobilePushControllerOptions {
  readonly platform: string;
  readonly environment: MobilePushStoredEnvironment;
  readonly locale: MobilePushStoredLocale;
  readonly client: MobilePushClientPort;
  readonly deviceStore: MobilePushDeviceStore;
  readonly notifications: NativeNotificationsApi;
  readonly digest: (value: string) => Promise<string>;
  readonly registrationId: () => string | Promise<string>;
  readonly revocationSecret: () => string | Promise<string>;
  readonly now?: () => number;
}

type NotificationResponse = Parameters<
  Parameters<NativeNotificationsApi["addNotificationResponseReceivedListener"]>[0]
>[0];

/** Coordinates one device-private opt-in with one exact live Mobile authority.
 * Every registration ticket is durable before the token leaves the device, so
 * ambiguous replies can always be retired without replaying another profile. */
export class MobilePushController {
  readonly #client: MobilePushClientPort;
  readonly #deviceStore: MobilePushDeviceStore;
  readonly #digest: (value: string) => Promise<string>;
  readonly #environment: MobilePushStoredEnvironment;
  readonly #notifications: NativeNotificationsApi;
  readonly #now: () => number;
  readonly #platform: string;
  readonly #registrationId: () => string | Promise<string>;
  readonly #revocationSecret: () => string | Promise<string>;
  #activeController: AbortController | undefined;
  #enabled = false;
  #foreground = true;
  #interactive = true;
  #generation = 0;
  #hydrated = false;
  #lastAuthorityObservation = "";
  #listeners = new Set<() => void>();
  #locale: MobilePushStoredLocale;
  #offerIntent: ((intent: string) => boolean | void) | undefined;
  #pendingResponse: NotificationResponse | undefined;
  #removeClient: (() => void) | undefined;
  #responseSubscription: { remove(): void } | undefined;
  #started = false;
  #state: MobilePushControllerState;
  #tail: Promise<void> = Promise.resolve();
  #tokenSubscription: { remove(): void } | undefined;

  constructor(options: MobilePushControllerOptions) {
    this.#platform = options.platform;
    this.#environment = options.environment;
    this.#locale = options.locale;
    this.#client = options.client;
    this.#deviceStore = options.deviceStore;
    this.#notifications = options.notifications;
    this.#digest = options.digest;
    this.#registrationId = options.registrationId;
    this.#revocationSecret = options.revocationSecret;
    this.#now = options.now ?? Date.now;
    this.#state = Object.freeze({
      enabled: false,
      saving: false,
      status: this.#platform === "ios" ? "loading" : "unsupported-platform"
    });
  }

  get snapshot(): MobilePushControllerState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(offerIntent: (intent: string) => boolean | void, foreground = true): Promise<void> {
    this.#offerIntent = offerIntent;
    if (this.#started) return;
    this.#started = true;
    this.#foreground = foreground;
    this.#interactive = foreground;
    this.#generation += 1;
    if (this.#platform !== "ios") {
      this.#publish({ enabled: false, saving: false, status: "unsupported-platform" });
      return;
    }
    this.#notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false
      })
    });
    this.#responseSubscription = this.#notifications.addNotificationResponseReceivedListener((response) => {
      this.#consumeResponse(response);
    });
    this.#tokenSubscription = this.#notifications.addPushTokenListener(() => {
      if (this.#enabled && this.#foreground) void this.reconcile();
    });
    this.#removeClient = this.#client.subscribe(() => this.#handleClientChange());
    if (this.#interactive) void this.#readLastResponse();
    try {
      const snapshot = await this.#deviceStore.hydrate();
      if (!this.#started) return;
      this.#hydrated = true;
      this.#enabled = snapshot.enabled;
      this.#publish({
        enabled: this.#enabled,
        saving: false,
        status: this.#enabled ? "waiting" : "disabled"
      });
      await this.reconcile();
    } catch {
      if (this.#started) {
        this.#enabled = false;
        this.#publish({ enabled: false, saving: false, status: "error", error: "storage" });
      }
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    this.#generation += 1;
    this.#activeController?.abort();
    this.#activeController = undefined;
    this.#removeClient?.();
    this.#removeClient = undefined;
    this.#responseSubscription?.remove();
    this.#responseSubscription = undefined;
    this.#tokenSubscription?.remove();
    this.#tokenSubscription = undefined;
    this.#offerIntent = undefined;
    this.#pendingResponse = undefined;
  }

  setLocale(locale: MobilePushStoredLocale): void {
    if (this.#locale === locale) return;
    this.#locale = locale;
    if (this.#enabled && this.#started && this.#foreground) void this.reconcile();
  }

  handleAppStateChange(state: string): void {
    // `inactive` is a transient interaction fence on iOS, including the
    // permission sheet used by this controller. Only a real background event
    // retires registration work.
    if (state !== "active") this.#interactive = false;
    if (state === "background") {
      if (!this.#foreground) return;
      this.#foreground = false;
      this.#generation += 1;
      this.#activeController?.abort();
      this.#activeController = undefined;
      return;
    }
    if (state !== "active") return;
    if (this.#interactive && this.#foreground) return;
    const resumed = !this.#foreground;
    this.#foreground = true;
    this.#interactive = true;
    const pending = this.#pendingResponse;
    this.#pendingResponse = undefined;
    if (pending) this.#consumeResponse(pending);
    void this.#readLastResponse();
    if (resumed && this.#enabled) void this.reconcile();
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#platform !== "ios" || !this.#hydrated) {
        if (this.#platform !== "ios") {
          this.#publish({ enabled: false, saving: false, status: "unsupported-platform" });
          return;
        }
        throw new Error("Notification settings are unavailable.");
      }
      if (enabled === this.#enabled) {
        await this.#reconcileNow();
        return;
      }
      this.#publish({ ...this.#state, saving: true, error: undefined });
      if (enabled) {
        let permission = await this.#notifications.getPermissionsAsync();
        if (!permission.granted) permission = await this.#notifications.requestPermissionsAsync();
        if (!permission.granted) {
          this.#publish({ enabled: false, saving: false, status: "permission-denied" });
          return;
        }
        await this.#deviceStore.setEnabled(true);
        this.#enabled = true;
        this.#publish({ enabled: true, saving: true, status: "syncing" });
      } else {
        await this.#deviceStore.setEnabled(false);
        this.#enabled = false;
        this.#generation += 1;
        this.#activeController?.abort();
        this.#activeController = undefined;
        this.#publish({ enabled: false, saving: true, status: "disabled" });
      }
      await this.#reconcileNow();
      this.#publish({ ...this.#state, enabled: this.#enabled, saving: false });
    }).catch((error) => {
      this.#publish({ enabled: this.#enabled, saving: false, status: "error", error: "storage" });
      throw error;
    });
  }

  reconcile(): Promise<void> {
    return this.#enqueue(() => this.#reconcileNow());
  }

  #handleClientChange(): void {
    const scope = this.#client.mobilePushLifecycleScope();
    const authority = this.#client.mobilePushAuthority();
    const observation = `${scope.ready ? "1" : "0"}\u001f${scope.activeProfileId ?? ""}\u001f${authority?.key ?? ""}`;
    if (observation === this.#lastAuthorityObservation) return;
    this.#lastAuthorityObservation = observation;
    this.#generation += 1;
    this.#activeController?.abort();
    this.#activeController = undefined;
    if (this.#started && this.#foreground && this.#hydrated) void this.reconcile();
  }

  async #reconcileNow(): Promise<void> {
    if (!this.#started || !this.#foreground || !this.#hydrated || this.#platform !== "ios") return;
    const scope = this.#client.mobilePushLifecycleScope();
    if (!scope.ready) {
      this.#publish({ enabled: this.#enabled, saving: this.#state.saving, status: this.#enabled ? "waiting" : "disabled" });
      return;
    }
    const authority = this.#client.mobilePushAuthority();
    const records = [...this.#deviceStore.snapshot.registrations];
    const retired = records.filter((record) => {
      if (!this.#enabled || scope.activeProfileId === undefined) return true;
      if (record.profileId !== scope.activeProfileId) return true;
      return authority !== undefined && !recordMatchesAuthority(record, authority);
    });
    let retirementFailed = false;
    for (const record of retired) {
      if (!await this.#retire(record)) retirementFailed = true;
    }
    if (!this.#enabled) {
      this.#publish({
        enabled: false,
        saving: this.#state.saving,
        status: "disabled",
        ...(retirementFailed ? { error: "retirement" as const } : {})
      });
      return;
    }
    if (retirementFailed) {
      this.#publish({ enabled: true, saving: this.#state.saving, status: "error", error: "retirement" });
      return;
    }
    if (!authority) {
      this.#publish({ enabled: true, saving: this.#state.saving, status: "waiting" });
      return;
    }

    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#activeController?.abort();
    this.#activeController = controller;
    const timer = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);
    const current = (): boolean => this.#started && this.#foreground && this.#enabled
      && generation === this.#generation && !controller.signal.aborted
      && this.#client.mobilePushAuthority()?.key === authority.key;
    this.#publish({ enabled: true, saving: this.#state.saving, status: "syncing" });
    try {
      const capability = await this.#client.getMobilePushCapability(authority, controller.signal);
      if (!current()) return;
      if (!capability.supported) {
        this.#publish({ enabled: true, saving: this.#state.saving, status: "unsupported-node" });
        return;
      }
      const permission = await this.#notifications.getPermissionsAsync();
      if (!current()) return;
      if (!permission.granted) {
        this.#publish({ enabled: true, saving: this.#state.saving, status: "permission-denied" });
        return;
      }
      const nativeToken = await this.#notifications.getDevicePushTokenAsync();
      if (!current()) return;
      const token = normalizedToken(nativeToken.data);
      if (!token) {
        this.#publish({ enabled: true, saving: this.#state.saving, status: "error", error: "token" });
        return;
      }
      const tokenDigest = (await this.#digest(token)).toLocaleLowerCase("en-US");
      if (!current()) return;
      if (!/^[0-9a-f]{64}$/u.test(tokenDigest)) throw new Error("The notification token digest is invalid.");
      let record = this.#deviceStore.snapshot.registrations.find((item) => recordMatchesAuthority(item, authority));
      if (record?.confirmed && record.environment === this.#environment && record.locale === this.#locale
        && record.tokenDigest === tokenDigest && record.expiresAt > this.#now() + RENEWAL_WINDOW_MS) {
        this.#publish({ enabled: true, saving: this.#state.saving, status: "registered" });
        return;
      }
      if (!record) {
        record = {
          profileId: authority.profileId,
          origin: authority.origin,
          serverId: authority.serverId,
          connectionId: authority.connectionId,
          deviceId: authority.deviceId,
          registrationId: await this.#registrationId(),
          secret: await this.#revocationSecret(),
          environment: this.#environment,
          locale: this.#locale,
          tokenDigest,
          confirmed: false,
          expiresAt: 0
        };
      } else {
        record = {
          ...record,
          environment: this.#environment,
          locale: this.#locale,
          tokenDigest,
          confirmed: false
        };
      }
      if (!current()) return;
      await this.#deviceStore.putRegistration(record);
      if (!current()) return;
      const result = await this.#client.registerMobilePush(authority, {
        environment: this.#environment,
        locale: this.#locale,
        deviceToken: token,
        ticket: ticketOf(record)
      }, controller.signal);
      if (!current()) return;
      const confirmed = { ...record, confirmed: true, expiresAt: result.expiresAt };
      await this.#deviceStore.putRegistration(confirmed);
      if (current()) this.#publish({ enabled: true, saving: this.#state.saving, status: "registered" });
    } catch {
      if (current()) this.#publish({ enabled: true, saving: this.#state.saving, status: "error", error: "sync" });
    } finally {
      clearTimeout(timer);
      if (this.#activeController === controller) this.#activeController = undefined;
    }
  }

  async #retire(record: MobilePushStoredRegistration): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RETIRE_TIMEOUT_MS);
    try {
      await this.#client.unregisterMobilePush(record.origin, ticketOf(record), controller.signal);
      await this.#deviceStore.removeRegistration(record.serverId, record.registrationId);
      return true;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }

  #consumeResponse(response: NotificationResponse): void {
    if (!this.#interactive) {
      this.#pendingResponse = response;
      return;
    }
    const intent = parseMobileNotificationResponseIntent(response);
    if (!intent) return;
    const key = mobileNotificationResponseKey(response, intent);
    if (consumedResponseKeys.has(key)) return;
    if (consumedResponseKeys.size >= CONSUMED_RESPONSE_LIMIT) {
      const oldest = consumedResponseKeys.values().next().value as string | undefined;
      if (oldest !== undefined) consumedResponseKeys.delete(oldest);
    }
    consumedResponseKeys.add(key);
    this.#offerIntent?.(intent);
    void this.#notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  }

  async #readLastResponse(): Promise<void> {
    if (!this.#started || !this.#interactive || this.#platform !== "ios") return;
    try {
      const response = await this.#notifications.getLastNotificationResponseAsync();
      if (response) this.#consumeResponse(response);
    } catch { /* A later foreground transition retries the native last-response read. */ }
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #publish(next: MobilePushControllerState): void {
    this.#state = Object.freeze(next);
    for (const listener of this.#listeners) listener();
  }
}

function recordMatchesAuthority(record: MobilePushStoredRegistration, authority: MobilePushAuthority): boolean {
  return record.profileId === authority.profileId && record.origin === authority.origin
    && record.serverId === authority.serverId && record.connectionId === authority.connectionId
    && record.deviceId === authority.deviceId;
}

function ticketOf(record: MobilePushStoredRegistration): MobilePushRevocationTicket {
  return Object.freeze({
    serverId: record.serverId,
    registrationId: record.registrationId,
    secret: record.secret
  });
}

function normalizedToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token.length >= 1 && token.length <= 512 && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(token)
    ? token : undefined;
}
