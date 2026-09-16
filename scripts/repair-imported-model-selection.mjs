#!/usr/bin/env node
// scripts/repair-imported-model-selection.mjs
//
// Repo-local entry point. The implementation now lives INSIDE the npm package
// (packages/dsh-hermes-link/bin/repair-imported-model-selection.mjs, exposed as
// the `hermes-link-repair-model-pins` bin since v0.6.1) so that npm users can
// repair their own imported sessions without cloning the repository. Arguments
// and the exit code pass straight through.
await import(new URL('../packages/dsh-hermes-link/bin/repair-imported-model-selection.mjs', import.meta.url).href)
