import { randomUUID } from "node:crypto";
import { startNamedTunnel } from "@jokoagent/linkspan-cloudflare";
import { startConnector, reconcileConnectorResource, type ConnectorResource } from "@jokoagent/linkspan-connectors";
import { operationBodyHash } from "@joko/store";
import type { OrchestratorApplication } from "./application.js";
import { registerManagedLinkspanOrigin } from "./linkspan-connector.js";
import { linkspanHttpConnectTransport, type LinkspanDeploymentEntry, type SdkDeployment } from "./linkspan-deployment.js";
import { captureLinkspanProcessIdentity, linkspanProcessIsRetired, ownLinkspanProcessIdentity } from "./linkspan-process-identity.js";
import { prepareLinkspanPrivateProviderPaths } from "./linkspan-private-paths.js";

interface Record {
  readonly requestId: string;
  readonly state: "starting" | "active" | "closed";
  readonly resource?: ConnectorResource;
  readonly processId?: number;
  readonly resourceProcessIdentity?: string;
  readonly ownerProcessId?: number;
  readonly ownerProcessIdentity?: string;
  readonly publicOrigin?: string;
}

/** Each selected entrance has its own durable effect and exact owned handle. */
export async function startManagedProviderConnector(application: OrchestratorApplication, entry: Omit<LinkspanDeploymentEntry, "connector"> & {
  readonly connector: Exclude<NonNullable<LinkspanDeploymentEntry["connector"]>, SdkDeployment>;
}, input: Omit<Parameters<typeof startConnector>[1], "requestId" | "onResource">) {
  const store = application.store;
  const config = await prepareLinkspanPrivateProviderPaths(application.config, entry.id, application.serverId, entry.connector, input.signal);
  const endpointTransport = linkspanHttpConnectTransport(config);
  if ((endpointTransport !== undefined) !== (input.encryptedStreamTarget !== undefined)
    || endpointTransport === undefined && (input.localOrigin === undefined || input.originCaPool === undefined || input.originServerName === undefined)) {
    throw new Error("Select the exact encrypted TCP target for HTTP CONNECT or the verified HTTPS origin for this connector.");
  }
  const journalKey = `runtime.linkspan.connector.${entry.id}`;
  const previous = store.findSetting<Record>("service", "orchestrator", journalKey)?.value;
  if (previous !== undefined && previous.state !== "closed") {
    const original = store.getOperation(previous.requestId);
    const originalBody = original.body as { entryId?: string; provider?: string; serverId?: string } | null;
    if (original.kind !== "connection.public.start" || original.connectionId !== undefined || original.completionMode !== "external_effect" || original.status === "failed"
      || originalBody?.entryId !== entry.id || originalBody.provider !== config.provider || originalBody.serverId !== application.serverId) throw new Error("The original public entrance operation conflicts with this recovery.");
    let retired = false;
    if (config.provider === "cloudflare") {
      // A persisted PID cannot authorize killing a process after restart.
      retired = previous.processId !== undefined && linkspanProcessIsRetired(previous.processId, previous.resourceProcessIdentity);
    } else if (previous.resource !== undefined) {
      const cleanupId = `${previous.requestId}:reconcile`;
      const cleanupBody = { entryId: entry.id, provider: config.provider, originalRequestId: previous.requestId };
      const cleanup = store.findOperation(cleanupId) ?? store.claimDeferredEffectOperation({ id: cleanupId, kind: "connection.public.reconcile", body: cleanupBody }).operation;
      if (cleanup.kind !== "connection.public.reconcile" || cleanup.completionMode !== "external_effect" || cleanup.connectionId !== undefined
        || cleanup.bodyHash !== operationBodyHash(cleanupBody) || cleanup.status === "failed") throw new Error("The original connector cleanup operation conflicts with this recovery.");
      const processRetired = config.provider !== "zrok" && (previous.resource.processId !== undefined
        ? linkspanProcessIsRetired(previous.resource.processId, previous.resourceProcessIdentity)
        : previous.ownerProcessId !== undefined && linkspanProcessIsRetired(previous.ownerProcessId, previous.ownerProcessIdentity));
      const result = cleanup.status === "completed" || processRetired ? { state: "retired" as const } : await reconcileConnectorResource(config, previous.resource, {
        requestId: previous.requestId, deadline: Date.now() + 10000,
        ...(input.signal === undefined ? {} : { signal: input.signal })
      });
      retired = result.state === "retired";
      if (retired) store.completeDeferredEffectOperation(cleanupId, cleanup.bodyHash, () => ({ state: "closed" }));
    }
    if (!retired) throw new Error("A previous public entrance has unconfirmed cleanup. Reconcile its original operation before replacing it.");
    const operation = store.getOperation(previous.requestId);
    store.completeDeferredEffectOperation(previous.requestId, operation.bodyHash, current => {
      current.setSetting("service", "orchestrator", journalKey, { ...previous, state: "closed" });
      return { state: "closed", reason: "original_resource_retired" };
    });
    store.setSetting("service", "orchestrator", journalKey, { ...previous, state: "closed" });
  }
  const requestId = `linkspan:${entry.id}:${randomUUID()}`;
  let record: Record = { requestId, state: "starting", ownerProcessId: process.pid, ownerProcessIdentity: ownLinkspanProcessIdentity() };
  const claim = store.claimDeferredEffectOperation({ id: requestId, kind: "connection.public.start",
    body: { entryId: entry.id, provider: config.provider, ...("mode" in config ? { mode: config.mode } : {}),
      ...(input.localOrigin === undefined ? {} : { localOrigin: input.localOrigin }),
      ...(input.encryptedStreamTarget === undefined ? {} : { encryptedStreamTarget: input.encryptedStreamTarget }), serverId: application.serverId } }, current => {
      current.setSetting("service", "orchestrator", journalKey, record);
    });
  let connector: Awaited<ReturnType<typeof startConnector>> | Awaited<ReturnType<typeof startNamedTunnel>>;
  try {
    if (config.provider === "cloudflare") {
      const { localOrigin, originCaPool, originServerName } = input;
      if (localOrigin === undefined || originCaPool === undefined || originServerName === undefined) throw new Error("Cloudflare requires its verified HTTPS origin.");
      connector = await startNamedTunnel({ ...input, ...config, localOrigin, originCaPool, originServerName, requestId, onSpawn: ({ processId }) => {
        const identity = captureLinkspanProcessIdentity(processId);
        record = { ...record, processId, ...(identity === undefined ? {} : { resourceProcessIdentity: identity }) }; store.setSetting("service", "orchestrator", journalKey, record);
      } });
    } else connector = await startConnector(config, { ...input, requestId, onResource: resource => {
      const identity = resource.processId === undefined ? undefined : captureLinkspanProcessIdentity(resource.processId);
      record = { ...record, resource, ...(identity === undefined ? {} : { resourceProcessIdentity: identity }) }; store.setSetting("service", "orchestrator", journalKey, record);
    } });
  } catch (error) {
    if (error !== null && typeof error === "object" && ("code" in error && ["outcome_unknown", "cleanup_failed"].includes(String(error.code))
      || "outcome" in error && error.outcome === "unknown")) throw error;
    store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, current => {
      current.setSetting("service", "orchestrator", journalKey, { ...record, state: "closed" });
      return { state: "closed", reason: "startup_rejected_and_owned_resource_retired" };
    });
    throw error;
  }
  record = { ...record, state: "active", publicOrigin: connector.publicOrigin };
  const markClosed = (): void => {
    unpublish();
    const current = store.findSetting<Record>("service", "orchestrator", journalKey)?.value;
    if (current?.requestId === requestId) store.setSetting("service", "orchestrator", journalKey, { ...current, state: "closed" });
  };
  let unpublish: () => void = () => undefined;
  try {
    store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, current => {
      current.setSetting("service", "orchestrator", journalKey, record);
      return { state: "active", entryId: entry.id, provider: config.provider, publicOrigin: connector.publicOrigin, limits: connector.limits };
    });
  } catch (error) {
    try { await connector.close(); }
    catch (cleanup) { throw Object.assign(new AggregateError([error, cleanup], "The public entrance receipt and cleanup are unconfirmed."), { code: "cleanup_failed" }); }
    store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, current => {
      current.setSetting("service", "orchestrator", journalKey, { ...record, state: "closed" });
      return { state: "closed", reason: "publication_receipt_failed_and_resource_retired" };
    });
    throw error;
  }
  unpublish = registerManagedLinkspanOrigin(store, journalKey, requestId, connector.publicOrigin);
  void connector.closed.then(markClosed).catch(() => {
    unpublish();
    process.stderr.write("A public entrance cleanup is unconfirmed; its original operation is retained.\n");
  });
  return { publicOrigin: connector.publicOrigin, limits: connector.limits,
    ...(endpointTransport === undefined ? {} : { endpointTransport }),
    async close(): Promise<void> { unpublish(); await connector.close(); markClosed(); } };
}
