import { createHash } from "node:crypto";

import type {
  BackendDescriptor,
  BackendProviderCredentialSurface,
  BackendProviderDescriptor
} from "@joko/core";
import type { OperationalStore } from "@joko/store";

import {
  CredentialManager,
  type CredentialDescriptor
} from "./credential-manager.js";

export interface ProviderCredentialSurfaceIdentity {
  readonly backendId: string;
  readonly providerId: string;
  readonly surfaceId: string;
}

export interface ResolvedProviderCredentialSurface {
  readonly backend: BackendDescriptor;
  readonly provider: BackendProviderDescriptor;
  readonly surface: BackendProviderCredentialSurface;
  readonly credentialReferenceId: string;
}

export interface ConfiguredProviderCredentialSurface extends ResolvedProviderCredentialSurface {
  readonly credential: CredentialDescriptor;
}

export interface ProviderCredentialSurfaceResolverOptions {
  readonly store: OperationalStore;
  readonly credentials: CredentialManager;
  readonly providerEnabled?: (backendId: string, providerId: string) => boolean;
  readonly modelEnabled?: (backendId: string, providerId: string, modelId: string) => boolean;
}

/** Stable exact-owner reference shared by upload, projection, and dispatch. */
export function providerCredentialSurfaceReference(
  backendId: string,
  providerId: string,
  surfaceId: string
): string {
  const digest = createHash("sha256")
    .update(backendId)
    .update("\0")
    .update(providerId)
    .update("\0")
    .update(surfaceId)
    .digest("hex")
    .slice(0, 32);
  return `cred_surface_${digest}`;
}

export function reserveProviderCredentialSurface(
  credentials: CredentialManager | undefined,
  identity: ProviderCredentialSurfaceIdentity,
  surface: BackendProviderCredentialSurface
): string {
  const credentialReferenceId = providerCredentialSurfaceReference(
    identity.backendId,
    identity.providerId,
    identity.surfaceId
  );
  credentials?.reserveManagedSecret({
    credentialReferenceId,
    kind: surface.kind,
    providerId: identity.providerId
  });
  return credentialReferenceId;
}

/** Resolve only an explicitly declared exact surface; duplicate declarations fail closed. */
export function resolveDeclaredProviderCredentialSurface(
  store: OperationalStore,
  credentials: CredentialManager | undefined,
  identity: ProviderCredentialSurfaceIdentity
): ResolvedProviderCredentialSurface | undefined {
  let backend: BackendDescriptor;
  try {
    backend = store.getBackend(identity.backendId).descriptor;
  } catch {
    return undefined;
  }
  const provider = declaredProviderCredentialSurfaces(backend)
    .find((candidate) => candidate.provider.providerId === identity.providerId)?.provider;
  if (provider === undefined) return undefined;
  const matches = provider.credentialSurfaces!.filter((candidate) =>
    candidate.surfaceId === identity.surfaceId);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new Error("Provider credential surface is duplicated.");
  const surface = matches[0]!;
  return {
    backend,
    provider,
    surface,
    credentialReferenceId: reserveProviderCredentialSurface(credentials, identity, surface)
  };
}

/**
 * Service-owned resolver. Plaintext is returned only to the service execution
 * caller and is never part of a descriptor, event, or bridge argument.
 */
export class ProviderCredentialSurfaceResolver {
  readonly #store: OperationalStore;
  readonly #credentials: CredentialManager;
  readonly #providerEnabled: (backendId: string, providerId: string) => boolean;
  readonly #modelEnabled: (backendId: string, providerId: string, modelId: string) => boolean;

  constructor(options: ProviderCredentialSurfaceResolverOptions) {
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#providerEnabled = options.providerEnabled ?? (() => true);
    this.#modelEnabled = options.modelEnabled ?? (() => true);
  }

  listConfigured(input: {
    readonly capability: BackendProviderCredentialSurface["capability"];
    readonly executionApi: BackendProviderCredentialSurface["executionApi"];
  }): readonly ConfiguredProviderCredentialSurface[] {
    const configured: ConfiguredProviderCredentialSurface[] = [];
    const referenceOwners = new Map<string, string>();
    const collidedReferences = new Set<string>();
    for (const record of this.#store.listBackends()) {
      const backendId = record.descriptor.id;
      if (!boundedIdentifier(backendId, 256)) continue;
      for (const declaration of declaredProviderCredentialSurfaces(record.descriptor)) {
        const provider = declaration.provider;
        try {
          if (!this.#providerEnabled(backendId, provider.providerId)) continue;
        } catch {
          continue;
        }
        const counts = new Map<string, number>();
        for (const surface of declaration.surfaces) {
          counts.set(surface.surfaceId, (counts.get(surface.surfaceId) ?? 0) + 1);
        }
        for (const surface of declaration.surfaces) {
          if (counts.get(surface.surfaceId) !== 1
            || surface.capability !== input.capability
            || surface.executionApi !== input.executionApi
            || surface.models.length === 0
            || !surface.models.some((model) => {
              try {
                return this.#modelEnabled(backendId, provider.providerId, model.modelId);
              } catch {
                return false;
              }
            })) continue;
          const identity = { backendId, providerId: provider.providerId, surfaceId: surface.surfaceId };
          try {
            const credentialReferenceId = reserveProviderCredentialSurface(
              this.#credentials,
              identity,
              surface
            );
            const owner = `${backendId}\0${provider.providerId}\0${surface.surfaceId}`;
            const previousOwner = referenceOwners.get(credentialReferenceId);
            if (previousOwner !== undefined && previousOwner !== owner) {
              collidedReferences.add(credentialReferenceId);
              continue;
            }
            referenceOwners.set(credentialReferenceId, owner);
            const credential = this.#credentials.find(credentialReferenceId);
            if (credential?.configured !== true
              || credential.kind !== surface.kind
              || credential.providerId !== provider.providerId) continue;
            configured.push({
              backend: record.descriptor,
              provider,
              surface,
              credentialReferenceId,
              credential
            });
          } catch {
            // A malformed or colliding declaration is unavailable, never guessed.
          }
        }
      }
    }
    return configured.filter((candidate) => !collidedReferences.has(candidate.credentialReferenceId)).sort((left, right) =>
      left.backend.id.localeCompare(right.backend.id, "en")
      || left.provider.providerId.localeCompare(right.provider.providerId, "en")
      || left.surface.surfaceId.localeCompare(right.surface.surfaceId, "en"));
  }

  modelEnabled(surface: ConfiguredProviderCredentialSurface, modelId: string): boolean {
    try {
      return this.#modelEnabled(surface.backend.id, surface.provider.providerId, modelId);
    } catch {
      return false;
    }
  }

  resolveSecret(input: ConfiguredProviderCredentialSurface): string {
    if (!this.#providerEnabled(input.backend.id, input.provider.providerId)) {
      throw new Error("Provider credential surface is disabled.");
    }
    const current = resolveDeclaredProviderCredentialSurface(this.#store, this.#credentials, {
      backendId: input.backend.id,
      providerId: input.provider.providerId,
      surfaceId: input.surface.surfaceId
    });
    if (current === undefined
      || current.surface.capability !== input.surface.capability
      || current.surface.executionApi !== input.surface.executionApi
      || current.surface.kind !== input.surface.kind) {
      throw new Error("Provider credential surface is no longer available.");
    }
    const credential = this.#credentials.find(current.credentialReferenceId);
    if (credential?.configured !== true
      || credential.kind !== current.surface.kind
      || credential.providerId !== current.provider.providerId) {
      throw new Error("Provider credential surface is not configured.");
    }
    const secret = this.#credentials.resolve(current.credentialReferenceId);
    if (Buffer.byteLength(secret, "utf8") === 0) {
      throw new Error("Provider credential surface is not configured.");
    }
    return secret;
  }
}

interface DeclaredProviderCredentialSurfaces {
  readonly provider: BackendProviderDescriptor;
  readonly surfaces: readonly BackendProviderCredentialSurface[];
}

function declaredProviderCredentialSurfaces(
  backend: BackendDescriptor
): readonly DeclaredProviderCredentialSurfaces[] {
  if (!Array.isArray(backend.providers) || backend.providers.length > 256) return [];
  const declarations: DeclaredProviderCredentialSurfaces[] = [];
  const counts = new Map<string, number>();
  for (const value of backend.providers as readonly unknown[]) {
    if (!isRecord(value)) continue;
    const providerId = value["providerId"];
    const displayName = value["displayName"];
    const credentialSurfaces = value["credentialSurfaces"];
    if (!boundedIdentifier(providerId, 256)
      || !boundedDisplayName(displayName, 512)
      || !Array.isArray(credentialSurfaces)
      || credentialSurfaces.length > 64) continue;
    const surfaces = validatedProviderCredentialSurfaces(credentialSurfaces);
    counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
    declarations.push({
      provider: {
        ...(value as unknown as BackendProviderDescriptor),
        providerId,
        displayName,
        credentialSurfaces: surfaces
      },
      surfaces
    });
  }
  return declarations.filter((candidate) => counts.get(candidate.provider.providerId) === 1);
}

export function validatedProviderCredentialSurfaces(
  value: unknown
): readonly BackendProviderCredentialSurface[] {
  if (!Array.isArray(value) || value.length > 64) return [];
  const surfaces = value.flatMap((candidate) => {
    const surface = validatedProviderCredentialSurface(candidate);
    return surface === undefined ? [] : [surface];
  });
  const ids = new Set<string>();
  for (const surface of surfaces) {
    if (ids.has(surface.surfaceId)) return [];
    ids.add(surface.surfaceId);
  }
  return surfaces;
}

function validatedProviderCredentialSurface(value: unknown): BackendProviderCredentialSurface | undefined {
  if (!isRecord(value)) return undefined;
  const surfaceId = value["surfaceId"];
  const modelValues = value["models"];
  if (!boundedIdentifier(surfaceId, 256)
    || value["capability"] !== "image_generation"
    || value["kind"] !== "api_key"
    || value["executionApi"] !== "openai-images"
    || !Array.isArray(modelValues)
    || modelValues.length === 0
    || modelValues.length > 64) return undefined;
  const models: { readonly modelId: string; readonly displayName: string }[] = [];
  const modelIds = new Set<string>();
  for (const model of modelValues) {
    if (!isRecord(model)) return undefined;
    const modelId = model["modelId"];
    const displayName = model["displayName"];
    if (!boundedIdentifier(modelId, 256)
      || !boundedDisplayName(displayName, 512)
      || modelIds.has(modelId)) return undefined;
    modelIds.add(modelId);
    models.push({ modelId, displayName });
  }
  return {
    surfaceId,
    capability: "image_generation",
    kind: "api_key",
    executionApi: "openai-images",
    models
  };
}

function boundedIdentifier(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function boundedDisplayName(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
