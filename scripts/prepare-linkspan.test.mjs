import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { checkoutSource, inspectSource, verifySourcePackages } from './prepare-linkspan.mjs';
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
  const update = () => execute(manager.executable, [...manager.arguments, 'update', '--recursive', '--no-save', '@jokoagent/linkspan-*'], { cwd: root, windowsHide: true, timeout: 30000 });
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
