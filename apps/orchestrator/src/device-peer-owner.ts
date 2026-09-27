import { randomUUID } from "node:crypto";

import {
  DevicePeerRegistryError,
  DevicePeerRouteRegistry,
  type DevicePeerAgentOutcome,
  type DevicePeerCapability,
  type DevicePeerEffectKind,
  type DevicePeerMultiplexEvent,
  type DevicePeerResponseFrame,
  type DevicePeerRouteLease,
  type DevicePeerRouteTransport,
  type RegisteredDevicePeerClaim
} from "@joko/device-peer";
import type {
  ConnectionRecord,
  DeviceControlRelationRecord,
  DeviceRecord,
  OperationalStore
} from "@joko/store";

const REQUIRED_SELECTION_CAPABILITIES = ["files", "process"] as const satisfies readonly DevicePeerCapability[];

export interface DevicePeerSelectionIdentity {
  readonly targetDeviceId: string;
  readonly targetDeviceRevision: bigint;
  readonly relationId: string;
  readonly relationRevision: bigint;
  readonly routeGeneration: number;
}

export interface DevicePeerSelectionView extends DevicePeerSelectionIdentity {
  readonly displayName: string;
  readonly kind: "desktop" | "service";
  readonly platform: string;
  readonly capabilities: readonly DevicePeerCapability[];
}

export interface DevicePeerAuthority {
  /** Present only for controller-facing selection/browse calls. */
  readonly controllerConnectionId?: string;
  readonly controllerDeviceId: string;
  readonly identity: DevicePeerSelectionIdentity;
  readonly capabilities: readonly DevicePeerCapability[];
  assertCurrent(requiredCapabilities?: readonly DevicePeerCapability[]): void;
}

/**
 * Keeps one accepted start-command claim alive while its process, PTY, or
 * forwarding stream is still emitting. Closing the lease retires only the
 * controller-side stream ownership; it never replays or cancels a target
 * effect implicitly.
 */
export interface DevicePeerStreamLease {
  readonly requestId: string;
  readonly response: DevicePeerResponseFrame;
  close(): void;
}

export class DevicePeerAuthorityError extends Error {
  constructor(
    readonly code:
      | "access_revoked"
      | "capability_unavailable"
      | "invalid_identity"
      | "route_unavailable"
      | "stale_authority",
    message: string
  ) {
    super(message);
    this.name = "DevicePeerAuthorityError";
  }
}

/**
 * The sole service-side owner of live Device peer routes. Durable product
 * entities remain in OperationalStore; this owner retains no credential,
 * Target, Workspace, Session, Event, or request payload after a claim ends.
 */
export class DevicePeerOwner {
  readonly #store: OperationalStore;
  readonly #routes: DevicePeerRouteRegistry;

  constructor(options: { readonly store: OperationalStore; readonly routes?: DevicePeerRouteRegistry }) {
    this.#store = options.store;
    this.#routes = options.routes ?? new DevicePeerRouteRegistry();
  }

  registerRoute(
    connection: ConnectionRecord,
    transport: DevicePeerRouteTransport,
    options: { readonly deferredActivation?: boolean } = {}
  ): DevicePeerRouteLease {
    const current = this.#currentConnection(connection);
    const device = this.#store.getDevice(current.deviceId);
    requireAgentDevice(device);
    return this.#routes.registerRoute(device.id, transport, options);
  }

  activateRoute(identity: Pick<DevicePeerRouteLease, "targetDeviceId" | "routeGeneration">): DevicePeerRouteLease {
    return this.#routes.activateRoute(identity);
  }

  retireRoute(
    identity: Pick<DevicePeerRouteLease, "targetDeviceId" | "routeGeneration">,
    reason: "replaced" | "connection_closed" | "authority_changed" | "shutdown"
  ): boolean {
    return this.#routes.retireRoute(identity, reason);
  }

  list(controller: ConnectionRecord): readonly DevicePeerSelectionView[] {
    const current = this.#currentConnection(controller);
    const controllerDevice = this.#store.getDevice(current.deviceId);
    if (controllerDevice.state !== "active") throw accessRevoked();
    const views: DevicePeerSelectionView[] = [];
    for (const route of this.#routes.listRoutes()) {
      if (route.targetDeviceId === current.deviceId || !hasCapabilities(route.capabilities, REQUIRED_SELECTION_CAPABILITIES)) {
        continue;
      }
      const target = this.#store.getDevice(route.targetDeviceId);
      const relation = this.#store.getDeviceControlRelation(current.deviceId, target.id);
      if (!relationIsEffective(controllerDevice, target, relation)) continue;
      views.push(Object.freeze({
        ...selectionIdentity(target, relation, route.routeGeneration),
        displayName: target.name,
        kind: target.kind as "desktop" | "service",
        platform: target.platform,
        capabilities: Object.freeze([...route.capabilities])
      }));
    }
    return Object.freeze(views.sort((left, right) => left.displayName.localeCompare(right.displayName)
      || left.targetDeviceId.localeCompare(right.targetDeviceId)));
  }

  capture(
    controller: ConnectionRecord,
    identity: DevicePeerSelectionIdentity,
    requiredCapabilities: readonly DevicePeerCapability[] = REQUIRED_SELECTION_CAPABILITIES
  ): DevicePeerAuthority {
    validateSelectionIdentity(identity);
    const current = this.#currentConnection(controller);
    if (current.deviceId !== controller.deviceId) throw staleAuthority();
    return this.#authority(controller, controller.deviceId, identity, requiredCapabilities);
  }

  /**
   * Re-resolves a durable Target/Session binding to the current route while
   * retaining the exact controller->target relation chosen at creation.
   * A Connection or route generation is deliberately not durable authority.
   */
  captureBinding(
    controllerDeviceId: string,
    targetDeviceId: string,
    requiredCapabilities: readonly DevicePeerCapability[] = REQUIRED_SELECTION_CAPABILITIES
  ): DevicePeerAuthority {
    const controller = this.#store.getDevice(controllerDeviceId);
    const target = this.#store.getDevice(targetDeviceId);
    const relation = this.#store.getDeviceControlRelation(controller.id, target.id);
    const route = this.#routes.getRoute(target.id);
    if (!relationIsEffective(controller, target, relation)) throw accessRevoked();
    if (route === undefined) throw routeUnavailable();
    if (!hasCapabilities(route.capabilities, requiredCapabilities)) throw capabilityUnavailable();
    return this.#authority(
      undefined,
      controller.id,
      selectionIdentity(target, relation, route.routeGeneration),
      requiredCapabilities
    );
  }

  #authority(
    controller: ConnectionRecord | undefined,
    controllerDeviceId: string,
    identity: DevicePeerSelectionIdentity,
    requiredCapabilities: readonly DevicePeerCapability[]
  ): DevicePeerAuthority {
    const capturedRoute = this.#routes.getRoute(identity.targetDeviceId);
    if (capturedRoute === undefined || capturedRoute.routeGeneration !== identity.routeGeneration) {
      throw routeUnavailable();
    }
    if (!hasCapabilities(capturedRoute.capabilities, requiredCapabilities)) throw capabilityUnavailable();
    const authority = Object.freeze({
      ...(controller === undefined ? {} : { controllerConnectionId: controller.id }),
      controllerDeviceId,
      identity: Object.freeze({ ...identity }),
      capabilities: Object.freeze([...capturedRoute.capabilities]),
      assertCurrent: (required: readonly DevicePeerCapability[] = requiredCapabilities): void => {
        const current = controller === undefined ? undefined : this.#currentConnection(controller);
        if (current !== undefined && current.deviceId !== controllerDeviceId) throw staleAuthority();
        const controllerDevice = this.#store.getDevice(controllerDeviceId);
        const target = this.#store.getDevice(identity.targetDeviceId);
        const relation = this.#store.getDeviceControlRelation(controllerDevice.id, target.id);
        if (target.revision !== identity.targetDeviceRevision || relation.revision !== identity.relationRevision
          || relationId(relation) !== identity.relationId) throw staleAuthority();
        if (!relationIsEffective(controllerDevice, target, relation)) throw accessRevoked();
        const route = this.#routes.getRoute(target.id);
        if (route === undefined || route.routeGeneration !== identity.routeGeneration) throw routeUnavailable();
        if (!hasCapabilities(route.capabilities, required)) throw capabilityUnavailable();
      }
    } satisfies DevicePeerAuthority);
    authority.assertCurrent(requiredCapabilities);
    return authority;
  }

  async dispatch(
    authority: DevicePeerAuthority,
    input: {
      readonly requestId?: string;
      readonly capability: DevicePeerCapability;
      readonly effectKind: DevicePeerEffectKind;
      readonly action: string;
      readonly payload: unknown;
      readonly signal?: AbortSignal;
    }
  ): Promise<DevicePeerResponseFrame> {
    authority.assertCurrent([input.capability]);
    const claim = this.#routes.registerClaim({
      requestId: input.requestId ?? randomUUID(),
      targetDeviceId: authority.identity.targetDeviceId,
      routeGeneration: authority.identity.routeGeneration,
      capability: input.capability,
      effectKind: input.effectKind,
      action: input.action,
      payload: input.payload
    });
    try {
      const response = await this.#routes.dispatch(claim, input.signal);
      try {
        authority.assertCurrent([input.capability]);
      } catch (error) {
        if (response.outcome === "outcome_unknown") return response;
        if (input.effectKind === "side_effect" && response.outcome !== "aborted") {
          return responseFromAuthorityLoss(authority, claim.requestId);
        }
        throw error;
      }
      return response;
    } finally {
      try { this.#routes.forgetClaim(claim); } catch (error) {
        if (!(error instanceof DevicePeerRegistryError)) throw error;
      }
    }
  }

  async dispatchStream(
    authority: DevicePeerAuthority,
    input: {
      readonly requestId?: string;
      readonly capability: DevicePeerCapability;
      readonly effectKind: DevicePeerEffectKind;
      readonly action: string;
      readonly payload: unknown;
      readonly signal?: AbortSignal;
    },
    listener: (event: DevicePeerMultiplexEvent) => void
  ): Promise<DevicePeerStreamLease> {
    authority.assertCurrent([input.capability]);
    const claim = this.#routes.registerClaim({
      requestId: input.requestId ?? randomUUID(),
      targetDeviceId: authority.identity.targetDeviceId,
      routeGeneration: authority.identity.routeGeneration,
      capability: input.capability,
      effectKind: input.effectKind,
      action: input.action,
      payload: input.payload
    });
    let authorityLost = false;
    let subscription!: { dispose(): void };
    subscription = this.#routes.subscribe(authority.identity, (event) => {
      if (event.kind !== "route_closed" && event.requestId !== claim.requestId) return;
      try {
        authority.assertCurrent([input.capability]);
      } catch {
        if (event.kind === "route_closed") {
          listener(event);
          return;
        }
        if (authorityLost) return;
        authorityLost = true;
        subscription.dispose();
        try { this.#routes.suppressStreamClaim(claim); } catch (error) {
          if (!(error instanceof DevicePeerRegistryError)) throw error;
        }
        listener(routeClosedFromAuthorityLoss(authority));
        return;
      }
      listener(event);
    });
    let keepClaim = false;
    try {
      const response = await this.#routes.dispatch(claim, input.signal);
      try {
        authority.assertCurrent([input.capability]);
      } catch (error) {
        if (response.outcome !== "outcome_unknown" && input.effectKind === "side_effect"
          && response.outcome !== "aborted") {
          return this.#streamLease(
            claim,
            subscription,
            responseFromAuthorityLoss(authority, claim.requestId),
            false
          );
        }
        if (response.outcome !== "outcome_unknown") throw error;
      }
      keepClaim = response.outcome === "completed";
      return this.#streamLease(claim, subscription, response, keepClaim);
    } catch (error) {
      subscription.dispose();
      this.#suppressStreamClaim(claim);
      throw error;
    }
  }

  subscribe(
    authority: DevicePeerAuthority,
    listener: (event: DevicePeerMultiplexEvent) => void
  ): { dispose(): void } {
    authority.assertCurrent();
    return this.#routes.subscribe(authority.identity, listener);
  }

  shutdown(): void {
    this.#routes.shutdown();
  }

  #streamLease(
    claim: RegisteredDevicePeerClaim,
    subscription: { dispose(): void },
    response: DevicePeerResponseFrame,
    keepClaim: boolean
  ): DevicePeerStreamLease {
    if (!keepClaim) {
      subscription.dispose();
      this.#suppressStreamClaim(claim);
      return Object.freeze({ requestId: claim.requestId, response, close: () => undefined });
    }
    let closed = false;
    return Object.freeze({
      requestId: claim.requestId,
      response,
      close: (): void => {
        if (closed) return;
        closed = true;
        subscription.dispose();
        this.#suppressStreamClaim(claim);
      }
    });
  }

  #suppressStreamClaim(claim: RegisteredDevicePeerClaim): void {
    try { this.#routes.suppressStreamClaim(claim); } catch (error) {
      if (!(error instanceof DevicePeerRegistryError)) throw error;
    }
  }

  #currentConnection(expected: ConnectionRecord): ConnectionRecord {
    const current = this.#store.getConnection(expected.id);
    if (current.state !== "active" || current.deviceId !== expected.deviceId
      || current.authKeyDigest !== expected.authKeyDigest || current.revision !== expected.revision) {
      throw accessRevoked();
    }
    return current;
  }
}

function selectionIdentity(
  target: DeviceRecord,
  relation: DeviceControlRelationRecord,
  routeGeneration: number
): DevicePeerSelectionIdentity {
  return {
    targetDeviceId: target.id,
    targetDeviceRevision: target.revision,
    relationId: relationId(relation),
    relationRevision: relation.revision,
    routeGeneration
  };
}

function validateSelectionIdentity(identity: DevicePeerSelectionIdentity): void {
  if (identity.targetDeviceId.trim() === "" || identity.targetDeviceId !== identity.targetDeviceId.trim()
    || identity.relationId.trim() === "" || identity.relationId !== identity.relationId.trim()
    || identity.targetDeviceRevision < 1n || identity.relationRevision < 0n
    || !Number.isSafeInteger(identity.routeGeneration) || identity.routeGeneration < 1) {
    throw new DevicePeerAuthorityError("invalid_identity", "The Device peer authority identity is invalid.");
  }
}

function requireAgentDevice(device: DeviceRecord): void {
  if (device.state !== "active" || (device.kind !== "desktop" && device.kind !== "service")) {
    throw new DevicePeerAuthorityError(
      "access_revoked",
      "A Device peer route requires one active Desktop or service Device."
    );
  }
}

function relationIsEffective(
  controller: DeviceRecord,
  target: DeviceRecord,
  relation: DeviceControlRelationRecord
): boolean {
  return controller.state === "active" && target.state === "active"
    && target.id !== controller.id && (target.kind === "desktop" || target.kind === "service")
    && target.remoteControlEnabled && relation.controllerDeviceId === controller.id
    && relation.targetDeviceId === target.id && relation.outboundEnabled && relation.inboundAllowed;
}

function relationId(relation: DeviceControlRelationRecord): string {
  return `${relation.controllerDeviceId}:${relation.targetDeviceId}`;
}

function hasCapabilities(
  actual: readonly DevicePeerCapability[],
  required: readonly DevicePeerCapability[]
): boolean {
  return required.every((capability) => actual.includes(capability));
}

function responseFromAuthorityLoss(
  authority: DevicePeerAuthority,
  requestId: string
): DevicePeerResponseFrame {
  return Object.freeze({
    protocolVersion: 1,
    kind: "response",
    requestId,
    targetDeviceId: authority.identity.targetDeviceId,
    routeGeneration: authority.identity.routeGeneration,
    outcome: "outcome_unknown",
    errorCode: "authority_changed"
  });
}

function routeClosedFromAuthorityLoss(authority: DevicePeerAuthority): DevicePeerMultiplexEvent {
  return Object.freeze({
    protocolVersion: 1,
    kind: "route_closed",
    targetDeviceId: authority.identity.targetDeviceId,
    routeGeneration: authority.identity.routeGeneration,
    reason: "authority_changed"
  });
}

function accessRevoked(): DevicePeerAuthorityError {
  return new DevicePeerAuthorityError("access_revoked", "Device peer access is no longer authorized.");
}

function staleAuthority(): DevicePeerAuthorityError {
  return new DevicePeerAuthorityError("stale_authority", "Device peer authority changed. Refresh the selected Device.");
}

function routeUnavailable(): DevicePeerAuthorityError {
  return new DevicePeerAuthorityError("route_unavailable", "The selected Device peer route is unavailable.");
}

function capabilityUnavailable(): DevicePeerAuthorityError {
  return new DevicePeerAuthorityError("capability_unavailable", "The selected Device peer capability is unavailable.");
}
