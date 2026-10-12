import { CodeHostProjectionCoordinator, type CodeHostProvider, type CodeHostPullRequestReference,
  type CodeHostSessionAuthorizationPort, type CodeHostSessionProjection, type CodeHostSessionReferenceProjection } from "@joko/code-host";

interface Scope {
  readonly key: string;
  readonly references: ReadonlyMap<string, CodeHostPullRequestReference>;
  readonly assertReference: (reference: CodeHostPullRequestReference) => void;
  readonly changed: () => void;
}

/** Read-only item observations share the existing provider/cache behavior.
 * The durable workbench grant and judgment remain the only authority. */
export class PartnerWorkbenchPullRequests {
  readonly #scopes = new Map<string, Scope>();
  readonly #cache = new Map<string, CodeHostSessionProjection>();
  readonly #coordinator: CodeHostProjectionCoordinator;

  constructor(providers: (authorization: CodeHostSessionAuthorizationPort) => readonly CodeHostProvider[], now: () => number) {
    const authorize: CodeHostSessionAuthorizationPort["authorize"] = (sessionOwnerId, reference) => {
      const scope = this.#scopes.get(sessionOwnerId);
      if (scope === undefined || scope.references.get(reference.key)?.webUrl !== reference.webUrl) return undefined;
      try { scope.assertReference(reference); } catch { return undefined; }
      return { sessionOwnerId, referenceKey: reference.key, ownerRevision: scope.key };
    };
    const authorization: CodeHostSessionAuthorizationPort = { authorize, isCurrent: (previous, reference) => {
      const current = authorize(previous.sessionOwnerId, reference);
      return current !== undefined && current.ownerRevision === previous.ownerRevision && current.referenceKey === previous.referenceKey;
    } };
    this.#coordinator = new CodeHostProjectionCoordinator({ now, providers: providers(authorization).map((provider) => ({
      capability: provider.capability,
      ...(provider.minimumTimeToLiveMs === undefined ? {} : { minimumTimeToLiveMs: provider.minimumTimeToLiveMs }),
      supports: (reference) => provider.supports(reference),
      getPullRequest: async (reference, options) => {
        const scope = authorize(options.sessionOwnerId, reference);
        if (scope === undefined) throw new Error("The workbench reference is no longer available.");
        const result = await provider.getPullRequest(reference, options);
        if (!authorization.isCurrent(scope, reference)) throw new Error("The workbench reference owner changed.");
        return result;
      }
    })), repository: { read: (id) => this.#cache.get(id), write: (projection) => {
      const scope = this.#scopes.get(projection.sessionOwnerId);
      if (scope === undefined) return;
      for (const entry of projection.references) {
        if (scope.references.get(entry.reference.key)?.webUrl !== entry.reference.webUrl) return;
        scope.assertReference(entry.reference);
      }
      this.#cache.set(projection.sessionOwnerId, projection);
    } } });
  }

  read(sessionId: string, scope: Scope): readonly CodeHostSessionReferenceProjection[] {
    this.#scopes.set(sessionId, scope);
    const cached = new Map(this.#cache.get(sessionId)?.references.map((item) => [item.reference.key, item]));
    const visible = [...scope.references.values()].map((reference) => {
      scope.assertReference(reference);
      return cached.get(reference.key) ?? { reference };
    });
    if (visible.length > 0) {
      void this.#coordinator.refreshSession(sessionId, [...scope.references.values()]).then((result) => {
        if (this.#scopes.get(sessionId)?.key !== scope.key) return;
        for (const reference of scope.references.values()) scope.assertReference(reference);
        if (result.changed) scope.changed();
      }).catch(() => { /* Failed observations keep the last successful provider facts. */ });
    } else this.#cache.delete(sessionId);
    return visible;
  }

  retire(sessionId: string): void { this.#scopes.delete(sessionId); this.#cache.delete(sessionId); }
}
