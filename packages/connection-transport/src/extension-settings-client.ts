import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { ExtensionAuthorizationPhase, OperationMutationSchema, type ExtensionOAuthFlow, type ExtensionOAuthService,
  type CredentialUploadTicket, type OperationMutation, type ExtensionNetworkService, type ExtensionService,
  type ExtensionSettingsCall, type ExtensionSettingsHost } from "@joko/contracts";

export interface ExtensionSettingsProjection {
  readonly extensionId: string; readonly revision: bigint; readonly name: string;
  readonly setup: { readonly state: "notRequired" | "required" | "inProgress" | "ready" | "cancelled" | "failed";
    readonly fields: readonly { readonly fieldId: string; readonly label: string; readonly description: string;
      readonly kind: "text" | "secret" | "oauth" | "confirmation"; readonly configured: boolean }[] };
  readonly permissions: readonly { readonly label: string; readonly description: string }[];
}

export interface ExtensionSettingsClient<E extends ExtensionSettingsProjection> {
  readonly surface: { readonly surfaceId: string };
  readonly api: Client<typeof ExtensionService>;
  readonly oauth?: Client<typeof ExtensionOAuthService>;
  readonly connections?: Client<typeof ExtensionNetworkService>;
  readonly upload: (ticket: CredentialUploadTicket, value: string, signal: AbortSignal) => Promise<string>;
  readonly fresh: (signal: AbortSignal) => Promise<E>;
  readonly current: () => void;
  readonly submit: (extension: E, mutation: OperationMutation, kind: "routing" | "clear", signal: AbortSignal) => Promise<void>;
  readonly begin: (extension: E, signal: AbortSignal) => Promise<{ readonly extension: E }>;
  readonly field: (extension: E, id: string, value: string | boolean, signal: AbortSignal) => Promise<{ readonly extension: E }>;
  readonly secret: (extension: E, id: string, value: string, signal: AbortSignal) => Promise<{ readonly extension: E }>;
  readonly complete: (extension: E, signal: AbortSignal) => Promise<{ readonly extension: E }>;
}

const setup = (extension: ExtensionSettingsProjection) => ({ extensionId: extension.extensionId, ...extension.setup,
  // These are configured markers, never credential references or values.
  secrets: Object.fromEntries(extension.setup.fields.filter(field => field.kind === "secret" || field.kind === "oauth")
    .map(field => [field.fieldId.replace(/^network-secret:/u, ""), { configured: field.configured }])) });
const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const finish = () => { signal.removeEventListener("abort", cancel); resolve(); };
  const timer = setTimeout(finish, 350);
  const cancel = () => { clearTimeout(timer); reject(new Error("Plugin authorization cancelled.")); };
  signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
});

/** Only the original native host can present confirmations or open a browser. */
export async function executeExtensionSettingsCall<E extends ExtensionSettingsProjection>(client: ExtensionSettingsClient<E>, call: ExtensionSettingsCall,
  host: ExtensionSettingsHost, signal: AbortSignal): Promise<unknown> {
  const current = () => { signal.throwIfAborted(); client.current(); };
  current(); let extension = await client.fresh(signal); current();
  const rpc = { signal, timeoutMs: 15_000 };
  const readRouting = async () => {
    const response = await client.api.getExtensionSettingsRoutingData({ surfaceId: client.surface.surfaceId }, rpc); current();
    if (!response.routingData || !/^(?:0|[1-9][0-9]{0,19})$/u.test(response.routingData.revision)
      || response.routingData.dataJson.length > 65_536) throw new Error("The plugin parameter response is invalid.");
    return { revision: response.routingData.revision, dataJson: response.routingData.dataJson };
  };
  const begin = async () => {
    if (extension.setup.state !== "inProgress") extension = (await client.begin(extension, signal)).extension;
    current();
  };
  switch (call.kind) {
    case "context.get": return { context: { locale: host.locale ?? "en" } };
    case "routing.get": return readRouting();
    case "routing.set": {
      await client.submit(extension, create(OperationMutationSchema, { payload: { case: "setExtensionSettingsRoutingData", value: {
        extensionId: extension.extensionId, expectedRevision: { value: extension.revision }, surfaceId: client.surface.surfaceId,
        expectedRoutingRevision: call.revision, dataJson: call.dataJson
      } } }), "routing", signal);
      current(); return readRouting();
    }
    case "setup.get": return setup(extension);
    case "setup.begin": await begin(); return setup(extension);
    case "setup.field": {
      const field = extension.setup.fields.find(field => field.fieldId === call.fieldId);
      if (!field || !["text", "confirmation"].includes(field.kind)) throw new Error("Select a declared plugin setup field.");
      if (field.kind === "confirmation" && !await host.confirm(field.label, field.description, signal)) throw new Error("Plugin permission was cancelled.");
      current(); await begin(); extension = (await client.field(extension, call.fieldId, call.value, signal)).extension;
      current(); return setup(extension);
    }
    case "secret.set": {
      const field = extension.setup.fields.find(field => field.fieldId === call.fieldId && field.kind === "secret");
      if (!field) throw new Error("Select a declared plugin credential field.");
      await begin(); extension = (await client.secret(extension, call.fieldId, call.value, signal)).extension;
      current(); return setup(extension);
    }
    case "secret.clear": {
      if (!await host.confirm(extension.name, extension.setup.fields.find(field => field.fieldId === call.fieldId)?.label ?? call.fieldId, signal)) throw new Error("Credential removal was cancelled.");
      current(); await client.submit(extension, create(OperationMutationSchema, { payload: { case: "clearExtensionSetupCredential", value: {
        extensionId: extension.extensionId, expectedRevision: { value: extension.revision }, surfaceId: client.surface.surfaceId, fieldId: call.fieldId
      } } }), "clear", signal);
      current(); return setup(await client.fresh(signal));
    }
    case "secret.check": {
      const response = await client.api.beginExtensionSecretCheck({ surfaceId: client.surface.surfaceId, secretKey: call.key }, rpc);
      current(); if (!response.ticket) throw new Error("The candidate validation channel is unavailable.");
      const ticket = await client.upload(response.ticket, call.value, signal); current();
      const result = await client.api.checkExtensionSecret({ surfaceId: client.surface.surfaceId, secretKey: call.key, credentialUploadTicketId: ticket }, { signal, timeoutMs: 18_000 }); current();
      const expiry = result.expiresAt ? Number(result.expiresAt.seconds) * 1000 + Math.floor(result.expiresAt.nanos / 1_000_000) : undefined;
      return { valid: result.valid, ...(expiry === undefined ? {} : { expiresAt: new Date(expiry).toISOString() }) };
    }
    case "setup.complete": {
      if (extension.setup.state === "notRequired") return setup(extension);
      if (!await host.confirm(extension.name, extension.permissions.map(permission => `${permission.label}: ${permission.description}`).join("\n"), signal)) throw new Error("Plugin permission was cancelled.");
      current(); await begin();
      for (const field of extension.setup.fields.filter(field => field.kind === "confirmation" && !field.configured)) {
        extension = (await client.field(extension, field.fieldId, true, signal)).extension; current();
      }
      extension = (await client.complete(extension, signal)).extension; current(); return setup(extension);
    }
    case "library.open": await host.openLibrary(signal); current(); return { accepted: true };
    case "oauth.get": {
      if (!client.oauth) throw new Error("Plugin account settings are unavailable.");
      const result = await client.oauth.get({ extensionId: extension.extensionId }, rpc); current(); return result.state;
    }
    case "oauth.change": {
      if (!client.oauth || !await host.confirm(extension.name, call.key, signal)) throw new Error("Plugin account change was cancelled.");
      current(); const result = await client.oauth.change({ extensionId: extension.extensionId, expectedRevision: { value: extension.revision }, slotKey: call.key,
        action: call.action === "clearClient" ? { case: "clearClient", value: true }
          : call.action === "remove" ? { case: "removeAccountId", value: call.accountId! } : { case: "defaultAccountId", value: call.accountId! } }, rpc);
      current(); return result.state;
    }
    case "oauth.connect": {
      if (!client.oauth) throw new Error("Plugin account authorization is unavailable.");
      const api = client.oauth; let flow: ExtensionOAuthFlow | undefined;
      try {
        const response = await api.start({ extensionId: extension.extensionId, expectedRevision: { value: extension.revision }, slotKey: call.key, scopes: [...(call.scopes ?? [])] }, rpc);
        current(); flow = response.flow;
        const originalFlowId = flow?.flowId, originalExpiry = flow?.expiresAt === undefined ? undefined : `${flow.expiresAt.seconds}:${flow.expiresAt.nanos}`;
        const matches = () => {
          if (!flow || !flow.flowId || flow.flowId !== originalFlowId || flow.extensionId !== extension.extensionId || flow.slotKey !== call.key || !flow.expiresAt
            || `${flow.expiresAt.seconds}:${flow.expiresAt.nanos}` !== originalExpiry) throw new Error("Plugin authorization owner changed.");
          const expiry = Number(flow.expiresAt.seconds) * 1000 + Math.floor(flow.expiresAt.nanos / 1_000_000);
          if (!Number.isSafeInteger(expiry) || expiry <= Date.now() || expiry > Date.now() + 310_000) throw new Error("Plugin authorization expired.");
          return expiry;
        };
        matches();
        const read = async () => { await pause(signal); current(); const result = await api.getFlow({ flowId: flow!.flowId }, rpc); current(); flow = result.flow; matches(); };
        while (flow!.phase === ExtensionAuthorizationPhase.PREPARING) await read();
        const expiry = matches();
        if (flow!.phase !== ExtensionAuthorizationPhase.AUTHORIZING || !flow!.authorization) throw new Error("Plugin authorization could not start.");
        if (!await host.confirm(extension.name, new URL(flow!.authorization.authorizeUrl).hostname, signal)) throw new Error("Plugin authorization was cancelled.");
        current();
        const callback = await host.authorize(flow!.authorization, expiry, signal); current();
        // Refresh the exact installed owner after returning from the native browser.
        extension = await client.fresh(signal); current();
        const ticket = await api.beginCallback({ flowId: flow!.flowId }, rpc); current();
        if (!ticket.ticket) throw new Error("Plugin authorization callback channel is unavailable.");
        const uploaded = await client.upload(ticket.ticket, JSON.stringify(callback), signal); current();
        const finished = await api.completeCallback({ flowId: flow!.flowId, credentialUploadTicketId: uploaded }, rpc); current(); flow = finished.flow; matches();
        while (flow!.phase === ExtensionAuthorizationPhase.EXCHANGING) await read();
        if (flow!.phase !== ExtensionAuthorizationPhase.COMPLETE) throw new Error("Plugin authorization could not be completed.");
        const result = await api.get({ extensionId: extension.extensionId }, rpc); current(); return result.state;
      } catch (error) {
        if (flow?.flowId) void api.cancelFlow({ flowId: flow.flowId }, { timeoutMs: 5_000 }).catch(() => undefined);
        throw error;
      }
    }
    case "connections.get": {
      if (!client.connections) throw new Error("Plugin connection settings are unavailable.");
      const result = await client.connections.get({ extensionId: extension.extensionId }, rpc); current(); return result.state;
    }
    case "connections.set": {
      if (!client.connections || !await host.confirm(extension.name, call.host, signal)) throw new Error("Plugin connection change was cancelled.");
      current(); const result = await client.connections.beginCredential({ extensionId: extension.extensionId, expectedRevision: { value: extension.revision }, slotKey: call.key, host: call.host,
        ...(call.label === undefined ? {} : { label: call.label }) }, rpc); current();
      if (!result.ticket) throw new Error("The private plugin connection channel is unavailable.");
      const id = await client.upload(result.ticket, call.value, signal); current();
      const finished = await client.connections.commitCredential({ extensionId: extension.extensionId, credentialUploadTicketId: id }, rpc); current(); return finished.state;
    }
    case "connections.change": {
      if (!client.connections || !await host.confirm(extension.name, call.key, signal)) throw new Error("Plugin connection change was cancelled.");
      current(); const result = await client.connections.change({ extensionId: extension.extensionId, expectedRevision: { value: extension.revision }, slotKey: call.key,
        action: call.action === "remove" ? { case: "removeConnectionId", value: call.connectionId } : { case: "defaultConnectionId", value: call.connectionId } }, rpc);
      current(); return result.state;
    }
  }
}
