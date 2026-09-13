import { randomUUID } from "node:crypto";

export interface BrowserLeaseFence {
  readonly id: string;
  readonly providerId: string;
  readonly owner: string;
  readonly generation: number;
}

/** Exclusive, generation-fenced control granted to an agent/tool caller. */
export interface BrowserLease extends BrowserLeaseFence {
  readonly mode: "agent";
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export class BrowserLeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserLeaseConflictError";
  }
}

/**
 * Holds the single agent control lease for one Browser Provider.
 *
 * Human takeover is deliberately not represented by this registry. A human
 * takeover has a stronger page-bound fence and lives in BrowserTakeoverRegistry.
 */
export class BrowserLeaseRegistry {
  #lease: BrowserLease | undefined;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  acquire(
    binding: Pick<BrowserLeaseFence, "providerId" | "owner" | "generation">,
    ttlMs: number
  ): BrowserLease {
    validateAgentLeaseBinding(binding);
    validateAgentTtl(ttlMs);
    const current = this.current();
    if (current !== undefined && !sameBinding(current, binding)) {
      throw new BrowserLeaseConflictError("Browser Provider already has an active agent control lease.");
    }
    const now = this.#now();
    this.#lease = {
      id: current?.id ?? randomUUID(),
      providerId: binding.providerId,
      owner: binding.owner,
      generation: binding.generation,
      mode: "agent",
      acquiredAt: current?.acquiredAt ?? now,
      expiresAt: now + ttlMs
    };
    return this.#lease;
  }

  renew(fence: BrowserLeaseFence, ttlMs: number): BrowserLease {
    validateAgentTtl(ttlMs);
    const current = this.assert(fence);
    this.#lease = { ...current, expiresAt: this.#now() + ttlMs };
    return this.#lease;
  }

  release(fence: BrowserLeaseFence): void {
    this.assert(fence);
    this.#lease = undefined;
  }

  fence(minimumGeneration: number): void {
    validateGeneration(minimumGeneration);
    const current = this.current();
    if (current !== undefined && current.generation < minimumGeneration) this.#lease = undefined;
  }

  assert(fence: BrowserLeaseFence): BrowserLease {
    validateAgentLeaseFence(fence);
    const current = this.current();
    if (current === undefined || !sameFence(current, fence)) {
      throw new BrowserLeaseConflictError("Browser agent lease is missing, expired, or fenced.");
    }
    return current;
  }

  current(): BrowserLease | undefined {
    if (this.#lease !== undefined && this.#lease.expiresAt <= this.#now()) this.#lease = undefined;
    return this.#lease;
  }
}

function sameBinding(
  left: Pick<BrowserLeaseFence, "providerId" | "owner" | "generation">,
  right: Pick<BrowserLeaseFence, "providerId" | "owner" | "generation">
): boolean {
  return left.providerId === right.providerId && left.owner === right.owner && left.generation === right.generation;
}

function sameFence(left: BrowserLeaseFence, right: BrowserLeaseFence): boolean {
  return left.id === right.id && sameBinding(left, right);
}

function validateAgentLeaseBinding(binding: Pick<BrowserLeaseFence, "providerId" | "owner" | "generation">): void {
  validateOpaqueId(binding.providerId, "Browser Provider ID");
  validateOpaqueId(binding.owner, "Browser lease owner");
  validateGeneration(binding.generation);
}

function validateAgentLeaseFence(fence: BrowserLeaseFence): void {
  validateAgentLeaseBinding(fence);
  validateOpaqueId(fence.id, "Browser lease ID");
}

function validateAgentTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60 * 1_000) {
    throw new RangeError("Browser agent lease TTL must be between one second and one hour.");
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
