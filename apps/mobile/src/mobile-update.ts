export const mobileUpdateIdentityMaximumCharacters = 256;
export const mobileUpdateReleaseNotesMaximumCharacters = 4_000;
export const mobileUpdateReloadMaximum = 2;

export type MobileUpdateChannel = "stable" | "beta";
export type MobileUpdatePlatform = "android" | "ios" | "other";

export interface MobileUpdateConfiguration {
  readonly releaseFeedUrl: string | null;
  readonly otaEnabled: boolean;
  readonly betaEnabled: boolean;
}

export interface MobileUpdateRelease {
  readonly version: string;
  readonly runtimeVersion: string;
  readonly installUrl: string;
  readonly releaseNotes?: string;
  readonly minVersion?: string;
}

export interface MobileBundleUpdateEvaluation {
  readonly needsUpdate: boolean;
  readonly forced: boolean;
  readonly target?: MobileUpdateRelease;
}

export interface MobileOtaCheckResult {
  readonly isAvailable: boolean;
  readonly manifestId?: string;
}

export interface MobileOtaFetchResult {
  readonly isNew: boolean;
  readonly manifestId?: string;
}

export interface MobileUpdateRuntimeInfo {
  readonly appVersion: string;
  readonly runtimeVersion?: string;
  readonly updateId?: string;
  readonly channel?: string;
  readonly createdAt?: Date;
  readonly isEnabled: boolean;
  readonly isEmbeddedLaunch: boolean;
  readonly isEmergencyLaunch: boolean;
  readonly emergencyLaunchReason?: string;
}

export interface MobileUpdateRuntime {
  readonly info: MobileUpdateRuntimeInfo;
  configureChannel(channel: MobileUpdateChannel): void;
  checkOta(): Promise<MobileOtaCheckResult>;
  fetchOta(): Promise<MobileOtaFetchResult>;
  reload(): Promise<void>;
  fetchRelease(
    feedUrl: string,
    platform: Exclude<MobileUpdatePlatform, "other">,
    channel: MobileUpdateChannel,
    timeoutMs: number
  ): Promise<unknown | null>;
  openUrl(url: string): Promise<void>;
}

export interface MobileOtaRequestClient {
  check(): Promise<MobileOtaCheckResult>;
  fetch(): Promise<MobileOtaFetchResult>;
  reload(): Promise<void>;
}

export function parseMobileUpdateConfiguration(value: unknown): MobileUpdateConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Joko mobile update configuration is missing.");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys[0] !== "betaEnabled" || keys[1] !== "otaEnabled"
    || keys[2] !== "releaseFeedUrl" || keys[3] !== "version" || record.version !== 1
    || typeof record.otaEnabled !== "boolean" || typeof record.betaEnabled !== "boolean") {
    throw new Error("The Joko mobile update configuration is not the current v1 shape.");
  }
  const releaseFeedUrl = record.releaseFeedUrl === ""
    ? null
    : publicHttpsUrl(record.releaseFeedUrl, "release feed");
  if (record.betaEnabled && releaseFeedUrl === null && !record.otaEnabled) {
    throw new Error("Beta updates require a configured Joko mobile update authority.");
  }
  return Object.freeze({
    releaseFeedUrl,
    otaEnabled: record.otaEnabled,
    betaEnabled: record.betaEnabled
  });
}

export function parseMobileUpdateRelease(value: unknown): MobileUpdateRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Joko mobile release record is not an object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["installUrl", "minVersion", "releaseNotes", "runtimeVersion", "version"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("The Joko mobile release record contains an unknown field.");
  }
  if (!isMobileUpdateVersion(record.version)) {
    throw new Error("The Joko mobile release version is invalid.");
  }
  const runtimeVersion = boundedIdentity(record.runtimeVersion);
  if (runtimeVersion === undefined) throw new Error("The Joko mobile release runtime is invalid.");
  const installUrl = publicHttpsUrl(record.installUrl, "install target");
  const releaseNotes = optionalBoundedText(record.releaseNotes, mobileUpdateReleaseNotesMaximumCharacters);
  const minVersion = record.minVersion === undefined ? undefined : record.minVersion;
  if (minVersion !== undefined && !isMobileUpdateVersion(minVersion)) {
    throw new Error("The Joko mobile minimum version is invalid.");
  }
  return Object.freeze({
    version: record.version,
    runtimeVersion,
    installUrl,
    ...(releaseNotes === undefined ? {} : { releaseNotes }),
    ...(minVersion === undefined ? {} : { minVersion })
  });
}

export function evaluateMobileBundleUpdate(input: {
  readonly currentVersion: string | undefined;
  readonly currentRuntimeVersion: string | undefined;
  readonly release: MobileUpdateRelease;
}): MobileBundleUpdateEvaluation {
  if (!isMobileUpdateVersion(input.currentVersion) || !boundedIdentity(input.currentRuntimeVersion)
    || compareMobileUpdateVersions(input.release.version, input.currentVersion) <= 0) {
    return Object.freeze({ needsUpdate: false, forced: false });
  }
  const forced = input.release.minVersion !== undefined
    && compareMobileUpdateVersions(input.currentVersion, input.release.minVersion) < 0
    && compareMobileUpdateVersions(input.release.version, input.release.minVersion) >= 0;
  if (!forced && input.release.runtimeVersion === input.currentRuntimeVersion) {
    return Object.freeze({ needsUpdate: false, forced: false });
  }
  return Object.freeze({ needsUpdate: true, forced, target: input.release });
}

export function isMobileUpdateVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) return false;
  return value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

export function compareMobileUpdateVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! > b[index]! ? 1 : -1;
  }
  return 0;
}

export function mobileUpdateChannelHeaders(channel: MobileUpdateChannel): Readonly<Record<string, string>> {
  return Object.freeze({ "expo-channel-name": channel });
}

export function mobileUpdateManifestId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { readonly id?: unknown }).id;
  return boundedIdentity(id)?.toLowerCase();
}

export function withMobileUpdateTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mobile-update-timeout(${milliseconds}ms)`)), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** Serializes native update requests and keeps the lease until timed-out native promises actually settle. */
export class MobileUpdateRequestCoordinator {
  #queue: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(private readonly runtime: MobileUpdateRuntime) {}

  get busy(): boolean { return this.#pending > 0; }

  async configure(channel: MobileUpdateChannel): Promise<void> {
    try { await this.run(channel, async () => undefined); }
    finally { await this.waitUntilIdle(); }
  }

  waitUntilIdle(): Promise<void> { return this.#queue; }

  run<T>(channel: MobileUpdateChannel, operation: (client: MobileOtaRequestClient) => Promise<T>): Promise<T> {
    this.#pending += 1;
    const transaction = this.#queue.then(() => this.#start(channel, operation));
    const result = transaction.then((started) => started.result);
    this.#queue = transaction.then((started) => started.drained).then(() => undefined, () => undefined).finally(() => {
      this.#pending -= 1;
    });
    return result;
  }

  async #start<T>(
    channel: MobileUpdateChannel,
    operation: (client: MobileOtaRequestClient) => Promise<T>
  ): Promise<{ readonly result: Promise<T>; readonly drained: Promise<void> }> {
    this.runtime.configureChannel(channel);
    const pending: Promise<unknown>[] = [];
    const track = <R,>(promise: Promise<R>): Promise<R> => {
      pending.push(promise);
      return promise;
    };
    const client: MobileOtaRequestClient = {
      check: () => track(this.runtime.checkOta()),
      fetch: () => track(this.runtime.fetchOta()),
      reload: () => this.runtime.reload()
    };
    const result = Promise.resolve().then(() => operation(client));
    const drained = result.then(() => undefined, () => undefined).then(async () => {
      await Promise.allSettled(pending);
    });
    return { result, drained };
  }
}

function publicHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length > 2_048) {
    throw new Error(`The Joko mobile ${label} URL is invalid.`);
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`The Joko mobile ${label} URL is invalid.`); }
  if (url.protocol !== "https:" || !publicDnsHostname(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new Error(`The Joko mobile ${label} must be public HTTPS without credentials, query, or fragment.`);
  }
  return url.href;
}

function publicDnsHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value.includes(".") && !value.startsWith("[") && !/^\d+(?:\.\d+){3}$/u.test(value)
    && ![".local", ".localhost", ".internal", ".invalid", ".test", ".example", ".home.arpa"]
      .some((suffix) => value === suffix.slice(1) || value.endsWith(suffix));
}

function boundedIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.length >= 1 && value.length <= mobileUpdateIdentityMaximumCharacters
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function optionalBoundedText(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("The Joko mobile release notes are invalid.");
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new Error("The Joko mobile release notes are invalid.");
  }
  return text;
}
