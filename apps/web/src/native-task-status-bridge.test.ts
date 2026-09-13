import { PermissionDecisionKind } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AppController } from "./controller.js";
import type { InteractionView, SessionView, TimelineItemView } from "./model.js";
import {
  projectNativeTaskStatusSnapshot,
  resolveNativeTaskStatusPermissionAction
} from "./native-task-status-bridge.js";

describe("native task-status Web projection", () => {
  it("covers concurrent running, pending-interaction, completed, and error tasks", () => {
    const running = session("running", "running", 2n, 20);
    const permissionSession = session("permission", "waiting", 7n, 30);
    const completed = {
      ...session("completed", "idle", 3n, 10),
      attention: attention("done", true, 40)
    };
    const error = {
      ...session("error", "idle", 4n, 11),
      attention: attention("error", true, 50)
    };
    const permission = interaction("request", "permission", 7n, [
      PermissionDecisionKind.ALLOW_ONCE,
      PermissionDecisionKind.ALLOW_FOR_SESSION,
      PermissionDecisionKind.DENY_ONCE
    ]);
    const projected = projectNativeTaskStatusSnapshot({
      ownerId: "owner",
      revision: 12n,
      locale: "zh-CN",
      sessions: [running, permissionSession, completed, error],
      interactions: [permission],
      timelineBySession: new Map()
    });
    expect(projected).toMatchObject({
      ownerId: "owner", revision: "12", locale: "zh-CN"
    });
    expect(projected.sessions.map((value) => [value.sessionId, value.phase])).toEqual([
      ["running", "running"],
      ["permission", "interaction"],
      ["completed", "completed"],
      ["error", "error"]
    ]);
    expect(projected.sessions.find((value) => value.sessionId === "permission")?.permission).toEqual({
      interactionId: "request",
      generation: "7",
      allow: true,
      allowForSession: true,
      deny: true
    });
    expect(projected.sessions.find((value) => value.sessionId === "permission")?.interactionKind).toBe("permission");
  });

  it("does not invent terminal status or permission actions without authoritative values", () => {
    const idle = session("idle", "idle", 1n, 1);
    const permissionSession = session("permission", "waiting", 2n, 2);
    const permission = interaction("request", "permission", 2n, [PermissionDecisionKind.DENY_ONCE]);
    const projected = projectNativeTaskStatusSnapshot({
      ownerId: "owner", revision: 1n, locale: "en",
      sessions: [idle, permissionSession], interactions: [permission], timelineBySession: new Map()
    });
    expect(projected.sessions).toHaveLength(1);
    expect(projected.sessions[0]?.permission).toMatchObject({ allow: false, allowForSession: false, deny: true });
  });

  it("projects only the latest three bounded user-visible activity lines", () => {
    const running = session("running", "running", 2n, 20);
    const timeline = [
      timelineItem("one", "user", "First"),
      timelineItem("two", "assistant", "Second"),
      timelineItem("three", "tool", "ignored", "browser"),
      timelineItem("four", "status", "Fourth")
    ];
    const projected = projectNativeTaskStatusSnapshot({
      ownerId: "owner",
      revision: 13n,
      locale: "en",
      sessions: [running],
      interactions: [],
      timelineBySession: new Map([[running.id, timeline]])
    });
    expect(projected.sessions[0]?.activityLines).toEqual([
      { id: "two", kind: "assistant", text: "Second" },
      { id: "three", kind: "tool", text: "browser" },
      { id: "four", kind: "status", text: "Fourth" }
    ]);
  });
});

describe("native task-status permission resolution fence", () => {
  it("uses the existing Interaction operation only after exact task, interaction, and generation validation", async () => {
    const current = interaction("request", "permission", 8n, [
      PermissionDecisionKind.ALLOW_ONCE,
      PermissionDecisionKind.ALLOW_FOR_SESSION,
      PermissionDecisionKind.DENY_ONCE
    ]);
    const resolveInteraction = vi.fn(async () => undefined);
    const controller = {
      state: { snapshot: { sessions: [session("permission", "waiting", 8n, 2)], interactions: [current] } },
      resolveInteraction
    } as unknown as Pick<AppController, "state" | "resolveInteraction">;

    await expect(resolveNativeTaskStatusPermissionAction(controller, {
      kind: "permission", sessionId: "permission", interactionId: "request", generation: "7", decision: "allow"
    })).resolves.toBe(false);
    await expect(resolveNativeTaskStatusPermissionAction(controller, {
      kind: "permission", sessionId: "permission", interactionId: "request", generation: "8", decision: "allowForSession"
    })).resolves.toBe(true);
    expect(resolveInteraction).toHaveBeenCalledWith(current, {
      kind: "permission", decisionId: String(PermissionDecisionKind.ALLOW_FOR_SESSION)
    });
  });

  it("refuses a semantic action that is absent from the current allowed decisions", async () => {
    const current = interaction("request", "permission", 8n, [PermissionDecisionKind.DENY_ONCE]);
    const resolveInteraction = vi.fn(async () => undefined);
    const controller = {
      state: { snapshot: { sessions: [session("permission", "waiting", 8n, 2)], interactions: [current] } },
      resolveInteraction
    } as unknown as Pick<AppController, "state" | "resolveInteraction">;
    await expect(resolveNativeTaskStatusPermissionAction(controller, {
      kind: "permission", sessionId: "permission", interactionId: "request", generation: "8", decision: "allow"
    })).resolves.toBe(false);
    expect(resolveInteraction).not.toHaveBeenCalled();
  });
});

function session(
  id: string,
  state: SessionView["state"],
  generation: bigint,
  updatedAt: number
): SessionView {
  return {
    id,
    backendId: "backend",
    targetId: "target",
    name: `${id} task`,
    state,
    pinned: false,
    archived: false,
    generation,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt
  };
}

function attention(kind: "done" | "awaiting" | "error", unread: boolean, updatedAt: number): NonNullable<SessionView["attention"]> {
  const cursor = { opaqueToken: `${kind}:${updatedAt}`, sequence: BigInt(updatedAt), generation: 1n };
  return { kind, unread, subjectCursor: cursor, attentionCursor: cursor, readThroughCursor: cursor, updatedAt };
}

function interaction(
  id: string,
  kind: InteractionView["kind"],
  generation: bigint,
  decisions: readonly PermissionDecisionKind[]
): InteractionView {
  return {
    id,
    sessionId: "permission",
    generation,
    kind,
    title: "Permission required",
    message: "Review this action",
    options: decisions.map((decision) => ({ id: String(decision), label: String(decision) })),
    fields: [],
    planSteps: [],
    createdAt: 4
  };
}

function timelineItem(
  id: string,
  kind: TimelineItemView["kind"],
  text: string,
  toolName?: string
): TimelineItemView {
  return {
    id,
    sequence: BigInt(id.length),
    kind,
    createdAt: 1,
    text,
    ...(toolName === undefined ? {} : {
      tool: { id: `tool-${id}`, name: toolName, state: "running", input: "", isError: false }
    })
  };
}
