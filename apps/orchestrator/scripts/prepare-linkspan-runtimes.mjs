import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PINGGY_NODE_ABI, PINGGY_NODE_VERSION, preparePinggyNodeRuntime } from './prepare-linkspan-pinggy-node.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist', 'linkspan-runtime');
const allowed = new Set(['cloudflare','iroh','tailcat','funnel','frp','rathole','bore','netbird','zrok','pangolin','pinggy-sdk']);

/** Release preparation only; application startup never downloads a backend. */
export async function prepareLinkspanServerRuntimes() {
  const target = process.env.JOKO_LINKSPAN_BUILD_TARGET ?? `${process.platform}-${process.arch}`;
  const selected = new Set((process.env.JOKO_LINKSPAN_BUILD_BACKENDS ?? 'cloudflare,iroh,tailcat').split(',').map(value => value.trim()).filter(Boolean));
  if ([...selected].some(value => !allowed.has(value))) throw new Error('Unknown Linkspan build backend. Select only explicitly integrated server runtimes.');
  await mkdir(output, { recursive: true });
  const info = await lstat(output);
  const actual = await realpath(output), canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(actual) !== canonical(output)) throw new Error('The Linkspan runtime output must be a canonical regular directory.');
  // Own generated output only. Remove inactive backend/target material so a
  // repeated build cannot accidentally ship a previous architecture's payload.
  for (const name of await readdir(output)) {
    const candidate = resolve(output, name), suffix = relative(output, candidate);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('The runtime cleanup escaped its output.');
    const child = await lstat(candidate);
    if (child.isSymbolicLink()) throw new Error('A linked runtime output cannot be replaced.');
    await rm(candidate, { recursive: child.isDirectory(), force: false });
  }
  const prepared = {};
  if (selected.has('iroh')) {
    const { prepareIrohRuntime } = await import('@jokoagent/linkspan-iroh-node/prepare');
    const result = await prepareIrohRuntime({ directory: join(output, 'iroh'), target });
    prepared.iroh = result.receipt;
  }
  if (selected.has('tailcat')) {
    const { prepareTailcatRuntime } = await import('@jokoagent/linkspan-tailcat-node/prepare');
    const result = await prepareTailcatRuntime({ directory: join(output, 'tailcat'), target });
    prepared.tailcat = result.receipt;
  }
  const helpers = {};
  for (const provider of selected) {
    if (['cloudflare','iroh','tailcat','pinggy-sdk'].includes(provider)) continue;
    const { prepareConnectorHelper } = await import('@jokoagent/linkspan-connectors');
    const result = await prepareConnectorHelper({ provider, directory: join(output, 'connectors'), target });
    helpers[provider] = { ...result, executable: relative(output, result.executable).replaceAll('\\','/') };
  }
  if (selected.has('pinggy-sdk')) {
    const { preparePinggySdk } = await import('@jokoagent/linkspan-pinggy');
    // The SDK publishes only this fixed Node ABI. A build driven by Electron
    // must not accidentally request Electron's different native ABI.
    const result = await preparePinggySdk({ directory: join(output, 'pinggy'), target, nodeAbi: PINGGY_NODE_ABI });
    const sdkDirectory = relative(output, result.sdkDirectory);
    if (!isAbsolute(result.sdkDirectory) || !sdkDirectory || sdkDirectory === '..' || sdkDirectory.startsWith(`..${sep}`) || isAbsolute(sdkDirectory)
      || result.target !== target || result.nodeAbi !== PINGGY_NODE_ABI || result.version !== '0.5.3'
      || sdkDirectory.replaceAll('\\', '/') !== `pinggy/pinggy-0.5.3/${target}/node-${PINGGY_NODE_ABI}`) throw new Error('The prepared Pinggy SDK escaped its selected runtime output.');
    const node = await preparePinggyNodeRuntime({ directory: join(output, 'pinggy'), target });
    if (target === `${process.platform}-${process.arch}`) {
      const environment = { ...process.env };
      delete environment.NODE_OPTIONS; delete environment.NODE_PATH; delete environment.ELECTRON_RUN_AS_NODE;
      const script = `if(process.version!==${JSON.stringify(`v${PINGGY_NODE_VERSION}`)}||process.versions.modules!==${JSON.stringify(PINGGY_NODE_ABI)})throw new Error('Unexpected Pinggy Node runtime');`
        + `const {verifyPinggySdk}=await import(${JSON.stringify(import.meta.resolve('@jokoagent/linkspan-pinggy'))});`
        + `await verifyPinggySdk(${JSON.stringify(result.sdkDirectory)});await import(${JSON.stringify(pathToFileURL(join(result.sdkDirectory, 'dist/index.js')).href)});`;
      await promisify(execFile)(node.executable, ['--input-type=module', '--eval', script], { env: environment, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 });
    }
    prepared.pinggy = { sdkDirectory: sdkDirectory.replaceAll('\\', '/'), target, nodeAbi: PINGGY_NODE_ABI, version: result.version,
      nodeRuntime: { ...node, executable: relative(output, node.executable).replaceAll('\\', '/') } };
  }
  const source = JSON.parse(await readFile(resolve(root, '../../.runtime/linkspan-packages/manifest.json'), 'utf8'));
  await writeFile(join(output, 'selected.json'), JSON.stringify({ target, sourceCommit: source.sourceCommit,
    backends: [...selected], prepared, helpers }, null, 2)+'\n');
  console.log(`Prepared only selected Linkspan server runtimes (${[...selected].join(', ') || 'none'}) for ${target}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareLinkspanServerRuntimes();
