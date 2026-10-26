import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('keeps selected relay assets distinct as Android raw resources and removes only owned stale outputs', async () => {
  // A fixture beneath Mobile resolves the same installed SDK and Metro inputs
  // without mutating the app's selected build or generated runtime directory.
  await mkdir(join(mobile, 'dist'), { recursive: true });
  const root = await mkdtemp(join(mobile, 'dist', 'linkspan-assets-test-'));
  try {
    await mkdir(join(root, 'scripts'));
    await copyFile(join(mobile, 'scripts/prepare-linkspan-runtimes.mjs'), join(root, 'scripts/prepare-linkspan-runtimes.mjs'));
    for (const name of ['linkspan-runtime-selection.cjs', 'svg-string-transformer.cjs', 'connection-runtime-transformer.cjs']) {
      await copyFile(join(mobile, name), join(root, name));
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    const output = join(root, 'dist/linkspan-runtime');
    await mkdir(output, { recursive: true });
    for (const kind of ['iroh', 'tailcat']) for (const extension of ['lsruntime', 'lsnotice']) {
      await writeFile(join(output, `${kind}.${extension}`), 'stale');
    }
    await writeFile(join(output, 'unrelated.txt'), 'retained');
    const require = createRequire(join(root, 'package.json'));
    const { testing } = require('./svg-string-transformer.cjs') as {
      testing: { buildLinkspanAssetModule: (filename: string) => string; buildHttpConnectClientModule: (src: string, filename: string) => string }
    };
    for (const [modes, kinds, webRtc] of [
      ['iroh-relay,tailcat-relay', ['iroh', 'tailcat'], false],
      ['webrtc', [], true],
      ['iroh-relay', ['iroh'], false],
      ['iroh-native', [], false],
      ['http-connect-native', [], false]
    ] as const) {
      await execute(process.execPath, [join(root, 'scripts/prepare-linkspan-runtimes.mjs')], {
        cwd: root, env: { ...process.env, JOKO_LINKSPAN_BUILD_BACKENDS: modes }, windowsHide: true
      });
      const names = [...kinds.flatMap(kind => [`${kind}-runtime.lsruntime`, `${kind}.wasm`, `${kind}-notices.lsnotice`]), ...(webRtc ? ['webrtc-runtime.lsruntime', 'webrtc-notices.lsnotice'] : []), ...(modes === 'http-connect-native' ? ['http-connect-notices.lsnotice'] : [])];
      expect((await readdir(output)).sort()).toEqual([...names, 'selected.json', 'unrelated.txt'].sort());
      const source = testing.buildLinkspanAssetModule(join(root, 'src/linkspan-runtime-assets.ts'));
      const client = testing.buildHttpConnectClientModule(await readFile(join(mobile, 'src/mobile-http-connect-client.ts'), 'utf8'), join(root, 'src/mobile-http-connect-client.ts'));
      expect(client.includes("import('@jokoagent/linkspan-http-connect')")).toBe(modes === 'http-connect-native');
      expect(source).toContain(`linkspanNativeHttpConnectSelected:${modes === 'http-connect-native'}`);
      if (modes === 'http-connect-native') {
        expect(names).toEqual(['http-connect-notices.lsnotice']);
        expect(await readFile(join(output, names[0]!), 'utf8')).toContain('MIT');
      }
      for (const name of names) expect(source).toContain(`/linkspan-runtime/${name}`);
      expect((source.match(/require\(/gu) ?? []).length).toBe(names.length);
      if (webRtc) {
        const script = await readFile(join(output, 'webrtc-runtime.lsruntime'), 'utf8');
        expect(script).toContain('jokoLinkspanStart');
        expect(script).not.toContain('initializeIrohWasm'); expect(script).not.toContain('initializeTailcatWasm');
        expect((await readdir(output)).some(name => name.endsWith('.wasm'))).toBe(false);
        expect(await readFile(join(output, 'webrtc-notices.lsnotice'), 'utf8')).toContain('MIT');
      }
      // React Native's Android identifier drops extensions and punctuation.
      const identifiers = names.map(name => `dist_linkspanruntime_${name.slice(0, name.lastIndexOf('.'))}`.toLowerCase().replace(/[^a-z0-9_]/gu, ''));
      expect(new Set(identifiers).size).toBe(names.length);
      expect(await readFile(join(output, 'unrelated.txt'), 'utf8')).toBe('retained');
    }
  } finally {
    if (dirname(root) !== join(mobile, 'dist')) throw new Error('Fixture cleanup escaped its generated parent.');
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
