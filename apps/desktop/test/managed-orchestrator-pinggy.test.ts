import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from './test-paths.js';
import {
  probeManagedOrchestratorConnection,
  resolveManagedOrchestratorExecutable,
  selectManagedOrchestratorPorts,
  startManagedOrchestrator
} from '../src/managed-orchestrator.js';

const target = `${process.platform}-${process.arch}`;
const archives: Readonly<Record<string, string>> = {
  'darwin-arm64': '39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6',
  'darwin-x64': '298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185',
  'linux-arm64': '589f5b6dd4fcfee4dfda73013903c966abaa8abd93dbc9d436544e472b4f0e74',
  'linux-x64': '2faf6a387e9b62b888e21c54f01249fb27537ffecf1842f29f4c919d0a59a0ff',
  'win32-arm64': '14834611d4c6b3c06054e7007732b90474c16e0b32f395e05b55a571ef71c6d2',
  'win32-x64': 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56'
};
const cleanups: string[] = [];
afterEach(() => {
  for (const directory of cleanups.splice(0)) {
    if (!isAbsolute(directory) || !basename(directory).startsWith('joko-pinggy-managed-')) throw new Error('Unexpected managed runtime fixture.');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(selected = true, source = false) {
  const directory = mkdtempSync(join(tmpdir(), 'joko-pinggy-managed-')); cleanups.push(directory);
  const orchestrator = resolve(directory, 'orchestrator');
  const entry = resolve(orchestrator, source ? 'src/main.ts' : 'dist/main.js');
  const root = resolve(orchestrator, 'dist/linkspan-runtime');
  const sdkDirectory = `pinggy/pinggy-0.5.3/${target}/node-137`;
  const nodeDirectory = `pinggy/node-v24.16.0/${target}`;
  const executable = `${nodeDirectory}/${process.platform === 'win32' ? 'node.exe' : 'node'}`;
  mkdirSync(dirname(entry), { recursive: true }); writeFileSync(entry, 'export {};\n');
  mkdirSync(root, { recursive: true });
  const bytes = Buffer.from('a release-prepared Node fixture');
  const receipt = { target, backends: selected ? ['pinggy-sdk'] : [], prepared: {
    ...(selected ? { pinggy: { sdkDirectory, target, nodeAbi: '137', version: '0.5.3', nodeRuntime: {
      executable, target, nodeAbi: '137', version: '24.16.0', sha256: createHash('sha256').update(bytes).digest('hex'), archiveSha256: archives[target]!
    } } } : {})
  } };
  const selectedFile = resolve(root, 'selected.json');
  const save = () => writeFileSync(selectedFile, JSON.stringify(receipt));
  if (selected) {
    mkdirSync(resolve(root, sdkDirectory, 'dist'), { recursive: true }); mkdirSync(resolve(root, sdkDirectory, 'lib'), { recursive: true });
    writeFileSync(resolve(root, sdkDirectory, 'prepared.json'), JSON.stringify({ version: '0.5.3', target, nodeAbi: '137' }));
    writeFileSync(resolve(root, sdkDirectory, 'dist/index.js'), 'export {};\n');
    writeFileSync(resolve(root, sdkDirectory, 'lib/addon.node'), 'SDK native fixture');
    writeFileSync(resolve(root, sdkDirectory, 'LICENSE.pinggy-sdk'), 'SDK license');
    mkdirSync(resolve(root, nodeDirectory), { recursive: true }); writeFileSync(resolve(root, executable), bytes);
    writeFileSync(resolve(root, nodeDirectory, 'LICENSE'), 'Node license');
  }
  save();
  return { directory, orchestrator, entry, root, selectedFile, receipt, save, sdkDirectory, nodeDirectory, executable: resolve(root, executable) };
}

it('uses the original host when the SDK is absent, empty or unselected', async () => {
  const layout = fixture(false);
  await expect(resolveManagedOrchestratorExecutable(layout.entry)).resolves.toBe(process.execPath);
  writeFileSync(layout.selectedFile, ' \n');
  await expect(resolveManagedOrchestratorExecutable(layout.entry)).resolves.toBe(process.execPath);
  rmSync(layout.selectedFile);
  await expect(resolveManagedOrchestratorExecutable(layout.entry)).resolves.toBe(process.execPath);
  expect(existsSync(resolve(layout.root, 'pinggy'))).toBe(false);
});

it.each([false, true])('selects only the fixed receipt beside the entry (source=%s)', async source => {
  const layout = fixture(true, source);
  await expect(resolveManagedOrchestratorExecutable(layout.entry)).resolves.toBe(layout.executable);
});

it.each([
  ['target', (layout: ReturnType<typeof fixture>) => { layout.receipt.target = 'other-x64'; layout.save(); }],
  ['SDK ABI', (layout: ReturnType<typeof fixture>) => { layout.receipt.prepared.pinggy!.nodeAbi = '148'; layout.save(); }],
  ['Node version', (layout: ReturnType<typeof fixture>) => { layout.receipt.prepared.pinggy!.nodeRuntime.version = '24.16.1'; layout.save(); }],
  ['Node ABI', (layout: ReturnType<typeof fixture>) => { layout.receipt.prepared.pinggy!.nodeRuntime.nodeAbi = '148'; layout.save(); }],
  ['archive digest', (layout: ReturnType<typeof fixture>) => { layout.receipt.prepared.pinggy!.nodeRuntime.archiveSha256 = '0'.repeat(64); layout.save(); }],
  ['escaping executable', (layout: ReturnType<typeof fixture>) => { layout.receipt.prepared.pinggy!.nodeRuntime.executable = '../node.exe'; layout.save(); }],
  ['escaping SDK', (layout: ReturnType<typeof fixture>) => { layout.receipt.prepared.pinggy!.sdkDirectory = '../sdk'; layout.save(); }],
  ['executable mutation', (layout: ReturnType<typeof fixture>) => { writeFileSync(layout.executable, 'changed executable'); }],
  ['missing executable', (layout: ReturnType<typeof fixture>) => { rmSync(layout.executable); }],
  ['missing license', (layout: ReturnType<typeof fixture>) => { rmSync(resolve(layout.root, layout.nodeDirectory, 'LICENSE')); }],
  ['missing SDK entry', (layout: ReturnType<typeof fixture>) => { rmSync(resolve(layout.root, layout.sdkDirectory, 'dist/index.js')); }],
  ['SDK receipt mismatch', (layout: ReturnType<typeof fixture>) => { writeFileSync(resolve(layout.root, layout.sdkDirectory, 'prepared.json'), '{"version":"0.5.3","target":"wrong","nodeAbi":"137"}'); }],
  ['oversized selection', (layout: ReturnType<typeof fixture>) => { writeFileSync(layout.selectedFile, ' '.repeat(65_537)); }]
] as const)('rejects %s instead of falling back to Electron', async (_label, mutate) => {
  const layout = fixture(); mutate(layout);
  await expect(resolveManagedOrchestratorExecutable(layout.entry)).rejects.toThrow(/could not start securely/u);
});

it('rejects a linked runtime directory even when its executable digest matches', async () => {
  const layout = fixture(), original = resolve(layout.root, layout.nodeDirectory), outside = resolve(layout.directory, 'outside-node');
  renameSync(original, outside); symlinkSync(outside, original, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(resolveManagedOrchestratorExecutable(layout.entry)).rejects.toThrow(/could not start securely/u);
});

it('keeps the explicit trusted test executable override and rejects invalid selection before normal spawn', async () => {
  const layout = fixture(); writeFileSync(layout.selectedFile, '{bad json');
  const spawnChild = vi.fn((_executable: string) => { throw new Error('captured explicit executable'); });
  const options = { orchestratorEntryPath: layout.entry, dataDirectory: resolve(layout.directory, 'data'), workspaceRoot: layout.directory,
    deviceId: randomUUID(), defaultDeviceName: 'Fixture', appVersion: '0.1.0', spawnChild };
  await expect(startManagedOrchestrator(options)).rejects.toThrow(/could not start securely/u);
  expect(spawnChild).not.toHaveBeenCalled();
  await expect(startManagedOrchestrator({ ...options, executablePath: process.execPath })).rejects.toThrow('captured explicit executable');
  expect(spawnChild.mock.calls[0]?.[0]).toBe(process.execPath);
});

it('preserves the selected Node and both licenses through the exact Desktop runtime filter', async () => {
  const layout = fixture();
  const config = JSON.parse(readFileSync(new URL('../electron-builder.json', import.meta.url), 'utf8')) as { extraResources: { to: string; filter: string[] }[] };
  const filter = config.extraResources.find(resource => resource.to === 'orchestrator-runtime')!.filter;
  const { matchesBuilderFileSet } = await import(new URL('../scripts/smoke-packaged-helpers.mjs', import.meta.url).href) as {
    matchesBuilderFileSet(path: string, patterns: readonly string[]): boolean;
  };
  const destination = resolve(layout.directory, 'packaged/orchestrator-runtime');
  cpSync(layout.orchestrator, destination, { recursive: true, filter: path => lstatSync(path).isDirectory()
    || matchesBuilderFileSet(relative(layout.orchestrator, path).replaceAll('\\', '/'), filter) });
  await expect(resolveManagedOrchestratorExecutable(resolve(destination, 'dist/main.js'))).resolves.toBe(resolve(destination, relative(layout.orchestrator, layout.executable)));
  expect(existsSync(resolve(destination, 'dist/linkspan-runtime', layout.sdkDirectory, 'LICENSE.pinggy-sdk'))).toBe(true);
});

const preparedEntry = process.env.JOKO_DESKTOP_PINGGY_PREPARED_ENTRY?.trim();
const preparedIt = preparedEntry ? it : it.skip;
preparedIt('runs the actual verified Pinggy SDK and private managed bootstrap on the prepared Node ABI', async () => {
  if (!preparedEntry || !isAbsolute(preparedEntry)) throw new Error('An absolute prepared Orchestrator entry is required.');
  const entry = resolve(preparedEntry);
  const executable = await resolveManagedOrchestratorExecutable(entry);
  expect(executable).not.toBe(process.execPath);
  const selected = JSON.parse(readFileSync(resolve(dirname(entry), 'linkspan-runtime/selected.json'), 'utf8'));
  const sdkDirectory = resolve(dirname(entry), 'linkspan-runtime', selected.prepared.pinggy.sdkDirectory);
  const script = `import { pathToFileURL } from 'node:url'; import { join } from 'node:path';
    const {verifyPinggySdk}=await import('@jokoagent/linkspan-pinggy');
    await verifyPinggySdk(process.argv[1]); const sdk=await import(pathToFileURL(join(process.argv[1],'dist/index.js')).href);
    if(typeof sdk.pinggy?.createTunnel!=='function')throw new Error('Missing actual SDK entry');
    console.log(JSON.stringify({version:process.versions.node,nodeAbi:process.versions.modules,sdkImported:true}));`;
  const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH; delete environment.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(executable, ['--input-type=module', '-e', script, sdkDirectory], {
    cwd: dirname(entry), env: environment, timeout: 30_000, windowsHide: true
  });
  expect(JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)!)).toEqual({ version: '24.16.0', nodeAbi: '137', sdkImported: true });
  const directory = mkdtempSync(join(tmpdir(), 'joko-pinggy-managed-')); cleanups.push(directory);
  const workspaceRoot = resolve(directory, 'workspace'); mkdirSync(workspaceRoot);
  const workspaceEntry = fileURLToPath(new URL('../../orchestrator/dist/main.js', import.meta.url));
  const runtime = await startManagedOrchestrator({ orchestratorEntryPath: entry,
    ...(entry === workspaceEntry ? { nodeImportPath: fileURLToPath(import.meta.resolve('tsx')) } : {}),
    dataDirectory: resolve(directory, 'data'), workspaceRoot, deviceId: randomUUID(), defaultDeviceName: 'Prepared Pinggy Desktop',
    appVersion: '0.1.0', environment: { ...process.env, JOKO_BROWSER_ENABLED: '0' }, ephemeral: true, ...await selectManagedOrchestratorPorts() });
  try {
    const authKey = runtime.takeAuthKey(); await runtime.commit();
    await expect(probeManagedOrchestratorConnection({ connection: runtime.connection, readAuthKey: async () => authKey })).resolves.toBe('authenticated');
  } finally { await runtime.stop(); }
}, 75_000);
