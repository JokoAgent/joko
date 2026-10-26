import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, X509Certificate } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { OrchestratorE2eFixture } from './fixture.js';
import { parseDeviceAuthorizationReview } from '@joko/connection-transport/device-authorization';

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim();
const webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt('invites, reviews and connects an independent device through production Web and the pinned HTTPS node', async () => {
  if (!browserPath || !webDirectory || !isAbsolute(browserPath) || !isAbsolute(webDirectory)) throw new Error('Absolute browser and production Web paths are required.');
  const evidence = process.env.JOKO_DEVICE_AUTHORIZATION_EVIDENCE_DIR;
  if (evidence && !isAbsolute(evidence)) throw new Error('The evidence path must be absolute.');
  if (evidence) await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(join(tmpdir(), 'joko-device-authorization-tls-'));
  const tls = { certificatePath: join(directory, 'certificate.pem'), privateKeyPath: join(directory, 'private.pem') };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tls.privateKeyPath, '-out', tls.certificatePath,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15_000 });
  const fixture = await OrchestratorE2eFixture.start({ webDirectory, tls });
  const certificate = new X509Certificate(await readFile(tls.certificatePath));
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  // Only the disposable local TLS certificate is exempted. The application still
  // performs its full Noise endpoint-key check before every authorization request.
  const first = await browser.newPage({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
  const second = await browser.newPage({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  const tabTo = async (name: string) => {
    const target = second.getByRole('button', { name, exact: true });
    for (let index = 0; index < 80; index++) {
      await second.keyboard.press('Tab');
      if (await target.evaluate(element => element === document.activeElement)) return;
    }
    throw new Error(`The keyboard could not reach ${name}.`);
  };
  for (const page of [first, second]) page.on('pageerror', error => errors.push(error.message));
  const screenshot = async (name: string, page = second) => {
    if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', fullPage: false,
      mask: [page.locator('textarea:visible'), page.locator('.device-authorization__qr:visible'), page.locator('.device-authorization__admission:visible'), page.locator('input[autocomplete="one-time-code"]:visible')] });
  };
  try {
    const challenge = fixture.application.connections.issuePairing('Existing device');
    await first.goto(fixture.baseUrl);
    await first.locator('.connection-tabs > button').nth(2).click();
    await first.locator('details.device-authorization__manual > summary').click();
    await first.getByLabel('Joko node address', { exact: true }).fill(fixture.baseUrl);
    await first.locator('.pair-form textarea').fill(fixture.application.linkspanIdentity!.publicKey);
    await first.getByLabel('Pairing code', { exact: true }).fill(challenge.code);
    await first.getByLabel('Device name', { exact: true }).fill('Existing device');
    await first.locator('.pair-form__submit').click();
    await first.locator('.app').waitFor({ timeout: 30_000 });
    await first.evaluate(() => { location.hash = '#/settings/connections'; });
    const owner = first.locator('article.device-authorization');
    await owner.waitFor({ state: 'visible' });
    await first.setViewportSize({ width: 390, height: 844 });
    await owner.scrollIntoViewIfNeeded(); await screenshot('owner-settings-dark-390', first);
    await first.setViewportSize({ width: 1280, height: 960 });
    await first.evaluate(() => { location.hash = '#/settings/general'; });
    await first.locator('.theme-picker').getByRole('radio', { name: 'Light', exact: true }).click();
    await expect.poll(() => first.locator('.theme-picker').getByRole('radio', { name: 'Light', exact: true }).getAttribute('aria-checked')).toBe('true');
    await first.evaluate(() => { location.hash = '#/settings/connections'; });
    await owner.waitFor({ state: 'visible' }); await screenshot('owner-settings-light-wide', first);
    const allowedMethods = owner.locator('details').filter({ has: first.locator('summary', { hasText: 'Allowed connection methods' }) });
    await allowedMethods.locator('summary').click();
    await allowedMethods.getByRole('combobox').click();
    await first.getByRole('option', { name: 'Choose methods', exact: true }).click();
    const allowedChoice = allowedMethods.getByRole('checkbox').first();
    await allowedChoice.click(); expect(await allowedChoice.getAttribute('aria-checked')).toBe('true');
    await first.setViewportSize({ width: 320, height: 740 });
    await allowedMethods.scrollIntoViewIfNeeded(); await screenshot('owner-allowed-methods-320', first);
    expect(await first.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await allowedChoice.click(); expect(await allowedChoice.getAttribute('aria-checked')).toBe('false');
    await allowedMethods.getByRole('combobox').click();
    await first.getByRole('option', { name: 'All published methods', exact: true }).click();
    await allowedMethods.locator('summary').click();
    await first.setViewportSize({ width: 1280, height: 960 });
    await owner.getByRole('button', { name: 'Add a device', exact: true }).click();
    await expect.poll(() => owner.locator('textarea').inputValue()).toMatch(/^joko:\/\/pair#/u);
    const invitation = await owner.locator('textarea').inputValue();
    expect(await owner.locator('svg.device-authorization__qr').count()).toBe(1);
    await screenshot('owner-invitation', first);
    await first.setViewportSize({ width: 390, height: 844 });
    await owner.scrollIntoViewIfNeeded(); await screenshot('owner-invitation-light-390', first);
    await first.setViewportSize({ width: 1280, height: 960 });
    const carrierChoice = owner.locator('details:has(.connection-methods)');
    if (await carrierChoice.count()) {
      await first.setViewportSize({ width: 320, height: 740 });
      await carrierChoice.locator('summary').click();
      await carrierChoice.locator('.connection-method').first().waitFor({ state: 'visible' });
      expect(await first.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await screenshot('owner-carriers-320', first);
      await carrierChoice.locator('summary').click();
      await first.setViewportSize({ width: 1280, height: 960 });
    }

    const chinese = await browser.newPage({ ignoreHTTPSErrors: true, locale: 'zh-CN', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    chinese.on('pageerror', error => errors.push(error.message));
    await chinese.goto(fixture.baseUrl);
    await chinese.locator('.connection-tabs > button').nth(2).click();
    const localizedEntry = chinese.locator('section.device-authorization');
    await localizedEntry.getByRole('button', { name: '使用邀请链接', exact: true }).waitFor();
    expect(await localizedEntry.locator('input:visible, textarea:visible').count()).toBe(0);
    await screenshot('methods-chinese-narrow', chinese);
    await localizedEntry.getByRole('button', { name: '使用邀请链接', exact: true }).click();
    await localizedEntry.getByLabel('邀请链接', { exact: true }).fill(invitation);
    expect(await chinese.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot('invitation-chinese-narrow', chinese);
    await chinese.close();

    await second.goto(fixture.baseUrl);
    await second.locator('.connection-tabs > button').nth(2).click();
    const entry = second.locator('section.device-authorization');
    expect(await entry.locator('input:visible, textarea:visible').count()).toBe(0);
    if (await second.evaluate(() => document.documentElement.dataset.theme) !== 'light') await second.locator('.connection-theme-toggle').click();
    await tabTo('Use an invitation link');
    await screenshot('methods-light-narrow-focus');
    await second.setViewportSize({ width: 320, height: 740 });
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot('methods-light-320');
    await second.setViewportSize({ width: 1280, height: 960 });
    await screenshot('methods-light-wide');
    await second.locator('.connection-theme-toggle').click(); await screenshot('methods-dark-wide');
    await second.setViewportSize({ width: 320, height: 740 });
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot('methods-dark-320');
    await second.setViewportSize({ width: 390, height: 844 }); await screenshot('methods-dark-narrow');
    await second.locator('details.device-authorization__manual > summary').click();
    await second.locator('.pair-form').waitFor({ state: 'visible' });
    await expect.poll(() => second.locator('section.device-authorization').count()).toBe(0);
    await screenshot('manual-dark-narrow');
    await second.locator('details.device-authorization__manual > summary').click();
    await entry.getByRole('button', { name: 'Use an invitation link', exact: true }).click();
    await entry.getByRole('button', { name: 'Back to connection methods', exact: true }).click();
    expect(await entry.locator('textarea').count()).toBe(0);
    await entry.getByRole('button', { name: 'Use an invitation link', exact: true }).click();
    await entry.getByLabel('Invitation link', { exact: true }).fill('not-an-invitation');
    expect(await entry.getByRole('button', { name: 'Request connection', exact: true }).isDisabled()).toBe(true);
    await screenshot('invitation-validation-dark-narrow');
    await entry.getByLabel('Invitation link', { exact: true }).fill(invitation);
    await entry.locator('.device-authorization__name > summary').click();
    await entry.getByLabel('This device', { exact: true }).fill('New independent device');
    expect(fixture.application.store.listConnections()).toHaveLength(1);
    await tabTo('Request connection');
    expect(await entry.getByRole('button', { name: 'Request connection', exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (await second.evaluate(() => document.documentElement.dataset.theme) !== 'light') await second.locator('.connection-theme-toggle').click();
    await tabTo('Request connection');
    await screenshot('request-light-narrow-focus');
    await second.locator('.connection-theme-toggle').click();
    await screenshot('request-dark-narrow');
    await second.locator('.connection-auto-choice').getByRole('checkbox').click();
    await entry.getByRole('button', { name: 'Request connection', exact: true }).click();
    await entry.getByText('Waiting for approval', { exact: true }).waitFor();
    const code = await entry.locator('.device-authorization__code').textContent();
    expect(fixture.application.store.listConnections()).toHaveLength(1);
    await screenshot('pending-request');
    await second.reload();
    await second.locator('.connection-tabs > button').nth(2).click();
    await entry.getByText('Waiting for approval', { exact: true }).waitFor();
    expect(await entry.locator('.device-authorization__code').textContent()).toBe(code);
    // Opt-in is a UI preference; it is chosen again after a pending-page reload.
    const automatic = second.locator('.connection-auto-choice').getByRole('checkbox');
    if (await automatic.getAttribute('aria-checked') !== 'true') await automatic.click();
    await second.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await entry.locator('summary', { hasText: 'Link for the approving device' }).click();
    await entry.getByRole('button', { name: 'Copy review link', exact: true }).click();
    await entry.getByText('Review link copied', { exact: true }).waitFor();
    const reviewLink = await second.evaluate(() => navigator.clipboard.readText());
    expect(parseDeviceAuthorizationReview(reviewLink).serverId).toBe(fixture.application.serverId);
    await first.goto(reviewLink);
    const connectReview = first.getByRole('button', { name: /Connect to the saved node to review/u });
    await expect.poll(async () => await connectReview.count() + await owner.getByRole('button', { name: 'Allow connection', exact: true }).count()).toBeGreaterThan(0);
    if (await connectReview.count()) await connectReview.click();
    await owner.getByRole('button', { name: 'Allow connection', exact: true }).waitFor();
    expect(await owner.textContent()).toContain('New independent device');
    expect(await owner.locator('.device-authorization__code').textContent()).toBe(code);
    expect(fixture.application.store.listConnections()).toHaveLength(1);
    await screenshot('owner-exact-approval', first);
    await first.setViewportSize({ width: 390, height: 844 });
    await owner.getByRole('button', { name: 'Allow connection', exact: true }).scrollIntoViewIfNeeded();
    await screenshot('owner-approval-light-390', first);
    expect(await first.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await owner.getByRole('button', { name: 'Allow connection', exact: true }).click();
    await second.locator('.app').waitFor({ timeout: 30_000 });
    await expect.poll(() => fixture.application.store.listConnections().length).toBe(2);
    await expect.poll(() => second.evaluate(() => new Promise<boolean>((resolve, reject) => {
      const open = indexedDB.open('joko-ui'); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, transaction = db.transaction(['secrets', 'preferences'], 'readonly');
        const draft = transaction.objectStore('secrets').get('device-authorization-request-v1');
        const preference = transaction.objectStore('preferences').get('ui');
        transaction.oncomplete = () => { db.close(); resolve(draft.result === undefined && preference.result?.automaticConnectionTarget?.kind === 'profile'); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    })), { timeout: 15_000 }).toBe(true);
    await second.reload(); await second.locator('.app').waitFor({ timeout: 30_000 });
    const connections = fixture.application.store.listConnections();
    expect(new Set(connections.map(value => value.authKeyDigest)).size).toBe(2);
    fixture.application.connections.revoke(connections[0]!.id);
    await second.reload(); await second.locator('.app').waitFor({ timeout: 30_000 });
    expect(fixture.application.store.listConnections()).toHaveLength(2);
    expect(errors).toEqual([]);
    if (evidence) await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ productionWeb: true, transport: 'HTTPS + pinned Noise',
      independentConnections: 2, pendingReload: true, automaticReload: true, issuerRevocationRetainsChild: true,
      secureDraftCleared: true, progressiveEntry: true, methodReturn: true, invalidInvitationBlocked: true, allowedMethodsLayout: true, reviewLinkExplicitApproval: true,
      locales: ['en', 'zh-CN'], views: ['light', 'dark', 'wide', 'narrow', 'keyboard-focus', 'methods', 'invitation', 'validation', 'pending', 'explicit-approval'], pageErrors: errors }, null, 2));
  } catch (error) { await screenshot('failure-new-device'); await screenshot('failure-existing-device', first); throw error; }
  finally { await browser.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
