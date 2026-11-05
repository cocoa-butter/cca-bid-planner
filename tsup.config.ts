import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'core/index': 'src/core/index.ts',
      'cli/bin': 'src/cli/bin.ts',
    },
    format: ['esm'],
    target: 'node22',
    platform: 'node',
    dts: { entry: { index: 'src/index.ts', 'core/index': 'src/core/index.ts' } },
    sourcemap: true,
    clean: true,
    splitting: true,
  },
  {
    entry: { 'demo/planner': 'src/ui/entry.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    minify: true,
    sourcemap: false,
    noExternal: [/.*/],
  },
]);
