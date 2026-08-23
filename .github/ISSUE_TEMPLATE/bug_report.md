---
name: 🐛 Bug Report
about: Report incorrect behavior in hermes-link
title: "[bug] "
labels: ["bug"]
assignees: []
---

## What happened

<!-- A short summary of the bug. -->

## Reproduction steps

<!-- Minimal steps to reproduce. -->

1. `dsh plugin --profile web add @Tianbuyu-wwx/hermes-link`
2. Restart `dsh web`
3. ...
4. ...

## Expected behavior

<!-- What you expected to happen. -->

## Actual behavior

<!-- What actually happened, including any error messages verbatim. -->

## Environment

- hermes-link version (`dsh plugin list` or `npm ls @Tianbuyu-wwx/hermes-link`):
- DSH version (`dsh --version`):
- Hermes version (if applicable, from `%LOCALAPPDATA%\hermes\state.db` query or `hermes --version`):
- Node version (`node --version`):
- OS / architecture (`node -p "process.platform + ' ' + process.arch"`):
- `HERMES_LINK_TOKEN` set? (yes / no)
- `HERMES_LINK_TRUST_LEGACY` set? (yes / no)

## Logs / output

<!-- Paste relevant log lines. For DSH, you can usually grab them with `dsh web > dsh.log 2>&1`. -->
<!-- For Hermes, see `~/.local/share/hermes/logs/` or `%LOCALAPPDATA%\hermes\logs\`. -->

## Context

<!-- Anything else that might help: dshmarket install vs npm install vs git install, profile name, sandbox mode, etc. -->

<!--
SECURITY NOTE: If your bug report involves exposed secrets (api keys, tokens,
passwords), REDACT them before pasting. Use [SECURITY.md](../SECURITY.md) for
real security issues, not public issues.
-->