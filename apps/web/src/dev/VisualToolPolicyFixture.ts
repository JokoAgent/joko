import type { ToolPolicySettingsView } from "../model.js";

export const VISUAL_TOOL_POLICY_SETTLE_EVENT = "joko-visual-tool-policy-settle";
export const PROVIDER_ID = "visual-ordinary-tools";
export const TARGET_A_ID = "visual-target";
export const TARGET_B_ID = "visual-target-b";
let nextFixtureOwner = 0;

type ToolPolicyPatch = { readonly enabled: boolean } | { readonly reset: true };

export interface VisualToolPolicyAttempt {
  readonly attempt: number;
  readonly toolProviderId: string;
  readonly targetId?: string;
  readonly patch: ToolPolicyPatch;
}

export interface VisualToolPolicyState {
  readonly ownerId: string;
  readonly phase: "ready" | "pending" | "failed" | "confirmed";
  readonly attempts: number;
  readonly failedAttempts: number;
  readonly confirmedAttempts: number;
  readonly policy: ToolPolicySettingsView;
  readonly pending?: VisualToolPolicyAttempt;
}

interface PendingPolicyChange {
  readonly value: VisualToolPolicyAttempt;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function visualToolPolicyInitialPolicy(): ToolPolicySettingsView {
  return {
    toolProviderId: PROVIDER_ID, displayName: "Ordinary tools",
    description: "Control ordinary tools for new tasks with user defaults and project overrides.",
    productDefaultEnabled: true, userEffectiveEnabled: true, userEffectiveSource: "productDefault",
    targetSettings: [TARGET_A_ID, TARGET_B_ID].map((targetId) => ({
      targetId, effectiveEnabled: true, effectiveSource: "productDefault"
    }))
  };
}

/** Development-only typed backend. A settlement never dispatches another policy mutation. */
export class VisualToolPolicyFixture {
  readonly #ownerId = `visual-tool-policy-owner-${++nextFixtureOwner}`;
  readonly #listeners = new Set<(state: VisualToolPolicyState) => void>();
  readonly #onConfirmed: (policy: ToolPolicySettingsView) => void;
  #policy = visualToolPolicyInitialPolicy();
  #phase: VisualToolPolicyState["phase"] = "ready";
  #attempts = 0;
  #failedAttempts = 0;
  #confirmedAttempts = 0;
  #pending?: PendingPolicyChange;

  constructor(onConfirmed: (policy: ToolPolicySettingsView) => void) { this.#onConfirmed = onConfirmed; }

  get policy(): ToolPolicySettingsView { return this.#policy; }
  get state(): VisualToolPolicyState {
    return {
      ownerId: this.#ownerId, phase: this.#phase, attempts: this.#attempts,
      failedAttempts: this.#failedAttempts, confirmedAttempts: this.#confirmedAttempts, policy: this.#policy,
      ...(this.#pending === undefined ? {} : { pending: this.#pending.value })
    };
  }

  subscribe(listener: (state: VisualToolPolicyState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  readonly updateToolPolicySettings = (
    toolProviderId: string,
    targetId: string | undefined,
    patch: ToolPolicyPatch
  ): Promise<void> => {
    if (this.#pending !== undefined) return Promise.reject(new Error("The deterministic tool policy change is already pending."));
    if (toolProviderId !== PROVIDER_ID || targetId !== undefined && targetId !== TARGET_A_ID && targetId !== TARGET_B_ID
      || !validPatch(patch)) return Promise.reject(new Error("The deterministic tool policy source or change is invalid."));
    const value: VisualToolPolicyAttempt = {
      attempt: ++this.#attempts, toolProviderId,
      ...(targetId === undefined ? {} : { targetId }),
      patch: "enabled" in patch ? { enabled: patch.enabled } : { reset: true }
    };
    this.#phase = "pending";
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.value === value) this.#failPending(new Error("The deterministic tool policy request timed out. Retry the change."));
      }, 60_000);
      this.#pending = { value, resolve, reject, timer };
      this.#publish();
    });
  };

  settle(value: unknown): boolean {
    if (!record(value)) return false;
    const pending = this.#pending;
    if (pending === undefined || value.ownerId !== this.#ownerId || value.attempt !== pending.value.attempt
      || value.toolProviderId !== pending.value.toolProviderId || value.targetId !== pending.value.targetId
      || !validPatch(value.patch) || !samePatch(value.patch, pending.value.patch)
      || value.outcome !== "failure" && value.outcome !== "success"
      || Object.keys(value).some((key) => !["ownerId", "attempt", "toolProviderId", "targetId", "patch", "outcome"].includes(key))) return false;
    if (value.outcome === "failure") this.#failPending(new Error("The deterministic tool policy request failed. Retry the change."));
    else {
      clearTimeout(pending.timer);
      this.#pending = undefined;
      this.#policy = applyPatch(this.#policy, pending.value.targetId, pending.value.patch);
      this.#confirmedAttempts += 1;
      this.#phase = "confirmed";
      this.#onConfirmed(this.#policy);
      this.#publish();
      pending.resolve();
    }
    return true;
  }

  /** Retire pending work while preserving confirmed policy and monotonic attempts for StrictMode. */
  cancelPending(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    this.#phase = "ready";
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The deterministic tool policy owner retired."));
    }
    this.#publish();
  }

  #failPending(error: Error): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending = undefined;
    this.#failedAttempts += 1;
    this.#phase = "failed";
    this.#publish();
    pending.reject(error);
  }
  #publish(): void { for (const listener of this.#listeners) listener(this.state); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validPatch(value: unknown): value is ToolPolicyPatch {
  return record(value) && Object.keys(value).length === 1
    && (Object.hasOwn(value, "enabled") && typeof value.enabled === "boolean"
      || Object.hasOwn(value, "reset") && value.reset === true);
}
function samePatch(left: ToolPolicyPatch, right: ToolPolicyPatch): boolean {
  return "enabled" in left ? "enabled" in right && left.enabled === right.enabled : "reset" in right;
}
function applyPatch(policy: ToolPolicySettingsView, targetId: string | undefined, patch: ToolPolicyPatch): ToolPolicySettingsView {
  const userOverride = targetId === undefined
    ? "enabled" in patch ? { enabled: patch.enabled } : undefined
    : policy.userOverride;
  const userEffectiveEnabled = userOverride?.enabled ?? policy.productDefaultEnabled;
  const userEffectiveSource = userOverride === undefined ? "productDefault" : "userDefault";
  return {
    toolProviderId: policy.toolProviderId, displayName: policy.displayName, description: policy.description,
    productDefaultEnabled: policy.productDefaultEnabled, userEffectiveEnabled, userEffectiveSource,
    ...(userOverride === undefined ? {} : { userOverride }),
    targetSettings: policy.targetSettings.map((target) => {
      const projectOverride = targetId === target.targetId
        ? "enabled" in patch ? { enabled: patch.enabled } : undefined
        : target.projectOverride;
      return {
        targetId: target.targetId,
        effectiveEnabled: projectOverride?.enabled ?? userEffectiveEnabled,
        effectiveSource: projectOverride === undefined ? userEffectiveSource : "projectOverride",
        ...(projectOverride === undefined ? {} : { projectOverride })
      };
    })
  };
}
