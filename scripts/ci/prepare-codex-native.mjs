import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { LocalCodexRuntime, LOCAL_CODEX_RUNTIME_ASSETS, LOCAL_CODEX_RUNTIME_VERSION } from '../../apps/orchestrator/dist/local-codex-runtime.js';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) {
  throw new Error('Native Codex preparation requires the Actions runner and its environment file.');
}
const temporary = await realpath(process.env.RUNNER_TEMP);
const logs = join(temporary, 'joko-ci-logs');
await mkdir(logs, { recursive: true });
const platform = `${process.platform}-${process.arch}`;
const asset = LOCAL_CODEX_RUNTIME_ASSETS[platform];
if (!asset) throw new Error(`No pinned complete Codex package for ${platform}.`);
const root = await realpath(await mkdtemp(join(temporary, 'joko-codex-native-')));
const runtimeRoot = join(root, 'runtime');
const generation = 1;
let adopted = false;
const runtime = new LocalCodexRuntime({ rootDirectory: runtimeRoot, backendId: 'ci-codex',
  currentGeneration: () => generation,
  adopt: async expected => {
    if (expected !== generation) throw new Error('The CI runtime owner changed.');
    adopted = true;
  },
  fetch: async (input, options) => {
    console.log(`Downloading pinned complete package: ${String(input)}`);
    try {
      const response = await fetch(input, options);
      console.log(`Download response: status=${response.status} content-length=${response.headers.get('content-length') ?? 'unknown'}`);
      return response;
    } catch (error) {
      console.error('Pinned runtime download failed:', error);
      throw error;
    }
  }
});
console.log(JSON.stringify({ version: LOCAL_CODEX_RUNTIME_VERSION, platform, asset, root }));
let lastState, lastBytes = -1;
try {
  for await (const event of runtime.install({ requestId: 'ci-native-codex', backendId: 'ci-codex', expectedGeneration: generation, repair: false })) {
    const snapshot = event.runtime;
    if (snapshot.state !== lastState || snapshot.receivedBytes - lastBytes >= 8 * 1024 * 1024 || snapshot.receivedBytes === snapshot.totalBytes) {
      console.log(JSON.stringify({ sequence: String(event.sequence), ...snapshot }));
      lastBytes = snapshot.receivedBytes;
    }
    lastState = snapshot.state;
  }
  if (lastState !== 'complete' || !adopted) throw new Error(`The pinned complete runtime was not installed: ${lastState ?? 'no terminal state'}.`);
  // These product entry points revalidate the pinned manifest, every file digest/size,
  // the installation receipt, and the exact executable --version before CI opts in.
  const probe = await runtime.probe('ci-codex');
  if (probe.state !== 'ready' || probe.installedVersion !== LOCAL_CODEX_RUNTIME_VERSION) throw new Error('The installed complete runtime failed its product probe.');
  const executable = await runtime.resolveExecutable();
  if (!executable || /[\r\n]/u.test(executable)) throw new Error('The verified runtime executable is unavailable.');
  const within = relative(root, await realpath(executable));
  const info = await lstat(executable);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || !info.isFile() || info.isSymbolicLink()) {
    throw new Error('The native CI executable escaped its isolated installation.');
  }
  const receipt = JSON.parse(await readFile(join(runtimeRoot, 'current.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(runtimeRoot, receipt.directory, 'codex-package.json'), 'utf8'));
  const files = JSON.parse(await readFile(join(runtimeRoot, receipt.directory, '.joko-package.json'), 'utf8'));
  await writeFile(join(logs, 'codex-native-receipt.json'), JSON.stringify({ platform, asset, receipt, manifest, verifiedFiles: files.length, probe, executable }, null, 2));
  await appendFile(process.env.GITHUB_ENV, `JOKO_CODEX_HOSTED_TEST_BINARY=${executable}\n`);
  console.log(`Native tests enabled with verified complete Codex ${LOCAL_CODEX_RUNTIME_VERSION}: ${executable}`);
} catch (error) {
  console.error(`Native Codex preparation failed; isolated installation retained at ${root}.`, error);
  throw error;
} finally {
  await runtime.close();
}
