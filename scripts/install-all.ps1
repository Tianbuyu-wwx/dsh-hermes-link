# install-all.ps1 — legacy-compat entry point (was: install the old three
# hermes-foundation / hermes-oneshot-arbitrate / hermes-dispatch-bridge
# packages). Those packages are deprecated and removed; the single replacement
# plugin is hermes-link. This script now just delegates to the real installer.
#
# Usage: pwsh -File scripts/install-all.ps1 [-Profile web]

[CmdletBinding()]
param(
  [string]$Profile = 'web'
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $scriptDir 'install-dsh-hermes-link.ps1'

if (-not (Test-Path $installer)) {
  throw "install-dsh-hermes-link.ps1 not found next to install-all.ps1"
}

Write-Host '[install-all] legacy entry point — delegating to install-dsh-hermes-link.ps1' -ForegroundColor Cyan
Write-Host '[install-all] (hermes-foundation / -oneshot-arbitrate / -dispatch-bridge were consolidated into dsh-hermes-link)' -ForegroundColor DarkGray

if ($Profile -ne 'web') {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  & $installer -DSHProfile (Join-Path (Join-Path $dshHome 'profiles') $Profile)
} else {
  & $installer
}

if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
  exit $LASTEXITCODE
}