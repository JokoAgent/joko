import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { SshKeyError, SshKeyManager, sshKeyInstallCommand, type SshKeyInfo } from "@joko/remote-ssh";
import { NotFoundError } from "@joko/store";
import type { CredentialManager } from "./credential-manager.js";
import { fromProtoRevision, toProtoTimestamp } from "./proto-mapper.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";

export function createSshKeyConnectService(options: {
  readonly keys?: SshKeyManager;
  readonly credentials?: CredentialManager;
  readonly hosts?: RemoteHostRegistry;
  readonly authenticate: (context: HandlerContext) => { readonly connectionId: string };
  readonly onRevoked: (connectionId: string, listener: () => void) => () => void;
}): ServiceImpl<typeof contract.SshKeyService> {
  async function call<T>(context: HandlerContext, action: (keys: SshKeyManager, connectionId: string, signal: AbortSignal) => Promise<T>, mutates = false): Promise<T> {
    const owner = options.authenticate(context);
    if (!options.keys) throw new ConnectError("SSH key management is unavailable.", Code.Unimplemented);
    const abort = new AbortController();
    const cancel = (): void => abort.abort();
    const unsubscribe = options.onRevoked(owner.connectionId, cancel);
    context.signal.addEventListener("abort", cancel, { once: true });
    let mutationCompleted = false;
    const assertOwner = (): void => {
      if (options.authenticate(context).connectionId !== owner.connectionId) {
        throw new ConnectError("SSH request ownership changed.", Code.Unauthenticated);
      }
    };
    try {
      if (context.signal.aborted) cancel();
      assertOwner();
      if (abort.signal.aborted) throw new SshKeyError("aborted");
      const value = await action(options.keys, owner.connectionId, abort.signal);
      mutationCompleted = mutates;
      assertOwner();
      if (abort.signal.aborted) throw new SshKeyError("aborted");
      return value;
    } catch (error) { throw mapError(mutationCompleted ? new SshKeyError("outcome_unknown") : error); }
    finally { unsubscribe(); context.signal.removeEventListener("abort", cancel); }
  }
  function credentials(): CredentialManager {
    if (!options.credentials) throw new ConnectError("SSH credential upload is unavailable.", Code.Unimplemented);
    return options.credentials;
  }
  function passphrase(ticket: string | undefined, connectionId: string, purpose: "generate" | "agent_add", keyId = "", expectedFingerprint = ""): string | undefined {
    if (ticket === undefined) return undefined;
    try { return credentials().consumeSshKeyPassphrase({ credentialUploadTicketId: ticket, connectionId, purpose, keyId, expectedFingerprint }); }
    catch { throw new ConnectError("ssh_key.invalid_passphrase_ticket", Code.InvalidArgument); }
  }
  return {
    listSshKeys: (_, context) => call(context, async (keys, _owner, signal) => {
      const result = await keys.list(signal);
      return create(contract.ListSshKeysResponseSchema, {
        keys: result.keys.map(toProtoKey), generationSupported: result.generationSupported,
        agentState: result.agentState === "ready" ? contract.SshAgentState.READY
          : result.agentState === "unavailable" ? contract.SshAgentState.UNAVAILABLE : contract.SshAgentState.FAILED
      });
    }),
    beginSshKeyPassphraseUpload: (request, context) => call(context, async (keys, connectionId, signal) => {
      let purpose: "generate" | "agent_add";
      if (request.purpose === contract.SshKeyPassphrasePurpose.GENERATE && request.keyId === "" && request.expectedFingerprint === "") purpose = "generate";
      else if (request.purpose === contract.SshKeyPassphrasePurpose.AGENT_ADD) {
        await keys.readPublic(request.keyId, request.expectedFingerprint, signal);
        purpose = "agent_add";
      } else throw new ConnectError("SSH passphrase purpose is invalid.", Code.InvalidArgument);
      const ticket = credentials().createSshKeyPassphraseTicket({ connectionId, purpose, keyId: request.keyId, expectedFingerprint: request.expectedFingerprint });
      return create(contract.BeginSshKeyPassphraseUploadResponseSchema, { ticket: {
        ticketId: ticket.credentialUploadTicketId,
        relativeEndpoint: `/v1/credentials/upload/${encodeURIComponent(ticket.credentialUploadTicketId)}`,
        expiresAt: toProtoTimestamp(ticket.expiresAt), maximumBytes: BigInt(ticket.maximumBytes)
      } });
    }),
    generateSshKey: (request, context) => call(context, async (keys, connectionId, signal) => {
      const secret = passphrase(request.passphraseUploadTicketId, connectionId, "generate");
      const key = await keys.generate({ name: request.name, comment: request.comment, ...(secret === undefined ? {} : { passphrase: secret }) }, signal);
      return create(contract.GenerateSshKeyResponseSchema, { key: toProtoKey(key) });
    }, true),
    addSshKeyToAgent: (request, context) => call(context, async (keys, connectionId, signal) => {
      const secret = passphrase(request.passphraseUploadTicketId, connectionId, "agent_add", request.keyId, request.expectedFingerprint);
      await keys.addToAgent(request.keyId, request.expectedFingerprint, secret, signal);
      return create(contract.AddSshKeyToAgentResponseSchema);
    }, true),
    readSshPublicKey: (request, context) => call(context, async (keys, _connectionId, signal) => create(contract.ReadSshPublicKeyResponseSchema, {
      publicKey: await keys.readPublic(request.keyId, request.expectedFingerprint, signal)
    })),
    getSshKeyInstallCommand: (request, context) => call(context, async (keys, _connectionId, signal) => {
      const destination = request.destination;
      if (!destination.case) throw new ConnectError("SSH installation destination is required.", Code.InvalidArgument);
      const saved = destination.case === "savedHost" ? destination.value : undefined;
      if (saved && !options.hosts) throw new ConnectError("Remote Host catalog is unavailable.", Code.Unimplemented);
      const expected = saved ? fromProtoRevision(saved.expectedRevision, "expected_revision") : undefined;
      const host = saved ? options.hosts!.get(saved.targetId, saved.hostId) : destination.value as contract.SshKeyDraftHost;
      if (saved && "revision" in host && host.revision !== expected) throw new ConnectError("Remote Host changed. Refresh before preparing the command.", Code.Aborted);
      const shell = request.shell === contract.SshInstallShell.POSIX ? "posix"
        : request.shell === contract.SshInstallShell.POWERSHELL ? "powershell" : undefined;
      if (!shell) throw new ConnectError("SSH installation shell is required.", Code.InvalidArgument);
      const key = await keys.readPublic(request.keyId, request.expectedFingerprint, signal);
      if (saved && options.hosts!.get(saved.targetId, saved.hostId).revision !== expected) throw new ConnectError("Remote Host changed. Refresh before preparing the command.", Code.Aborted);
      return create(contract.GetSshKeyInstallCommandResponseSchema, { command: sshKeyInstallCommand(key, host, shell) });
    })
  };
}
function toProtoKey(value: SshKeyInfo): contract.SshKey {
  return create(contract.SshKeySchema, { ...value, modifiedAt: toProtoTimestamp(Math.floor(value.modifiedAt)) });
}
function mapError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof NotFoundError) return new ConnectError("SSH source was not found.", Code.NotFound);
  if (!(error instanceof SshKeyError)) return new ConnectError("ssh_key.io_failed", Code.Internal);
  const code = error.code === "invalid_name" || error.code === "invalid_key" || error.code === "bad_passphrase" ? Code.InvalidArgument
    : error.code === "key_changed" ? Code.Aborted : error.code === "not_found" ? Code.NotFound
      : error.code === "agent_unavailable" ? Code.Unavailable : error.code === "agent_failed" || error.code === "outcome_unknown" ? Code.FailedPrecondition
        : error.code === "busy" ? Code.ResourceExhausted : error.code === "aborted" ? Code.Canceled : Code.Internal;
  return new ConnectError(error.message, code);
}
