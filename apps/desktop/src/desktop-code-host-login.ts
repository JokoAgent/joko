import { createClient } from "@connectrpc/connect";
import { SessionService } from "@joko/contracts";

import type { DesktopCodeHostLoginScope, DesktopCodeHostLoginState } from "./channels.js";
import { withManagedDesktopHostAuthority, type ManagedDesktopHostAuthority } from "./managed-desktop-host-authority.js";

interface DesktopCodeHostLoginFlight {
  readonly document: string;
  readonly scope: DesktopCodeHostLoginScope;
  readonly abort: AbortController;
  state: DesktopCodeHostLoginState;
}

export class DesktopCodeHostLogin {
  private flight: DesktopCodeHostLoginFlight | undefined;

  constructor(private readonly getAuthority: (scope: DesktopCodeHostLoginScope, signal: AbortSignal) => ManagedDesktopHostAuthority) {}

  async status(document: string, scope: DesktopCodeHostLoginScope, assertDocument: () => void): Promise<DesktopCodeHostLoginState> {
    const flight = this.current(document, scope);
    const signal = flight?.abort.signal ?? AbortSignal.timeout(20_000);
    const authority = this.getAuthority(scope, signal);
    if (flight !== undefined) {
      const current = await authority.isAuthorityCurrent(authority.connection);
      assertDocument();
      return current && this.current(document, scope) === flight ? flight.state : { phase: "unavailable" };
    }
    const response = await withManagedDesktopHostAuthority(authority, transport => createClient(SessionService, transport)
      .getSessionCodeHostLogin({ scope }, { signal }));
    assertDocument();
    return { phase: response.signInRequired ? "ready" : "unavailable" };
  }

  start(document: string, scope: DesktopCodeHostLoginScope, assertDocument: () => void): DesktopCodeHostLoginState {
    const existing = this.current(document, scope);
    if (this.flight !== undefined && (this.flight.state.phase === "starting" || this.flight.state.phase === "authorizing")) {
      return existing?.state ?? { phase: "failed" };
    }
    const abort = new AbortController();
    const authority = this.getAuthority(scope, abort.signal);
    const flight: DesktopCodeHostLoginFlight = { document, scope, abort, state: { phase: "starting" } };
    this.flight = flight;
    void this.run(flight, authority, assertDocument);
    return flight.state;
  }

  cancel(document: string, scope: DesktopCodeHostLoginScope): void {
    if (this.current(document, scope) !== undefined) this.retire(document);
  }

  retire(document?: string): void {
    if (this.flight === undefined || (document !== undefined && this.flight.document !== document)) return;
    this.flight.abort.abort();
    this.flight = undefined;
  }

  private current(document: string, scope: DesktopCodeHostLoginScope): DesktopCodeHostLoginFlight | undefined {
    const flight = this.flight;
    if (flight?.document !== document) return undefined;
    const original = flight.scope;
    return original.scopeId === scope.scopeId && original.profileId === scope.profileId && original.serverId === scope.serverId
      && original.sessionId === scope.sessionId && original.targetId === scope.targetId && original.generation === scope.generation
      && original.referenceKey === scope.referenceKey ? flight : undefined;
  }

  private async run(flight: DesktopCodeHostLoginFlight, authority: ManagedDesktopHostAuthority, assertDocument: () => void): Promise<void> {
    try {
      const connected = await withManagedDesktopHostAuthority(authority, async transport => {
        const updates = createClient(SessionService, transport).startSessionCodeHostLogin({ scope: flight.scope }, {
          signal: flight.abort.signal, timeoutMs: 16 * 60_000
        });
        for await (const { update } of updates) {
          if (!await authority.isAuthorityCurrent(authority.connection)) break;
          assertDocument();
          if (this.flight !== flight || flight.abort.signal.aborted) break;
          if (update.case === "connected" && update.value) return true;
          if (update.case === "deviceCode" && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(update.value)) {
            flight.state = { phase: "authorizing", code: update.value };
          }
        }
        return false;
      });
      assertDocument();
      if (this.flight === flight) flight.state = { phase: connected ? "connected" : "failed" };
    } catch {
      if (this.flight === flight) flight.state = { phase: "failed" };
    }
  }
}

export function parseDesktopCodeHostLoginScope(value: unknown): DesktopCodeHostLoginScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid GitHub sign-in scope.");
  const scope = value as Partial<DesktopCodeHostLoginScope>;
  const { profileId, serverId, scopeId, sessionId, targetId, generation, referenceKey } = scope;
  if (!isIdentity(profileId) || !isIdentity(serverId) || !isIdentity(scopeId) || !isIdentity(sessionId) || !isIdentity(targetId)
    || typeof generation !== "bigint" || generation < 0n || generation > 0xffffffffffffffffn
    || !isIdentity(referenceKey) || !referenceKey.startsWith("github.com/")) throw new TypeError("Invalid GitHub sign-in scope.");
  return { profileId, serverId, scopeId, sessionId, targetId, generation, referenceKey };
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s|[\u0000-\u001f\u007f]/u.test(value);
}
