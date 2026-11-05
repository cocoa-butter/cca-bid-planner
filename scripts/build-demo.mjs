#!/usr/bin/env node
// Copy the demo page next to the browser bundle that tsup wrote to dist/demo/.
import { copyFileSync, existsSync } from 'node:fs';

const out = new URL('../dist/demo/', import.meta.url);
if (!existsSync(new URL('planner.js', out))) {
  console.error('dist/demo/planner.js missing: run tsup first');
  process.exit(1);
}
copyFileSync(new URL('../src/ui/index.html', import.meta.url), new URL('index.html', out));
console.log('demo: dist/demo/index.html');
