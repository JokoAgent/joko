import { buildTaskShareInvitation } from "@joko/contracts";
import { expect, it } from "vitest";
import { DesktopTaskSharingInvitationBuffer } from "../src/task-sharing-invitation.js";
import { DesktopInboundOpenIntentFence, desktopInboundOpenIntentFromArgv, parseDesktopDeepLink } from "../src/deep-link.js";

const invitation = (shareId = "share") => buildTaskShareInvitation({ hostOrigin: "https://host.example",
  hostServerId: "host", endpointPublicKey: `ed25519:${"a".repeat(64)}`, shareId, shareGeneration: 1n, inviteSecret: "a".repeat(43) });

it("accepts the canonical private handoff from cold argv and retires an earlier asynchronous navigation", () => {
  const value = invitation(), parsed = parseDesktopDeepLink(value);
  expect(parsed).toEqual({ kind: "taskShareInvitation", invitation: value });
  expect(desktopInboundOpenIntentFromArgv(["Joko.exe", value], "win32")).toEqual(parsed);
  for (const bad of [value.replace("#", "?token="), `${value}&extra`, "joko://shared-task/join#invalid", ` ${value}`]) {
    expect(parseDesktopDeepLink(bad)).toBeUndefined();
  }
  const fence = new DesktopInboundOpenIntentFence(), earlier = fence.begin({ kind: "portableFile", path: "D:\\task.jshare" })!;
  expect(fence.begin(parsed!)).toBeUndefined();
  expect(fence.isCurrent(earlier)).toBe(false);
});

it("keeps a private invitation across Document replacement, acknowledges only its exact occurrence and retires replaced intent", () => {
  const buffer = new DesktopTaskSharingInvitationBuffer();
  expect(buffer.offer(invitation())).toBeUndefined();
  const first = buffer.take("document-one")!;
  buffer.resetDocument();
  expect(buffer.acknowledge(first.documentOccurrence, first.deliveryOccurrence)).toBe(false);
  const replacement = buffer.take("document-two")!;
  expect(replacement.invitation).toBe(first.invitation);
  const newer = buffer.offer(invitation("new-share"))!;
  expect(buffer.acknowledge(replacement.documentOccurrence, replacement.deliveryOccurrence)).toBe(false);
  expect(buffer.acknowledge(newer.documentOccurrence, newer.deliveryOccurrence)).toBe(true);
  expect(buffer.take("document-two")).toBeUndefined();
  buffer.offer(invitation()); buffer.retirePending();
  expect(buffer.take("document-three")).toBeUndefined();
});
