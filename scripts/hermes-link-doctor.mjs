#!/usr/bin/env node
// scripts/hermes-link-doctor.mjs
//
// Repo-local entry point. The implementation now lives INSIDE the npm package
// (packages/dsh-hermes-link/bin/hermes-link-doctor.mjs, exposed as the
// `hermes-link-doctor` bin since v0.6.1) so that npm users get it too. This
// wrapper keeps the historical repo path working for docs, muscle memory and
// the CI chain; arguments, cwd and the exit code pass straight through.
await import(new URL('../packages/dsh-hermes-link/bin/hermes-link-doctor.mjs', import.meta.url).href)
