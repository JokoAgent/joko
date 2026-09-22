import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { MessagingTransportError, type WeChatAuthorizationEvent } from "@joko/messaging";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { CredentialManager } from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { createMessagingConnectService } from "./messaging-connect-service.js";
import { MessagingManager, type MessagingManagerOptions } from "./messaging-manager.js";
import { SessionHost } from "./session-host.js";
import { mkdtempSync } from "./test-paths.js";
import type { WeChatAuthorizationPort } from "./wechat-authorization-manager.js";

const QR_URL = "https://ilinkai.weixin.qq.com/qr/opaque-image";
const CREDENTIALS = {
  token: "private-wechat-bot-token",
  botId: "bot-one",
  userId: "account-one",
  baseUrl: "https://ilinkai.weixin.qq.com/"
};
type RequiredMessagingConnection = contract.MessagingConnection & {
  readonly connectionId: string;
  readonly generation: bigint;
  readonly revision: contract.Revision;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ScriptAuthorization implements WeChatAuthorizationPort {
  readonly id = `protocol-${Math.random().toString(16).slice(2)}`;
  closed = false;
  readonly events: Array<WeChatAuthorizationEvent | (() => Promise<WeChatAuthorizationEvent>)> = [];

  async begin(): Promise<WeChatAuthorizationEvent> {
    return { status: "waiting", attemptId: this.id, qrCodeUrl: QR_URL, expiresAt: Date.now() + 300_000 };
  }

  async poll(): Promise<WeChatAuthorizationEvent> {
    const event = this.events.shift();
    if (typeof event === "function") return event();
    return event ?? { status: "waiting", attemptId: this.id, qrCodeUrl: QR_URL, expiresAt: Date.now() + 300_000 };
  }

  cancel(): void { this.closed = true; }
  close(): void { this.closed = true; }
}

describe("WeChat authorization Connect boundary", () => {
  it("binds QR, verification input and confirmed Vault credential to the authenticated client without public secrets", async () => {
    const script = new ScriptAuthorization();
    script.events.push(
      { status: "scanned", attemptId: script.id, qrCodeUrl: QR_URL, expiresAt: Date.now() + 300_000 },
      { status: "verification_required", attemptId: script.id, retry: false },
      { status: "confirmed", attemptId: script.id, credentials: CREDENTIALS }
    );
    const fixture = await makeFixture();
    let client = "desktop-one";
    const service = createMessagingConnectService(fixture.manager, () => ({ connectionId: client }), {
      credentials: fixture.credentials,
      createWeChatAuthorization: () => script
    });
    cleanups.push(() => script.close());
    const context = {} as HandlerContext;

    const settings = await service.getMessagingSettings(create(contract.GetMessagingSettingsRequestSchema), context);
    expect(settings.channels?.find((item) => item.channel === contract.MessagingChannel.WECHAT))
      .toMatchObject({ available: true, reason: "" });

    await expect(service.createMessagingConnection(create(contract.CreateMessagingConnectionRequestSchema, {
      channel: contract.MessagingChannel.WECHAT,
      ownerProviderUserId: "must-not-be-client-selected",
      wechatConfiguration: create(contract.WeChatMessagingConfigurationSchema)
    }), context)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.InvalidArgument
    );
    await expect(service.createMessagingConnection(create(contract.CreateMessagingConnectionRequestSchema, {
      channel: contract.MessagingChannel.WECHAT,
      wechatConfiguration: create(contract.WeChatMessagingConfigurationSchema),
      telegramConfiguration: create(contract.TelegramMessagingConfigurationSchema)
    }), context)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.InvalidArgument
    );

    const created = (await service.createMessagingConnection(create(contract.CreateMessagingConnectionRequestSchema, {
      channel: contract.MessagingChannel.WECHAT,
      wechatConfiguration: create(contract.WeChatMessagingConfigurationSchema)
    }), context)).connection! as RequiredMessagingConnection;
    expect(created.wechatConfiguration).toBeDefined();
    expect(created.credentialConfigured).toBe(false);

    const started = (await service.beginWeChatAuthorization(create(contract.BeginWeChatAuthorizationRequestSchema, {
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    }), context)).attempt!;
    expect(started.status).toBe(contract.WeChatAuthorizationStatus.WAITING);
    expect(started.qrCodeUrl).toBe(QR_URL);
    expect(started.connection).toBeUndefined();

    const get = () => service.getWeChatAuthorization(create(contract.GetWeChatAuthorizationRequestSchema, {
      connectionId: created.connectionId,
      attemptId: started.attemptId,
      expectedGeneration: created.generation
    }), context);
    expect((await get()).attempt!.status).toBe(contract.WeChatAuthorizationStatus.SCANNED);
    const verification = (await get()).attempt!;
    expect(verification.status).toBe(contract.WeChatAuthorizationStatus.VERIFICATION_REQUIRED);
    expect(verification.qrCodeUrl).toBe(QR_URL);

    const ticket = (await service.beginWeChatVerificationInput(create(
      contract.BeginWeChatVerificationInputRequestSchema,
      { connectionId: created.connectionId, attemptId: started.attemptId, expectedGeneration: created.generation }
    ), context)).ticket!;
    fixture.credentials.upload(ticket.ticketId!, "123456", client);
    client = "desktop-two";
    await expect(service.submitWeChatVerificationCode(create(contract.SubmitWeChatVerificationCodeRequestSchema, {
      connectionId: created.connectionId,
      attemptId: started.attemptId,
      expectedGeneration: created.generation,
      credentialInputTicketId: ticket.ticketId
    }), context)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.Aborted
    );
    client = "desktop-one";
    const confirmed = (await service.submitWeChatVerificationCode(create(
      contract.SubmitWeChatVerificationCodeRequestSchema,
      {
        connectionId: created.connectionId,
        attemptId: started.attemptId,
        expectedGeneration: created.generation,
        credentialInputTicketId: ticket.ticketId
      }
    ), context)).attempt!;
    expect(confirmed.status).toBe(contract.WeChatAuthorizationStatus.SUCCEEDED);
    expect(confirmed.connection).toMatchObject({
      channel: contract.MessagingChannel.WECHAT,
      credentialConfigured: true,
      ownerProviderUserId: CREDENTIALS.userId
    });
    expect(confirmed.connection!.generation).toBe(created.generation + 1n);
    expect(safeStringify(confirmed)).not.toContain(CREDENTIALS.token);
    expect(safeStringify(fixture.store.getMessagingConnection(created.connectionId))).not.toContain(CREDENTIALS.token);
    expect((await get()).attempt!.status).toBe(contract.WeChatAuthorizationStatus.SUCCEEDED);
    await expect(service.submitWeChatVerificationCode(create(contract.SubmitWeChatVerificationCodeRequestSchema, {
      connectionId: created.connectionId,
      attemptId: started.attemptId,
      expectedGeneration: created.generation,
      credentialInputTicketId: ticket.ticketId
    }), context)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.InvalidArgument
    );
  });

  it("retires repeated and cancelled attempts before a late confirmation can replace the connection", async () => {
    const first = new ScriptAuthorization();
    const second = new ScriptAuthorization();
    let resolveLate: ((event: WeChatAuthorizationEvent) => void) | undefined;
    first.events.push(() => new Promise((resolve) => { resolveLate = resolve; }));
    const scripts = [first, second];
    const fixture = await makeFixture();
    const service = createMessagingConnectService(fixture.manager, () => ({ connectionId: "desktop" }), {
      credentials: fixture.credentials,
      createWeChatAuthorization: () => scripts.shift()!
    });
    const context = {} as HandlerContext;
    const created = (await service.createMessagingConnection(create(contract.CreateMessagingConnectionRequestSchema, {
      channel: contract.MessagingChannel.WECHAT,
      wechatConfiguration: create(contract.WeChatMessagingConfigurationSchema)
    }), context)).connection! as RequiredMessagingConnection;
    const request = create(contract.BeginWeChatAuthorizationRequestSchema, {
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    });
    const started = (await service.beginWeChatAuthorization(request, context)).attempt!;
    const oldPoll = service.getWeChatAuthorization(create(contract.GetWeChatAuthorizationRequestSchema, {
      connectionId: created.connectionId,
      attemptId: started.attemptId,
      expectedGeneration: created.generation
    }), context);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const replacement = service.beginWeChatAuthorization(request, context);
    resolveLate!({ status: "confirmed", attemptId: first.id, credentials: CREDENTIALS });
    await expect(oldPoll).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.Aborted
    );
    const next = (await replacement).attempt!;
    expect(next.attemptId).not.toBe(started.attemptId);
    expect(first.closed).toBe(true);
    expect(fixture.store.getMessagingConnection(created.connectionId).credentialReferenceId).toBeUndefined();

    const cancelled = (await service.cancelWeChatAuthorization(create(contract.CancelWeChatAuthorizationRequestSchema, {
      connectionId: created.connectionId,
      attemptId: next.attemptId,
      expectedGeneration: created.generation
    }), context)).attempt!;
    expect(cancelled.status).toBe(contract.WeChatAuthorizationStatus.CANCELLED);
    expect(second.closed).toBe(true);
    expect(fixture.store.getMessagingConnection(created.connectionId).credentialReferenceId).toBeUndefined();
  });

  it("keeps a valid rebind attempt after a transient poll error but fails closed when material changes", async () => {
    const script = new ScriptAuthorization();
    script.events.push(() => Promise.reject(new MessagingTransportError("network", "network", {
      retryable: true, effect: "none"
    })));
    const fixture = await makeFixture();
    const service = createMessagingConnectService(fixture.manager, () => ({ connectionId: "desktop" }), {
      credentials: fixture.credentials,
      createWeChatAuthorization: () => script
    });
    const context = {} as HandlerContext;
    const created = (await service.createMessagingConnection(create(contract.CreateMessagingConnectionRequestSchema, {
      channel: contract.MessagingChannel.WECHAT,
      wechatConfiguration: create(contract.WeChatMessagingConfigurationSchema)
    }), context)).connection! as RequiredMessagingConnection;
    const started = (await service.beginWeChatAuthorization(create(contract.BeginWeChatAuthorizationRequestSchema, {
      connectionId: created.connectionId,
      expectedRevision: created.revision,
      expectedGeneration: created.generation
    }), context)).attempt!;
    const request = create(contract.GetWeChatAuthorizationRequestSchema, {
      connectionId: created.connectionId,
      attemptId: started.attemptId,
      expectedGeneration: created.generation
    });
    const transient = (await service.getWeChatAuthorization(request, context)).attempt!;
    expect(transient.status).toBe(contract.WeChatAuthorizationStatus.WAITING);
    expect(transient.errorCode).toBe("network");
    expect(transient.qrCodeUrl).toBe(QR_URL);

    const changed = await fixture.manager.clearCredential({
      connectionId: created.connectionId,
      expectedRevision: created.revision!.value,
      expectedGeneration: Number(created.generation)
    });
    expect(changed.generation).toBeGreaterThan(Number(created.generation));
    await expect(service.getWeChatAuthorization(request, context)).rejects.toSatisfy(
      (error: unknown) => error instanceof ConnectError && error.code === Code.Aborted
    );
  });
});

async function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "joko-wechat-auth-"));
  const store = new OperationalStore(join(root, "operational.db"));
  const artifacts = new ArtifactStore({
    rootDirectory: join(root, "artifacts"),
    repository: new OperationalArtifactRepository(store),
    ingestRoots: [root]
  });
  await artifacts.initialize();
  const vault = await CredentialVault.open(join(root, "vault.key"));
  const credentials = new CredentialManager({ vault, storagePath: join(root, "credentials.json") });
  await credentials.initialize();
  const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
  let manager: MessagingManager | undefined;
  const host = new SessionHost(store, artifacts, [adapter], {
    onServiceRunSettled: (input) => manager?.onRunSettled(input)
  });
  await host.initialize();
  await host.registerTarget({
    id: "target-one",
    backendId: adapter.id,
    displayName: "Messaging target",
    workspaceRoot: root,
    managed: true,
    trusted: true
  });
  manager = new MessagingManager({
    store, credentials, contextVault: vault, sessionHost: host, artifacts,
    createWeChatTransport: (options) => ({
      channel: "wechat",
      connectionId: options.connectionId,
      generation: options.generation,
      probe: async () => ({
        channel: "wechat", connectionId: options.connectionId, generation: options.generation,
        providerAccountId: options.credentials.botId, displayName: "WeChat test bot", username: null
      }),
      poll: ({ signal }: { readonly signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new MessagingTransportError("cancelled", "test closed", {
          retryable: false, effect: "none"
        }));
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      }),
      close: async () => undefined
    }) as unknown as ReturnType<NonNullable<MessagingManagerOptions["createWeChatTransport"]>>
  });
  await manager.initialize();
  cleanups.push(async () => {
    await manager?.close().catch(() => undefined);
    await host.dispose().catch(() => undefined);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, credentials, manager };
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
}
