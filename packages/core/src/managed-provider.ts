import type {
  BackendProviderDescriptor,
  ProviderModel,
  ProviderRuntimeProtocol,
  ProviderRuntimeSupport
} from "./types.js";

/** Private composition authority. None of these objects cross Store or Connect. */
export interface ManagedProviderRouteOwner {
  readonly backendId: string;
  readonly backendInstanceGeneration: number;
  readonly targetId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
}

export interface ManagedProviderOperationLease {
  /** Idempotently revokes only this operation and aborts its in-flight requests. */
  release(): void;
}

/** Exact delegated-model snapshot captured with its independent request lease. */
export interface ManagedProviderSubtaskLease extends ManagedProviderOperationLease {
  readonly model: ProviderModel;
  readonly thinkingLevelMap: Readonly<Record<string, string | null>>;
}

/** A non-secret native configuration template; it cannot authorize HTTP requests. */
export interface ManagedProviderRouteBinding {
  readonly providerId: string;
  readonly model: ProviderModel;
  /** Exact model configuration: null disables an effort; absent keys retain identity mapping. */
  readonly thinkingLevelMap: Readonly<Record<string, string | null>>;
  readonly protocol: ProviderRuntimeProtocol;
  readonly revision: string;
  readonly baseUrl: string;
  readonly apiKeyEnvironment: string;
  /** Check catalog revision/admission before using this template for new work. */
  assertCurrent(): void;
  /** Capture credentials for one already admitted native operation. */
  activate(input: {
    readonly operationId: string;
    readonly signal: AbortSignal;
    /** Synchronous Adapter owner check, repeated at every HTTP dispatch. */
    readonly assertCurrent: () => void;
  }): Promise<ManagedProviderOperationLease>;
  /**
   * Authorize one exact native delegated-task model inside the already-active
   * parent operation. The parent Provider is fixed by this binding; callers
   * cannot use this lease to cross Provider or Backend ownership.
   */
  readonly authorizeSubtask?: (input: {
    readonly operationId: string;
    readonly requestId: string;
    readonly modelId: string;
    readonly signal: AbortSignal;
    /** Synchronous Adapter owner check, repeated at every delegated HTTP dispatch. */
    readonly assertCurrent: () => void;
  }) => Promise<ManagedProviderSubtaskLease>;
  /** Idempotently releases the template and every remaining operation. */
  dispose(): void;
}

/** Adapter-private, injected by the service owning the managed Provider catalog. */
export interface ManagedProviderRuntimePort {
  readonly support: ProviderRuntimeSupport;
  /** Only the proxy credential; inject into the native runtime and strip from tools. */
  readonly environment: Readonly<Record<string, string>>;
  readonly secretEnvironmentNames: readonly string[];
  /** Retire this Backend instance's proxy templates when the Adapter closes. */
  dispose(): void;
  hasProvider(providerId: string): boolean;
  listModels(): readonly ProviderModel[];
  /** Current catalog authority for one exact model; missing identities must fail. */
  getThinkingLevelMap(providerId: string, modelId: string): Readonly<Record<string, string | null>>;
  listProviders(): readonly BackendProviderDescriptor[];
  /** Invalid/disabled managed choices fail; callers must not fall back to native auth. */
  prepare(input: ManagedProviderRouteOwner & {
    readonly providerId: string;
    readonly modelId: string;
  }): Promise<ManagedProviderRouteBinding>;
}
