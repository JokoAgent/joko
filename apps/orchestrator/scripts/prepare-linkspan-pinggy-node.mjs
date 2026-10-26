import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inflateRawSync } from 'node:zlib';
import * as tar from 'tar';

export const PINGGY_NODE_VERSION = '24.16.0';
export const PINGGY_NODE_ABI = '137';
// Fixed official https://nodejs.org/dist/v24.16.0/SHASUMS256.txt inputs.
export const PINGGY_NODE_ARCHIVE_SHA256 = Object.freeze({
  'darwin-arm64': '39189dab4eeb15706c424af0ac08a3044c9e48f7db12a7d77f6b7aafc7dd5df6',
  'darwin-x64': '298b4c7b3cb80765c8703e42b90324a4ece3b6634947b89e769c3c980ab55185',
  'linux-arm64': '589f5b6dd4fcfee4dfda73013903c966abaa8abd93dbc9d436544e472b4f0e74',
  'linux-x64': '2faf6a387e9b62b888e21c54f01249fb27537ffecf1842f29f4c919d0a59a0ff',
  'win32-arm64': '14834611d4c6b3c06054e7007732b90474c16e0b32f395e05b55a571ef71c6d2',
  'win32-x64': 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56'
});

const maximumArchiveBytes = 200 * 1024 * 1024;
const maximumExecutableBytes = 160 * 1024 * 1024;
const maximumLicenseBytes = 2 * 1024 * 1024;
const require = createRequire(import.meta.url);
// Reuse the ZIP reader owned by the already declared extract-zip dependency.
const zipRequire = createRequire(require.resolve('extract-zip'));
const yauzl = zipRequire('yauzl');
const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);

export function pinggyNodeArtifact(target) {
  const archiveSha256 = PINGGY_NODE_ARCHIVE_SHA256[target];
  if (typeof archiveSha256 !== 'string') throw new Error('No pinned Pinggy Node runtime exists for this build target.');
  const archiveRoot = `node-v${PINGGY_NODE_VERSION}-${target.replace('win32-', 'win-')}`;
  const windows = target.startsWith('win32-');
  return Object.freeze({ target, archiveRoot, archiveSha256, executableName: windows ? 'node.exe' : 'node',
    executablePath: `${archiveRoot}/${windows ? 'node.exe' : 'bin/node'}`,
    licensePath: `${archiveRoot}/LICENSE`,
    url: `https://nodejs.org/dist/v${PINGGY_NODE_VERSION}/${archiveRoot}.${windows ? 'zip' : 'tar.gz'}` });
}

export function validatePinggyNodeArchivePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || /[\\:\0]/u.test(value) || value.startsWith('/')) return false;
  const parts = value.replace(/\/$/u, '').split('/');
  return parts.length <= 64 && parts.every(part => part !== '' && part !== '.' && part !== '..');
}

async function regularDirectory(directory) {
  if (!isAbsolute(directory)) throw new Error('The Pinggy Node output must be absolute.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical(await realpath(directory)) !== canonical(directory)) {
    throw new Error('The Pinggy Node output must be a canonical regular directory.');
  }
}

export async function hashPinggyNodeFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadArchive(artifact, destination) {
  const signal = AbortSignal.timeout(180_000);
  const response = await new Promise((accept, reject) => {
    const request = get(artifact.url, { signal }, accept);
    request.setTimeout(30_000, () => request.destroy(new Error('The fixed Node runtime download timed out.')));
    request.on('error', reject);
  });
  const length = response.headers['content-length'];
  if (response.statusCode !== 200 || length !== undefined && (!/^[0-9]+$/u.test(length) || Number(length) > maximumArchiveBytes)) {
    response.destroy(); throw new Error('The fixed Node runtime archive was not available within its download bound.');
  }
  let bytes = 0;
  const limit = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maximumArchiveBytes ? new Error('The Node runtime archive exceeded its download bound.') : null, chunk);
  } });
  await pipeline(response, limit, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  if (await hashPinggyNodeFile(destination) !== artifact.archiveSha256) throw new Error('The Node runtime archive did not match its fixed official SHA256.');
}

/** Release-only selective extraction. The caller verifies the pinned archive first.
 * Archive paths never become output paths: only these two fixed flat files exist. */
export async function extractPinggyNodeArchive({ archive, target, directory }) {
  const artifact = pinggyNodeArtifact(target);
  await regularDirectory(directory);
  if ((await readdir(directory)).length !== 0) throw new Error('Node extraction requires a new empty directory.');
  const selected = new Map([[artifact.executablePath, artifact.executableName], [artifact.licensePath, 'LICENSE']]);
  const seen = new Set();
  let entries = 0;
  const select = (path, size, regular) => {
    if (++entries > 50_000 || !validatePinggyNodeArchivePath(path)) throw new Error('The Node runtime archive contained an unsafe or excessive path.');
    const name = selected.get(path);
    if (name === undefined) return undefined;
    const limit = name === 'LICENSE' ? maximumLicenseBytes : maximumExecutableBytes;
    if (!regular || !Number.isSafeInteger(size) || size < 1 || size > limit || seen.has(path)) throw new Error('The selected Node runtime file was not a unique bounded regular file.');
    seen.add(path); return join(directory, name);
  };
  try {
    if (target.startsWith('win32-')) {
      await new Promise((accept, reject) => {
        yauzl.open(archive, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
          if (error) { reject(error); return; }
          let settled = false;
          const fail = cause => { if (!settled) { settled = true; zip.close(); reject(cause); } };
          zip.on('error', fail);
          zip.on('end', () => { if (!settled) { settled = true; accept(); } });
          zip.on('entry', entry => {
            let output;
            try {
              const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
              output = select(entry.fileName, entry.uncompressedSize, !entry.fileName.endsWith('/') && (mode === 0 || mode === 0o100000));
            } catch (cause) { fail(cause); return; }
            if (output === undefined) { zip.readEntry(); return; }
            if (entry.isEncrypted() || ![0, 8].includes(entry.compressionMethod) || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize > maximumArchiveBytes) {
              fail(new Error('The selected Node ZIP file has an unsupported encoding or size.')); return;
            }
            zip.openReadStream(entry, entry.isCompressed() ? { decompress: false } : {}, (cause, stream) => {
              if (cause) { fail(cause); return; }
              // The existing yauzl reader predates modern stream pipeline
              // backpressure. Keep this single, size-checked entry flowing;
              // its declared output is already capped above before allocation.
              const chunks = []; let bytes = 0;
              stream.on('error', fail);
              stream.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > entry.compressedSize) { stream.destroy(); fail(new Error('The selected ZIP file exceeded its pinned entry size.')); return; }
                chunks.push(chunk);
              });
              stream.on('end', () => {
                if (settled) return;
                if (bytes !== entry.compressedSize) { fail(new Error('The selected ZIP file was truncated.')); return; }
                let content;
                try {
                  const raw = Buffer.concat(chunks, bytes);
                  content = entry.isCompressed() ? inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize }) : raw;
                  if (content.length !== entry.uncompressedSize) throw new Error('The selected ZIP file had an unexpected output size.');
                } catch (cause) { fail(cause); return; }
                writeFile(output, content, { flag: 'wx', mode: 0o600 })
                  .then(() => { if (!settled) zip.readEntry(); }, fail);
              });
            });
          });
          zip.readEntry();
        });
      });
    } else {
      let failure;
      const writes = [];
      await tar.t({ file: archive, strict: true, noResume: true, onReadEntry(entry) {
        let output;
        try { output = select(entry.path, entry.size, entry.type === 'File'); }
        catch (cause) { failure ??= cause; }
        if (output === undefined || failure !== undefined) { entry.resume(); return; }
        writes.push(pipeline(entry, createWriteStream(output, { flags: 'wx', mode: 0o600 })).catch(cause => { failure ??= cause; }));
      } });
      await Promise.all(writes);
      if (failure !== undefined) throw failure;
    }
    if (seen.size !== selected.size) throw new Error('The pinned Node archive omitted its executable or license.');
    return { executable: join(directory, artifact.executableName), license: join(directory, 'LICENSE') };
  } catch (cause) {
    await Promise.all([...selected.values()].map(name => rm(join(directory, name), { force: true })));
    throw cause;
  }
}

/** Build preparation only. Neither the app nor the managed server downloads Node. */
export async function preparePinggyNodeRuntime({ directory, target }) {
  const artifact = pinggyNodeArtifact(target);
  await regularDirectory(directory);
  const destination = join(directory, `node-v${PINGGY_NODE_VERSION}`, target);
  const suffix = relative(directory, destination);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('The Node runtime destination escaped its output.');
  await regularDirectory(dirname(destination));
  if (await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('The selected Node runtime output already exists.');
  const temporary = await mkdtemp(join(directory, '.prepare-node-'));
  try {
    const archive = join(temporary, target.startsWith('win32-') ? 'node.zip' : 'node.tar.gz');
    await downloadArchive(artifact, archive);
    const files = await extractPinggyNodeArchive({ archive, target, directory: join(temporary, 'files') });
    await mkdir(destination, { mode: 0o700 });
    const executable = join(destination, artifact.executableName);
    await copyFile(files.executable, executable, constants.COPYFILE_EXCL);
    await copyFile(files.license, join(destination, 'LICENSE'), constants.COPYFILE_EXCL);
    if (!target.startsWith('win32-')) await chmod(executable, 0o755);
    return Object.freeze({ executable, version: PINGGY_NODE_VERSION, nodeAbi: PINGGY_NODE_ABI, target,
      sha256: await hashPinggyNodeFile(executable), archiveSha256: artifact.archiveSha256 });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
