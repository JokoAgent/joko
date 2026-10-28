import { create } from "@bufbuild/protobuf";
import { HostedAgentModelAccessSchema, type HostedAgentModelAccess } from "./gen/joko/v1/hosted_agent_pb.js";

/** undefined inherits the Provider's current and future catalog; [] denies all. */
export function readRemoteModelAccess(value: HostedAgentModelAccess | undefined): readonly string[] | undefined {
  if (!value) return undefined;
  if (value.modelIds.length > 4096 || value.modelIds.some(id => !id || id.length > 512 || /[\0\r\n]/u.test(id))
    || new Set(value.modelIds).size !== value.modelIds.length || value.allModels && value.modelIds.length) throw new Error("Invalid remote model selection.");
  return value.allModels ? undefined : [...value.modelIds];
}

export function toRemoteModelAccess(modelIds: readonly string[] | undefined): HostedAgentModelAccess {
  const value = create(HostedAgentModelAccessSchema, { allModels: modelIds === undefined, modelIds: modelIds ? [...modelIds] : [] });
  readRemoteModelAccess(value); return value;
}
