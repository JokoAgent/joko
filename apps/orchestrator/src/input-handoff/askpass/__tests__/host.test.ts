import { stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { AskpassHost, askpassTemporaryRoot } from '../host.js';

describe('askpass socket location', () => {
  it('keeps short roots and bounds long and multibyte roots by socket bytes', () => {
    expect(askpassTemporaryRoot('/tmp/owned')).toBe('/tmp/owned');
    expect(askpassTemporaryRoot(`/tmp/${'a'.repeat(81)}`)).not.toBe('/tmp');
    expect(askpassTemporaryRoot(`/tmp/${'a'.repeat(82)}`)).toBe('/tmp');
    expect(askpassTemporaryRoot(`/tmp/${'界'.repeat(30)}`)).toBe('/tmp');
  });

  let host: AskpassHost | undefined;
  afterEach(async () => { await host?.close(); host = undefined; });
  it.skipIf(process.platform === 'win32')('starts a private socket with a long temporary root and removes it on close', async () => {
    host = new AskpassHost({ tmpRoot: `/tmp/${'long-runtime-root-'.repeat(8)}`,
      startTerminalPrompt: () => ({ ok: false }), isDisabledForSession: async () => false });
    await host.prepare();
    const socket = host.socketPath!, helper = host.helperPath!;
    expect(Buffer.byteLength(socket)).toBeLessThan(104);
    expect((await stat(socket)).isSocket()).toBe(true);
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    expect((await stat(helper)).mode & 0o777).toBe(0o700);
    await host.close();
    await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
