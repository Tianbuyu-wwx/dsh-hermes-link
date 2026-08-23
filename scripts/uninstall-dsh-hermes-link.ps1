# uninstall-dsh-hermes-link.ps1
#
# Reverses install-dsh-hermes-link.ps1:
#   1. Removes dsh-hermes-link node_modules symlink
#   2. Reverts profile package.json (drops dsh-hermes-link from dependencies + bundles)
#   3. Reverts profile cordis.patch.yml (drops dsh-hermes-link row; legacy
#      "hermes-link" row stays disabled in place)
#   4. Restores Hermes config.yaml from the most recent .bak.dsh-hermes-link.*
#      backup if one exists; otherwise leaves /mcp/collab reference alone.
#
# Idempotent. Keeps user data (~/.dsh/dsh-hermes-link/) untouched.
#
# This is the v0.2.5+ uninstall script. The legacy filename
# "uninstall-hermes-link.ps1" is gone — please update your docs / CI.

[CmdletBinding()]
param(
  [string]$DSHProfile = (Join-Path $env:USERPROFILE '.dsh\profiles\web'),
  [string]$HermesHome = $null,
  [string]$Workspace  = $null
)

$ErrorActionPreference = 'Stop'

if (-not $Workspace) {
  $Workspace = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
}
if (-not $HermesHome) {
  if ($env:HERMES_HOME -and (Test-Path $env:HERMES_HOME)) {
    $HermesHome = $env:HERMES_HOME
  } elseif ($env:LOCALAPPDATA) {
    $HermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
  }
}

$DshHermesLinkDst = Join-Path $DSHProfile 'node_modules\dsh-hermes-link'

Write-Host "=== dsh-hermes-link uninstall ==="
Write-Host "  DSH profile : $DSHProfile"
Write-Host "  Hermes home : $HermesHome"

# ----- 1. Remove symlink -------------------------------------------------------
Write-Host "`n--- 1. Removing dsh-hermes-link symlink ---"
if (Test-Path $DshHermesLinkDst) {
  Remove-Item -Path $DshHermesLinkDst -Recurse -Force
  Write-Host "  - removed: $DshHermesLinkDst"
} else {
  Write-Host "  - not present: $DshHermesLinkDst"
}

# ----- 2. Revert package.json --------------------------------------------------
Write-Host "`n--- 2. Reverting package.json ---"
$PkgJsonPath = Join-Path $DSHProfile 'package.json'
if (Test-Path $PkgJsonPath) {
  $PkgJson = Get-Content -Path $PkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $changed = $false
  if ($PkgJson.dependencies -and ($PkgJson.dependencies.PSObject.Properties.Name -contains 'dsh-hermes-link')) {
    $PkgJson.dependencies.PSObject.Properties.Remove('dsh-hermes-link')
    $changed = $true
    Write-Host "  - dependencies: removed dsh-hermes-link"
  }
  if ($PkgJson.dsh -and $PkgJson.dsh.profile -and $PkgJson.dsh.profile.bundles) {
    $bundles = $PkgJson.dsh.profile.bundles
    for ($i = $bundles.Count - 1; $i -ge 0; $i--) {
      if ($bundles[$i] -eq 'dsh-hermes-link') {
        $bundles.RemoveAt($i)
        $changed = $true
        Write-Host "  - bundles: removed dsh-hermes-link"
      }
    }
  }
  if ($changed) {
    Set-Content -Path $PkgJsonPath -Value ($PkgJson | ConvertTo-Json -Depth 16) -Encoding UTF8
    Write-Host "  written: $PkgJsonPath"
  } else {
    Write-Host "  - no dsh-hermes-link reference; skip"
  }
}

# ----- 3. Revert cordis.patch.yml ----------------------------------------------
Write-Host "`n--- 3. Reverting cordis.patch.yml ---"
$CordisPatch = Join-Path $DSHProfile 'cordis.patch.yml'
if (Test-Path $CordisPatch) {
  $cpRaw = Get-Content -Path $CordisPatch -Raw -Encoding UTF8
  if ($cpRaw -match '(?ms)^\- id: dsh-hermes-link\b.*?(?=^\- id:|\Z)') {
    $cpNew = [regex]::Replace($cpRaw, '(?ms)^\- id: dsh-hermes-link\b.*?(?=^\- id:|\Z)', '', 1)
    Set-Content -Path $CordisPatch -Value $cpNew -Encoding UTF8
    Write-Host "  - removed: - id: dsh-hermes-link block"
  } else {
    Write-Host "  - no dsh-hermes-link row; skip"
  }
  # Note: legacy "hermes-link" row (from v0.2.4, disabled) is intentionally
  # left in place. It is harmless while disabled and preserves audit trail.
}

# ----- 4. Restore Hermes config.yaml from backup -------------------------------
if ($HermesHome -and (Test-Path $HermesHome)) {
  Write-Host "`n--- 4. Restoring Hermes config.yaml ---"
  $HermesConfig = Join-Path $HermesHome 'config.yaml'
  if (Test-Path $HermesConfig) {
    $bak = Get-ChildItem -Path "$HermesConfig.bak.dsh-hermes-link.*" -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($bak) {
      Write-Host "  + restoring from: $($bak.FullName)"
      Copy-Item -Path $bak.FullName -Destination $HermesConfig -Force
      Write-Host "    config.yaml restored (backup left in place)"
    } else {
      Write-Host "  - no .bak.dsh-hermes-link.* found; leaving config.yaml alone"
      Write-Host "    (you may want to manually revert /mcp/collab -> /mcp/dispatch)"
    }
  } else {
    Write-Host "  - Hermes config.yaml not found; skip"
  }
}

Write-Host ""
Write-Host "=== uninstall complete ==="
Write-Host "  dsh-hermes-link removed from DSH profile; restart dsh to take effect."
Write-Host "  user data in ~/.dsh/dsh-hermes-link/ was preserved."