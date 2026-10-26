import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { createLinkspanIngress, createPublicServer, publishConnectionEntry } from '@joko/orchestrator';
import { OrchestratorE2eFixture } from './fixture.js';

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim(), webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt('prepares a second real Noise entrance, survives loss of the preferred listener and returns without a new device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joko-entrances-'));
  const tls = { certificatePath: join(root, 'cert.pem'), privateKeyPath: join(root, 'key.pem') };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tls.privateKeyPath, '-out', tls.certificatePath,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15_000 });
  const certificate = new X509Certificate(await readFile(tls.certificatePath));
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const fixture = await OrchestratorE2eFixture.start({ webDirectory: webDirectory!, tls });
  const impostor = await OrchestratorE2eFixture.start({ tls, serverId: fixture.application.serverId });
  const impostorBackend = await createPublicServer(impostor.application, { secureBridge: true }); impostorBackend.log.level = 'silent';
  let impostorRequests = 0, impostorCredentials = 0;
  impostorBackend.addHook('onRequest', async request => { impostorRequests++; if (request.headers.authorization) impostorCredentials++; });
  const impostorBackendOrigin = await impostorBackend.listen({ host: '127.0.0.1', port: 0 });
  const backend = await createPublicServer(fixture.application, { secureBridge: true }); backend.log.level = 'silent';
  const backendOrigin = await backend.listen({ host: '127.0.0.1', port: 0 });
  let primary = await createPublicServer(fixture.application); primary.log.level = 'silent';
  const primaryOrigin = await primary.listen({ host: '127.0.0.1', port: 0 });
  let ingress = createLinkspanIngress(fixture.application, { server: primary.server, backendOrigin });
  const retire = publishConnectionEntry(fixture.application.store, { id: 'linkspan:preferred-route', provider: 'public', origin: primaryOrigin });
  const browser = await chromium.launch({ executablePath: browserPath!, headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US', reducedMotion: 'reduce' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const evidence = process.env.JOKO_DEVICE_AUTHORIZATION_EVIDENCE_DIR;
  const profiles = () => page.evaluate(() => new Promise<{ id: string; origin: string; deviceId: string }[]>((resolve, reject) => {
    const open = indexedDB.open('joko-ui'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result, read = db.transaction('profiles', 'readonly').objectStore('profiles').getAll();
      read.onsuccess = () => { db.close(); resolve((read.result as { id: string; origin: string; deviceId: string }[]).map(({ id, origin, deviceId }) => ({ id, origin, deviceId }))); }; read.onerror = () => { db.close(); reject(read.error); }; };
  }));
  const capture = async (name: string) => { if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `entrances-${name}.png`), fullPage: false }); } };
  try {
    // The trusted Web distribution stays reachable independently of the preferred API entrance.
    await page.goto(fixture.baseUrl);
    await page.locator('.connection-tabs > button').nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel('Joko node address', { exact: true }).fill(primaryOrigin);
    await page.locator('.pair-form textarea').fill(fixture.application.linkspanIdentity!.publicKey);
    await page.getByLabel('Pairing code', { exact: true }).fill(fixture.application.connections.issuePairing('Single device').code);
    await page.getByLabel('Device name', { exact: true }).fill('Single device');
    const automatic = page.locator('.connection-auto-choice').getByRole('checkbox');
    if (await automatic.getAttribute('aria-checked') !== 'true') await automatic.click();
    await page.locator('.pair-form__submit').click(); await page.locator('.app').waitFor({ timeout: 30_000 });
    await page.evaluate(() => { location.hash = '#/settings/connections'; });
    const panel = page.locator('.connection-entry-panel');
    await panel.locator('summary').click();
    const backup = panel.locator('.connection-entry-choice').filter({ hasText: 'Direct connection' });
    await backup.getByRole('button', { name: 'Prepare on this device', exact: true }).click();
    await backup.getByText('Identity verified', { exact: true }).waitFor();
    await backup.getByRole('checkbox').click();
    await expect.poll(() => backup.getByRole('checkbox').isChecked()).toBe(true);
    const original = (await profiles())[0]!;
    expect(fixture.application.store.listConnections()).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture('prepared-narrow');
    // Real listener shutdown, not a successful response supplied by a test stub.
    await ingress.close(); await primary.close();
    await expect.poll(async () => (await profiles())[0]?.origin, { timeout: 55_000 }).toBe(fixture.baseUrl);
    expect(await profiles()).toEqual([{ ...original, origin: fixture.baseUrl }]);
    expect(fixture.application.store.listConnections()).toHaveLength(1);
    await page.evaluate(() => { location.hash = '#/settings/connections'; });
    await capture('fallback');
    primary = await createPublicServer(fixture.application); primary.log.level = 'silent';
    await primary.listen({ host: '127.0.0.1', port: Number(new URL(primaryOrigin).port) });
    ingress = createLinkspanIngress(fixture.application, { server: primary.server, backendOrigin });
    await expect.poll(async () => (await profiles())[0]?.origin, { timeout: 120_000 }).toBe(primaryOrigin);
    expect(fixture.application.store.listConnections()).toHaveLength(1);
    // An explicit remote preference is respected even with the other entrance online.
    if (!await panel.evaluate(element => (element as HTMLDetailsElement).open)) await panel.locator('summary').click();
    await backup.getByRole('button', { name: 'Use and prefer', exact: true }).click();
    await expect.poll(async () => (await profiles())[0]?.origin).toBe(fixture.baseUrl);
    await page.reload(); await page.locator('.app').waitFor({ timeout: 30_000 });
    expect((await profiles())[0]?.origin).toBe(fixture.baseUrl);
    expect(fixture.application.store.listConnections()).toHaveLength(1);
    // The same TLS certificate and copied serverId do not authorize another Noise key.
    await ingress.close(); await primary.close();
    primary = await createPublicServer(impostor.application); primary.log.level = 'silent';
    await primary.listen({ host: '127.0.0.1', port: Number(new URL(primaryOrigin).port) });
    ingress = createLinkspanIngress(impostor.application, { server: primary.server, backendOrigin: impostorBackendOrigin });
    await page.evaluate(() => { location.hash = '#/settings/connections'; });
    if (!await panel.evaluate(element => (element as HTMLDetailsElement).open)) await panel.locator('summary').click();
    const compromised = panel.locator('[data-entry-id="saved"]');
    await compromised.getByRole('button', { name: 'Use and prefer', exact: true }).click();
    await compromised.getByText('Identity mismatch · entrance isolated', { exact: true }).waitFor({ timeout: 15_000 });
    expect((await profiles())[0]?.origin).toBe(fixture.baseUrl);
    expect(impostorRequests).toBe(0); expect(impostorCredentials).toBe(0);
    expect(impostor.application.store.listConnections()).toHaveLength(0);
    await capture('impostor-rejected');
    expect(errors).toEqual([]);
    if (evidence) await writeFile(join(evidence, 'entrances-receipt.json'), JSON.stringify({ realNoiseListeners: 2, preferredOffline: true,
      cachedBackup: true, stableReturn: true, explicitPreferenceSurvivesReload: true, copiedServerIdRejected: true, impostorRequests, impostorCredentials,
      savedServers: 1, deviceAuthorizations: 1, pageErrors: errors }, null, 2));
  } catch (error) { await capture('failure'); throw error; }
  finally { await browser.close(); retire(); await ingress.close(); await primary.close(); await backend.close(); await impostorBackend.close(); await impostor.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
}, 240_000);
