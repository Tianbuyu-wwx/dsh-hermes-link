# benchmark-prompt-size.ps1 — quick size comparison to show token savings.
#
# Hermes side  : `hermes prompt-size` reports the bytes of Hermes's
#                assembled system prompt + tool schemas right now.
# DSH side     : asks the live session "how big is your system prompt?"
#                (requires an LLM call; included as a manual step.)
#
# This script only runs the cheap part — the Hermes measurement. Use the
# returned number as a "what would have been shipped into DSH" baseline;
# compare to the L1 mirror slice = ~4KB hard cap.
[CmdletBinding()]
param(
  [string]$HermesExe = (Join-Path $env:LOCALAPPDATA 'hermes\hermes-agent\venv\Scripts\hermes.exe'),
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $HermesExe)) {
  throw "Hermes not found at $HermesExe; override with -HermesExe or set HERMES_EXE."
}

Write-Host "[benchmark] Hermes baseline (full system prompt + tool schemas):" -ForegroundColor Cyan
& $HermesExe prompt-size 2>&1 | Out-Host
Write-Host ""
Write-Host "[benchmark] L1 mirror slice hard cap: 4096 chars." -ForegroundColor Cyan
Write-Host "[benchmark] Compare the two numbers — that's the per-turn token delta." -ForegroundColor Cyan
