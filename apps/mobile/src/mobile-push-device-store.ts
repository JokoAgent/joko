export interface MobilePushPlainStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface MobilePushSecureStorage {
  isAvailable(): Promise<boolean>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export type MobilePushStoredEnvironment = "sandbox" | "production";
export type MobilePushStoredLocale = "en" | "zh-CN" | "zh-TW" | "ja" | "ko";

export interface MobilePushStoredRegistration {
  readonly profileId: string;
  readonly origin: string;
  readonly serverId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly registrationId: string;
  readonly secret: string;
  readonly environment: MobilePushStoredEnvironment;
  readonly locale: MobilePushStoredLocale;
  readonly tokenDigest: string;
  readonly confirmed: boolean;
  readonly expiresAt: number;
}

export interface MobilePushDeviceSnapshot {
  readonly enabled: boolean;
  readonly registrations: readonly MobilePushStoredRegistration[];
}

const ENABLED_KEY = "joko.mobile.push.enabled.v1";
const REGISTRATIONS_KEY = "joko.mobile.push.registrations.v1";
const MAXIMUM_REGISTRATIONS = 32;
const RECORD_KEYS = Object.freeze([
  "profileId", "origin", "serverId", "connectionId", "deviceId", "registrationId", "secret",
  "environment", "locale", "tokenDigest", "confirmed", "expiresAt"
] as const);

/** Device-local push state is deliberately split: the opt-in bit is ordinary
 * device storage, while every exact revocation ticket stays in SecureStore. */
export class MobilePushDeviceStore {
  #enabled = false;
  #hydrated = false;
  #registrations: MobilePushStoredRegistration[] = [];

  constructor(
    private readonly plain: MobilePushPlainStorage,
    private readonly secure: MobilePushSecureStorage
  ) {}

  get snapshot(): MobilePushDeviceSnapshot {
    if (!this.#hydrated) throw new Error("Mobile push device state has not been loaded.");
    return Object.freeze({ enabled: this.#enabled, registrations: Object.freeze([...this.#registrations]) });
  }

  async hydrate(): Promise<MobilePushDeviceSnapshot> {
    const [enabledRaw, secureAvailable] = await Promise.all([
      this.plain.getItem(ENABLED_KEY),
      this.secure.isAvailable()
    ]);
    if (enabledRaw !== null && enabledRaw !== "0" && enabledRaw !== "1") {
      throw new Error("The saved notification preference is invalid.");
    }
    if (!secureAvailable) throw new Error("Secure notification registration storage is unavailable.");
    const registrationsRaw = await this.secure.getItem(REGISTRATIONS_KEY);
    const registrations = registrationsRaw === null ? [] : parseRegistrations(registrationsRaw);
    this.#enabled = enabledRaw === "1";
    this.#registrations = registrations;
    this.#hydrated = true;
    return this.snapshot;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.#assertHydrated();
    await this.plain.setItem(ENABLED_KEY, enabled ? "1" : "0");
    this.#enabled = enabled;
  }

  async putRegistration(record: MobilePushStoredRegistration): Promise<void> {
    this.#assertHydrated();
    const normalized = parseRegistration(record);
    const currentIndex = this.#registrations.findIndex((item) => item.profileId === normalized.profileId);
    if (currentIndex < 0 && this.#registrations.length >= MAXIMUM_REGISTRATIONS) {
      throw new Error("Too many pending notification registrations require retirement.");
    }
    const next = currentIndex < 0
      ? [...this.#registrations, normalized]
      : this.#registrations.map((item, index) => index === currentIndex ? normalized : item);
    assertUniqueRegistrations(next);
    await this.#writeRegistrations(next);
  }

  async removeRegistration(serverId: string, registrationId: string): Promise<void> {
    this.#assertHydrated();
    const next = this.#registrations.filter((item) => (
      item.serverId !== serverId || item.registrationId !== registrationId
    ));
    if (next.length === this.#registrations.length) return;
    await this.#writeRegistrations(next);
  }

  async #writeRegistrations(next: readonly MobilePushStoredRegistration[]): Promise<void> {
    await this.secure.setItem(REGISTRATIONS_KEY, JSON.stringify({ version: 1, registrations: next }));
    this.#registrations = [...next];
  }

  #assertHydrated(): void {
    if (!this.#hydrated) throw new Error("Mobile push device state has not been loaded.");
  }
}

function parseRegistrations(raw: string): MobilePushStoredRegistration[] {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("The saved notification registrations are invalid."); }
  if (!plainObject(value) || !exactKeys(value, ["version", "registrations"])
    || value.version !== 1 || !Array.isArray(value.registrations)
    || value.registrations.length > MAXIMUM_REGISTRATIONS) {
    throw new Error("The saved notification registrations are invalid.");
  }
  const registrations = value.registrations.map(parseRegistration);
  assertUniqueRegistrations(registrations);
  return registrations;
}

function parseRegistration(value: unknown): MobilePushStoredRegistration {
  if (!plainObject(value) || !exactKeys(value, RECORD_KEYS)) {
    throw new Error("A saved notification registration is invalid.");
  }
  const profileId = identity(value.profileId);
  const serverId = identity(value.serverId);
  const connectionId = identity(value.connectionId);
  const deviceId = identity(value.deviceId);
  const registrationId = identity(value.registrationId);
  const origin = strictOrigin(value.origin);
  const secret = typeof value.secret === "string" ? value.secret : "";
  const tokenDigest = typeof value.tokenDigest === "string" ? value.tokenDigest : "";
  const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : -1;
  if (!profileId || !serverId || !connectionId || !deviceId || !registrationId || !origin
    || !/^[A-Za-z0-9_-]{43}$/u.test(secret) || !/^[0-9a-f]{64}$/u.test(tokenDigest)
    || !(value.environment === "sandbox" || value.environment === "production")
    || !(value.locale === "en" || value.locale === "zh-CN" || value.locale === "zh-TW"
      || value.locale === "ja" || value.locale === "ko")
    || typeof value.confirmed !== "boolean" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) {
    throw new Error("A saved notification registration is invalid.");
  }
  return Object.freeze({
    profileId,
    origin,
    serverId,
    connectionId,
    deviceId,
    registrationId,
    secret,
    environment: value.environment,
    locale: value.locale,
    tokenDigest,
    confirmed: value.confirmed,
    expiresAt
  });
}

function assertUniqueRegistrations(records: readonly MobilePushStoredRegistration[]): void {
  const profiles = new Set<string>();
  const registrations = new Set<string>();
  for (const record of records) {
    const registrationKey = `${record.serverId}\u001f${record.registrationId}`;
    if (profiles.has(record.profileId) || registrations.has(registrationKey)) {
      throw new Error("Saved notification registrations contain duplicate authority.");
    }
    profiles.add(record.profileId);
    registrations.add(registrationKey);
  }
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && value === value.trim()
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value) ? value : undefined;
}

function strictOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.pathname !== "" && parsed.pathname !== "/")) return undefined;
    return parsed.origin;
  } catch { return undefined; }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

export const mobilePushDeviceStoreTesting = {
  enabledKey: ENABLED_KEY,
  registrationsKey: REGISTRATIONS_KEY,
  parseRegistrations
};
