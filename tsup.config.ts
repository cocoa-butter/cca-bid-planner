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
    // Declarations come from tsc (tsconfig.build.json): TypeScript 7 has no compiler API for rollup-plugin-dts.
    dts: false,
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
