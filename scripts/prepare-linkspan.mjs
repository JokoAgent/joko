import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { pnpmInvocation } from './pnpm-invocation.mjs';

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = async (file, args, cwd) => {
  const result = await execute(file, args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
};

export async function inspectSource(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase()) throw new Error('The source must be a canonical directory.');
  const git = args => run('git', args, directory);
  if (await git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('The source contains edited tracked files.');
  return { sourceCommit: await git(['rev-parse', 'HEAD']), sourceTree: await git(['rev-parse', 'HEAD^{tree}']) };
}

/** Follow the configured remote branch; no release, tag or commit is selected. */
export async function checkoutSource(directory, source) {
  if (typeof source.repository !== 'string' || typeof source.ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(source.ref)) throw new Error('Invalid Linkspan source branch.');
  await mkdir(directory, { recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(directory)).toLowerCase() !== resolve(directory).toLowerCase()) throw new Error('The source cache must be a canonical directory.');
  const git = args => run('git', ['-c', 'core.logAllRefUpdates=false', ...args], directory);
  const initialized = await lstat(join(directory, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!initialized) {
    await git(['init', '--quiet']);
    await git(['remote', 'add', 'origin', source.repository]);
  } else {
    if (await git(['remote', 'get-url', 'origin']) !== source.repository) throw new Error('The source cache belongs to another remote.');
    if (await git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('The source cache contains edited tracked files.');
  }
  await git(['fetch', '--quiet', '--depth=1', 'origin', `refs/heads/${source.ref}`]);
  await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  return { sourceCommit: await git(['rev-parse', 'HEAD']), sourceTree: await git(['rev-parse', 'HEAD^{tree}']) };
}

export async function verifySourcePackages(directory, identity) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.sourceCommit !== identity.sourceCommit || manifest.sourceTree !== identity.sourceTree
    || !Array.isArray(manifest.packages) || manifest.packages.length < 1 || manifest.packages.length > 128) throw new Error('The prepared packages do not match the selected source.');
  const names = new Set();
  for (const item of manifest.packages) {
    if (!/^@jokoagent\/linkspan-[a-z-]+$/.test(item.name) || item.directory !== item.name.slice('@jokoagent/linkspan-'.length) || names.has(item.name)) throw new Error('Invalid source package directory.');
    names.add(item.name);
    const path = join(directory, item.directory), info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('A source package must be a regular directory.');
    const receipt = JSON.parse(await readFile(join(path, 'dist', 'source-build.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
    if (pkg.name !== item.name || receipt.name !== item.name || receipt.sourceCommit !== identity.sourceCommit || receipt.sourceTree !== identity.sourceTree) throw new Error('A source package receipt differs from the selected source.');
  }
  return manifest;
}

export async function refreshSourceDependencies(root, pnpm) {
  await pnpm(['update', '--recursive', '--no-save', '@jokoagent/linkspan-*'], root);
  // Selected updates can leave optional peers in a partial importer context.
  // Resolve the declared workspace graph exactly as the lockfile workflow does,
  // without running lifecycle effects or discarding any source changes.
  await pnpm(['install', '--lockfile-only', '--ignore-scripts'], root);
}

export async function prepareLinkspan(root = repositoryRoot, { sourceDirectory } = {}) {
  const source = JSON.parse(await readFile(join(root, 'linkspan.json'), 'utf8'));
  const runtime = join(root, '.runtime');
  await mkdir(runtime, { recursive: true });
  if (resolve(await realpath(runtime)).toLowerCase() !== resolve(runtime).toLowerCase()) throw new Error('The build cache must not be linked.');
  const checkout = sourceDirectory ? resolve(root, sourceDirectory) : join(runtime, 'linkspan-source');
  const packages = join(runtime, 'linkspan-packages');
  const identity = sourceDirectory ? await inspectSource(checkout) : await checkoutSource(checkout, source);
  const manager = await pnpmInvocation();
  const pnpm = (args, cwd) => run(manager.executable, [...manager.arguments, ...args], cwd);
  let prepared;
  try { prepared = await verifySourcePackages(packages, identity); } catch { /* Rebuild the selected remote source. */ }
  if (!prepared) {
    await pnpm(['install', '--frozen-lockfile'], checkout);
    const next = await mkdtemp(join(runtime, 'linkspan-packages-next-'));
    await pnpm(['build:consumers', next], checkout);
    prepared = await verifySourcePackages(next, identity);
    const prior = await lstat(packages).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (prior) {
      if (!prior.isDirectory() || prior.isSymbolicLink() || resolve(await realpath(packages)).toLowerCase() !== resolve(packages).toLowerCase()) throw new Error('The package cache must be a canonical directory.');
      const suffix = relative(runtime, packages);
      if (suffix !== 'linkspan-packages' || isAbsolute(suffix)) throw new Error('Unsafe package cache target.');
      await rm(packages, { recursive: true });
    }
    await rename(next, packages);
  }
  // Only these source dependencies are re-resolved. The other dependency
  // requirements remain those of the workspace and its ordinary lockfile.
  await refreshSourceDependencies(root, pnpm);
  await writeFile(join(runtime, 'linkspan-source.json'), JSON.stringify({ directory: checkout }, null, 2) + '\n');
  console.log(`Prepared Linkspan from ${sourceDirectory ? checkout : `remote ${source.ref}`} (${identity.sourceCommit}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'source-directory': { type: 'string' } } });
  await prepareLinkspan(repositoryRoot, { sourceDirectory: values['source-directory'] });
}
