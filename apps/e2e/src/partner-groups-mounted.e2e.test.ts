import { create, fromBinary } from "@bufbuild/protobuf";
import * as wire from "@joko/contracts";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
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

mountedIt("recovers a created group in mounted Web, delivers an attachment and decision to its hidden real Pi lane, then completes shared work across service restart", async () => {
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
  members = profiles.map(profile => profile.partnerId);
  const auxiliary = (await manager.clients.settings.getSettings({})).settings!.auxiliaryText!;
  await submit(manager.clients.operation, manager.connectionId, create(wire.OperationMutationSchema, { payload: { case: "updateAuxiliaryTextSettings", value: {
    expectedRevision: auxiliary.revision, models: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }] } } }));
  browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" }), errors: string[] = [];
  await page.emulateMedia({ colorScheme: "light" });
  page.on("pageerror", error => errors.push(error.message));
  await pairPage(page, fixture);
  let createCalls = 0, requestId = "";
  await page.route("**/joko.v1.PartnerGroupService/CreatePartnerGroup", async route => {
    createCalls++; requestId = fromBinary(wire.CreatePartnerGroupRequestSchema, route.request().postDataBuffer()!).requestId;
    const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort("failed");
  });
  await page.locator(".partner-groups-section").getByRole("button", { name: "Create group", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create group", exact: true });
  await dialog.getByLabel("Group name", { exact: true }).fill("Shared work");
  await dialog.getByLabel("Aster", { exact: true }).check(); await dialog.getByLabel("Beryl", { exact: true }).check();
  await dialog.getByRole("button", { name: "Create group", exact: true }).click();
  await dialog.getByRole("button", { name: "Check creation", exact: true }).waitFor();
  const receipt = await waitFor(() => manager.clients.partnerGroup.getPartnerGroupCreation({ requestId }), value => !!value.group, "the committed group receipt");
  const groupId = receipt.group!.id;
  await page.unroute("**/joko.v1.PartnerGroupService/CreatePartnerGroup");
  await dialog.getByRole("button", { name: "Check creation", exact: true }).click();
  await page.locator(".partner-group-header h1").filter({ hasText: "Shared work" }).waitFor();
  expect(createCalls).toBe(1); expect((await manager.clients.partnerGroup.listPartnerGroups({})).groups).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("joko.group-creation.v1:")).length)).toBe(0);
  await page.getByRole("button", { name: "Group settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Group settings", exact: true });
  await settings.getByLabel("Who replies", { exact: true }).selectOption(String(wire.PartnerGroupReplyMode.MENTIONED));
  await waitFor(() => manager.clients.partnerGroup.getPartnerGroup({ groupId }), value => value.detail?.group?.replyMode === wire.PartnerGroupReplyMode.MENTIONED, "the shared reply setting");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Message the group · @mention a partner", exact: true });
  await composer.fill("@Aster GROUP_QUESTION");
  await page.locator(".partner-group-header").dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(["Group attachment bytes"], "group-notes.txt", { type: "text/plain" })); return transfer;
  }) });
  await page.locator(".partner-group-composer").getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Which group result should I produce?", { exact: true }).waitFor({ timeout: 30_000 });
  await page.locator(".question-choice-grid label").filter({ hasText: "Short result" }).click();
  await page.locator(".partner-group-timeline").getByText("GROUP_TOOL_FINISHED", { exact: true }).waitFor({ timeout: 30_000 });
  const conversation = await manager.clients.partnerGroup.getPartnerGroup({ groupId });
  expect(conversation.detail!.messages.find(message => message.authorKind === wire.PartnerGroupAuthorKind.USER)?.attachments).toHaveLength(1);
  expect(conversation.interactions).toHaveLength(0);
  expect(fixture.application.partners!.listSessions(members[0]!).every(item => item.link.role !== "group")).toBe(true);
  await page.locator(".partner-group-attachments").getByRole("button", { name: "Preview: group-notes.txt", exact: true }).click();
  await page.getByRole("dialog").getByText("Group attachment bytes", { exact: true }).waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await composer.fill("GROUP_WORK_REQUEST"); await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Arrange work", exact: false }).click();
  await page.locator(".partner-group-composer").getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".partner-group-plan").getByRole("button", { name: "Start", exact: true }).waitFor({ timeout: 30_000 });
  await captureGroupEvidence(page, "groups-web-proposed-wide-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator(".panel-scrim--navigation").isVisible()) await page.locator(".sidebar").getByRole("button", { name: "Close navigation", exact: true }).click();
  await captureGroupEvidence(page, "groups-web-proposed-narrow-dark"); await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator(".partner-group-plan").getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Continue to next partner", exact: true }).waitFor({ timeout: 30_000 });
  const firstStep = await manager.clients.partnerGroup.getPartnerGroup({ groupId }), plan = firstStep.detail!.plans.at(-1)!;
  expect(plan.steps[0]!.status).toBe(wire.PartnerGroupStepStatus.DONE); expect(plan.workDir).toBeTruthy();
  const handoff = firstStep.detail!.messages.find(message => message.files.includes("group-result-1.txt"))!;
  const file = await manager.clients.partnerGroup.readPartnerGroupFile({ groupId, messageId: handoff.id, relativePath: "group-result-1.txt" }); expect(file.blob!.byteSize).toBeGreaterThan(0n);
  await captureGroupEvidence(page, "groups-web-wide-dark");
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: "dark" });
  if (await page.locator(".panel-scrim--navigation").isVisible()) await page.locator(".sidebar").getByRole("button", { name: "Close navigation", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await captureGroupEvidence(page, "groups-web-narrow-dark");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${fixture.baseUrl}/#/settings`, { waitUntil: "domcontentloaded" });
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.goto(`${fixture.baseUrl}/#/partners/groups/${encodeURIComponent(groupId)}`, { waitUntil: "domcontentloaded" });
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
  const restored = await manager.clients.partnerGroup.getPartnerGroup({ groupId }); expect(restored.detail!.plans.at(-1)!.workDir).toBe(plan.workDir);
  await manager.clients.partnerGroup.actPartnerGroupPlan({ groupId, planId: plan.id, expectedRevision: restored.detail!.plans.at(-1)!.revision, action: wire.PartnerGroupPlanAction.CONTINUE });
  const done = await waitFor(() => manager.clients.partnerGroup.getPartnerGroup({ groupId }), value => value.detail!.plans.at(-1)?.status === wire.PartnerGroupPlanStatus.DONE, "the second group's shared work step", 30_000);
  expect(done.detail!.plans.at(-1)!.steps.every(step => step.status === wire.PartnerGroupStepStatus.DONE)).toBe(true);
  expect(done.detail!.plans.at(-1)!.workDir).toBe(plan.workDir);
  const final = done.detail!.group!; await manager.clients.partnerGroup.deletePartnerGroup({ groupId, expectedRevision: final.revision });
  expect((await manager.clients.partnerGroup.getPartnerGroupCreation({ requestId })).retired).toBe(true);
  for (const profile of profiles) expect(fixture.application.store.getSession(profile.canonicalSessionId!).descriptor.archived).toBe(false);
  expect(errors).toEqual([]);
}, 180_000);

async function pairPage(page: Page, system: RealPiSystemFixture) {
  const begun = await system.anonymous.connection.beginPairing({ deviceDisplayName: "Group Web" });
  await page.goto(`${system.baseUrl}/#/partners`, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-tabs > button").nth(2).click();
  await page.locator("form.pair-form input[type=url]").fill(system.baseUrl);
  await page.getByLabel("Pairing code", { exact: true }).fill(system.pairingCode(begun.challenge!.challengeId));
  await page.getByLabel("Device name", { exact: true }).fill("Group Web");
  await page.locator("form.pair-form button[type=submit]").click();
  await page.locator(".partner-groups-section").waitFor({ state: "visible", timeout: 30_000 });
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
    elements: [".partner-group-timeline", ".partner-group-timeline-content", ".partner-group-plan-card", ".partner-group-composer-frame", ".partner-group-follow-up", ".partner-group-follow-up-actions"].map(selector => {
      const element = document.querySelector(selector), rect = element?.getBoundingClientRect(), style = element && getComputedStyle(element);
      return { selector, x: rect?.x, y: rect?.y, bottom: rect?.bottom, width: rect?.width, height: rect?.height, gap: style?.gap, padding: style?.padding, font: style?.font };
    }) }));
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  await writeFile(resolve(directory, `${name}.json`), JSON.stringify(metrics, null, 2));
}
