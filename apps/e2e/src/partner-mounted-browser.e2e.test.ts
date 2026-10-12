import { create, fromBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  CreatePartnerRequestSchema,
  PartnerCapabilitiesSchema,
  PartnerDelegationStatus,
  PartnerDraftSchema,
  PartnerModelRouteSchema,
  PermissionMode,
  RunState
} from "@joko/contracts";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";

import { queueRunIdFrom, sendInputMutation, submit } from "./operations.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  RealPiSystemFixture,
  type CapturedProviderRequest,
  type RealPiProviderResponder
} from "./real-pi-fixture.js";
import { waitFor } from "./fixture.js";

const PRIVATE_COMMAND = "PARTNER_E3_SEND_PRIVATE";
const PRIVATE_MESSAGE = "PRIVATE_BOUNDARY_E3: verify the durable recovery fence.";
const PRIVATE_REPLY = "PRIVATE_REPLY_E3: the recovery fence is durable.";
const COMPLETE_COMMAND = "PARTNER_E3_DELEGATE_COMPLETE";
const COMPLETE_TITLE = "Mounted recovery audit";
const COMPLETE_OBJECTIVE = "CHILD_COMPLETE_E3: audit the recovery boundary and return one concrete result.";
const COMPLETE_REPLY = "DELEGATION_RESULT_E3: the recovery boundary is durable.";
const CANCEL_COMMAND = "PARTNER_E3_DELEGATE_CANCEL";
const CANCEL_TITLE = "Mounted cancellation audit";
const CANCEL_OBJECTIVE = "CHILD_CANCEL_E3: wait until the parent cancels this durable task.";
const ARTIFACT_FILE = "delegation-recovery-report.txt";

const MOUNTED_CHAIN_ENABLED = nonBlankEnvironment("JOKO_BROWSER_EXECUTABLE") !== undefined
  && nonBlankEnvironment("JOKO_MOUNTED_WEB_DIR") !== undefined;
const mountedIt = MOUNTED_CHAIN_ENABLED ? it : it.skip;

describe("mounted Partner collaboration product chain", () => {
  let fixture: RealPiSystemFixture | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  mountedIt("recovers a user-photo Partner after lost creation receipt, edits, service restart and narrow Web reload without duplicate initialization", async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = requiredEnvironment("JOKO_MOUNTED_WEB_DIR");
    fixture = await RealPiSystemFixture.start({ webDirectory, keepRoot: true, enableInternalServer: true });
    const rootDirectory = fixture.rootDirectory;
    const port = Number(new URL(fixture.baseUrl).port);
    const internalPort = fixture.application.config.internalPort;
    const manager = await fixture.pair("Partner creation manager");
    const challenge = required((await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Partner creation Web" })).challenge, "the pairing challenge");
    const pairingCode = fixture.pairingCode(challenge.challengeId);
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${fixture.baseUrl}/#/partners`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    const pairForm = page.locator("form.pair-form");
    try { await pairForm.waitFor({ state: "visible", timeout: 3_000 }); }
    catch { throw new Error(`The pairing form is unavailable: ${JSON.stringify(await page.locator(".connection-card").evaluateAll((nodes) => nodes.map((node) => ({
      buttons: Array.from(node.querySelectorAll("button")).map((button) => button.textContent), labels: Array.from(node.querySelectorAll("label span")).map((span) => span.textContent)
    }))))}`); }
    await pairForm.locator("input[type=url]").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Partner creation Web");
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator(".partners-page .route-header").getByRole("button", { name: "Invite partner", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    let sent = 0;
    let captured: ReturnType<typeof create<typeof CreatePartnerRequestSchema>> | undefined;
    let interceptionError: Error | undefined;
    await page.route("**/joko.v1.PartnerService/CreatePartner", async (route) => {
      sent += 1;
      try {
        captured = fromBinary(CreatePartnerRequestSchema, required(route.request().postDataBuffer(), "the binary creation request"));
        if (captured.draft?.capabilities?.modelChain[0]?.backendId !== "pi") throw new Error("The creation fixture must use its local provider.");
        const response = await route.fetch();
        if (response.status() !== 200) throw new Error("The original creation was not confirmed by the service.");
      } catch { interceptionError = new Error("The binary creation fixture could not confirm its local service response."); }
      finally { await route.abort("failed"); }
    });
    await page.locator(".partners-page .route-header").getByRole("button", { name: "Invite partner", exact: true }).click();
    const invite = page.getByRole("dialog", { name: "Invite a partner", exact: true });
    await invite.getByLabel("Name", { exact: true }).fill("Nova");
    await invite.locator('.partner-avatar-picker input[type=file]').setInputFiles({ name: "partner-photo.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
    await waitFor(() => invite.getByRole("button", { name: "Choose a photo", exact: true }).getAttribute("aria-pressed"),
      (value) => value === "true", "the prepared user photo");
    await invite.locator(".partner-avatar--photo img").waitFor({ state: "visible" });
    await invite.getByRole("combobox", { name: "Primary model", exact: true }).click();
    await page.getByRole("option", { name: /Joko real Pi E2E model/u }).click();
    await invite.getByRole("button", { name: "Invite partner", exact: true }).click();
    await invite.getByRole("button", { name: "Check creation result", exact: true }).waitFor({ state: "visible" });
    await waitFor(() => invite.getByRole("button", { name: "Check creation result", exact: true }).isEnabled(), (value) => value, "the unconfirmed creation state");
    expect(sent).toBe(1);
    expect(interceptionError).toBeUndefined();
    expect(await invite.getByLabel("Name", { exact: true }).isDisabled()).toBe(true);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    const request = required(captured, "the original creation request");
    const original = required((await manager.clients.partner.getPartnerCreation({ requestId: request.requestId })).partner, "the original Partner");
    const originalImage = required(original.avatar, "the image avatar").value;
    if (originalImage.case !== "image") throw new Error("The Partner must retain its user photo.");
    const photo = await manager.clients.partner.readPartnerAvatar({ partnerId: original.partnerId,
      expectedRevision: original.revision, sha256: originalImage.value.sha256 });
    expect(photo.image).toMatchObject({ mimeType: "image/jpeg", byteLength: BigInt(photo.content.length) });
    expect(photo.content.length).toBeLessThanOrEqual(41_250);
    const updated = required((await manager.clients.partner.updatePartner({
      partnerId: original.partnerId, expectedRevision: original.revision, patch: { displayName: "Nova updated" }
    })).partner, "the updated Partner");
    expect((await manager.clients.partner.createPartner(request)).partner).toMatchObject({ partnerId: original.partnerId, displayName: "Nova updated", revision: updated.revision });
    const authKey = manager.authKey;
    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await RealPiSystemFixture.start({ rootDirectory, webDirectory, port, internalPort, enableInternalServer: true });
    const restarted = fixture.clients(authKey);
    const replayed = required((await restarted.partner.createPartner(request)).partner, "the replayed Partner");
    expect(replayed).toMatchObject({ partnerId: original.partnerId, canonicalSessionId: original.canonicalSessionId, displayName: "Nova updated", revision: updated.revision });
    expect((await restarted.partner.listPartners({})).partners).toHaveLength(1);
    expect((await restarted.partner.readPartnerAvatar({ partnerId: replayed.partnerId,
      expectedRevision: replayed.revision, sha256: originalImage.value.sha256 })).content).toEqual(photo.content);
    await page.unroute("**/joko.v1.PartnerService/CreatePartner");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Saved nodes", exact: true }).click();
    await page.locator(".connection-card .profile-card").filter({ hasText: fixture.baseUrl }).getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator(partnerCard(original.partnerId)).waitFor({ state: "visible", timeout: 30_000 });
    const navigationScrim = page.locator(".panel-scrim--navigation");
    if (await navigationScrim.isVisible()) await page.locator(".sidebar").getByRole("button", { name: "Close navigation", exact: true }).click();
    await page.locator(".partners-page .route-header").getByRole("button", { name: "Invite partner", exact: true }).click();
    const recovery = page.getByRole("dialog", { name: "Invite a partner", exact: true });
    expect(await recovery.getByLabel("Name", { exact: true }).isDisabled()).toBe(true);
    await recovery.getByRole("button", { name: "Check creation result", exact: true }).click();
    await waitFor(async () => page.url(), (value) => value.includes(`#/partners/${original.partnerId}`), "the recovered original Partner route");
    await page.getByRole("dialog").getByRole("tab", { name: "Profile settings", exact: true }).click();
    await page.getByRole("dialog").locator(".partner-avatar--photo img").waitFor({ state: "visible" });
    expect(sent).toBe(1);
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("joko.partner.creation.v1:")).length)).toBe(0);
    const lateId = "creation-request-delayed-e3";
    await expect(restarted.partner.getPartnerCreation({ requestId: lateId })).rejects.toMatchObject({ code: Code.NotFound });
    expect((await restarted.partner.retirePartnerCreation({ requestId: lateId })).retired).toBe(true);
    const latestDirectory = required((await restarted.partner.getPartnerDirectory({})).directory?.revision, "the directory revision");
    await expect(restarted.partner.createPartner({ ...request, requestId: lateId, expectedDirectoryRevision: latestDirectory, draft: { ...request.draft!, displayName: "Delayed" } }))
      .rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect((await restarted.partner.listPartners({})).partners).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  }, 120_000);

  mountedIt("persists private collaboration, delegation cards, cancellation, files, and restart state in wide and narrow production Web", async () => {
    const executablePath = requiredEnvironment("JOKO_BROWSER_EXECUTABLE");
    const webDirectory = requiredEnvironment("JOKO_MOUNTED_WEB_DIR");
    let targetPartnerId = "";
    let releaseCancelledChild: (() => void) | undefined;
    const cancelledChildGate = new Promise<void>((resolve) => { releaseCancelledChild = resolve; });
    const responder = partnerResponder(() => targetPartnerId, cancelledChildGate);

    fixture = await RealPiSystemFixture.start({
      webDirectory,
      keepRoot: true,
      providerResponder: responder,
      enableInternalServer: true
    });
    const rootDirectory = fixture.rootDirectory;
    const port = Number(new URL(fixture.baseUrl).port);
    const internalPort = fixture.application.config.internalPort;
    const manager = await fixture.pair("Mounted Partner manager");
    const first = await createPartner(fixture, manager, "Aster", "orbit");
    const second = await createPartner(fixture, manager, "Beryl", "spark");
    targetPartnerId = second.partnerId;

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Partner Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Partner Web pairing returned no challenge.");
    const pairingCode = fixture.pairingCode(challenge.challenge.challengeId);

    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const browserErrors = observeBrowserErrors(page);
    await page.goto(`${fixture.baseUrl}/#/partners`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(pairingCode);
    await page.getByLabel("Device name").fill("Mounted Partner Web");
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator(partnerCard(first.partnerId)).waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(partnerCard(second.partnerId)).waitFor({ state: "visible" });
    browserErrors.splice(0);

    await sendPartnerPrompt(fixture, manager, first.canonicalSessionId, PRIVATE_COMMAND);
    try {
      await waitFor(
        () => manager.clients.partner.getPartner({ partnerId: second.partnerId }),
        (value) => (value.partner?.activity?.unreadReplyCount ?? 0n) > 0n,
        "the recipient Partner unread reply",
        30_000
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Recipient runs: ${JSON.stringify(fixture.application.store.listRuns({ sessionId: second.canonicalSessionId }), bigintJson)} Provider trace: ${JSON.stringify(fixture.providerRequests.map(providerRequestSummary))}`,
        { cause: error }
      );
    }
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const secondCard = page.locator(partnerCard(second.partnerId));
    await waitFor(() => secondCard.textContent(), (value) => value?.includes("unread replies") === true, "the unread Partner card");
    await secondCard.getByRole("button", { name: "Open task" }).click();
    await page.getByText(PRIVATE_REPLY, { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 });
    await waitFor(
      () => manager.clients.partner.getPartner({ partnerId: second.partnerId }),
      (value) => value.partner?.activity?.unreadReplyCount === 0n,
      "the durable Partner read cursor"
    );

    await page.goto(`${fixture.baseUrl}/#/partners/${encodeURIComponent(second.partnerId)}`);
    const secondWorkspace = page.getByRole("dialog", { name: "Beryl workspace" });
    await secondWorkspace.getByText(PRIVATE_MESSAGE, { exact: false }).waitFor({ state: "visible", timeout: 30_000 });
    const privateThreads = await manager.clients.partner.listPartnerPrivateThreads({ partnerId: second.partnerId });
    const privateThreadId = required(privateThreads.threads[0]?.threadId, "private thread ID");
    await waitFor(
      () => manager.clients.partner.getPartnerPrivateThread({ partnerId: second.partnerId, threadId: privateThreadId }),
      (value) => value.readState?.throughSequence === 1n,
      "the private-thread read cursor"
    );
    const activityTab = secondWorkspace.getByRole("tab", { name: "Activity" });
    await activityTab.focus();
    await activityTab.press("ArrowRight");
    const profileTab = secondWorkspace.getByRole("tab", { name: "Profile settings" });
    expect(await profileTab.getAttribute("aria-selected")).toBe("true");
    expect(await profileTab.evaluate((node) => document.activeElement === node)).toBe(true);
    await profileTab.press("Home");
    expect(await activityTab.getAttribute("aria-selected")).toBe("true");

    await sendPartnerPrompt(fixture, manager, first.canonicalSessionId, COMPLETE_COMMAND);
    const completed = await waitForDelegation(manager, first.partnerId, COMPLETE_TITLE, PartnerDelegationStatus.COMPLETED);
    const completedChildSessionId = required(completed.childSessionId, "completed delegation child task");
    const stagedArtifact = await artifactForSession(
      fixture,
      completedChildSessionId,
      new TextEncoder().encode("mounted Partner recovery evidence\n"),
      ARTIFACT_FILE
    );
    expect(stagedArtifact.fileName).toBe(ARTIFACT_FILE);

    await sendPartnerPrompt(fixture, manager, first.canonicalSessionId, CANCEL_COMMAND);
    await waitFor(
      () => manager.clients.partner.listPartnerDelegations({ partnerId: first.partnerId }),
      (value) => value.delegations.some((delegation) => delegation.title === CANCEL_TITLE
        && delegation.status !== PartnerDelegationStatus.PREPARING
        && delegation.status !== PartnerDelegationStatus.COMPLETED
        && delegation.status !== PartnerDelegationStatus.FAILED
        && delegation.status !== PartnerDelegationStatus.CANCELLED),
      "the cancellable Partner delegation",
      30_000
    );

    await page.goto(`${fixture.baseUrl}/#/partners`);
    const firstCard = page.locator(partnerCard(first.partnerId));
    await firstCard.waitFor({ state: "visible", timeout: 30_000 });
    await firstCard.getByRole("button", { name: "Open task" }).dispatchEvent("click");
    await page.waitForURL((url) => url.hash.includes(encodeURIComponent(first.canonicalSessionId)), { timeout: 30_000 });
    const completedCard = page.getByLabel(`Delegated work: ${COMPLETE_TITLE}`);
    try {
      await completedCard.waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Timeline text: ${(await page.locator("main").innerText()).slice(-8_000)} Provider trace: ${JSON.stringify(fixture.providerRequests.map(providerRequestSummary).slice(-8))}`,
        { cause: error }
      );
    }
    await waitFor(() => completedCard.textContent(), (text) => text?.includes("Completed") === true
      && text.includes("1 files") && text.includes(COMPLETE_REPLY), "the completed inline delegation card", 30_000);
    const cancelCard = page.getByLabel(`Delegated work: ${CANCEL_TITLE}`);
    await cancelCard.waitFor({ state: "visible", timeout: 30_000 });
    await cancelCard.getByRole("button", { name: "Stop delegation" }).click();
    await waitFor(() => cancelCard.textContent(), (text) => text?.includes("Cancelled") === true, "the cancelled inline delegation card", 30_000);
    releaseCancelledChild?.();
    releaseCancelledChild = undefined;

    await page.goto(`${fixture.baseUrl}/#/partners/${encodeURIComponent(first.partnerId)}`);
    const firstWorkspace = page.getByRole("dialog", { name: "Aster workspace" });
    await firstWorkspace.getByText(ARTIFACT_FILE, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await firstWorkspace.getByText(COMPLETE_TITLE, { exact: true }).waitFor({ state: "visible" });
    await firstWorkspace.getByText(CANCEL_TITLE, { exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 390, height: 844 });
    await firstWorkspace.getByText(ARTIFACT_FILE, { exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(await firstWorkspace.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);

    const authKey = manager.authKey;
    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await RealPiSystemFixture.start({
      rootDirectory,
      webDirectory,
      port,
      internalPort,
      providerResponder: responder,
      enableInternalServer: true
    });
    const restarted = fixture.clients(authKey);
    const restartedPartners = await restarted.partner.listPartners({});
    expect(restartedPartners.partners.map((partner) => partner.displayName)).toEqual(expect.arrayContaining(["Aster", "Beryl"]));
    const restartedDelegations = await restarted.partner.listPartnerDelegations({ partnerId: first.partnerId });
    expect(restartedDelegations.delegations).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: COMPLETE_TITLE, status: PartnerDelegationStatus.COMPLETED, artifactCount: 1n }),
      expect.objectContaining({ title: CANCEL_TITLE, status: PartnerDelegationStatus.CANCELLED })
    ]));
    const restartedThread = await restarted.partner.getPartnerPrivateThread({
      partnerId: second.partnerId,
      threadId: privateThreadId
    });
    expect(restartedThread.messages).toEqual([
      expect.objectContaining({ content: PRIVATE_MESSAGE })
    ]);
    expect(restartedThread.readState?.throughSequence).toBe(1n);

    await page.goto(`${fixture.baseUrl}/#/partners/${encodeURIComponent(first.partnerId)}`, { waitUntil: "domcontentloaded" });
    const restartedWorkspace = page.getByRole("dialog", { name: "Aster workspace" });
    await restartedWorkspace.getByText(ARTIFACT_FILE, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    await restartedWorkspace.getByText(COMPLETE_TITLE, { exact: true }).waitFor({ state: "visible" });
    await restartedWorkspace.getByText(CANCEL_TITLE, { exact: true }).waitFor({ state: "visible" });
    browserErrors.splice(0);
    await restartedWorkspace.locator(".partner-activity__summary").getByRole("button", { name: "Refresh" }).click();
    await restartedWorkspace.getByText(ARTIFACT_FILE, { exact: true }).waitFor({ state: "visible" });
    expect(await overflow(page)).toBeLessThanOrEqual(1);
    expect(browserErrors).toEqual([]);
  }, 180_000);
});

function partnerResponder(
  targetPartnerId: () => string,
  cancelledChildGate: Promise<void>
): RealPiProviderResponder {
  return async ({ request, requestNumber }) => {
    const serialized = JSON.stringify(request.body);
    if (serialized.includes("You are a permission reviewer for one tool call")) {
      return {
        kind: "text",
        text: JSON.stringify({ verdict: "allow", reason: "The bounded local Partner fixture call is required and scoped." })
      };
    }
    if (lastMessageRole(request) === "tool") {
      return { kind: "text", text: `PARTNER_TOOL_SETTLED_E3:${requestNumber}` };
    }
    const advertisedTools = providerToolNames(request);
    const hasPartnerTools = advertisedTools.some((name) => name.startsWith("mcp__joko_partners__"));
    const currentUser = latestUserText(request);
    if (hasPartnerTools && currentUser.includes(PRIVATE_COMMAND)) {
      return {
        kind: "tool",
        name: requiredToolName(request, "send_private_message"),
        arguments: { target_partner_id: required(targetPartnerId(), "target Partner ID"), message: PRIVATE_MESSAGE },
        callId: `partner-private-e3-${requestNumber}`
      };
    }
    if (hasPartnerTools && currentUser.includes(COMPLETE_COMMAND)) {
      return {
        kind: "tool",
        name: requiredToolName(request, "start_delegation"),
        arguments: { target_partner_id: required(targetPartnerId(), "target Partner ID"), title: COMPLETE_TITLE, objective: COMPLETE_OBJECTIVE },
        callId: `partner-complete-e3-${requestNumber}`
      };
    }
    if (hasPartnerTools && currentUser.includes(CANCEL_COMMAND)) {
      return {
        kind: "tool",
        name: requiredToolName(request, "start_delegation"),
        arguments: { target_partner_id: required(targetPartnerId(), "target Partner ID"), title: CANCEL_TITLE, objective: CANCEL_OBJECTIVE },
        callId: `partner-cancel-e3-${requestNumber}`
      };
    }
    if (currentUser.includes(COMPLETE_OBJECTIVE)) return { kind: "text", text: COMPLETE_REPLY };
    if (currentUser.includes(CANCEL_OBJECTIVE)) {
      await cancelledChildGate;
      return { kind: "text", text: "LATE_CANCELLED_CHILD_E3" };
    }
    if (currentUser.includes(PRIVATE_MESSAGE)) return { kind: "text", text: PRIVATE_REPLY };
    return { kind: "text", text: `PARTNER_FALLBACK_E3:${requestNumber}` };
  };
}

async function createPartner(
  fixture: RealPiSystemFixture,
  manager: Awaited<ReturnType<RealPiSystemFixture["pair"]>>,
  displayName: string,
  avatar: string
): Promise<{ readonly partnerId: string; readonly canonicalSessionId: string }> {
  const directory = await manager.clients.partner.getPartnerDirectory({});
  const response = await manager.clients.partner.createPartner({
    requestId: `creation-request-${displayName}`,
    expectedDirectoryRevision: required(directory.directory?.revision, "Partner directory revision"),
    draft: create(PartnerDraftSchema, {
      displayName,
      avatar: { value: { case: "presetId", value: avatar } },
      identitySource: `You are ${displayName}, a durable mounted-browser Partner.`,
      templateId: "general",
      usesDirectoryDefaults: false,
      capabilities: create(PartnerCapabilitiesSchema, {
        modelChain: [create(PartnerModelRouteSchema, {
          backendId: "pi",
          providerId: REAL_PI_PROVIDER_ID,
          modelId: REAL_PI_MODEL_ID,
          fastMode: false
        })],
        permissionMode: PermissionMode.AUTO,
        planMode: false
      })
    })
  });
  const partner = required(response.partner, `${displayName} Partner`);
  return {
    partnerId: partner.partnerId,
    canonicalSessionId: required(partner.canonicalSessionId, `${displayName} canonical task`)
  };
}

async function sendPartnerPrompt(
  fixture: RealPiSystemFixture,
  manager: Awaited<ReturnType<RealPiSystemFixture["pair"]>>,
  sessionId: string,
  prompt: string
): Promise<void> {
  const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
  const submitted = await submit(
    manager.clients.operation,
    manager.connectionId,
    sendInputMutation(sessionId, generation, prompt)
  );
  const runId = queueRunIdFrom(submitted);
  let settled: Awaited<ReturnType<typeof manager.clients.run.getRun>>;
  try {
    settled = await waitFor(
      () => manager.clients.run.getRun({ runId }),
      (value) => value.run?.state === RunState.SUCCEEDED || value.run?.state === RunState.FAILED
        || value.run?.state === RunState.CANCELLED || value.run?.state === RunState.ABORTED,
      `${prompt} Partner run`,
      30_000
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Provider trace: ${JSON.stringify(fixture.providerRequests.map(providerRequestSummary))}`,
      { cause: error }
    );
  }
  expect(settled.run?.state).toBe(RunState.SUCCEEDED);
}

async function waitForDelegation(
  manager: Awaited<ReturnType<RealPiSystemFixture["pair"]>>,
  partnerId: string,
  title: string,
  status: PartnerDelegationStatus
) {
  const response = await waitFor(
    () => manager.clients.partner.listPartnerDelegations({ partnerId }),
    (value) => value.delegations.some((delegation) => delegation.title === title && delegation.status === status),
    `${title} delegation state`,
    60_000
  );
  return required(response.delegations.find((delegation) => delegation.title === title), `${title} delegation`);
}

async function artifactForSession(
  fixture: RealPiSystemFixture,
  sessionId: string,
  bytes: Uint8Array,
  fileName: string
) {
  const staged = await fixture.application.artifacts.ingestBytes(bytes, {
    fileName,
    mimeType: "text/plain",
    expiresAt: Date.now() + 10 * 60_000
  });
  return fixture.application.store.transaction((store) => store.adoptSessionArtifact({
    blob: store.getArtifact(staged.id).blob,
    sessionId
  })).blob;
}

function requiredToolName(request: CapturedProviderRequest, suffix: string): string {
  const tools = Array.isArray(request.body["tools"]) ? request.body["tools"] : [];
  for (const candidate of tools) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const fn = (candidate as Record<string, unknown>)["function"];
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) continue;
    const name = (fn as Record<string, unknown>)["name"];
    if (typeof name === "string" && name.endsWith(`__${suffix}`)) return name;
  }
  throw new Error(`The Partner runtime did not advertise ${suffix}.`);
}

function lastMessageRole(request: CapturedProviderRequest): string | undefined {
  const messages = Array.isArray(request.body["messages"]) ? request.body["messages"] : [];
  const last = messages.at(-1);
  return last !== null && typeof last === "object" && !Array.isArray(last)
    ? String((last as Record<string, unknown>)["role"] ?? "")
    : undefined;
}

function latestUserText(request: CapturedProviderRequest): string {
  const messages = Array.isArray(request.body["messages"]) ? request.body["messages"] : [];
  for (const message of [...messages].reverse()) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
    const record = message as Record<string, unknown>;
    if (record["role"] === "user") return JSON.stringify(record["content"] ?? "");
  }
  return "";
}

function providerRequestSummary(request: CapturedProviderRequest): Readonly<Record<string, unknown>> {
  const messages = Array.isArray(request.body["messages"]) ? request.body["messages"] : [];
  const lastMessage = messages.at(-1);
  return {
    roles: messages.map((message) => message !== null && typeof message === "object" && !Array.isArray(message)
      ? String((message as Record<string, unknown>)["role"] ?? "")
      : "invalid"),
    toolNames: providerToolNames(request),
    markers: [PRIVATE_COMMAND, PRIVATE_MESSAGE, COMPLETE_COMMAND, COMPLETE_OBJECTIVE, CANCEL_COMMAND, CANCEL_OBJECTIVE]
      .filter((marker) => JSON.stringify(request.body).includes(marker)),
    lastMessage: JSON.stringify(lastMessage).slice(0, 1_500)
  };
}

function providerToolNames(request: CapturedProviderRequest): readonly string[] {
  const tools = Array.isArray(request.body["tools"]) ? request.body["tools"] : [];
  return tools.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const fn = (candidate as Record<string, unknown>)["function"];
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) return [];
    const name = (fn as Record<string, unknown>)["name"];
    return typeof name === "string" ? [name] : [];
  });
}

function observeBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      errors.push(`console:${message.text()}:${location.url}:${location.lineNumber}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`response:${response.status()}:${response.url()}`);
  });
  return errors;
}

async function overflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function partnerCard(partnerId: string): string {
  return `.partner-card[data-partner-id="${partnerId}"]`;
}

function required<T>(value: T | null | undefined | "", label: string): T {
  if (value === undefined || value === null || value === "") throw new Error(`${label} is required.`);
  return value;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function nonBlankEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function requiredEnvironment(name: string): string {
  return required(nonBlankEnvironment(name), `${name} for the mounted Partner E3`);
}
