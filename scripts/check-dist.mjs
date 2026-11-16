// Fails the build if a wagmi-free entry reaches @wagmi/core through its static
// import graph (directly or via a shared chunk).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const WAGMI_FREE_ENTRIES = ['client', 'vue', 'server'];

function walk(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const specifier = match[1] ?? match[2];
    if (specifier.startsWith('.'))
      walk(resolve(dirname(file), specifier), seen);
    else seen.add(specifier);
  }
  return seen;
}

const failures = [];
for (const entry of WAGMI_FREE_ENTRIES) {
  const graph = walk(resolve('dist', `${entry}.js`));
  if ([...graph].some((item) => item.startsWith('@wagmi/'))) {
    failures.push(entry);
  }
}
if (failures.length > 0) {
  console.error(`dist entries import @wagmi/*: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(
  `dist check ok: ${WAGMI_FREE_ENTRIES.join(', ')} do not import @wagmi/*`,
);
