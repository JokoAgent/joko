import { describe, expect, it, vi } from "vitest";

import {
  bindDesktopOpenIntentIngress,
  type DesktopOpenIntentEvent,
  type DesktopOpenIntentEventSource
} from "../src/desktop-open-intents.js";
import type { DesktopInboundOpenIntent } from "../src/deep-link.js";

describe("Desktop OS open-intent ingress", () => {
  it("collects the initial cold argv only after singleton activation", () => {
    const fixture = ingressFixture("win32");
    expect(fixture.listeners.openUrl).toBeTypeOf("function");
    expect(fixture.listeners.openFile).toBeTypeOf("function");
    expect(fixture.listeners.secondInstance).toBeUndefined();

    fixture.ingress.activateSingleInstance(["Joko.exe", "--flag", "joko://settings/providers"]);

    expect(fixture.intents).toEqual([{ kind: "settings", section: "providers" }]);
    expect(fixture.sources).toEqual(["coldArgv"]);
    expect(fixture.listeners.secondInstance).toBeTypeOf("function");
    expect(fixture.showMainWindow).not.toHaveBeenCalled();
  });

  it("shows the existing window before dispatching a second-instance intent", () => {
    const fixture = ingressFixture("win32");
    fixture.ingress.activateSingleInstance(["Joko.exe"]);
    fixture.order.length = 0;

    fixture.listeners.secondInstance?.({}, ["Joko.exe", "joko://task/task-one"]);

    expect(fixture.intents).toEqual([{ kind: "session", sessionId: "task-one" }]);
    expect(fixture.sources).toEqual(["secondInstance"]);
    expect(fixture.order).toEqual(["show", "dispatch:session"]);
  });

  it("prevents the native URL handoff and dispatches its parsed public intent", () => {
    const fixture = ingressFixture("darwin");
    const valid = event();
    fixture.listeners.openUrl?.(valid, "joko://focus/oauth%20return");
    expect(valid.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.intents).toEqual([{ kind: "focus", source: "oauth return" }]);
    expect(fixture.sources).toEqual(["openUrl"]);

    const invalid = event();
    fixture.listeners.openUrl?.(invalid, "joko://app/index.html");
    expect(invalid.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.intents).toHaveLength(1);
  });

  it("accepts only an absolute portable package from the native file handoff", () => {
    const fixture = ingressFixture("win32");
    const relative = event();
    const foreign = event();
    const portable = event();

    fixture.listeners.openFile?.(relative, "task.jshare");
    fixture.listeners.openFile?.(foreign, "C:\\Transfers\\task.txt");
    fixture.listeners.openFile?.(portable, "C:\\Transfers\\Task.JSHARE");

    expect(relative.preventDefault).not.toHaveBeenCalled();
    expect(foreign.preventDefault).not.toHaveBeenCalled();
    expect(portable.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.intents).toEqual([{
      kind: "portableFile",
      path: "C:\\Transfers\\Task.JSHARE"
    }]);
    expect(fixture.sources).toEqual(["openFile"]);
  });
});

function event() {
  return { preventDefault: vi.fn<DesktopOpenIntentEvent["preventDefault"]>() };
}

function ingressFixture(platform: NodeJS.Platform) {
  const listeners: {
    openUrl?: Parameters<DesktopOpenIntentEventSource["listenOpenUrl"]>[0];
    openFile?: Parameters<DesktopOpenIntentEventSource["listenOpenFile"]>[0];
    secondInstance?: Parameters<DesktopOpenIntentEventSource["listenSecondInstance"]>[0];
  } = {};
  const intents: DesktopInboundOpenIntent[] = [];
  const sources: string[] = [];
  const order: string[] = [];
  const showMainWindow = vi.fn(() => { order.push("show"); });
  const ingress = bindDesktopOpenIntentIngress({
    platform,
    source: {
      listenOpenUrl: (listener) => { listeners.openUrl = listener; },
      listenOpenFile: (listener) => { listeners.openFile = listener; },
      listenSecondInstance: (listener) => { listeners.secondInstance = listener; }
    },
    dispatch: (intent, source) => {
      intents.push(intent);
      sources.push(source);
      order.push(`dispatch:${intent.kind}`);
    },
    showMainWindow
  });
  return { ingress, intents, listeners, order, showMainWindow, sources };
}
