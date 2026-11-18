import { create } from "@bufbuild/protobuf";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSelectionSchema, PerTurnOverridesSchema, RunState } from "@joko/contracts";
import { chromium, type Browser } from "playwright-core";
import { expect, it, vi } from "vitest";

import { waitFor } from "./fixture.js";
import { createSessionMutation, queueItemIdFrom, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, RealPiSystemFixture } from "./real-pi-fixture.js";

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt("recovers the failed Pi input's original Provider from a cold receipt and honors an edited schedule model", { timeout: 120_000 }, async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "joko-quota-recovery-"));
  const realNow = Date.now;
  let clockOffset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
  const resetAt = Math.ceil(realNow() / 60_000) * 60_000 + 600_000;
  const defaultResetAt = resetAt + 3_600_000;
  const defaultProviderId = "quota-default";
  const defaultModelId = "quota-default-model";
  const defaultModelName = "Task default quota model";
  let fixture: RealPiSystemFixture | undefined;
  let browser: Browser | undefined;
  try {
    const configureDefaultProvider = async (host: RealPiSystemFixture) => {
      const providers = host.application.providers!;
      const local = providers.get("pi", REAL_PI_PROVIDER_ID).provider;
      await providers.upsert({ backendId: "pi", credentialOrigin: "", credentialBindings: {}, enabled: true,
        displayName: "Task default Provider", kind: "local_keyless", supportsLogin: false, supportsLogout: false, supportsRefresh: false,
        provider: { ...local, id: defaultProviderId, models: [{ ...local.models[0]!, id: defaultModelId, name: defaultModelName }] } });
      await host.application.refreshPiGeneration!();
    };
    fixture = await RealPiSystemFixture.start({ rootDirectory, webDirectory,
      piSettings: { retry: { enabled: false, provider: { maxRetries: 0 } } },
      providerResponder: () => ({ kind: "rateLimit", resetAt }) });
    await configureDefaultProvider(fixture);
    const owner = await fixture.pair("Failed input owner");
    const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
      backendId: "pi", targetId: "workspace-real-pi", displayName: "Quota recovery task", providerId: defaultProviderId, modelId: defaultModelId
    })));
    const session = fixture.application.store.getSession(sessionId).descriptor;
    const original = sendInputMutation(sessionId, BigInt(session.binding.generation), "Use the per-turn quota Provider");
    if (original.payload.case !== "sendInput") throw new Error("The fixture must submit a real sendInput.");
    const model = create(ModelSelectionSchema, { model: { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID }, effortId: "off" });
    original.payload.value.overrides = create(PerTurnOverridesSchema, { model });
    const admitted = await submit(owner.clients.operation, owner.connectionId, original);
    const runId = queueRunIdFrom(admitted);
    const queueItemId = queueItemIdFrom(admitted);
    await waitFor(() => owner.clients.run.getRun({ runId }), value => value.run?.state === RunState.FAILED, "the original Pi rate limit");
    expect(fixture.providerRequests.length).toBeGreaterThan(0);
    expect(fixture.providerRequests.every(({ body }) => body["model"] === REAL_PI_MODEL_ID)).toBe(true);
    expect(fixture.application.store.getQueueItem(queueItemId).executionOverrides)
      .toMatchObject({ providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID });
    expect(fixture.application.store.getSession(sessionId).descriptor.providerId).toBe(defaultProviderId);

    await fixture.close();
    fixture = await RealPiSystemFixture.start({ rootDirectory, webDirectory });
    await configureDefaultProvider(fixture);
    const service = fixture.clients(owner.authKey);
    // Supply the unrelated account window through the service's public Provider projection.
    const providers = fixture.application.providers!;
    const list = providers.list.bind(providers);
    vi.spyOn(providers, "list").mockImplementation(backendId => list(backendId).map(provider => provider.provider.id === defaultProviderId
      ? { ...provider, capabilities: new Set([...(provider.capabilities ?? []), "provider.account_usage"]) } : provider));
    const quota = { providerId: defaultProviderId, observedAt: Date.now(), limitReached: true,
      primaryWindow: { usedPercent: 100, resetAt: defaultResetAt } };
    const usage = fixture.application.providerAccountUsage!;
    vi.spyOn(usage, "peek").mockImplementation(providerId => providerId === defaultProviderId ? quota : undefined);
    vi.spyOn(usage, "get").mockImplementation(async providerId => providerId === defaultProviderId ? quota : undefined);
    expect((await service.backend.listProviders({ backendId: "pi" })).providers.find(provider => provider.providerId === defaultProviderId)
      ?.accountUsage?.primaryWindow?.resetAt?.seconds).toBe(BigInt(defaultResetAt / 1_000));
    const cold = (await service.operation.getOperation({ operationId: admitted.operationId })).operation;
    expect(cold?.mutation?.payload).toMatchObject({ case: "sendInput", value: { overrides: { model } } });
    expect(cold?.result?.payload).toMatchObject({ case: "queueItem", value: { queueItemId, runId } });

    const challenge = (await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Quota recovery browser" })).challenge!;
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    const page = await browser.newPage({ locale: "en-US", timezoneId: "UTC", viewport: { width: 1440, height: 960 } });
    const taskUrl = `${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`;
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill("Quota recovery browser");
    await page.locator("form.pair-form button[type=submit]").click();

    const trigger = resetAt + 60_000;
    const schedules = [
      { name: "Continue with failed Provider", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, triggerAt: trigger },
      { name: "Continue with chosen Provider", providerId: defaultProviderId, modelId: defaultModelId, triggerAt: trigger + 60_000 }
    ];
    for (const [index, schedule] of schedules.entries()) {
      const banner = page.getByTestId("error-tail-banner");
      await banner.getByRole("button", { name: "Continue after reset", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "Create schedule", exact: true });
      const triggerAt = editor.getByLabel("Trigger at", { exact: true });
      const picker = editor.locator(".schedule-editor__model-picker");
      expect(await triggerAt.inputValue()).toBe(new Date(trigger).toISOString().slice(0, 16));
      expect(await picker.innerText()).toContain("Joko real Pi E2E model");
      if (schedule.providerId === defaultProviderId) {
        await picker.click();
        await page.getByRole("option", { name: /Task default quota model/u }).click();
        expect(await picker.innerText()).toContain(defaultModelName);
        await triggerAt.fill(new Date(schedule.triggerAt).toISOString().slice(0, 16));
      }
      await editor.getByLabel("Name", { exact: true }).fill(schedule.name);
      await editor.getByRole("button", { name: "New schedule", exact: true }).click();
      await waitFor(() => service.scheduler.listSchedules({ sessionId }), result => result.schedules.some(value => value.displayName === schedule.name), "the scheduled recovery");
      await editor.waitFor({ state: "hidden" });
      if (index + 1 < schedules.length) {
        await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: "Saved nodes", exact: true }).click();
        await page.locator(".connection-card .profile-card").filter({ hasText: fixture.baseUrl })
          .getByRole("button", { name: "Connect", exact: true }).click();
      }
    }

    for (const schedule of schedules) {
      const saved = (await service.scheduler.listSchedules({ sessionId })).schedules.find(value => value.displayName === schedule.name)!;
      expect(saved.execution?.model?.model).toMatchObject({ providerId: schedule.providerId, modelId: schedule.modelId });
      expect(saved.nextTriggerAt?.seconds).toBe(BigInt(schedule.triggerAt / 1_000));
      clockOffset = schedule.triggerAt - realNow();
      const history = await waitFor(() => service.scheduler.listScheduleRunHistory({ scheduleId: saved.scheduleId }),
        result => result.history[0]?.state === RunState.SUCCEEDED, "the saved recovery occurrence");
      expect(history.history).toHaveLength(1);
      const item = fixture.application.store.findQueueItemByRunId(sessionId, history.history[0]!.runId);
      expect(item?.executionOverrides).toMatchObject({ providerId: schedule.providerId, modelId: schedule.modelId });
    }
    expect(fixture.providerRequests.map(({ body }) => body["model"])).toEqual([REAL_PI_MODEL_ID, defaultModelId]);
  } finally {
    clock.mockRestore();
    await browser?.close();
    await fixture?.close();
    await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
});
