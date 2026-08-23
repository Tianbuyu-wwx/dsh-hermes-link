#!/usr/bin/env node
// scripts/version-bump.mjs
// Local emergency version bump (bypass changesets when needed):
//   node scripts/version-bump.mjs 0.2.5
//
// Updates VERSION constants in index.mjs + http/dispatch.mjs and
// packages/hermes-link/package.json. Run from repo root.
//
// Normal workflow: use changesets (`pnpm changeset`), then
// `pnpm changeset version` before publishing. This script exists for
// hotfix situations where a tiny emergency patch needs to ship without
// the full changesets ceremony.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(next)) {
  console.error('Usage: node scripts/version-bump.mjs <semver>');
  console.error('Example: node scripts/version-bump.mjs 0.2.5');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const pkgPath = resolve(root, 'packages/hermes-link/package.json');
const indexPath = resolve(root, 'packages/hermes-link/index.mjs');
const dispatchPath = resolve(root, 'packages/hermes-link/http/dispatch.mjs');

function bumpFile(p, replacer) {
  const before = readFileSync(p, 'utf8');
  const after = replacer(before);
  if (before === after) {
    console.warn(`  (no change) ${p}`);
    return;
  }
  writeFileSync(p, after);
  console.log(`  bumped ${p}`);
}

// package.json
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`  bumped ${pkgPath}`);

// index.mjs + http/dispatch.mjs VERSION constant
const bumpVersionConst = (s) => s.replace(/(const VERSION\s*=\s*['"])\d+\.\d+\.\d+(?:[-+][^'"]*)?(['"])/, `$1${next}$2`);
bumpFile(indexPath, bumpVersionConst);
bumpFile(dispatchPath, bumpVersionConst);

console.log(`\nDone. Now run: git add -A && git commit -m "v${next} bump" && git tag v${next}`);