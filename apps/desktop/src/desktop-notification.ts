import type { DesktopNotification } from "./channels.js";

export const MAXIMUM_DESKTOP_NOTIFICATION_TITLE_CHARACTERS = 160;
export const MAXIMUM_DESKTOP_NOTIFICATION_BODY_CHARACTERS = 2_000;
export const MAXIMUM_DESKTOP_NOTIFICATION_IDENTITY_CHARACTERS = 256;

export interface NativeDesktopNotification {
  once(event: "click" | "close" | "failed", listener: () => void): this;
  removeListener(event: "click" | "close" | "failed", listener: () => void): this;
  show(): void;
  close(): void;
}

export interface DesktopNotificationCoordinatorOptions<TOwner> {
  readonly isSupported: () => boolean;
  readonly createNotification: (value: Pick<DesktopNotification, "title" | "body">) => NativeDesktopNotification;
  readonly isApplicationForeground: () => boolean;
  readonly isCurrentOwner: (owner: TOwner, documentOccurrence: string) => boolean;
  readonly activateOwner: (owner: TOwner) => boolean;
  readonly navigate: (navigation: NonNullable<DesktopNotification["navigation"]>) => void;
}

interface ActiveDesktopNotification<TOwner> {
  readonly owner: TOwner;
  readonly documentOccurrence: string;
  readonly notification: NativeDesktopNotification;
  readonly release: () => void;
  readonly close: () => void;
}

/**
 * Owns native notifications for one exact renderer document. A document reload,
 * crash, or replacement closes its outstanding notifications and removes their
 * click authority before a replacement document can become current.
 */
export class DesktopNotificationCoordinator<TOwner> {
  readonly #options: DesktopNotificationCoordinatorOptions<TOwner>;
  readonly #active = new Set<ActiveDesktopNotification<TOwner>>();

  constructor(options: DesktopNotificationCoordinatorOptions<TOwner>) {
    this.#options = options;
  }

  get size(): number {
    return this.#active.size;
  }

  show(owner: TOwner, documentOccurrence: string, value: DesktopNotification): boolean {
    if (!this.#options.isCurrentOwner(owner, documentOccurrence)
      || this.#options.isApplicationForeground()
      || !this.#options.isSupported()) return false;

    const notification = this.#options.createNotification({ title: value.title, body: value.body });
    let released = false;
    let entry: ActiveDesktopNotification<TOwner>;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#active.delete(entry);
      notification.removeListener("click", onClick);
      notification.removeListener("close", release);
      notification.removeListener("failed", release);
    };
    const close = (): void => {
      release();
      try {
        notification.close();
      } catch {
        // Native close is best-effort. Click authority is already retired, and
        // one failed host notification must not block the rest of the owner.
      }
    };
    const onClick = (): void => {
      release();
      if (!this.#options.isCurrentOwner(owner, documentOccurrence)
        || !this.#options.activateOwner(owner)
        || !this.#options.isCurrentOwner(owner, documentOccurrence)) return;
      if (value.navigation !== undefined) this.#options.navigate(value.navigation);
    };
    entry = Object.freeze({ owner, documentOccurrence, notification, release, close });
    notification.once("click", onClick);
    notification.once("close", release);
    notification.once("failed", release);
    this.#active.add(entry);
    try {
      notification.show();
      return true;
    } catch (error) {
      release();
      throw error;
    }
  }

  retireOwner(owner: TOwner, documentOccurrence: string): void {
    for (const entry of [...this.#active]) {
      if (entry.owner === owner && entry.documentOccurrence === documentOccurrence) entry.close();
    }
  }

  dispose(): void {
    for (const entry of [...this.#active]) entry.close();
    this.#active.clear();
  }
}

export function parseDesktopNotification(value: unknown): DesktopNotification {
  if (!exactRecord(value)) throw new TypeError("Desktop notification must be an exact object.");
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "body,title" && keys !== "body,navigation,title") {
    throw new TypeError("Desktop notification must contain only title, body, and optional navigation.");
  }
  if (!notificationText(value["title"], 1, MAXIMUM_DESKTOP_NOTIFICATION_TITLE_CHARACTERS, true)
    || !notificationText(value["body"], 0, MAXIMUM_DESKTOP_NOTIFICATION_BODY_CHARACTERS, false)) {
    throw new TypeError("Desktop notification text is invalid.");
  }
  const navigation = keys === "body,navigation,title"
    ? parseDesktopNotificationNavigation(value["navigation"])
    : undefined;
  return Object.freeze({
    title: value["title"],
    body: value["body"],
    ...(navigation === undefined ? {} : { navigation })
  });
}

function parseDesktopNotificationNavigation(value: unknown): NonNullable<DesktopNotification["navigation"]> {
  if (!exactRecord(value) || Object.keys(value).sort().join(",") !== "kind,profileId,sessionId"
    || value["kind"] !== "session"
    || !notificationIdentity(value["profileId"])
    || !notificationIdentity(value["sessionId"])) {
    throw new TypeError("Desktop notification navigation must identify one exact machine task.");
  }
  return Object.freeze({ kind: "session", profileId: value["profileId"], sessionId: value["sessionId"] });
}

function exactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notificationText(
  value: unknown,
  minimumCharacters: number,
  maximumCharacters: number,
  requireNonWhitespace: boolean
): value is string {
  return typeof value === "string" && value.length >= minimumCharacters && value.length <= maximumCharacters
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && (!requireNonWhitespace || value.trim().length > 0);
}

function notificationIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1
    && value.length <= MAXIMUM_DESKTOP_NOTIFICATION_IDENTITY_CHARACTERS
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
