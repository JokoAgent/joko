import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selected = JSON.parse(await readFile(resolve(mobile, 'dist/linkspan-runtime/selected.json'), 'utf8'));
if (selected.schema !== 1 || typeof selected.nativeHttpConnect !== 'boolean' || !Array.isArray(selected.relayBackends)) {
  throw new Error('The Mobile runtime selection receipt is invalid.');
}
if (selected.nativeHttpConnect && (selected.nativeIroh !== false || selected.webRtc !== false || selected.relayBackends.length !== 0)) {
  throw new Error('This native CONNECT audit requires an isolated selected build.');
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const notice = selected.nativeHttpConnect ? await readFile(resolve(mobile, 'dist/linkspan-runtime/http-connect-notices.lsnotice')) : undefined;
if (notice !== undefined && (notice.byteLength === 0 || notice.byteLength > 4_194_304)) throw new Error('The selected dependency notice is unavailable.');
const library = JSON.parse(await readFile(resolve(mobile, '../../.runtime/linkspan-packages/manifest.json'), 'utf8'));
const receipts = [];
const platforms = process.argv.length > 2 ? process.argv.slice(2) : ['android', 'ios'];
if (platforms.some(platform => !['android', 'ios'].includes(platform)) || new Set(platforms).size !== platforms.length) throw new Error('Select an exported Mobile platform.');
for (const platform of platforms) {
  const root = resolve(mobile, 'dist', platform);
  async function regular(name, maximum) {
    if (typeof name !== 'string') throw new Error('An export path is invalid.');
    const parts = name.split(/[\\/]/u);
    if (isAbsolute(name) || parts.some(part => !part || part === '.' || part === '..' || /[:\0]/u.test(part))) throw new Error('An export path escaped its platform directory.');
    const path = resolve(root, ...parts), info = await lstat(path);
    const canonical = await realpath(path), inside = relative(await realpath(root), canonical);
    if (!info.isFile() || info.isSymbolicLink() || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)
      || info.size <= 0 || info.size > maximum) throw new Error('An exported artifact is not a bounded regular file.');
    return readFile(path);
  }
  const metadata = JSON.parse(await regular('metadata.json', 2_097_152));
  const entry = metadata.fileMetadata?.[platform];
  if (metadata.bundler !== 'metro' || !entry || !Array.isArray(entry.assets) || typeof entry.bundle !== 'string' || !entry.bundle.endsWith('.hbc')) throw new Error('The actual Hermes export metadata is invalid.');
  const bundle = await regular(entry.bundle, 67_108_864);
  if (!bundle.subarray(0, 8).equals(Buffer.from('c61fbc03c103191f', 'hex'))) throw new Error('The selected export is not Hermes bytecode.');
  const sourceMap = await regular(entry.bundle + '.map', 134_217_728);
  const sources = [];
  function collect(map) {
    if (Array.isArray(map.sources)) for (const source of map.sources) if (typeof source === 'string') sources.push(source.replaceAll('\\', '/'));
    if (Array.isArray(map.sections)) for (const section of map.sections) collect(section.map);
  }
  collect(JSON.parse(sourceMap));
  if (sources.length === 0) throw new Error('The actual Metro dependency graph is unavailable.');
  const parser = sources.filter(source => source.includes('@jokoagent/linkspan-http-connect/dist/connect-parser.js'));
  const nodeSdk = sources.filter(source => source.includes('@jokoagent/linkspan-webrtc-node/') || source.includes('@jokoagent/linkspan-http-connect/dist/node'));
  if ((parser.length > 0) !== selected.nativeHttpConnect || nodeSdk.length !== 0) throw new Error('The actual Metro graph includes an unselected parser or Node SDK.');
  const sdkAssets = entry.assets.filter(asset => ['wasm', 'lsruntime', 'lsnotice'].includes(asset.ext));
  if (selected.nativeHttpConnect && (sdkAssets.length !== 1 || sdkAssets[0].ext !== 'lsnotice')) throw new Error('An unselected WASM or embedded relay/WebRTC runtime entered the native CONNECT export.');
  const exportedNotice = selected.nativeHttpConnect ? await regular(sdkAssets[0].path, 4_194_304) : undefined;
  if (exportedNotice !== undefined && sha256(exportedNotice) !== sha256(notice)) throw new Error('The actual export omitted or changed the selected dependency notice.');
  const receipt = { schemaVersion: 1, platform, scope: 'actual-hermes-export-and-selected-assets', selected,
    linkspan: { sourceCommit: library.sourceCommit, sourceTree: library.sourceTree },
    hermes: { path: entry.bundle, bytes: bundle.byteLength, sha256: sha256(bundle) },
    graph: { sourceMapSha256: sha256(sourceMap), sources: sources.length, connectParser: parser.length, nodeSdk: nodeSdk.length },
    assets: { wasm: sdkAssets.filter(asset => asset.ext === 'wasm').length, runtimePayloads: sdkAssets.filter(asset => asset.ext === 'lsruntime').length,
      notices: sdkAssets.filter(asset => asset.ext === 'lsnotice').length, ...(exportedNotice === undefined ? {} : { noticeSha256: sha256(exportedNotice) }) } };
  await writeFile(resolve(root, 'linkspan-export-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  receipts.push(receipt);
}
console.log(JSON.stringify({ mobileSdkExports: receipts }));
