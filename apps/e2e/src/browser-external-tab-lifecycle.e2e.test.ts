import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { BrowserAutomationTarget, OperationMutationSchema, OperationState } from "@joko/contracts";
import { OperationalBrowserState } from "@joko/orchestrator";
import { expect, it } from "vitest";

import { createSessionMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const executable = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const browserIt = executable ? it : it.skip;

browserIt("removes a closed native external tab from Owner recovery and preserves the surviving tab across a Provider stop", { timeout: 75_000 }, async () => {
  const fixture = await RealPiSystemFixture.start({ externalBrowserExecutable: executable! });
  try {
    const provider = fixture.application.browser;
    if (provider === undefined) throw new Error("The external Browser Provider was not configured.");
    const owner = await fixture.pair("External Browser owner");
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "External Browser task", providerId: REAL_PI_PROVIDER_ID,
      modelId: REAL_PI_MODEL_ID, effortId: "off"
    })));
    const open = (url: string, recoveryPageId = "") => {
      const takeover = provider.currentHumanTakeover();
      return submit(owner.clients.operation, owner.connectionId, create(OperationMutationSchema, { payload: {
        case: "openBrowserPage", value: {
          browserProviderId: provider.id, sessionId, expectedGeneration: BigInt(provider.generation), url, recoveryPageId,
          presentationTarget: BrowserAutomationTarget.EXTERNAL, currentPageId: takeover?.pageId ?? "", takeoverId: takeover?.takeoverId ?? ""
        }
      } }));
    };
    expect((await open("about:blank")).state).toBe(OperationState.SUCCEEDED);
    const surviving = provider.currentHumanTakeover();
    if (surviving === undefined) throw new Error("No surviving Browser takeover was returned.");
    const survivor = await provider.runHumanTakeoverOperation(surviving, async page => page);
    const url = "https://external-tab.example.test/closed";
    await survivor.context().route(url, route => route.fulfill({ contentType: "text/html",
      body: "<!doctype html><title>Tab to close</title><p>Ordinary external Browser tab.</p>" }));
    expect((await open(url)).state).toBe(OperationState.SUCCEEDED);
    const closing = provider.currentHumanTakeover();
    if (closing === undefined) throw new Error("No closing Browser takeover was returned.");
    const page = await provider.runHumanTakeoverOperation(closing, async original => original);
    const list = async () => (await owner.clients.browser.listBrowserProviders({})).providers.find(value => value.browserProviderId === provider.id);
    expect((await list())?.pages).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageId: surviving.pageId, sessionId, recoverable: false }),
      expect.objectContaining({ pageId: closing.pageId, sessionId, url, recoverable: false })
    ]));

    await page.close();
    expect(survivor.isClosed()).toBe(false);
    expect(provider.generation).toBe(closing.generation);
    expect((await list())?.pages).toEqual([expect.objectContaining({ pageId: surviving.pageId, sessionId, recoverable: false })]);
    expect(provider.currentHumanTakeover()).toBeUndefined();
    await expect(open(url, closing.pageId)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const persisted = new OperationalBrowserState(fixture.application.store);
    expect(persisted.findRecoverablePage(provider.id, closing.pageId)).toBeUndefined();
    expect(persisted.findRecoverablePage(provider.id, surviving.pageId)).toBeDefined();

    await provider.stop();
    expect((await list())?.pages).toEqual([expect.objectContaining({ pageId: surviving.pageId, sessionId, recoverable: true })]);
  } finally {
    await fixture.close({ removeRoot: true });
  }
});
