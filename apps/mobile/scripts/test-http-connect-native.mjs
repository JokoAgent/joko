import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('The selected Network.framework engine check requires macOS.');
const directory = mkdtempSync(join(tmpdir(), 'joko-native-proxy-'));
try {
  const executable = join(directory, 'native-proxy-check');
  execFileSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library',
    fileURLToPath(new URL('../modules/joko-linkspan-http-connect/ios/selected/LinkspanHttpConnectEngine.swift', import.meta.url)),
    fileURLToPath(new URL('./fixtures/http-connect-native.swift', import.meta.url)), '-o', executable], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(executable, [], { stdio: 'inherit', timeout: 60_000 });
} finally { rmSync(directory, { recursive: true, force: true }); }
