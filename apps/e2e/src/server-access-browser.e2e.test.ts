import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { connectionEntryDirectory } from '@joko/orchestrator';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@joko/connection-transport/node';
import { DeviceAuthorizationReceiver, type DeviceAuthorizationDraft, type DeviceTransportRequestDraft } from '@joko/connection-transport/device-authorization';
import { DeviceKind, ServerAccessService } from '@joko/contracts';
import { OrchestratorE2eFixture } from './fixture.js';

const browserPath = process.env.JOKO_BROWSER_EXECUTABLE?.trim(), webDirectory = process.env.JOKO_MOUNTED_WEB_DIR?.trim();
const mountedIt = browserPath && webDirectory ? it : it.skip;

mountedIt('saves, publishes and retires real SDK ingress through production settings, and restores Vault-backed media configuration', async () => {
  if (!browserPath || !webDirectory || !isAbsolute(browserPath) || !isAbsolute(webDirectory)) throw new Error('Absolute production paths are required.');
  const directory = await mkdtemp(join(tmpdir(), 'joko-access-browser-'));
  const evidence = process.env.JOKO_LINKSPAN_BROWSER_EVIDENCE_DIR && join(process.env.JOKO_LINKSPAN_BROWSER_EVIDENCE_DIR, 'server-access');
  if (evidence) await mkdir(evidence, { recursive: true });
  const tls = { certificatePath: join(directory, 'certificate.pem'), privateKeyPath: join(directory, 'private.pem') };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tls.privateKeyPath, '-out', tls.certificatePath,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 15_000 });
  let fixture = await OrchestratorE2eFixture.start({ webDirectory, tls, serverAccess: true, keepRoot: true });
  const certificate = new X509Certificate(await readFile(tls.certificatePath));
  const spki = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
  const page = await browser.newPage({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1280, height: 960 }, reducedMotion: 'reduce' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const screenshot = async (name: string) => {
    if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`), animations: 'disabled', mask: [page.locator('input[type="password"]:visible'), page.locator('.server-access__sensitive:visible'), page.locator('.device-authorization textarea:visible'), page.locator('.device-authorization__qr:visible')] });
  };
  try {
    const challenge = fixture.application.connections.issuePairing('Server manager');
    await page.goto(fixture.baseUrl); await page.locator('.connection-tabs > button').nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel('Joko node address', { exact: true }).fill(fixture.baseUrl);
    await page.locator('.pair-form textarea').fill(fixture.application.linkspanIdentity!.publicKey);
    await page.getByLabel('Pairing code', { exact: true }).fill(challenge.code);
    await page.getByLabel('Device name', { exact: true }).fill('Server manager'); await page.locator('.pair-form__submit').click();
    await page.locator('.app').waitFor({ timeout: 30_000 });
    const connection = fixture.application.store.listConnections()[0]!;
    await page.evaluate(() => { location.hash = '#/settings/connections'; });
    const settings = page.locator('article.server-access'); await settings.waitFor();
    await settings.getByRole('button', { name: 'Add connection method', exact: true }).click();
    await settings.getByRole('button', { name: 'iroh', exact: true }).click();
    expect(await settings.locator('input:visible').count()).toBe(1);
    await settings.getByLabel('Display name', { exact: true }).fill('Home iroh');
    await settings.getByRole('button', { name: 'Save configuration', exact: true }).click();
    const sdk = settings.locator('.server-access__entry').filter({ hasText: 'iroh' });
    await sdk.getByRole('button', { name: 'Check and enable', exact: true }).click();
    await sdk.getByText('Enabled', { exact: true }).waitFor({ timeout: 45_000 });
    const published = connectionEntryDirectory(fixture.application).entries.find(entry => entry.transportKind === 'iroh')!;
    expect(published).toBeDefined();
    expect(published.displayName).toBe('Home iroh');
    await settings.scrollIntoViewIfNeeded(); await screenshot('enabled-dark-wide');
    let draft: DeviceAuthorizationDraft | undefined, transportRequest: DeviceTransportRequestDraft | undefined;
    const receiver = new DeviceAuthorizationReceiver({ read: async () => draft, write: async value => { draft = value; },
      readTransportRequest: async () => transportRequest, writeTransportRequest: async value => { transportRequest = value; } },
      { uuid: randomUUID, secret: () => randomBytes(32).toString('hex'), digest: async value => createHash('sha256').update(value).digest('hex') },
      target => {
        expect(target.endpointTransport?.kind).toBe('iroh');
        return createConnectTransport({ baseUrl: target.origin, endpointPublicKey: target.endpointPublicKey, endpointTransport: target.endpointTransport,
          transportKind: 'iroh', httpVersion: '1.1', defaultTimeoutMs: 20_000 });
      });
    // The receiver is an independent Node consumer, with its own peer-package
    // instance. Point that consumer at the same verified, packaged target.
    const clientPackages = createRequire(import.meta.resolve('@joko/connection-transport/node'));
    const sdkPackages = createRequire(clientPackages.resolve('@jokoagent/linkspan-iroh/node'));
    const runtime = await import(pathToFileURL(sdkPackages.resolve('@jokoagent/linkspan-iroh-node')).href) as { configureIrohRuntime(directory: string): void };
    runtime.configureIrohRuntime(fileURLToPath(new URL('../../orchestrator/dist/linkspan-runtime/iroh', import.meta.url)));
    const requestLink = await receiver.transportRequest('iroh');
    const owner = page.locator('article.device-authorization');
    await owner.getByRole('button', { name: 'Add a device', exact: true }).click();
    const carriers = owner.locator('details:has(.connection-methods)'); await carriers.locator('summary').click();
    await carriers.locator('.connection-method').filter({ hasText: 'iroh' }).click();
    await owner.getByRole('textbox', { name: /^Request link from the new device/ }).fill(requestLink);
    await owner.getByRole('button', { name: 'Prepare this invitation', exact: true }).click();
    await owner.locator('textarea[readonly]').waitFor({ state: 'attached' });
    const invitation = await owner.locator('textarea[readonly]').inputValue();
    const progress = await receiver.start(invitation, 'GUI invited SDK device', DeviceKind.DESKTOP, 'test', undefined, published.entryId);
    expect(progress.state).toBe('pending'); expect(fixture.application.store.listConnections()).toHaveLength(1);
    await owner.getByRole('button', { name: 'Review request', exact: true }).click();
    expect(await owner.locator('.device-authorization__matching .device-authorization__code').textContent()).toBe(progress.userCode);
    await owner.getByRole('button', { name: 'Allow connection', exact: true }).click();
    await expect.poll(async () => (await receiver.refresh())?.state).toBe('approved');
    const claimed = await receiver.claim(); expect(fixture.application.store.listConnections()).toHaveLength(2);
    const invited = createClient(ServerAccessService, createConnectTransport({ baseUrl: claimed.draft.invitation.origin, httpVersion: '1.1',
      endpointPublicKey: claimed.draft.invitation.endpointPublicKey, endpointTransport: claimed.draft.endpointTransport, transportKind: 'iroh', defaultTimeoutMs: 20_000,
      interceptors: [next => request => { request.header.set('authorization', `Bearer ${claimed.draft.authKey}`); return next(request); }] }));
    expect((await invited.getServerAccessSettings({})).entries[0]?.publishedEntryId).toBe(published.entryId);
    fixture.application.connections.revoke(claimed.authorization.connection!.connectionId);
    await expect(invited.getServerAccessSettings({})).rejects.toBeDefined();
    await receiver.clear(progress.requestId);
    await sdk.getByRole('button', { name: 'Stop', exact: true }).click();
    expect(await settings.getByRole('button', { name: 'Confirm', exact: true }).isDisabled()).toBe(true);
    await settings.getByRole('checkbox').click(); await settings.getByRole('button', { name: 'Confirm', exact: true }).click();
    await sdk.getByText('Stopped', { exact: true }).waitFor();
    expect(connectionEntryDirectory(fixture.application).entries.some(entry => entry.transportKind === 'iroh')).toBe(false);
    await sdk.getByRole('button', { name: 'Delete configuration', exact: true }).click(); await settings.getByRole('button', { name: 'Confirm', exact: true }).click();
    await sdk.waitFor({ state: 'detached' });
    await settings.getByRole('button', { name: 'Configure media relay', exact: true }).click();
    await settings.getByRole('button', { name: 'coturn', exact: true }).click();
    await settings.getByLabel('TURN key or account ID', { exact: true }).fill('owned-relay');
    await settings.getByLabel('Publisher API token or shared secret', { exact: true }).fill('fixture-private-coturn-key');
    await settings.getByLabel('TURN URLs (one per line)', { exact: true }).fill('turn:relay.example:3478');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 }); await settings.locator('form').scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await screenshot(`media-form-dark-${width}`);
    }
    await settings.getByRole('button', { name: 'Save configuration', exact: true }).click();
    const media = settings.locator('.server-access__entry').filter({ hasText: 'coturn' });
    await media.getByRole('button', { name: 'Check and enable', exact: true }).click(); await media.getByText('Enabled', { exact: true }).waitFor();
    await media.getByRole('button', { name: 'Edit', exact: true }).click();
    expect(await settings.getByLabel('Publisher API token or shared secret', { exact: true }).inputValue()).toBe('');
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => { location.hash = '#/settings/general'; });
    await page.locator('.theme-picker').getByRole('radio', { name: 'Light', exact: true }).click();
    await page.evaluate(() => { location.hash = '#/settings/connections'; }); await settings.scrollIntoViewIfNeeded(); await screenshot('media-enabled-light-390');
    const publicState = JSON.stringify(fixture.application.store.listSettings(), (_key, value) => typeof value === 'bigint' ? String(value) : value); expect(publicState).not.toContain('fixture-private-coturn-key');
    const ice = await fixture.application.serverAccessMedia!.ice.getConfiguration({ controllerDeviceId: 'controller', targetDeviceId: 'target', leaseId: 'gui-check', signal: new AbortController().signal });
    expect(ice.some(server => server.urls.includes('turn:relay.example:3478'))).toBe(true);
    await fixture.application.serverAccessMedia!.ice.releaseConfiguration!('gui-check');
    const rootDirectory = fixture.rootDirectory; await page.close(); await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory, webDirectory, tls, serverAccess: true });
    await expect.poll(async () => (await fixture.application.serverAccess!.read(connection)).entries[0]?.state).toBe('active');
    const restored = await fixture.application.serverAccess!.read(connection);
    expect(restored.entries).toHaveLength(1); expect(restored.entries[0]).toMatchObject({ provider: 'coturn', source: 'gui', enabled: true });
    expect(fixture.application.credentials!.list()).toEqual([]); expect(errors).toEqual([]);
    if (evidence) await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ actualSdk: 'iroh', sdkPublishedAndRetired: true, sdkInvitationApprovedAndRevoked: true, vaultMediaRestored: true, secretNotProjected: true,
      widths: [320, 390, 1280], themes: ['dark', 'light'], errors }, null, 2));
  } catch (error) { await screenshot('failure').catch(() => undefined); throw error; }
  finally { await browser.close(); await fixture.close({ removeRoot: true }); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
