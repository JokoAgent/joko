import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { isSupportedPublicReference, type GhCliTokenSource } from "@joko/code-host";
import type { SessionCodeHostLoginScope, StartSessionCodeHostLoginResponseSchema } from "@joko/contracts";
import type { OperationalStore } from "@joko/store";

import { readSessionCodeHostReferences, type SessionCodeHostContextRuntime } from "./session-code-host-context.js";

type LoginUpdate = MessageInitShape<typeof StartSessionCodeHostLoginResponseSchema>;

export class SessionCodeHostLogin {
  private active = false;

  constructor(
    private readonly store: OperationalStore,
    private readonly context: SessionCodeHostContextRuntime,
    private readonly credentials: GhCliTokenSource | undefined
  ) {}

  async requiresSignIn(scope: SessionCodeHostLoginScope, assertOwner: () => void): Promise<boolean> {
    if (this.credentials === undefined) return false;
    await this.context.refreshSession(scope.sessionId);
    assertOwner();
    const reference = this.unobservedReference(scope);
    if (reference === undefined || !this.context.isReferenceCurrent(scope.sessionId, reference)) return false;
    const required = await this.credentials.isSignInRequired();
    assertOwner();
    return required && this.unobservedReference(scope)?.webUrl === reference.webUrl
      && this.context.isReferenceCurrent(scope.sessionId, reference);
  }

  async *start(scope: SessionCodeHostLoginScope, assertOwner: () => void, requestSignal: AbortSignal): AsyncGenerator<LoginUpdate> {
    const credentials = this.credentials;
    const reference = this.unobservedReference(scope);
    if (credentials === undefined || reference === undefined) throw unavailable();
    if (this.active) throw new ConnectError("A GitHub sign-in is already in progress.", Code.AlreadyExists);

    const cancelled = new AbortController();
    const signal = AbortSignal.any([requestSignal, cancelled.signal]);
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      assertOwner();
      if (!this.context.isReferenceCurrent(scope.sessionId, reference)) throw unavailable();
    };
    assertCurrent();
    const stopWatching = this.store.subscribe(event => {
      if (event.sessionId !== scope.sessionId && event.targetId !== scope.targetId) return;
      try { assertCurrent(); } catch { cancelled.abort(); }
    });

    this.active = true;
    let sendDeviceCode: (code: string) => void = () => undefined;
    const deviceCode = new Promise<string>(resolve => { sendDeviceCode = resolve; });
    const complete = credentials.signIn(signal, assertCurrent, code => {
      if (/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(code)) sendDeviceCode(code);
    }).then(() => true, () => false);
    try {
      const first = await Promise.race([deviceCode, complete]);
      assertCurrent();
      if (typeof first === "string") yield { update: { case: "deviceCode", value: first } };
      if (!await complete) throw unavailable();
      assertCurrent();
      await this.context.refreshAfterSignIn(scope.sessionId, scope.referenceKey, assertCurrent);
      assertCurrent();
      yield { update: { case: "connected", value: true } };
    } finally {
      stopWatching();
      cancelled.abort();
      await complete;
      this.active = false;
    }
  }

  private unobservedReference(scope: SessionCodeHostLoginScope) {
    const entry = readSessionCodeHostReferences(this.store, scope.sessionId)
      .find(item => item.reference.key === scope.referenceKey);
    return entry?.projection === undefined && entry?.notFoundUntil !== undefined
      && isSupportedPublicReference(entry.reference) ? entry.reference : undefined;
  }
}

function unavailable(): ConnectError {
  return new ConnectError("GitHub sign-in could not be completed for this task.", Code.FailedPrecondition);
}
