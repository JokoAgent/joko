import { create } from "@bufbuild/protobuf";
import { EventSchema, SnapshotSchema, type Event } from "@joko/contracts";
import { describe, expect, it } from "vitest";

import {
  isVisionBridgeStatusEvent,
  mapSnapshot,
  projectSnapshotEvent,
  visionBridgeUiEffect
} from "./gateway.js";

describe("Vision Bridge UI event projection", () => {
  it("preserves full Backend+Provider+Model identity in settings projection", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      settings: {
        agentResource: {},
        collaboration: {},
        gitSafety: {},
        visionBridge: {
          enabled: true,
          targetModels: [
            { backendId: "backend-a", providerId: "provider", modelId: "model" },
            { backendId: "backend-b", providerId: "provider", modelId: "model" }
          ],
          primary: { backendId: "backend-a", providerId: "provider", modelId: "vision" },
          fallback: { backendId: "backend-b", providerId: "provider", modelId: "vision" }
        }
      }
    }));

    expect(snapshot.settings.visionBridge).toMatchObject({
      targetModels: [
        { backendId: "backend-a", providerId: "provider", modelId: "model" },
        { backendId: "backend-b", providerId: "provider", modelId: "model" }
      ],
      primary: { backendId: "backend-a", providerId: "provider", modelId: "vision" },
      fallback: { backendId: "backend-b", providerId: "provider", modelId: "vision" }
    });
  });

  it("extracts trusted status keys and generic output/terminal cleanup", () => {
    expect(visionBridgeUiEffect(event("statusStream", {
      statusId: "vision-bridge-recognizing",
      label: "vision-bridge-recognizing",
      detail: "3"
    }))).toMatchObject({ kind: "recognizing", sessionId: "session-a", imageCount: 3 });
    expect(visionBridgeUiEffect(event("statusStream", {
      statusId: "vision-bridge-fallback",
      label: "vision-bridge-fallback"
    }))).toMatchObject({ kind: "fallback" });
    expect(visionBridgeUiEffect(event("statusStream", {
      statusId: "vision-bridge-unavailable",
      label: "vision-bridge-unavailable"
    }))).toMatchObject({ kind: "unavailable" });
    expect(visionBridgeUiEffect(event("textDelta", { messageId: "message-a", delta: "first" })))
      .toMatchObject({ kind: "clear", sessionId: "session-a" });
    expect(visionBridgeUiEffect(event("runDone", { runId: "run-a" })))
      .toMatchObject({ kind: "clear", sessionId: "session-a" });
    expect(visionBridgeUiEffect(event("statusStream", { statusId: "working", label: "Working" })))
      .toBeUndefined();
  });

  it("filters dedicated Vision status from live and rebuilt timelines", () => {
    const raw = create(SnapshotSchema, { generation: 1n, timeline: [] });
    const snapshot = mapSnapshot(raw);
    const status = event("statusStream", {
      statusId: "vision-bridge-recognizing",
      label: "vision-bridge-recognizing",
      detail: "1"
    });
    expect(isVisionBridgeStatusEvent(status)).toBe(true);
    const result = projectSnapshotEvent(raw, snapshot, status);
    expect(result.rawSnapshot.timeline).toEqual([]);
    expect(result.snapshot.timelineBySession.get("session-a")).toBeUndefined();

    const rebuilt = mapSnapshot(create(SnapshotSchema, { generation: 1n, timeline: [status] }));
    expect(rebuilt.timelineBySession.get("session-a")).toBeUndefined();
  });
});

function event(caseName: NonNullable<NonNullable<Event["payload"]>["kind"]>["case"], value: unknown): Event {
  return create(EventSchema, {
    eventId: `event-${caseName}`,
    cursor: { generation: 1n, sequence: 1n },
    identity: { sessionId: "session-a", runId: "run-a" },
    payload: { kind: { case: caseName, value } as NonNullable<Event["payload"]>["kind"] }
  });
}
