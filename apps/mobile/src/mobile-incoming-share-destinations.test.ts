import { describe, expect, it } from "vitest";
import { CapabilitySupport, TargetState, capabilityNames, type Snapshot } from "@joko/contracts";
import { mobileIncomingShareTaskDestinations } from "./mobile-incoming-share-destinations";

type DestinationOwner = Pick<Snapshot, "sessions" | "targets" | "backends">;

describe("mobile incoming-share task destinations", () => {
  it("offers only uniquely owned tasks on current text-capable targets", () => {
    const owner = {
      sessions: [
        { sessionId: "ready", targetId: "active", backendId: "text" },
        { sessionId: "duplicate", targetId: "active", backendId: "text" },
        { sessionId: "duplicate", targetId: "active", backendId: "text" },
        { sessionId: "inactive", targetId: "retired", backendId: "text" },
        { sessionId: "noText", targetId: "limited", backendId: "limitedBackend" },
        { sessionId: "wrongBackend", targetId: "active", backendId: "limitedBackend" }
      ],
      targets: [
        { targetId: "active", backendId: "text", state: TargetState.ACTIVE },
        { targetId: "retired", backendId: "text", state: TargetState.ARCHIVED },
        { targetId: "limited", backendId: "limitedBackend", state: TargetState.ACTIVE }
      ],
      backends: [
        { backendId: "text", capabilities: { capabilities: [{ name: capabilityNames.inputText,
          support: CapabilitySupport.SUPPORTED }] } },
        { backendId: "limitedBackend", capabilities: { capabilities: [{ name: capabilityNames.inputText,
          support: CapabilitySupport.NOT_IMPLEMENTED }] } }
      ]
    } as unknown as DestinationOwner;

    expect(mobileIncomingShareTaskDestinations(owner).map((session) => session.sessionId)).toEqual(["ready"]);
    expect(mobileIncomingShareTaskDestinations(undefined)).toEqual([]);
  });
});
