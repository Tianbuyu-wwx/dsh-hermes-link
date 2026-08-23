# uninstall-all.ps1 — legacy-compat entry point (was: uninstall the old three
# hermes-* packages). Those are deprecated; the single plugin dsh-hermes-link is
# removed by this script now (delegates to uninstall-dsh-hermes-link.ps1).
#
# Usage: pwsh -File scripts/uninstall-all.ps1 [-Profile web]

[CmdletBinding()]
param(
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$uninstaller = Join-Path $scriptDir 'uninstall-dsh-hermes-link.ps1'

if (-not (Test-Path $uninstaller)) {
  throw "uninstall-dsh-hermes-link.ps1 not found next to uninstall-all.ps1"
}

Write-Host '[uninstall-all] legacy entry point — delegating to uninstall-dsh-hermes-link.ps1' -ForegroundColor Cyan

if ($Profile -ne 'web') {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  & $uninstaller -DSHProfile (Join-Path (Join-Path $dshHome 'profiles') $Profile)
} else {
  & $uninstaller
}

if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}