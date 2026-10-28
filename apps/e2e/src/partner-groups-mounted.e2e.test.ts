import { create, fromBinary } from "@bufbuild/protobuf";
import * as wire from "@joko/contracts";
import { networkHash } from "@joko/store";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { waitFor } from "./fixture.js";
import { submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture, type RealPiProviderResponder } from "./real-pi-fixture.js";

const browserPath = process.env["JOKO_BROWSER_EXECUTABLE"]?.trim(), webDirectory = process.env["JOKO_MOUNTED_WEB_DIR"]?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;
let fixture: RealPiSystemFixture | undefined, browser: Browser | undefined;
afterEach(async ({ task }) => {
  const evidenceDirectory = process.env["JOKO_GROUP_EVIDENCE_DIR"]?.trim();
  if (task.result?.state === "fail" && browser && evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true }); const page = browser.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: resolve(evidenceDirectory, "groups-web-failed.png"), fullPage: true });
  }
  await browser?.close(); browser = undefined; await fixture?.close({ removeRoot: true }); fixture = undefined;
});

mountedIt("recovers a new single-speaker group, delivers an attachment and decision to its hidden real Pi lane, then retains an existing work arrangement across service restart", async () => {
  let members: string[] = [];
  const responder: RealPiProviderResponder = ({ request }) => {
    const serialized = JSON.stringify(request.body), messages = Array.isArray(request.body["messages"]) ? request.body["messages"] : [];
    const latest = [...messages].reverse().map(record).find(message => message?.["role"] === "user");
    const text = JSON.stringify(latest?.["content"] ?? "");
    if (serialized.includes("You are the organizer of a group chat")) return { kind: "text", text: JSON.stringify(text.includes("GROUP_WORK_REQUEST")
      ? { needsPlan: true, steps: [{ partnerId: members[0], task: "Write result" }, { partnerId: members[1], task: "Review result" }] }
      : { needsPlan: false, steps: [] }) };
    if (serialized.includes("You are a permission reviewer")) return { kind: "text", text: JSON.stringify({ verdict: "allow", reason: "The local group fixture writes only its approved work folder." }) };
    if (record(messages.at(-1))?.["role"] === "tool") return { kind: "text", text: "GROUP_TOOL_FINISHED" };
    if (text.includes("The user approved a plan")) {
      const step = text.includes("step 1 is yours") ? 1 : 2;
      return { kind: "tool", name: "write", arguments: { path: `group-result-${step}.txt`, content: `Group step ${step} completed.\n` } };
    }
    if (text.includes("GROUP_QUESTION")) return { kind: "tool", name: "ask_user_question", arguments: { questions: [{ question: "Which group result should I produce?", options: [{ label: "Short result" }, { label: "Detailed result" }] }] } };
    return { kind: "text", text: "GROUP_REPLY_READY" };
  };
  fixture = await RealPiSystemFixture.start({ webDirectory: webDirectory!, providerResponder: responder, enableInternalServer: true });
  let manager = await fixture.pair("Group manager");
  const profiles: wire.PartnerProfile[] = [];
  for (const name of ["Aster", "Beryl"]) {
    const directory = await manager.clients.partner.getPartnerDirectory({});
    const created = await manager.clients.partner.createPartner({ requestId: `group-member-create-${name}`, expectedDirectoryRevision: directory.directory!.revision,
      draft: create(wire.PartnerDraftSchema, { displayName: name, avatar: { value: { case: "presetId", value: "orbit" } }, templateId: "general", identitySource: `You are ${name}.`, usesDirectoryDefaults: false,
        capabilities: { modelChain: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, fastMode: false }], permissionMode: wire.PermissionMode.AUTO, planMode: false } }) });
    expect(created.partner?.initializationState).toBe(wire.PartnerInitializationState.READY); profiles.push(created.partner!);
  }
  const auxiliary = (await manager.clients.settings.getSettings({})).settings!.auxiliaryText!;
  await submit(manager.clients.operation, manager.connectionId, create(wire.OperationMutationSchema, { payload: { case: "updateAuxiliaryTextSettings", value: {
    expectedRevision: auxiliary.revision, models: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }] } } }));
  browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" }), errors: string[] = [];
  await page.emulateMedia({ colorScheme: "light" });
  page.on("pageerror", error => errors.push(error.message));
  await pairPage(page, fixture);
  const creationIds: string[] = [];
  await page.route("**/joko.v1.PartnerNetworkService/CreatePartnerNetwork", async route => {
    creationIds.push(fromBinary(wire.CreatePartnerNetworkRequestSchema, route.request().postDataBuffer()!).operationId);
    const response = await route.fetch(); expect(response.status()).toBe(200);
    if (creationIds.length === 1) await route.abort("failed"); else await route.fulfill({ response });
  });
  await page.getByRole("region", { name: "Group conversations", exact: true }).getByRole("button", { name: "Start a group", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start a group", exact: true });
  await dialog.getByLabel("Group name", { exact: true }).fill("Shared work");
  await dialog.getByLabel("Your display name", { exact: true }).fill("Group owner");
  await dialog.getByLabel("Aster", { exact: true }).check(); await dialog.getByLabel("Beryl", { exact: true }).check();
  await dialog.getByRole("button", { name: "Start a group", exact: true }).click();
  await dialog.getByRole("alert").waitFor();
  const receipt = await waitFor(() => manager.clients.partnerNetwork.listPartnerNetwork({}), value => value.rooms.length === 1, "the committed group receipt");
  const groupId = receipt.rooms[0]!.id;
  members = profiles.map(profile => receipt.rooms[0]!.members.find(actor => actor.partnerId === profile.partnerId)!.id);
  await dialog.getByRole("button", { name: "Start a group", exact: true }).click();
  await page.locator(".partner-group-header h1").filter({ hasText: "Shared work" }).waitFor();
  expect(creationIds).toHaveLength(2); expect(new Set(creationIds).size).toBe(1);
  expect((await manager.clients.partnerNetwork.listPartnerNetwork({})).rooms).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("joko.conversation-entry.v1:"))
    .every(key => JSON.parse(localStorage.getItem(key)!).confirmed === true))).toBe(true);
  expect(receipt.rooms[0]!.singleSpeaker).toBe(true);
  await page.getByRole("button", { name: "Group settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Group settings", exact: true });
  expect(await settings.getByRole("combobox", { name: /^Reply mode/ }).count()).toBe(0);
  await settings.getByLabel("Group name", { exact: true }).fill("Shared conversation");
  await settings.locator(".partner-group-form > button").filter({ hasText: /^Save$/u }).click();
  await waitFor(() => manager.clients.partnerNetwork.getPartnerNetwork({ roomId: groupId }), value => value.snapshot?.room?.name === "Shared conversation", "the shared group name setting");
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  expect(await page.getByRole("button", { name: "Arrange work", exact: true }).count()).toBe(0);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await page.locator(".partner-network-composer summary").click();
  await page.getByRole("button", { name: "@Aster (Group owner)", exact: true }).click();
  await composer.press("End"); await composer.pressSequentially(" GROUP_QUESTION");
  await page.locator(".partner-network-composer").dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(["Group attachment bytes"], "group-notes.txt", { type: "text/plain" })); return transfer;
  }) });
  await page.locator(".attachment-list").getByText("group-notes.txt", { exact: true }).waitFor();
  await page.locator(".partner-network-composer").getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Which group result should I produce?", { exact: true }).waitFor({ timeout: 30_000 });
  await page.locator(".question-choice-grid label").filter({ hasText: "Short result" }).click();
  await page.locator(".partner-group-timeline").getByText("GROUP_TOOL_FINISHED", { exact: true }).waitFor({ timeout: 30_000 });
  const conversation = await manager.clients.partnerNetwork.getPartnerNetwork({ roomId: groupId });
  expect(conversation.snapshot!.messages.find(message => message.authorId === conversation.snapshot!.room!.selfId && message.text.includes("GROUP_QUESTION"))?.attachments).toHaveLength(1);
  expect((await manager.clients.partnerNetwork.getPartnerNetworkOwnerControls({ roomId: groupId })).controls).toHaveLength(0);
  expect(fixture.application.partners!.listSessions(profiles[0]!.partnerId).every(item => item.link.role !== "group")).toBe(true);
  const downloadPromise = page.waitForEvent("download");
  await page.locator(".partner-network-media").getByRole("button", { name: "group-notes.txt · Download", exact: true }).click();
  const download = await downloadPromise; expect(await readFile((await download.path())!, "utf8")).toBe("Group attachment bytes");

  // New groups use talk queues. A retained current-v1 work arrangement still
  // owns its original settings, approval, shared folder and restart recovery.
  const retained = fixture.application.partnerNetwork!.options.host.storage.create({ operationId: "retained-work-group", singleSpeaker: false,
    serverId: receipt.rooms[0]!.hostServerId, origin: receipt.rooms[0]!.hostOrigin, name: "Retained shared work", displayName: "Group owner",
    partners: profiles.map(profile => ({ id: profile.partnerId, name: profile.displayName, description: profile.description })) });
  members = profiles.map(profile => retained.members.find(actor => actor.kind === "partner" && actor.state === "joined" && actor.partnerId === profile.partnerId)!.id);
  const workGroupId = retained.id;
  await page.goto(`${fixture.baseUrl}/#/partners/groups/${encodeURIComponent(`network:host:${workGroupId}`)}`, { waitUntil: "domcontentloaded" });
  await page.locator(".partner-group-header h1").filter({ hasText: "Retained shared work" }).waitFor();
  expect((await manager.clients.partnerNetwork.getPartnerNetwork({ roomId: workGroupId })).snapshot!.room!.singleSpeaker).toBe(false);
  await page.getByRole("button", { name: "Group settings", exact: true }).click();
  await settings.getByRole("combobox", { name: /^Reply mode/ }).selectOption("mentioned");
  await waitFor(() => manager.clients.partnerNetwork.getPartnerNetwork({ roomId: workGroupId }), value => value.snapshot?.room?.replyMode === "mentioned", "the retained work group's reply setting");
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await composer.fill("GROUP_WORK_REQUEST"); await page.getByRole("button", { name: "Arrange work", exact: true }).click();
  await page.locator(".partner-network-composer").getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".partner-group-plan").getByRole("button", { name: "Start", exact: true }).waitFor({ timeout: 30_000 });
  await captureGroupEvidence(page, "groups-web-proposed-wide-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator(".panel-scrim--navigation").isVisible()) await page.locator(".sidebar").getByRole("button", { name: "Close navigation", exact: true }).click();
  await captureGroupEvidence(page, "groups-web-proposed-narrow-dark"); await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator(".partner-group-plan").getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Continue to next partner", exact: true }).waitFor({ timeout: 30_000 });
  const firstStep = await manager.clients.partnerNetwork.getPartnerNetwork({ roomId: workGroupId }), plan = firstStep.snapshot!.plans.at(-1)!;
  expect(plan.steps[0]!.status).toBe("completed");
  const workDirectory = planWorkDirectory(fixture, firstStep.snapshot!.room!, plan);
  const handoff = firstStep.snapshot!.messages.find(message => message.id === plan.steps[0]!.resultMessageId)!;
  const file = await manager.clients.partnerNetwork.mediaPartnerNetwork({ roomId: workGroupId, action: "read", mediaId: handoff.attachments.find(file => file.name === "group-result-1.txt")!.id });
  expect(new TextDecoder().decode(file.data)).toBe("Group step 1 completed.\n");
  await captureGroupEvidence(page, "groups-web-wide-dark");
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: "dark" });
  if (await page.locator(".panel-scrim--navigation").isVisible()) await page.locator(".sidebar").getByRole("button", { name: "Close navigation", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await captureGroupEvidence(page, "groups-web-narrow-dark");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${fixture.baseUrl}/#/settings`, { waitUntil: "domcontentloaded" });
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.goto(`${fixture.baseUrl}/#/partners/groups/${encodeURIComponent(`network:host:${workGroupId}`)}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Continue to next partner", exact: true }).waitFor();
  await captureGroupEvidence(page, "groups-web-wide-light");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator(".panel-scrim--navigation").isVisible()) await page.locator(".sidebar").getByRole("button", { name: "Close navigation", exact: true }).click();
  await captureGroupEvidence(page, "groups-web-narrow-light");
  const authKey = manager.authKey, connectionId = manager.connectionId, deviceId = manager.deviceId, rootDirectory = fixture.rootDirectory, port = Number(new URL(fixture.baseUrl).port), internalPort = fixture.application.config.internalPort;
  await browser.close(); browser = undefined;
  await fixture.close({ removeRoot: false }); fixture = undefined;
  fixture = await RealPiSystemFixture.start({ rootDirectory, webDirectory: webDirectory!, port, internalPort, providerResponder: responder, enableInternalServer: true });
  manager = { authKey, connectionId, deviceId, clients: fixture.clients(authKey) };
  const restored = await manager.clients.partnerNetwork.getPartnerNetwork({ roomId: workGroupId });
  expect(planWorkDirectory(fixture, restored.snapshot!.room!, restored.snapshot!.plans.at(-1)!)).toBe(workDirectory);
  await manager.clients.partnerNetwork.planPartnerNetwork({ roomId: workGroupId, operationId: crypto.randomUUID(), planId: plan.id, expectedRevision: restored.snapshot!.plans.at(-1)!.revision, action: "continue" });
  const done = await waitFor(() => manager.clients.partnerNetwork.getPartnerNetwork({ roomId: workGroupId }), value => value.snapshot!.plans.at(-1)?.status === "completed", "the second group's shared work step", 30_000);
  expect(done.snapshot!.plans.at(-1)!.steps.every(step => step.status === "completed")).toBe(true);
  expect(await readFile(resolve(workDirectory, "group-result-2.txt"), "utf8")).toBe("Group step 2 completed.\n");
  const final = done.snapshot!.room!; await manager.clients.partnerNetwork.managePartnerNetwork({ roomId: workGroupId, operationId: crypto.randomUUID(), expectedRevision: final.revision, action: "dissolve" });
  expect((await manager.clients.partnerNetwork.getPartnerNetwork({ roomId: workGroupId })).snapshot!.room!.state).toBe("dissolved");
  const currentGroup = (await manager.clients.partnerNetwork.getPartnerNetwork({ roomId: groupId })).snapshot!.room!;
  expect(currentGroup.singleSpeaker).toBe(true);
  await manager.clients.partnerNetwork.managePartnerNetwork({ roomId: groupId, operationId: crypto.randomUUID(), expectedRevision: currentGroup.revision, action: "dissolve" });
  expect((await manager.clients.partnerNetwork.getPartnerNetwork({ roomId: groupId })).snapshot!.room!.state).toBe("dissolved");
  for (const profile of profiles) expect(fixture.application.store.getSession(profile.canonicalSessionId!).descriptor.archived).toBe(false);
  expect(errors).toEqual([]);
}, 180_000);

async function pairPage(page: Page, system: RealPiSystemFixture) {
  const begun = await system.anonymous.connection.beginPairing({ deviceDisplayName: "Group Web" });
  await page.goto(`${system.baseUrl}/#/partners`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator('details.device-authorization__manual > summary').click();
  await page.locator("form.pair-form input[type=url]").fill(system.baseUrl);
  await page.getByLabel("Pairing code", { exact: true }).fill(system.pairingCode(begun.challenge!.challengeId));
  await page.getByLabel("Device name", { exact: true }).fill("Group Web");
  await page.locator("form.pair-form button[type=submit]").click();
  await page.getByRole("region", { name: "Group conversations", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
}
function planWorkDirectory(system: RealPiSystemFixture, room: wire.PartnerNetworkRoom, plan: wire.PartnerNetworkPlan): string {
  const workspaces = system.application.partnerNetwork!.options.planWorkspaces!;
  const saved = workspaces.store.findSetting<{ localPlanId: string }>("service", "partner-network-plan-workspaces", networkHash([room.hostServerId, room.id, plan.id]))!;
  const directory = workspaces.lanes.getPlan(saved.value.localPlanId).workDir;
  expect(directory).toBeTruthy(); return directory!;
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
async function captureGroupEvidence(page: Page, name: string): Promise<void> {
  const directory = process.env["JOKO_GROUP_EVIDENCE_DIR"]?.trim(); if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.waitForFunction(() => {
    const actions = document.querySelector(".partner-group-follow-up-actions"), timeline = document.querySelector(".partner-group-timeline");
    if (!actions || !timeline) return true;
    const bounds = actions.getBoundingClientRect(), viewport = timeline.getBoundingClientRect();
    return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
  });
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
  const metrics = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    elements: [".partner-group-timeline", ".partner-group-timeline-content", ".partner-group-plan-card", ".partner-network-composer", ".partner-group-follow-up", ".partner-group-follow-up-actions"].map(selector => {
      const element = document.querySelector(selector), rect = element?.getBoundingClientRect(), style = element && getComputedStyle(element);
      return { selector, x: rect?.x, y: rect?.y, bottom: rect?.bottom, width: rect?.width, height: rect?.height, gap: style?.gap, padding: style?.padding, font: style?.font };
    }) }));
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  await writeFile(resolve(directory, `${name}.json`), JSON.stringify(metrics, null, 2));
}
