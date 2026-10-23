import type { NativeNavigationTarget, NativeSessionBinding, NativeSessionDerivationLifecycle, TargetDescriptor } from "@joko/core";
import type { HostedAgentStore } from "@joko/store";

interface NavigationReceipt {
  readonly format: 1;
  readonly operationId: string;
  readonly sourceBinding: NativeSessionBinding;
  readonly binding: NativeSessionBinding;
  readonly target: NativeNavigationTarget;
  readonly sourceRetired: boolean;
}

/** A native replacement stays behind the Source's opaque actor identity. The
 * child is recorded before any further SDK await, and a confirmed source close
 * is the only authority to adopt it. Restart never replays native navigation. */
export class HostedAgentNavigation {
  constructor(private readonly store: HostedAgentStore, private readonly key: string, private readonly leaseId: string) {}
  read(): NavigationReceipt | undefined {
    this.store.assertLease(this.key, this.leaseId);
    const value = this.store.store.findSetting<NavigationReceipt>("service", "native-hosted-navigation.v1", this.key)?.value;
    if (value === undefined) return undefined;
    if (!value || value.format !== 1 || !value.operationId || typeof value.sourceRetired !== "boolean"
      || !validBinding(value.sourceBinding) || !validBinding(value.binding)
      || value.binding.generation !== value.sourceBinding.generation + 1
      || value.binding.opaqueRef === value.sourceBinding.opaqueRef
      || !value.target || value.target.kind !== "session_start" && (value.target.kind !== "native_entry" || !value.target.entryId)
      || Object.keys(value).some(field => !["format", "operationId", "sourceBinding", "binding", "target", "sourceRetired"].includes(field))) {
      throw new Error("The hosted native navigation receipt is invalid.");
    }
    return value;
  }
  record(operationId: string, sourceBinding: NativeSessionBinding, binding: NativeSessionBinding, target: NativeNavigationTarget): void {
    if (this.read() || !operationId || !validBinding(binding) || binding.generation !== sourceBinding.generation + 1
      || binding.opaqueRef === sourceBinding.opaqueRef) throw new Error("The hosted native navigation owner conflicts.");
    this.store.store.setSetting("service", "native-hosted-navigation.v1", this.key,
      { format: 1, operationId, sourceBinding: { ...sourceBinding }, binding: { ...binding }, target: { ...target }, sourceRetired: false } satisfies NavigationReceipt);
  }
  retire(): void {
    const receipt = this.read(); if (!receipt) throw new Error("The hosted native navigation receipt is missing.");
    this.store.store.setSetting("service", "native-hosted-navigation.v1", this.key, { ...receipt, sourceRetired: true });
  }
  complete(binding: NativeSessionBinding): void {
    const receipt = this.read(); if (!receipt || !receipt.sourceRetired || binding.opaqueRef !== receipt.binding.opaqueRef
      || binding.nativeSessionId !== receipt.binding.nativeSessionId || binding.generation !== receipt.binding.generation) {
      throw new Error("The hosted native navigation adoption is unconfirmed.");
    }
    this.store.store.transaction(() => {
      this.store.bind(this.key, this.leaseId, binding); this.clear();
    });
  }
  clear(): void {
    this.store.assertLease(this.key, this.leaseId); this.store.store.deleteSetting("service", "native-hosted-navigation.v1", this.key);
  }
  lifecycle(sessionId: string, target: TargetDescriptor): NativeSessionDerivationLifecycle & { readonly binding: NativeSessionBinding } {
    const receipt = this.read(); if (!receipt) throw new Error("The hosted native navigation receipt is missing.");
    return { operationId: receipt.operationId, kind: "navigate", navigationTarget: receipt.target, sourceSessionId: sessionId,
      sourceBinding: receipt.sourceBinding, sessionId, sourceTarget: target, target, binding: receipt.binding };
  }
}
function validBinding(value: NativeSessionBinding): boolean {
  return !!value && typeof value.opaqueRef === "string" && value.opaqueRef.length > 0 && value.opaqueRef.length <= 16_384
    && Number.isSafeInteger(value.generation) && value.generation >= 0
    && (value.nativeSessionId === undefined || typeof value.nativeSessionId === "string" && value.nativeSessionId.length > 0);
}
