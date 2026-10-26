import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { Header } from 'tar';
import { afterEach, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ content: Buffer.from('modified archive'), status: 200, length: undefined }));
vi.mock('node:https', () => ({ get: (_url, _options, callback) => {
  const request = new EventEmitter(); request.setTimeout = () => request;
  queueMicrotask(() => {
    const response = Readable.from([network.content]);
    response.statusCode = network.status; response.headers = network.length === undefined ? {} : { 'content-length': network.length };
    callback(response);
  });
  return request;
} }));

import { extractPinggyNodeArchive, pinggyNodeArtifact, preparePinggyNodeRuntime, validatePinggyNodeArchivePath } from './prepare-linkspan-pinggy-node.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); network.status = 200; network.length = undefined; });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'joko-pinggy-node-')); roots.push(root); return root; }

// A tiny standard ZIP writer for bounded parser fixtures; production uses the
// declared extract-zip dependency's ZIP reader and the stdlib decompressor.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const files = [], directory = []; let offset = 0;
  for (const { path, content = Buffer.from('fixture'), mode = 0o100644, compressed = true, size = content.length } of entries) {
    const name = Buffer.from(path), data = compressed ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compressed ? 8 : 0, 10); central.writeUInt32LE(crc32(content), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    files.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}
function tgz(entries) {
  const records = [];
  for (const { path, content = Buffer.from('fixture'), type = 'File', linkpath } of entries) {
    const data = type === 'File' ? content : Buffer.alloc(0);
    const header = new Header({ path, type, linkpath, size: data.length, mode: 0o644 }); header.encode();
    records.push(header.block, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
}

it('selects only the six fixed official archives and rejects unsafe entry paths', () => {
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']) {
    expect(pinggyNodeArtifact(target).url).toMatch(/^https:\/\/nodejs\.org\/dist\/v24\.16\.0\/node-v24\.16\.0-.+\.(?:zip|tar\.gz)$/u);
    expect(pinggyNodeArtifact(target).archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
  }
  expect(() => pinggyNodeArtifact('win32-ia32')).toThrow(/pinned/u);
  for (const path of ['../node', '/node', 'a/../../node', 'a//node', 'a/./node', 'C:/node', 'a\\node', 'node\0suffix']) expect(validatePinggyNodeArchivePath(path)).toBe(false);
});

it.each(['win32-x64', 'linux-x64'])('extracts only the selected executable and license from %s, including large compressed data', async target => {
  const root = await fixture(), artifact = pinggyNodeArtifact(target), executable = randomBytes(256 * 1024), license = Buffer.from('official-license');
  const entries = [{ path: artifact.executablePath, content: executable }, { path: artifact.licensePath, content: license },
    { path: `${artifact.archiveRoot}/unselected/install-script.js`, content: Buffer.from('never extracted') },
    { path: `${artifact.archiveRoot}/unselected/npm`, mode: 0o120777, type: 'SymbolicLink', linkpath: '../outside', content: Buffer.from('../outside') }];
  const archive = join(root, 'archive'); await writeFile(archive, target.startsWith('win32-') ? zip(entries) : tgz(entries));
  const output = join(root, 'selected'); const files = await extractPinggyNodeArchive({ archive, target, directory: output });
  expect((await readdir(output)).sort()).toEqual(['LICENSE', artifact.executableName].sort());
  expect(await readFile(files.executable)).toEqual(executable); expect(await readFile(files.license)).toEqual(license);
});

it.each(['win32-x64', 'linux-x64'])('rejects linked, duplicate, omitted and escaping files for %s without leaving outputs', async target => {
  const root = await fixture(), artifact = pinggyNodeArtifact(target);
  const node = { path: artifact.executablePath }, license = { path: artifact.licensePath };
  const cases = [[{ ...node, mode: 0o120777, type: 'SymbolicLink', linkpath: '../outside' }, license],
    [node, node, license], [license], [node, license, { path: `${artifact.archiveRoot}/../../outside` }]];
  for (let index = 0; index < cases.length; index++) {
    const archive = join(root, `archive-${index}`), output = join(root, `out-${index}`);
    await writeFile(archive, target.startsWith('win32-') ? zip(cases[index]) : tgz(cases[index]));
    await expect(extractPinggyNodeArchive({ archive, target, directory: output })).rejects.toThrow();
    expect(await readdir(output)).toEqual([]);
  }
});

it('rejects bounded ZIP output size mismatches before delivering files', async () => {
  const root = await fixture(), target = 'win32-x64', artifact = pinggyNodeArtifact(target);
  for (const [index, size] of [160 * 1024 * 1024 + 1, 1, 50].entries()) {
    const archive = join(root, `archive-${index}`), output = join(root, `out-${index}`);
    await writeFile(archive, zip([{ path: artifact.executablePath, size }, { path: artifact.licensePath }]));
    await expect(extractPinggyNodeArchive({ archive, target, directory: output })).rejects.toThrow(); expect(await readdir(output)).toEqual([]);
  }
});

it('rejects a linked output directory without touching its existing files', async () => {
  const root = await fixture(), unrelated = join(root, 'unrelated'), linked = join(root, 'linked');
  await mkdir(unrelated); await writeFile(join(unrelated, 'keep'), 'host-owned');
  await symlink(unrelated, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(extractPinggyNodeArchive({ archive: join(root, 'unused'), target: 'win32-x64', directory: linked })).rejects.toThrow(/canonical/u);
  expect(await readdir(unrelated)).toEqual(['keep']); expect(await readFile(join(unrelated, 'keep'), 'utf8')).toBe('host-owned');
});

it('rejects a modified official archive and rejects redirects or oversized download headers', async () => {
  const root = await fixture();
  for (const [index, status, length] of [[0, 200, undefined], [1, 302, undefined], [2, 200, String(200 * 1024 * 1024 + 1)]]) {
    network.status = status; network.length = length;
    const directory = join(root, `prepared-${index}`);
    await expect(preparePinggyNodeRuntime({ directory, target: 'win32-x64' })).rejects.toThrow();
    expect(await readdir(directory)).toEqual(['node-v24.16.0']);
    expect(await readdir(join(directory, 'node-v24.16.0'))).toEqual([]);
  }
});
