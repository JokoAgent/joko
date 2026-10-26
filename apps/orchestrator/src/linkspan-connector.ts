import { randomUUID } from "node:crypto";
import { startQuickTunnel } from "@jokoagent/linkspan-cloudflare";
import type { OperationalStore } from "@joko/store";
import type { OrchestratorApplication } from "./application.js";
import { captureLinkspanProcessIdentity, linkspanProcessIsRetired } from "./linkspan-process-identity.js";
import { publishConnectionEntry, type PublishedConnectionEntry } from './connection-entries.js';

const JOURNAL = "runtime.linkspan.quick";
interface ConnectorRecord {
  readonly requestId: string;
  readonly processId?: number;
  readonly processIdentity?: string;
  readonly state: "starting" | "active" | "closed";
  readonly publicOrigin?: string;
}
const ownedPublicOrigins = new WeakMap<OperationalStore, { readonly requestId: string; readonly origin: string }>();
const additionalOrigins = new WeakMap<OperationalStore, Map<string, { readonly requestId: string; readonly origin: string }>>();

export function registerManagedLinkspanOrigin(store: OperationalStore, journalKey: string, requestId: string, origin: string, entry?: Omit<PublishedConnectionEntry, 'origin'>): () => void {
  let owned = additionalOrigins.get(store);
  if (owned === undefined) { owned = new Map(); additionalOrigins.set(store, owned); }
  owned.set(journalKey, { requestId, origin });
  const retire = entry ? publishConnectionEntry(store, { ...entry, origin }) : () => undefined;
  return () => { retire(); if (owned!.get(journalKey)?.requestId === requestId) owned!.delete(journalKey); };
}
/** A restored active journal alone never proves that this runtime owns a live entrance. */
export function advertisedLinkspanOrigin(store: OperationalStore, fallback: string): string {
  const owned = ownedPublicOrigins.get(store);
  if (owned !== undefined) {
    const record = store.findSetting<ConnectorRecord>("service", "orchestrator", JOURNAL)?.value;
    if (record?.requestId === owned.requestId && record.state === "active" && record.publicOrigin === owned.origin) return owned.origin;
  }
  for (const [key, candidate] of additionalOrigins.get(store) ?? []) {
    const record = store.findSetting<ConnectorRecord>("service", "orchestrator", key)?.value;
    if (record?.requestId === candidate.requestId && record.state === "active" && record.publicOrigin === candidate.origin) return candidate.origin;
  }
  return fallback;
}

/** Deployment configuration authorizes this free, ephemeral resource only. */
export async function startManagedLinkspanConnector(application: OrchestratorApplication, input: {
  readonly executable: string;
  readonly localOrigin: string;
  readonly originCaPool: string;
  readonly originServerName: string;
  readonly signal?: AbortSignal;
}) {
  const store = application.store;
  const previous = store.findSetting<ConnectorRecord>("service", "orchestrator", JOURNAL)?.value;
  if (previous !== undefined && previous.state !== "closed") {
    if (previous.processId === undefined || !linkspanProcessIsRetired(previous.processId, previous.processIdentity)) {
      throw new Error("The previous public connector's cleanup is unconfirmed. Stop and verify its recorded process before restarting the public path.");
    }
    const operation = store.getOperation(previous.requestId);
    store.completeDeferredEffectOperation(previous.requestId, operation.bodyHash, current => {
      current.setSetting("service", "orchestrator", JOURNAL, { ...previous, state: "closed" });
      return { state: "closed", reason: "original_process_gone" };
    });
    store.setSetting("service", "orchestrator", JOURNAL, { ...previous, state: "closed" });
  }
  const requestId = `linkspan-quick:${randomUUID()}`;
  let journal: ConnectorRecord = { requestId, state: "starting" };
  const claim = store.claimDeferredEffectOperation({ id: requestId, kind: "connection.public.quick.start", body: {
    provider: "cloudflare", mode: "quick", localOrigin: input.localOrigin, originServerName: input.originServerName, serverId: application.serverId
  } }, current => { current.setSetting("service", "orchestrator", JOURNAL, journal); });
  let tunnel: Awaited<ReturnType<typeof startQuickTunnel>>;
  try {
    tunnel = await startQuickTunnel({
      executable: input.executable, localOrigin: input.localOrigin, originCaPool: input.originCaPool,
      originServerName: input.originServerName, requestId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      onSpawn: ({ processId }) => {
        const identity = captureLinkspanProcessIdentity(processId);
        journal = { requestId, processId, ...(identity === undefined ? {} : { processIdentity: identity }), state: "starting" };
        store.setSetting("service", "orchestrator", JOURNAL, journal);
      }
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "cleanup_failed") throw error;
    // The library waits for its exact child cleanup before a start rejection.
    store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, current => {
      current.setSetting("service", "orchestrator", JOURNAL, { ...journal, state: "closed" });
      return { state: "closed", reason: "startup_failed_and_child_retired" };
    });
    throw error;
  }
  const identity = captureLinkspanProcessIdentity(tunnel.processId);
  journal = { requestId, processId: tunnel.processId, ...(identity === undefined ? {} : { processIdentity: identity }), state: "active", publicOrigin: tunnel.publicOrigin };
  let retireEntry: (() => void) | undefined;
  const unpublish = (): void => {
    retireEntry?.();
    if (ownedPublicOrigins.get(store)?.requestId === requestId) ownedPublicOrigins.delete(store);
  };
  const markClosed = (): void => {
    unpublish();
    const current = store.findSetting<ConnectorRecord>("service", "orchestrator", JOURNAL)?.value;
    if (current?.requestId === requestId) store.setSetting("service", "orchestrator", JOURNAL, { ...current, state: "closed" });
  };
  try {
    store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, current => {
      current.setSetting("service", "orchestrator", JOURNAL, journal);
      return { publicOrigin: tunnel.publicOrigin, processId: tunnel.processId, limits: tunnel.limits };
    });
  } catch (receiptError) {
    // The handle has not reached the service lifecycle yet. Its exact owned
    // child must be retired here, without trusting or killing a persisted PID.
    try { await tunnel.close(); }
    catch (cleanupError) {
      // Leave the original operation/journal pending; startup must reconcile it
      // before another external resource can be created.
      throw Object.assign(new AggregateError([receiptError, cleanupError],
        "The public connector receipt failed and its owned process cleanup is unconfirmed.", { cause: receiptError }), { code: "cleanup_failed" });
    }
    try {
      store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, current => {
        current.setSetting("service", "orchestrator", JOURNAL, { ...journal, state: "closed" });
        return { state: "closed", reason: "publication_receipt_failed_and_child_retired" };
      });
      // A committed receipt can be replayed if persistence reported a late
      // failure. In that case the completion callback does not run again.
      markClosed();
    } catch { /* Preserve the original durable record and report its receipt failure. */ }
    throw receiptError;
  }
  ownedPublicOrigins.set(store, { requestId, origin: tunnel.publicOrigin });
  retireEntry = publishConnectionEntry(store, { id: 'quick:cloudflare', provider: 'cloudflare', origin: tunnel.publicOrigin });
  void tunnel.closed.then(markClosed).catch(() => {
    unpublish();
    process.stderr.write("The public connector cleanup is unconfirmed or its receipt could not be saved.\n");
  });
  return { publicOrigin: tunnel.publicOrigin, limits: tunnel.limits,
    async close(): Promise<void> { unpublish(); await tunnel.close(); markClosed(); } };
}
