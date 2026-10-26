import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/** Retain upstream runtime notices with each explicitly integrated backend. */
export function linkspanAssetsPlugin(): Plugin {
  const require = createRequire(import.meta.url);
  return { name: 'joko-linkspan-runtime-notices', apply: 'build',
    async generateBundle(_options, bundle) {
      for (const kind of ['iroh', 'tailcat']) {
        const runtime = dirname(require.resolve(`@jokoagent/linkspan-${kind}-wasm`));
        const source = await readFile(join(runtime, 'runtime/THIRD_PARTY_NOTICES.txt'));
        if (source.byteLength < 1 || source.byteLength > 4_194_304) throw new Error('The selected Linkspan runtime notices are invalid.');
        this.emitFile({ type: 'asset', fileName: `linkspan/${kind}/THIRD_PARTY_NOTICES.txt`, source });
      }
      const closure = (roots: readonly string[]): string[] => {
        const seen = new Set<string>();
        const visit = (name: string): void => {
          if (seen.has(name)) return;
          seen.add(name);
          const value = bundle[name];
          if (value?.type === 'chunk') for (const dependency of value.imports) visit(dependency);
        };
        for (const name of roots) visit(name);
        return [...seen];
      };
      const containsBackend = (name: string, kind?: string): boolean => {
        const value = bundle[name];
        return value?.type === 'chunk' && Object.keys(value.modules).some(module => {
          const path = module.replace(/\\/gu, '/');
          return kind === undefined ? /@jokoagent\/linkspan-(iroh|tailcat)(?:-[^/]+)?\//u.test(path)
            : new RegExp(`@jokoagent/linkspan-${kind}(?:-[^/]+)?/`, 'u').test(path);
        });
      };
      const entries = Object.entries(bundle).filter(([, value]) => value.type === 'chunk' && value.isEntry).map(([name]) => name);
      const initialSdkChunks = closure(entries).filter(name => {
        const value = bundle[name];
        return value?.type === 'chunk' && Object.keys(value.modules).some(module => module.replace(/\\/gu, '/').includes('@jokoagent/linkspan-'));
      });
      if (initialSdkChunks.length > 0) {
        for (const name of initialSdkChunks) {
          const chunk = bundle[name];
          if (chunk?.type === 'chunk') this.warn(`${name}: ${Object.keys(chunk.modules).filter(module => !module.replace(/\\/gu, '/').includes('@jokoagent/linkspan-')).join(', ')}`);
        }
        throw new Error(`An unselected Linkspan runtime entered the initial Web module/preload graph: ${initialSdkChunks.join(', ')}.`);
      }
      for (const kind of ['iroh', 'tailcat']) {
        const opposite = kind === 'iroh' ? 'tailcat' : 'iroh';
        const selected = Object.keys(bundle).filter(name => containsBackend(name, kind));
        if (closure(selected).some(name => containsBackend(name, opposite))) throw new Error('One selected Linkspan SDK statically loads the other backend.');
      }
    }
  };
}
