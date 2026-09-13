import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { operationBodyHash, type OperationRecord } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";

const connection = {
  id: "voice-settings-connection",
  name: "Voice settings test",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

function context(): unknown {
  return { requestHeader: new Headers({ authorization: "Bearer test" }), signal: new AbortController().signal };
}

function completedRecord(id: string, kind: string, body: unknown, response: unknown): OperationRecord<unknown> {
  return {
    id,
    connectionId: connection.id,
    kind,
    body,
    bodyHash: operationBodyHash(body),
    completionMode: "external_effect",
    status: "completed",
    response,
    createdAt: 1,
    updatedAt: 2,
    revision: 1n
  };
}

describe("voice input settings operation", () => {
  it("persists the operation before applying the settings effect", async () => {
    const calls: string[] = [];
    const saved = create(contract.VoiceInputServiceSettingsSchema, {
      enabled: true,
      protocol: contract.VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH,
      endpoint: "https://speech.example/transcribe",
      model: "voice-model",
      keyless: true,
      credentialConfigured: false,
      version: { revision: { value: 2n }, generation: 0n, updatedAt: { seconds: 1n } }
    });
    const apply = vi.fn(async () => {
      calls.push("apply");
      return saved;
    });
    const host = {
      mutate: async (input: {
        readonly operationId: string;
        readonly kind: string;
        readonly body: unknown;
        readonly commit: () => unknown;
        readonly effect?: () => Promise<void>;
      }) => {
        calls.push("persist");
        const value = input.commit();
        await input.effect?.();
        return { replayed: false, value, operation: completedRecord(input.operationId, input.kind, input.body, value) };
      }
    };
    const application = {
      config: { publicOrigin: "https://orchestrator.example.test" },
      store: { findOperation: () => undefined },
      connections: { authenticate: () => connection },
      artifacts: {},
      blobTransfers: {},
      artifactRepository: {},
      workspaces: {},
      workspaceChanges: {},
      sessionHost: host,
      scheduler: {},
      adapters: [],
      browserActivity: [],
      voiceInputSettings: { snapshot: () => saved, apply },
      close: async () => undefined
    } as unknown as OrchestratorApplication;
    const services = createConnectServices(application);
    const patch = create(contract.VoiceInputServiceSettingsPatchSchema, {
      enabled: true,
      endpoint: "https://speech.example/transcribe",
      model: "voice-model",
      keyless: true,
      expectedRevision: { value: 1n }
    });
    const request = create(contract.SubmitOperationRequestSchema, {
      operationId: "voice-settings-operation",
      connectionId: connection.id,
      mutation: create(contract.OperationMutationSchema, {
        payload: {
          case: "updateVoiceInputServiceSettings",
          value: create(contract.UpdateVoiceInputServiceSettingsMutationSchema, { patch })
        }
      })
    });

    const response = await (services.operation.submitOperation as (
      request: contract.SubmitOperationRequest,
      context: unknown
    ) => Promise<contract.SubmitOperationResponse>)(request, context());

    expect(calls).toEqual(["persist", "apply"]);
    expect(apply).toHaveBeenCalledWith(patch, connection.id);
    expect(response.operation).toMatchObject({ state: contract.OperationState.SUCCEEDED });
    expect(response.operation?.result?.payload).toMatchObject({
      case: "acknowledgement",
      value: { accepted: true }
    });
  });
});
