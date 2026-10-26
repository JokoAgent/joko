import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { expect, it, vi } from "vitest";
import { createInputHandoffGateway } from "./input-handoff-gateway.js";
import { captureProviderSharingInvitation, readProviderSharingInvitation, clearProviderSharingInvitation } from "./provider-sharing-invitation.js";

const step: contract.InputHandoffSnapshot = { kind: "input_handoff", requestId: "request-1", revision: 3, phase: "ready", purpose: "Sign in",
  source: { app: "Example", origin: "https://example.test" }, stepNumber: 1,
  controls: [{ id: "field-1", kind: "text", label: "Password", contentType: "password" }] };
const ticket = { ticketId: "private-ticket", relativeEndpoint: "/v1/credentials/upload/private-ticket", maximumBytes: 65_536n };

it("sends entered values through the private upload and only its ticket through generated handoff RPCs", async () => {
  const rpcInputs: unknown[] = [], upload = vi.fn(async (_value: string, _ticket: contract.CredentialUploadTicket | undefined, _signal: AbortSignal) => ticket.ticketId), lifetime = new AbortController();
  const transport = createRouterTransport(({ service }) => service(contract.InputHandoffService, {
    beginInputHandoffSubmission: request => { rpcInputs.push(request); return create(contract.BeginInputHandoffSubmissionResponseSchema, { ticket }); },
    submitInputHandoff: request => { rpcInputs.push(request); return create(contract.SubmitInputHandoffResponseSchema, { accepted: true }); }
  }));
  const api = createInputHandoffGateway({ transport, signal: lifetime.signal, assertCurrent: () => {}, upload });
  expect(await api.submitInputHandoff(step, { expectedRevision: 3, values: { "field-1": "synthetic-password" }, action: { kind: "fill" } })).toBe(true);
  expect(JSON.parse(upload.mock.calls[0]![0] as string)).toMatchObject({ values: { "field-1": "synthetic-password" } });
  expect(rpcInputs).toMatchObject([{ requestId: "request-1", expectedRevision: 3n, presentationSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
    { requestId: "request-1", expectedRevision: 3n, credentialUploadTicketId: "private-ticket" }]);
  expect(JSON.stringify(rpcInputs, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value)).not.toContain("synthetic-password");
});

it("drops an old owner response before any private upload when the connection retires", async () => {
  const lifetime = new AbortController(), upload = vi.fn(async () => ticket.ticketId), submit = vi.fn();
  const transport = createRouterTransport(({ service }) => service(contract.InputHandoffService, {
    beginInputHandoffSubmission: () => { lifetime.abort(); return create(contract.BeginInputHandoffSubmissionResponseSchema, { ticket }); }, submitInputHandoff: submit
  }));
  const api = createInputHandoffGateway({ transport, signal: lifetime.signal, assertCurrent: () => lifetime.signal.throwIfAborted(), upload });
  await expect(api.submitInputHandoff(step, { expectedRevision: 3, values: { "field-1": "synthetic-password" }, action: { kind: "fill" } })).rejects.toBeDefined();
  expect(upload).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});

it("uses only the server-resolved original peer and the same handoff request for the native viewer", async () => {
  const openLive = vi.fn(async () => {}), lifetime = new AbortController();
  const transport = createRouterTransport(({ service }) => service(contract.InputHandoffService, {
    openInputHandoffLiveView: request => create(contract.OpenInputHandoffLiveViewResponseSchema, { requestId: request.requestId,
      peer: { targetDeviceId: "original-device", relationId: "owner-relation", routeGeneration: 4n } })
  }));
  const api = createInputHandoffGateway({ transport, signal: lifetime.signal, assertCurrent: () => {}, upload: async () => "", openLive });
  await api.openInputHandoffLiveView!(step);
  expect(openLive).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ targetDeviceId: "original-device", routeGeneration: 4n }), "request-1", lifetime.signal);
});

it("clears a provider invitation fragment before routing and keeps it only in current memory for explicit preview", () => {
  const link = contract.buildProviderSharingLink("https://home.example.test", "a".repeat(43), `ed25519:${"a".repeat(64)}`), replaceState = vi.fn();
  clearProviderSharingInvitation();
  captureProviderSharingInvitation({ href: link, pathname: "/provider-share/join" }, { replaceState, state: null });
  expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/#/settings/sharing");
  expect(readProviderSharingInvitation()).toBe(link); clearProviderSharingInvitation(link); expect(readProviderSharingInvitation()).toBeUndefined();
});
