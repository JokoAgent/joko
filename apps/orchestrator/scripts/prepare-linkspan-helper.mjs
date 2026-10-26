import { copyFile, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflaredArtifact, prepareCloudflared } from '@jokoagent/linkspan-cloudflare';

const target = process.env.JOKO_LINKSPAN_BUILD_TARGET ?? `${process.platform}-${process.arch}`;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const directory = resolve(scriptDirectory, '../dist/linkspan-helper');
await mkdir(directory, { recursive: true });
const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
if (canonical(await realpath(directory)) !== canonical(directory)) throw new Error('The Linkspan helper output must be a canonical owned directory.');
await copyFile(resolve(scriptDirectory, '../../../.runtime/linkspan-packages/manifest.json'), resolve(directory, '../linkspan-packages.json'));
// This is an owned packaging output, not the library's reusable multi-target cache.
// A reused dist directory must never ship a previous OS/CPU or helper version.
async function pruneChildren(parent, keep) {
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Linkspan helper output must be a regular directory.');
  for (const name of await readdir(parent)) {
    if (keep.has(name)) continue;
    const child = resolve(parent, name);
    const within = relative(directory, child);
    if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('The Linkspan helper cleanup escaped its output directory.');
    await rm(child, { recursive: true, force: true });
  }
}
let artifact;
if (process.env.JOKO_LINKSPAN_BUILD_BACKENDS !== undefined
  && !process.env.JOKO_LINKSPAN_BUILD_BACKENDS.split(',').map(value => value.trim()).includes('cloudflare')) {
  await pruneChildren(directory, new Set());
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ target, supported: false, reason: 'not_selected' }, null, 2) + '\n');
  console.log('Cloudflare was not selected for this server build.');
  process.exit(0);
}
try { artifact = cloudflaredArtifact(target); }
catch (error) {
  if (error.code !== 'unsupported_platform') throw error;
  await pruneChildren(directory, new Set());
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ target, supported: false, reason: 'unsupported_target' }, null, 2) + '\n');
  console.log(`Linkspan helper unavailable for ${target}; encrypted direct connections remain supported.`);
  process.exit(0);
}
await pruneChildren(directory, new Set([artifact.version]));
const versionDirectory = join(directory, artifact.version);
await mkdir(versionDirectory, { recursive: true });
await pruneChildren(versionDirectory, new Set([target]));
const targetDirectory = join(versionDirectory, target);
await mkdir(targetDirectory, { recursive: true });
await pruneChildren(targetDirectory, new Set([
  target.startsWith('win32-') ? 'cloudflared.exe' : 'cloudflared',
  'restricted-helper.build.json',
]));
const helper = await prepareCloudflared({ directory, target });
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ target, supported: true, version: artifact.version,
  executable: `${artifact.version}/${target}/${target.startsWith('win32-') ? 'cloudflared.exe' : 'cloudflared'}`,
  binaryBytes: artifact.binaryBytes, binarySha256: artifact.binarySha256 }, null, 2) + '\n');
console.log(`Prepared the pinned Linkspan helper for ${helper.target}.`);
