import { createRequire } from 'node:module';
import { copyFile, lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(mobile, 'package.json'));
const { selectedMobileLinkspanModes } = require('./linkspan-runtime-selection.cjs');

/** Runtime assets are build-selected and stay separate from the Hermes program. */
export async function prepareMobileLinkspanRuntimes() {
  const output = resolve(mobile, 'dist/linkspan-runtime');
  const selected = selectedMobileLinkspanModes();
  await mkdir(output, { recursive: true });
  const info = await lstat(output), canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(await realpath(output)) !== canonical(output)) throw new Error('The Mobile runtime output must be a canonical owned directory.');
  const assetNames = kind => [`${kind}-runtime.lsruntime`, `${kind}.wasm`, `${kind}-notices.lsnotice`];
  const legacyNames = kind => [`${kind}.lsruntime`, `${kind}.lsnotice`];
  for (const name of ['selected.json', 'webrtc-runtime.lsruntime', 'webrtc-notices.lsnotice', 'http-connect-notices.lsnotice', ...['iroh', 'tailcat'].flatMap(kind => [...assetNames(kind), ...legacyNames(kind)])]) {
    const before = await lstat(resolve(output, name)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (before !== undefined && (!before.isFile() || before.isSymbolicLink())) throw new Error('An unowned Mobile runtime output cannot be replaced.');
  }
  // Only these generated files belong to this preparer. Never clear app data or
  // other export directories when a mode is deselected.
  for (const kind of ['iroh', 'tailcat']) for (const name of [...legacyNames(kind), ...(!selected.relayBackends.includes(kind) ? assetNames(kind) : [])]) {
    const path = resolve(output, name), before = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (before === undefined) continue;
    if (!before.isFile() || before.isSymbolicLink() || canonical(resolve(path, '..')) !== canonical(output)) throw new Error('An unowned Mobile runtime file cannot be replaced.');
    await unlink(path);
  }
  for (const [kind, title, wasmFile] of [['iroh', 'Iroh', 'linkspan_iroh_bg.wasm'], ['tailcat', 'Tailcat', 'tailcat.wasm']]) {
    if (!selected.relayBackends.includes(kind)) continue;
    const wrapper = `@jokoagent/linkspan-${kind}`;
    const wasm = `@jokoagent/linkspan-${kind}-wasm`;
    const runtime = dirname(require.resolve(wasm));
    const wasmSource = resolve(runtime, 'runtime', wasmFile);
    // A missing binding is a build failure, never a runtime download fallback.
    const wasmBytes = await readFile(wasmSource);
    if (wasmBytes.byteLength < 8 || wasmBytes.readUInt32LE(0) !== 0x6d736100) throw new Error(`The selected ${kind} WASM artifact is invalid.`);
    const result = await build({
      absWorkingDir: mobile,
      stdin: { contents: `import { initialize${title}Wasm, create${title}BridgeHost } from ${JSON.stringify(wrapper)};
globalThis.jokoLinkspanStart = async bytes => { await initialize${title}Wasm(bytes); return create${title}BridgeHost(); };`,
        sourcefile: `linkspan-${kind}-host.js`, resolveDir: mobile, loader: 'js' },
      bundle: true, platform: 'browser', conditions: ['browser'], format: 'iife', target: ['chrome110', 'safari16.4'],
      minify: true, legalComments: 'inline', write: false,
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: { '.wasm': 'empty' }
    });
    if (result.outputFiles.length !== 1) throw new Error(`The selected ${kind} bridge did not build one local runtime.`);
    const script = result.outputFiles[0].text;
    if (!script.includes('jokoLinkspanStart') || script.length > 16_777_216) throw new Error(`The selected ${kind} runtime is invalid.`);
    // Android raw resource identifiers omit the extension. Keep each asset's
    // basename distinct so the resource merger can retain all three files.
    await writeFile(resolve(output, `${kind}-runtime.lsruntime`), script, 'utf8');
    await copyFile(wasmSource, resolve(output, `${kind}.wasm`));
    await copyFile(resolve(runtime, 'runtime/THIRD_PARTY_NOTICES.txt'), resolve(output, `${kind}-notices.lsnotice`));
  }
  if (selected.webRtc) {
    const result = await build({ absWorkingDir: mobile,
      stdin: { contents: `import { createWebRtcBridgeHost } from '@joko/connection-transport/webrtc'; globalThis.jokoLinkspanStart=async()=>createWebRtcBridgeHost();`,
        sourcefile: 'linkspan-webrtc-host.js', resolveDir: mobile, loader: 'js' },
      bundle: true, platform: 'browser', conditions: ['browser'], format: 'iife', target: ['chrome110', 'safari16.4'],
      minify: true, legalComments: 'inline', write: false, metafile: true, define: { 'process.env.NODE_ENV': '"production"' } });
    if (result.outputFiles.length !== 1 || result.outputFiles[0].text.length > 4_194_304) throw new Error('The selected WebRTC runtime is invalid.');
    await writeFile(resolve(output, 'webrtc-runtime.lsruntime'), result.outputFiles[0].text, 'utf8');
    const noise = Object.keys(result.metafile.inputs).find(name => name.replaceAll('\\', '/').endsWith('/@jokoagent/linkspan-noise/dist/index.js'));
    if (noise === undefined) throw new Error('The selected WebRTC signaling dependency inventory is unavailable.');
    await copyFile(resolve(dirname(resolve(mobile, noise)), 'THIRD_PARTY_LICENSES.txt'), resolve(output, 'webrtc-notices.lsnotice'));
  } else for (const name of ['webrtc-runtime.lsruntime', 'webrtc-notices.lsnotice']) await unlink(resolve(output, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (selected.nativeHttpConnect) {
    const parser = dirname(fileURLToPath(import.meta.resolve('@jokoagent/linkspan-http-connect'))), noise = dirname(fileURLToPath(import.meta.resolve('@jokoagent/linkspan-noise')));
    const notices = await Promise.all([readFile(resolve(parser, 'CONNECT_PARSER_LICENSE.txt'), 'utf8'), readFile(resolve(noise, 'THIRD_PARTY_LICENSES.txt'), 'utf8')]);
    if (notices.some(value => value.length === 0 || value.length > 2_097_152)) throw new Error('The selected native proxy dependency notices are unavailable.');
    await writeFile(resolve(output, 'http-connect-notices.lsnotice'), notices.join('\n\n'), 'utf8');
  } else await unlink(resolve(output, 'http-connect-notices.lsnotice')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(resolve(output, 'selected.json'), JSON.stringify({ schema: 1, ...selected }) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareMobileLinkspanRuntimes();
}
