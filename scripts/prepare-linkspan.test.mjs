import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { checkoutSource, inspectSource, refreshSourceDependencies, verifySourcePackages } from './prepare-linkspan.mjs';
import { pnpmInvocation } from './pnpm-invocation.mjs';

test('follows remote main advances and preserves edited source instead of resetting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linkspan-source-test-'));
  const remote = join(root, 'remote'), cache = join(root, 'cache');
  const git = args => execFileSync('git', ['-c', 'user.name=Source fixture', '-c', 'user.email=source@example.invalid', ...args], { cwd: remote, encoding: 'utf8' }).trim();
  try {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', remote]);
    await writeFile(join(remote, 'value'), 'first'); git(['add', 'value']); git(['commit', '--quiet', '-m', 'first']);
    const source = { repository: remote, ref: 'main' };
    const first = await checkoutSource(cache, source);
    assert.deepEqual(await inspectSource(remote), first);
    assert.equal(git(['branch', '--show-current']), 'main');
    assert.equal(await readFile(join(cache, 'value'), 'utf8'), 'first');
    const consumers = join(root, 'consumers'); await mkdir(join(consumers, 'core', 'dist'), { recursive: true });
    await writeFile(join(consumers, 'manifest.json'), JSON.stringify({ ...first, packages: [{ name: '@jokoagent/linkspan-core', directory: 'core' }] }));
    await writeFile(join(consumers, 'core', 'package.json'), JSON.stringify({ name: '@jokoagent/linkspan-core' }));
    await writeFile(join(consumers, 'core', 'dist', 'source-build.json'), JSON.stringify({ ...first, name: '@jokoagent/linkspan-core' }));
    await verifySourcePackages(consumers, first);
    await writeFile(join(remote, 'value'), 'second'); git(['commit', '--quiet', '-am', 'second']);
    const second = await checkoutSource(cache, source);
    assert.deepEqual(await inspectSource(remote), second);
    assert.notEqual(first.sourceCommit, second.sourceCommit);
    assert.equal(await readFile(join(cache, 'value'), 'utf8'), 'second');
    await assert.rejects(verifySourcePackages(consumers, second), /do not match the selected source/);
    assert.equal(execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: cache, encoding: 'utf8' }).trim(), '');
    await writeFile(join(cache, 'value'), 'local edit');
    await assert.rejects(checkoutSource(cache, source), /edited tracked files/);
    assert.equal(await readFile(join(cache, 'value'), 'utf8'), 'local edit');
    await assert.rejects(inspectSource(cache), /edited tracked files/);
  } finally {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('linkspan-source-test-')) throw new Error('Unexpected source fixture cleanup path.');
    await rm(root, { recursive: true, force: true });
  }
});

test('refreshes compiled source directories without requiring a package version bump', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linkspan-source-test-'));
  const compiled = join(root, 'compiled'), app = join(root, 'app');
  const manager = await pnpmInvocation(), execute = promisify(execFile);
  const update = () => refreshSourceDependencies(root, (args, cwd) => execute(manager.executable,
    [...manager.arguments, ...args], { cwd, windowsHide: true, timeout: 30000 }));
  const build = async value => {
    await mkdir(compiled);
    await writeFile(join(compiled, 'package.json'), JSON.stringify({ name: '@jokoagent/linkspan-core', version: '0.0.0-source', main: 'index.js' }));
    await writeFile(join(compiled, 'index.js'), value);
  };
  try {
    await mkdir(app);
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true }));
    await writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - app\noverrides:\n  '@jokoagent/linkspan-core': file:compiled\n");
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'source-consumer-fixture', private: true, dependencies: { '@jokoagent/linkspan-core': '*' } }));
    await build('module.exports = "first";'); await update();
    const installed = join(app, 'node_modules', '@jokoagent', 'linkspan-core', 'index.js');
    assert.equal(await readFile(installed, 'utf8'), 'module.exports = "first";');
    if (dirname(compiled) !== root) throw new Error('Unexpected source output path.');
    await rm(compiled, { recursive: true });
    await build('module.exports = "second";'); await update();
    assert.equal(await readFile(installed, 'utf8'), 'module.exports = "second";');
    assert.equal(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).dependencies['@jokoagent/linkspan-core'], '*');
  } finally {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('linkspan-source-test-')) throw new Error('Unexpected source fixture cleanup path.');
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps the declared optional-peer graph stable across repeated source preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linkspan-source-test-'));
  const manager = await pnpmInvocation(), execute = promisify(execFile);
  const pnpm = (args, cwd = root) => execute(manager.executable, [...manager.arguments, ...args], { cwd, windowsHide: true, timeout: 30000 });
  const names = { iroh: '@jokoagent/linkspan-iroh', node: '@jokoagent/linkspan-iroh-node', wasm: '@jokoagent/linkspan-iroh-wasm' };
  const peers = (...keys) => ({ peerDependencies: Object.fromEntries(keys.map(key => [names[key], '*'])),
    peerDependenciesMeta: Object.fromEntries(keys.map(key => [names[key], { optional: true }])) });
  try {
    const manifest = JSON.stringify({ private: true });
    await writeFile(join(root, 'package.json'), manifest);
    await writeFile(join(root, 'pnpm-workspace.yaml'), `packages:\n  - apps/*\noverrides:\n  '${names.iroh}': file:compiled/iroh\n  '${names.node}': file:compiled/node\n  '${names.wasm}': file:compiled/wasm\n`);
    for (const [directory, name, metadata] of [
      ['iroh', names.iroh, peers('node', 'wasm')], ['node', names.node, peers('wasm')], ['wasm', names.wasm, {}]
    ]) {
      await mkdir(join(root, 'compiled', directory), { recursive: true });
      await writeFile(join(root, 'compiled', directory, 'package.json'), JSON.stringify({ name, version: '0.0.0-source', main: 'index.js', ...metadata }));
      await writeFile(join(root, 'compiled', directory, 'index.js'), 'module.exports = "prepared";');
    }
    const consumers = new Map();
    for (const [name, keys] of [['both', ['iroh', 'node', 'wasm']], ['native', ['iroh', 'node']], ['browser', ['iroh', 'wasm']]]) {
      const directory = join(root, 'apps', name);
      await mkdir(directory, { recursive: true });
      const content = JSON.stringify({ name: `source-${name}-fixture`, private: true, dependencies: Object.fromEntries(keys.map(key => [names[key], '*'])) });
      consumers.set(join(directory, 'package.json'), content);
      await writeFile(join(directory, 'package.json'), content);
    }
    // Establish the accepted graph with the real source preparation first;
    // an empty lock-only resolution has not installed optional peer contexts.
    await refreshSourceDependencies(root, pnpm);
    const canonical = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
    assert.ok(canonical.includes('file:compiled/node(@jokoagent/linkspan-iroh-wasm@file:compiled/wasm)'));
    await pnpm(['install', '--frozen-lockfile', '--ignore-scripts']);
    assert.equal(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), canonical);
    for (let attempt = 0; attempt < 2; attempt++) {
      await refreshSourceDependencies(root, pnpm);
      assert.equal(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), canonical);
      assert.equal(await readFile(join(root, 'package.json'), 'utf8'), manifest);
      for (const [path, content] of consumers) assert.equal(await readFile(path, 'utf8'), content);
    }
  } finally {
    if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('linkspan-source-test-')) throw new Error('Unexpected source fixture cleanup path.');
    await rm(root, { recursive: true, force: true });
  }
});
