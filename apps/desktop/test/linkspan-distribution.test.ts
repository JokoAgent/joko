import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { auditDesktopLinkspanRuntime } = require('../scripts/audit-packaged.cjs') as {
  auditDesktopLinkspanRuntime(root: string): Promise<{ packages: number }>;
};
const { matchesBuilderFileSet } = await import(new URL('../scripts/smoke-packaged-helpers.mjs', import.meta.url).href) as {
  matchesBuilderFileSet(path: string, patterns: readonly string[]): boolean;
};
const config = JSON.parse(await readFile(new URL('../electron-builder.json', import.meta.url), 'utf8')) as {
  files: readonly string[];
  extraResources: Array<{ from: string; to: string; filter?: readonly string[] }>;
};

it('excludes Mobile native build inputs from the automatic Desktop dependency collector', () => {
  const { getNodeModuleFileMatcher } = createRequire(require.resolve('electron-builder'))('app-builder-lib/out/fileMatcher.js') as {
    getNodeModuleFileMatcher(root: string, destination: string, expand: (value: string) => string, platform: object,
      packager: object): { createFilter(): (path: string, stat: { isDirectory(): boolean }) => boolean };
  };
  const root = resolve('collector-input'), destination = resolve('collector-output');
  const filter = getNodeModuleFileMatcher(root, destination, value => value, {}, {
    config, debugLogger: { isEnabled: false }
  }).createFilter();
  const file = { isDirectory: () => false };
  expect(filter(join(root, 'node_modules/@jokoagent/linkspan-iroh/native/sources.json'), file)).toBe(false);
  expect(filter(join(root, 'node_modules/@jokoagent/linkspan-iroh/dist/node.js'), file)).toBe(true);
  expect(filter(join(root, 'node_modules/@jokoagent/linkspan-iroh/dist/bridge.js'), file)).toBe(true);
  expect(filter(join(root, 'node_modules/@jokoagent/linkspan-iroh/dist/source-build.json'), file)).toBe(true);
});

it('delivers and resolves the exact Desktop carrier closure even when the builder collector omits it', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'joko-linkspan-distribution-')), app = join(parent, 'app');
  const iroh = dirname(dirname(realpathSync(require.resolve('@jokoagent/linkspan-iroh/node'))));
  const tailcatNode = dirname(dirname(realpathSync(require.resolve('@jokoagent/linkspan-tailcat-node'))));
  const roots: Record<string, string> = {
    core: join(dirname(iroh), 'linkspan-core'), noise: join(dirname(iroh), 'linkspan-noise'),
    http: dirname(dirname(realpathSync(createRequire(new URL('../../../packages/connection-transport/package.json', import.meta.url)).resolve('@jokoagent/linkspan-http')))),
    'http-connect': dirname(dirname(realpathSync(require.resolve('@jokoagent/linkspan-http-connect/node')))),
    iroh, 'iroh-node': dirname(dirname(realpathSync(require.resolve('@jokoagent/linkspan-iroh-node')))),
    tailcat: dirname(dirname(realpathSync(require.resolve('@jokoagent/linkspan-tailcat/node')))),
    'tailcat-node': tailcatNode, 'tailcat-runtime': join(dirname(tailcatNode), 'linkspan-tailcat-runtime'),
    webrtc: dirname(dirname(realpathSync(fileURLToPath(import.meta.resolve('@jokoagent/linkspan-webrtc'))))),
    'webrtc-node': dirname(dirname(realpathSync(fileURLToPath(import.meta.resolve('@jokoagent/linkspan-webrtc-node')))))
  };
  try {
    const resources = config.extraResources.filter(item => item.to.startsWith('app/node_modules/@jokoagent/'));
    expect(resources.map(item => item.to.split('/').at(-1)).sort()).toEqual(Object.keys(roots).map(suffix => `linkspan-${suffix}`).sort());
    for (const [suffix, source] of Object.entries(roots)) {
      const name = `linkspan-${suffix}`, resource = resources.find(item => item.to.endsWith('/' + name))!;
      expect(resource.from).toBe(`dist/orchestrator-runtime/node_modules/@jokoagent/${name}`);
      expect(matchesBuilderFileSet('scripts/prepare-mobile.mjs', resource.filter!)).toBe(false);
      expect(matchesBuilderFileSet('helper/main.go', resource.filter!)).toBe(false);
      expect(matchesBuilderFileSet('dist/runtime/iroh.node', resource.filter!)).toBe(false);
      expect(matchesBuilderFileSet('dist/runtime/tailcat.wasm', resource.filter!)).toBe(false);
      if (suffix === 'webrtc-node') expect(matchesBuilderFileSet('dist/upstream-patches.json', resource.filter!)).toBe(true);
      if (suffix === 'http-connect') {
        expect(matchesBuilderFileSet('dist/CONNECT_PARSER_LICENSE.txt', resource.filter!)).toBe(true);
        expect(matchesBuilderFileSet('dist/connect-parser-input.json', resource.filter!)).toBe(true);
      }
      const destination = join(app, 'node_modules/@jokoagent', name);
      const copy = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const from = join(directory, entry.name), path = relative(source, from).replaceAll('\\', '/');
          if (entry.isDirectory()) { if (path === 'dist' || path.startsWith('dist/')) await copy(from); }
          else if (entry.isFile() && matchesBuilderFileSet(path, resource.filter!)) {
            const to = join(destination, path); await mkdir(dirname(to), { recursive: true }); await copyFile(from, to);
          }
        }
      };
      await copy(source);
    }
    expect(await auditDesktopLinkspanRuntime(app)).toEqual({ packages: 11 });
    const noiseRoot = join(app, 'node_modules/@jokoagent/linkspan-noise');
    expect((await readFile(join(noiseRoot, 'dist/THIRD_PARTY_LICENSES.txt'))).length).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(noiseRoot, 'dist/dependency-inventory.json'), 'utf8')).length).toBeGreaterThan(0);
    const entries = [['linkspan-noise/dist/index.js', 'connectWebSocket'], ['linkspan-http/dist/index.js', 'createHttpClient'],
      ['linkspan-http-connect/dist/node.js', 'connectHttpConnectStream'],
      ['linkspan-iroh/dist/node.js', 'createIrohBridgeHost'], ['linkspan-iroh-node/dist/index.js', 'configureIrohRuntime'],
      ['linkspan-tailcat/dist/node.js', 'createTailcatBridgeHost'], ['linkspan-tailcat-node/dist/index.js', 'configureTailcatRuntime'],
      ['linkspan-webrtc/dist/index.js', 'openWebRtcChannel'], ['linkspan-webrtc-node/dist/index.js', 'createNodeWebRtcPeer']];
    const script = entries.map(([entry, method], index) => `const m${index}=await import(${JSON.stringify(pathToFileURL(join(app, 'node_modules/@jokoagent', entry!)).href)});if(typeof m${index}[${JSON.stringify(method)}]!=='function')throw new Error('Missing production entry');`).join('\n');
    const environment: NodeJS.ProcessEnv = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: parent, env: environment, timeout: 15_000, windowsHide: true });
    const patchReceiptPath = join(app, 'node_modules/@jokoagent/linkspan-webrtc-node/dist/upstream-patches.json');
    const patchReceipt = await readFile(patchReceiptPath);
    await writeFile(patchReceiptPath, '{}');
    await expect(auditDesktopLinkspanRuntime(app)).rejects.toThrow(/patch receipt is invalid/u);
    await writeFile(patchReceiptPath, patchReceipt);
    const sourceReceiptPath = join(noiseRoot, 'dist/source-build.json');
    const sourceReceipt = JSON.parse(await readFile(sourceReceiptPath, 'utf8'));
    await writeFile(sourceReceiptPath, JSON.stringify({ ...sourceReceipt, sourceCommit: '0'.repeat(40) }));
    await expect(auditDesktopLinkspanRuntime(app)).rejects.toThrow(/conflicting source receipts/u);
    await rm(join(app, 'node_modules/@jokoagent/linkspan-noise'), { recursive: true });
    await expect(auditDesktopLinkspanRuntime(app)).rejects.toThrow(/missing.*linkspan-noise/u);
  } finally {
    if (dirname(parent) !== resolve(tmpdir()) || !parent.includes('joko-linkspan-distribution-')) throw new Error('Unexpected distribution fixture path.');
    await rm(parent, { recursive: true, force: true });
  }
});
