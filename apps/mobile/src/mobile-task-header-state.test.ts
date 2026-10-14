import { create } from "@bufbuild/protobuf";
import { QueueControlSchema, QueueDispatchState, SessionSchema } from "@joko/contracts";
import { expect, it } from "vitest";
import { mobileTaskHeaderLayout, mobileTaskHeaderTitleWidth } from "./mobile-task-header-layout";
import { mobileTaskHeaderNotice } from "./mobile-task-header-notice";

it("selects native header modes only for the fixed platform, window, source and sharing conditions and reserves toolbar title space", () => {
  const input = { platform: "ios", barEdge: "none" as const, persistent: false, selection: false, partner: false, drawerMounted: false };
  expect(mobileTaskHeaderLayout(input)).toBe("horizontal");
  expect(mobileTaskHeaderLayout({ ...input, barEdge: "left" })).toBe("rail");
  for (const patch of [{ platform: "android" }, { partner: true }, { persistent: true }]) expect(mobileTaskHeaderLayout({ ...input, ...patch })).toBe("inline");
  expect(mobileTaskHeaderLayout({ ...input, drawerMounted: true })).toBe("hidden");
  expect(mobileTaskHeaderLayout({ ...input, selection: true, barEdge: "right", drawerMounted: true })).toBe("selection");
  expect(mobileTaskHeaderTitleWidth(390, true, false)).toBe(106);
  expect(mobileTaskHeaderTitleWidth(390, true, true)).toBe(194);
  expect(mobileTaskHeaderTitleWidth(900, false, false)).toBe(240); expect(mobileTaskHeaderTitleWidth(150, true, false)).toBe(0);
});
it("prioritizes current queue, collaboration and archive notices and excludes another task's controls", () => {
  const session = create(SessionSchema, { sessionId: "task", backendId: "backend", targetId: "target" });
  const control = create(QueueControlSchema, { sessionId: "task", backendId: "backend", targetId: "target", queuedItemCount: 3n,
    dispatchState: QueueDispatchState.PAUSED });
  const input = { status: "connected" as const, session, pendingCount: 0, role: "worker" as const, queueControls: [control], locale: "en" as const };
  expect(mobileTaskHeaderNotice(input)).toBe("3 queued");
  control.queuedItemCount = 0n; expect(mobileTaskHeaderNotice(input)).toBe("Collaboration worker");
  expect(mobileTaskHeaderNotice({ ...input, role: "lead" })).toBe("Collaboration lead");
  session.archived = true; expect(mobileTaskHeaderNotice({ ...input, role: "ordinary" })).toBe("Archived");
  session.archived = false; expect(mobileTaskHeaderNotice({ ...input, role: "ordinary" })).toBe("Queue paused");
  control.sessionId = "other"; expect(mobileTaskHeaderNotice({ ...input, role: "ordinary" })).toBeUndefined();
  expect(mobileTaskHeaderNotice({ ...input, status: "offline" })).toBe("This Joko node is offline");
});
