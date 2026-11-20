// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import type { CodeHostPullRequestView } from "../model.js";
import { CodeHostTaskPullRequest, type CodeHostLoginOwner } from "./CodeHostPullRequestLogin.js";
import type { Translator } from "./types.js";

it("opens sign-in only on an explicit task action and retires its code on a native generation change", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const t: Translator = key => key;
  const owner: CodeHostLoginOwner = { profileId: "profile", serverId: "server", connectionGeneration: 1,
    sessionId: "task", targetId: "target", generation: 7n };
  const reference: CodeHostPullRequestView = { key: "github.com/acme/widgets#42", host: "github.com", repositoryOwner: "acme",
    repositoryName: "widgets", number: 42, webUrl: "https://github.com/acme/widgets/pull/42" };
  let phase: JokoDesktopCodeHostLoginState = { phase: "ready" };
  const status = vi.fn<JokoDesktopCodeHostLogin["status"]>(async () => phase);
  const start = vi.fn<JokoDesktopCodeHostLogin["start"]>(async () => { phase = { phase: "authorizing", code: "AB12-CD34" }; return { phase: "starting" }; });
  const cancel = vi.fn<JokoDesktopCodeHostLogin["cancel"]>(async () => { phase = { phase: "unavailable" }; });
  const openExternal = vi.fn(async () => undefined);
  const onOpen = vi.fn();
  const button = (label: string) => [...document.querySelectorAll("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label)!;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("jokoDesktop", { codeHostLogin: { status, start, cancel }, openExternal });
  vi.useFakeTimers();
  try {
    await act(async () => root.render(<CodeHostTaskPullRequest owner={owner} pullRequests={[reference]} t={t} onOpen={onOpen} />));
    await act(async () => button("codeHost.signInForPullRequest").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("codeHost.signInReason");
    expect(start).not.toHaveBeenCalled();
    await act(async () => button("codeHost.signInStart").click());
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    const scope = start.mock.calls[0]?.[0];
    expect(scope).toMatchObject({ sessionId: "task", generation: 7n, referenceKey: reference.key });
    expect(document.querySelector("code")?.textContent).toBe("AB12-CD34");
    expect(openExternal).not.toHaveBeenCalled();
    await act(async () => button("inputHandoff.openLogin").click());
    expect(openExternal).toHaveBeenCalledExactlyOnceWith("https://github.com/login/device");
    await act(async () => root.render(<CodeHostTaskPullRequest owner={{ ...owner, generation: 8n }} pullRequests={[reference]} t={t} onOpen={onOpen} />));
    expect(cancel).toHaveBeenCalledWith(scope);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain("AB12-CD34");
    await act(async () => button("codeHost.openPullRequest").click());
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(reference.webUrl);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
