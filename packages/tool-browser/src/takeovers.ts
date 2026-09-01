import { randomUUID } from "node:crypto";

export interface BrowserTakeoverRequest {
  readonly providerId: string;
  readonly pageId: string;
  readonly generation: number;
  readonly owner: string;
}

/** Complete capability and concurrency fence for one human takeover. */
export interface BrowserTakeoverFence extends BrowserTakeoverRequest {
  readonly takeoverId: string;
}

export interface BrowserTakeover extends BrowserTakeoverFence {
  readonly startedAt: number;
  readonly expiresAt: number;
}

export class BrowserTakeoverConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserTakeoverConflictError";
  }
}

export class BrowserTakeoverInputError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserTakeoverInputError";
  }
}

export class BrowserTakeoverRateLimitError extends Error {
  constructor(message = "Browser human takeover input rate exceeded.") {
    super(message);
    this.name = "BrowserTakeoverRateLimitError";
  }
}

export type BrowserTakeoverMouseButton = "primary" | "middle" | "secondary";

export type BrowserTakeoverKeyModifier = "Alt" | "Control" | "Meta" | "Shift";

export type BrowserTakeoverCharacterKey =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z"
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export type BrowserTakeoverKey =
  | "Enter"
  | "Tab"
  | "Escape"
  | "Backspace"
  | "Delete"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Space"
  | BrowserTakeoverCharacterKey;

export type BrowserTakeoverNavigationCommand = "back" | "forward" | "reload" | "stop";

export type BrowserTakeoverInput =
  | {
    readonly type: "mouseClick";
    readonly normalizedX: number;
    readonly normalizedY: number;
    readonly button: BrowserTakeoverMouseButton;
    readonly clickCount?: 1 | 2;
  }
  | { readonly type: "mouseMove"; readonly normalizedX: number; readonly normalizedY: number }
  | {
    readonly type: "mouseDrag";
    readonly startNormalizedX: number;
    readonly startNormalizedY: number;
    readonly endNormalizedX: number;
    readonly endNormalizedY: number;
    readonly button: BrowserTakeoverMouseButton;
  }
  | { readonly type: "scroll"; readonly deltaX: number; readonly deltaY: number }
  | {
    readonly type: "keyPress";
    readonly key: BrowserTakeoverKey;
    readonly modifiers?: readonly BrowserTakeoverKeyModifier[];
  }
  | { readonly type: "textInput"; readonly text: string }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "navigationCommand"; readonly command: BrowserTakeoverNavigationCommand };

const ALLOWED_TAKEOVER_KEYS = new Set<BrowserTakeoverKey>([
  "Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space",
  ...([..."abcdefghijklmnopqrstuvwxyz0123456789"] as BrowserTakeoverCharacterKey[])
]);

const ALLOWED_MOUSE_BUTTONS = new Set<BrowserTakeoverMouseButton>(["primary", "middle", "secondary"]);
const ALLOWED_KEY_MODIFIERS = new Set<BrowserTakeoverKeyModifier>(["Alt", "Control", "Meta", "Shift"]);
const ALLOWED_NAVIGATION_COMMANDS = new Set<BrowserTakeoverNavigationCommand>(["back", "forward", "reload", "stop"]);

export function validateTakeoverInput(input: BrowserTakeoverInput): void {
  if (input === null || typeof input !== "object") {
    throw new BrowserTakeoverInputError("Browser takeover input is required.");
  }
  switch (input.type) {
  case "mouseClick":
    validateNormalizedCoordinate(input.normalizedX, "x");
    validateNormalizedCoordinate(input.normalizedY, "y");
    if (!ALLOWED_MOUSE_BUTTONS.has(input.button)) {
      throw new BrowserTakeoverInputError("Browser takeover mouse button is not allowed.");
    }
    if (input.clickCount !== undefined && input.clickCount !== 1 && input.clickCount !== 2) {
      throw new BrowserTakeoverInputError("Browser takeover click count must be one or two.");
    }
    return;
  case "scroll":
    validateWheelDelta(input.deltaX, "x");
    validateWheelDelta(input.deltaY, "y");
    if (input.deltaX === 0 && input.deltaY === 0) {
      throw new BrowserTakeoverInputError("Browser takeover scroll must move on at least one axis.");
    }
    return;
  case "keyPress":
    if (!ALLOWED_TAKEOVER_KEYS.has(input.key)) {
      throw new BrowserTakeoverInputError("Browser takeover key is not allowed.");
    }
    validateKeyModifiers(input.modifiers ?? []);
    return;
  case "textInput":
    if (input.text.length === 0 || input.text.length > 4_096 || Buffer.byteLength(input.text, "utf8") > 16_384) {
      throw new BrowserTakeoverInputError("Browser takeover text must contain between 1 and 4,096 characters.");
    }
    if (input.text.includes("\u0000")) {
      throw new BrowserTakeoverInputError("Browser takeover text cannot contain NUL characters.");
    }
    return;
  case "mouseMove":
    validateNormalizedCoordinate(input.normalizedX, "x");
    validateNormalizedCoordinate(input.normalizedY, "y");
    return;
  case "mouseDrag":
    validateNormalizedCoordinate(input.startNormalizedX, "start x");
    validateNormalizedCoordinate(input.startNormalizedY, "start y");
    validateNormalizedCoordinate(input.endNormalizedX, "end x");
    validateNormalizedCoordinate(input.endNormalizedY, "end y");
    if (!ALLOWED_MOUSE_BUTTONS.has(input.button)) {
      throw new BrowserTakeoverInputError("Browser takeover mouse button is not allowed.");
    }
    if (input.startNormalizedX === input.endNormalizedX && input.startNormalizedY === input.endNormalizedY) {
      throw new BrowserTakeoverInputError("Browser takeover drag must move the pointer.");
    }
    return;
  case "navigate":
    validateTakeoverNavigationUrl(input.url);
    return;
  case "navigationCommand":
    if (!ALLOWED_NAVIGATION_COMMANDS.has(input.command)) {
      throw new BrowserTakeoverInputError("Browser takeover navigation command is not allowed.");
    }
    return;
  default:
    throw new BrowserTakeoverInputError("Browser takeover input type is not allowed.");
  }
}

function validateKeyModifiers(modifiers: readonly BrowserTakeoverKeyModifier[]): void {
  if (modifiers.length > ALLOWED_KEY_MODIFIERS.size || new Set(modifiers).size !== modifiers.length) {
    throw new BrowserTakeoverInputError("Browser takeover key modifiers must be unique and bounded.");
  }
  if (modifiers.some((modifier) => !ALLOWED_KEY_MODIFIERS.has(modifier))) {
    throw new BrowserTakeoverInputError("Browser takeover key modifier is not allowed.");
  }
}

/** Normalizes the deliberately narrow URL surface accepted from the durable human-control channel. */
export function validateTakeoverNavigationUrl(value: string): string {
  if (value.length === 0 || value.length > 8_192 || value.includes("\u0000")) {
    throw new BrowserTakeoverInputError("Browser takeover navigation URL is invalid.");
  }
  if (value === "about:blank") return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserTakeoverInputError("Browser takeover navigation URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BrowserTakeoverInputError("Only HTTP(S) browser takeover navigation is allowed.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new BrowserTakeoverInputError("Credentials must not be embedded in browser URLs.");
  }
  if (url.hash !== "" || [...url.searchParams].some(([name, item]) =>
    /(?:^|[_-])(?:access|auth|bearer|code|credential|jwt|key|password|secret|session|signature|token)(?:$|[_-])/iu.test(name)
    || (item.length >= 32 && /^[A-Za-z0-9._~+/=-]+$/u.test(item)))) {
    throw new BrowserTakeoverInputError("Credential-shaped URL material cannot enter durable Browser operations.");
  }
  return url.href;
}

function validateNormalizedCoordinate(value: number, axis: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new BrowserTakeoverInputError(`Browser takeover normalized ${axis} coordinate must be between 0 and 1.`);
  }
}

function validateWheelDelta(value: number, axis: string): void {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 10_000) {
    throw new BrowserTakeoverInputError(`Browser takeover ${axis} wheel delta must be an integer between -10,000 and 10,000.`);
  }
}

/** Stores one page-bound human takeover and checks every component of its fence. */
export class BrowserTakeoverRegistry {
  #takeover: BrowserTakeover | undefined;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  begin(request: BrowserTakeoverRequest, ttlMs: number): BrowserTakeover {
    validateTakeoverRequest(request);
    validateTakeoverTtl(ttlMs);
    if (this.current() !== undefined) {
      throw new BrowserTakeoverConflictError("Browser Provider already has an active human takeover.");
    }
    const now = this.#now();
    this.#takeover = {
      ...request,
      takeoverId: randomUUID(),
      startedAt: now,
      expiresAt: now + ttlMs
    };
    return this.#takeover;
  }

  assert(fence: BrowserTakeoverFence): BrowserTakeover {
    validateTakeoverFence(fence);
    const current = this.current();
    if (current === undefined || !sameTakeoverFence(current, fence)) {
      throw new BrowserTakeoverConflictError("Browser takeover is missing, expired, or fenced.");
    }
    return current;
  }

  end(fence: BrowserTakeoverFence): BrowserTakeover {
    const current = this.assert(fence);
    this.#takeover = undefined;
    return current;
  }

  /** Invalidates any takeover created before a new runtime generation. */
  fence(minimumGeneration: number): void {
    validateGeneration(minimumGeneration);
    const current = this.current();
    if (current !== undefined && current.generation < minimumGeneration) this.#takeover = undefined;
  }

  /** Invalidates a takeover when its exact native page closes or crashes. */
  fencePage(binding: Pick<BrowserTakeoverRequest, "providerId" | "pageId" | "generation">): void {
    validateOpaqueId(binding.providerId, "Browser Provider ID");
    validateOpaqueId(binding.pageId, "Browser page ID");
    validateGeneration(binding.generation);
    const current = this.current();
    if (
      current !== undefined &&
      current.providerId === binding.providerId &&
      current.pageId === binding.pageId &&
      current.generation === binding.generation
    ) this.#takeover = undefined;
  }

  clear(): void {
    this.#takeover = undefined;
  }

  current(): BrowserTakeover | undefined {
    if (this.#takeover !== undefined && this.#takeover.expiresAt <= this.#now()) this.#takeover = undefined;
    return this.#takeover;
  }
}

export function sameTakeoverFence(left: BrowserTakeoverFence, right: BrowserTakeoverFence): boolean {
  return left.providerId === right.providerId &&
    left.pageId === right.pageId &&
    left.generation === right.generation &&
    left.owner === right.owner &&
    left.takeoverId === right.takeoverId;
}

export function validateTakeoverRequest(request: BrowserTakeoverRequest): void {
  validateOpaqueId(request.providerId, "Browser Provider ID");
  validateOpaqueId(request.pageId, "Browser page ID");
  validateOpaqueId(request.owner, "Browser takeover owner");
  validateGeneration(request.generation);
}

export function validateTakeoverFence(fence: BrowserTakeoverFence): void {
  validateTakeoverRequest(fence);
  validateOpaqueId(fence.takeoverId, "Browser takeover ID");
}

export function validateTakeoverTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) {
    throw new RangeError("Browser takeover TTL must be between one second and 24 hours.");
  }
}

function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new RangeError("Browser generation must be a positive safe integer.");
  }
}

function validateOpaqueId(value: string, label: string): void {
  if (value.trim() === "" || value.length > 1_024) throw new TypeError(`${label} must be a non-empty opaque identifier.`);
}
