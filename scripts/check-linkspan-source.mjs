import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSource, verifySourcePackages } from './prepare-linkspan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(join(root, 'linkspan.json'), 'utf8'));
assert.equal(source.ref, 'main');
assert.equal(source.repository, 'https://github.com/JokoAgent/linkspan.git');
assert.equal(execFileSync('git', ['ls-files', '--', 'vendor/linkspan'], { cwd: root, encoding: 'utf8' }).trim(), '');
const packages = join(root, '.runtime', 'linkspan-packages');
const preparedSource = JSON.parse(await readFile(join(root, '.runtime', 'linkspan-source.json'), 'utf8'));
assert.equal(typeof preparedSource.directory, 'string');
assert.ok(isAbsolute(preparedSource.directory));
const identity = await inspectSource(preparedSource.directory);
const manifest = await verifySourcePackages(packages, identity);
const names = new Set(manifest.packages.map(item => item.name));
let consumers = 0;
for (const group of ['apps', 'packages']) for (const name of await readdir(join(root, group))) {
  const workspace = join(root, group, name);
  let pkg;
  try { pkg = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  for (const [dependency, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!dependency.startsWith('@jokoagent/linkspan-')) continue;
    assert.equal(range, '*'); assert.ok(names.has(dependency));
    const receipt = JSON.parse(await readFile(join(workspace, 'node_modules', dependency, 'dist', 'source-build.json'), 'utf8'));
    assert.equal(receipt.name, dependency); assert.equal(receipt.sourceCommit, identity.sourceCommit); assert.equal(receipt.sourceTree, identity.sourceTree); consumers++;
  }
}
console.log(`Verified ${consumers} Linkspan source consumers (${identity.sourceCommit}).`);
