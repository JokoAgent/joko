import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  DesktopNotificationCoordinator,
  parseDesktopNotification,
  type NativeDesktopNotification
} from "../src/desktop-notification.js";

class FakeNotification extends EventEmitter implements NativeDesktopNotification {
  readonly show = vi.fn<() => void>();
  readonly close = vi.fn(() => { this.emit("close"); });

  click(): void {
    this.emit("click");
  }
}

describe("Desktop notifications", () => {
  it("accepts only bounded text and an exact machine-owned task route", () => {
    const parsed = parseDesktopNotification({
      title: "Joko · Task",
      body: "Needs attention",
      navigation: { kind: "session", profileId: "machine-a", sessionId: "task-a" }
    });
    expect(parsed).toEqual({
      title: "Joko · Task",
      body: "Needs attention",
      navigation: { kind: "session", profileId: "machine-a", sessionId: "task-a" }
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.navigation)).toBe(true);
    expect(() => parseDesktopNotification({ title: "Task", body: "Done", sessionId: "task-a" }))
      .toThrow(/optional navigation/u);
    expect(() => parseDesktopNotification({
      title: "Task",
      body: "Done",
      navigation: { kind: "session", profileId: "machine-a", sessionId: "task-a", owner: "extra" }
    })).toThrow(/exact machine task/u);
    expect(() => parseDesktopNotification({
      title: "Task",
      body: "Done",
      navigation: { kind: "session", profileId: "machine-a", sessionId: "x".repeat(257) }
    })).toThrow(/exact machine task/u);
  });

  it("suppresses native notifications while any application window is foreground", () => {
    const fixture = coordinatorFixture();
    fixture.setForeground(true);
    expect(fixture.coordinator.show(fixture.owner, "document-one", notification())).toBe(false);
    expect(fixture.createNotification).not.toHaveBeenCalled();
  });

  it("activates the same current document and delivers its exact route once on click", () => {
    const fixture = coordinatorFixture();
    expect(fixture.coordinator.show(fixture.owner, "document-one", notification())).toBe(true);
    expect(fixture.createNotification).toHaveBeenCalledWith({ title: "Joko · Task", body: "Done" });
    expect(fixture.coordinator.size).toBe(1);
    fixture.created[0]!.click();
    expect(fixture.activateOwner).toHaveBeenCalledWith(fixture.owner);
    expect(fixture.navigate).toHaveBeenCalledWith({
      kind: "session",
      profileId: "machine-a",
      sessionId: "task-a"
    });
    expect(fixture.coordinator.size).toBe(0);
    fixture.created[0]!.click();
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });

  it("retires old-document click authority without closing a replacement document notification", () => {
    const fixture = coordinatorFixture();
    fixture.coordinator.show(fixture.owner, "document-one", notification());
    fixture.setDocument("document-two");
    fixture.coordinator.show(fixture.owner, "document-two", notification());
    fixture.coordinator.retireOwner(fixture.owner, "document-one");
    expect(fixture.created[0]!.close).toHaveBeenCalledOnce();
    expect(fixture.created[1]!.close).not.toHaveBeenCalled();
    fixture.created[0]!.click();
    expect(fixture.navigate).not.toHaveBeenCalled();
    fixture.created[1]!.click();
    expect(fixture.navigate).toHaveBeenCalledOnce();
  });

  it("retires every old notification when one native close throws", () => {
    const fixture = coordinatorFixture();
    fixture.coordinator.show(fixture.owner, "document-one", notification());
    fixture.coordinator.show(fixture.owner, "document-one", notification());
    fixture.created[0]!.close.mockImplementationOnce(() => {
      fixture.created[0]!.click();
      throw new Error("native close failed");
    });

    expect(() => fixture.coordinator.retireOwner(fixture.owner, "document-one")).not.toThrow();
    expect(fixture.created[0]!.close).toHaveBeenCalledOnce();
    expect(fixture.created[1]!.close).toHaveBeenCalledOnce();
    expect(fixture.coordinator.size).toBe(0);
    fixture.created[0]!.click();
    fixture.created[1]!.click();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("does not navigate when activation is fenced and does not retry a native show failure", () => {
    const fixture = coordinatorFixture();
    fixture.activateOwner.mockReturnValueOnce(false);
    fixture.coordinator.show(fixture.owner, "document-one", notification());
    fixture.created[0]!.click();
    expect(fixture.navigate).not.toHaveBeenCalled();

    const failure = coordinatorFixture();
    failure.createNotification.mockImplementationOnce(() => {
      const native = new FakeNotification();
      native.show.mockImplementationOnce(() => { throw new Error("native failed"); });
      failure.created.push(native);
      return native;
    });
    expect(() => failure.coordinator.show(failure.owner, "document-one", notification()))
      .toThrow("native failed");
    expect(failure.coordinator.size).toBe(0);
    expect(failure.createNotification).toHaveBeenCalledOnce();
  });
});

function notification() {
  return parseDesktopNotification({
    title: "Joko · Task",
    body: "Done",
    navigation: { kind: "session", profileId: "machine-a", sessionId: "task-a" }
  });
}

function coordinatorFixture() {
  const owner = Object.freeze({ id: 1 });
  let documentOccurrence = "document-one";
  let foreground = false;
  const created: FakeNotification[] = [];
  const createNotification = vi.fn(() => {
    const notification = new FakeNotification();
    created.push(notification);
    return notification;
  });
  const activateOwner = vi.fn(() => true);
  const navigate = vi.fn();
  const coordinator = new DesktopNotificationCoordinator({
    isSupported: () => true,
    createNotification,
    isApplicationForeground: () => foreground,
    isCurrentOwner: (candidate, candidateDocument) =>
      candidate === owner && candidateDocument === documentOccurrence,
    activateOwner,
    navigate
  });
  return {
    owner,
    coordinator,
    created,
    createNotification,
    activateOwner,
    navigate,
    setForeground: (value: boolean) => { foreground = value; },
    setDocument: (value: string) => { documentOccurrence = value; }
  };
}
