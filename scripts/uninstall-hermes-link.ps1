# uninstall-hermes-link.ps1
#
# Reverses install-hermes-link.ps1:
#   1. Removes hermes-link node_modules symlink
#   2. Reverts package.json (drops hermes-link from dependencies + bundles)
#   3. Reverts cordis.patch.yml (drops hermes-link row)
#   4. Restores Hermes config.yaml from the most recent .bak.hermes-link.*
#      backup if one exists; otherwise leaves /mcp/collab reference alone.
#
# Idempotent. Keeps user data (~/.dsh/hermes-link/) untouched.

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

$HermesLinkDst = Join-Path $DSHProfile 'node_modules\hermes-link'

Write-Host "=== hermes-link uninstall ==="
Write-Host "  DSH profile : $DSHProfile"
Write-Host "  Hermes home : $HermesHome"

# ----- 1. Remove symlink -------------------------------------------------------
Write-Host "`n--- 1. Removing hermes-link symlink ---"
if (Test-Path $HermesLinkDst) {
  Remove-Item -Path $HermesLinkDst -Recurse -Force
  Write-Host "  - removed: $HermesLinkDst"
} else {
  Write-Host "  - not present: $HermesLinkDst"
}

# ----- 2. Revert package.json --------------------------------------------------
Write-Host "`n--- 2. Reverting package.json ---"
$PkgJsonPath = Join-Path $DSHProfile 'package.json'
if (Test-Path $PkgJsonPath) {
  $PkgJson = Get-Content -Path $PkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $changed = $false
  if ($PkgJson.dependencies -and ($PkgJson.dependencies.PSObject.Properties.Name -contains 'hermes-link')) {
    $PkgJson.dependencies.PSObject.Properties.Remove('hermes-link')
    $changed = $true
    Write-Host "  - dependencies: removed hermes-link"
  }
  if ($PkgJson.dsh -and $PkgJson.dsh.profile -and $PkgJson.dsh.profile.bundles) {
    $bundles = $PkgJson.dsh.profile.bundles
    for ($i = $bundles.Count - 1; $i -ge 0; $i--) {
      if ($bundles[$i] -eq 'hermes-link') {
        $bundles.RemoveAt($i)
        $changed = $true
        Write-Host "  - bundles: removed hermes-link"
      }
    }
  }
  if ($changed) {
    Set-Content -Path $PkgJsonPath -Value ($PkgJson | ConvertTo-Json -Depth 16) -Encoding UTF8
    Write-Host "  written: $PkgJsonPath"
  } else {
    Write-Host "  - no hermes-link reference; skip"
  }
}

# ----- 3. Revert cordis.patch.yml ----------------------------------------------
Write-Host "`n--- 3. Reverting cordis.patch.yml ---"
$CordisPatch = Join-Path $DSHProfile 'cordis.patch.yml'
if (Test-Path $CordisPatch) {
  $cpRaw = Get-Content -Path $CordisPatch -Raw -Encoding UTF8
  if ($cpRaw -match '(?ms)^\- id: hermes-link\b.*?(?=^\- id:|\Z)') {
    $cpNew = [regex]::Replace($cpRaw, '(?ms)^\- id: hermes-link\b.*?(?=^\- id:|\Z)', '', 1)
    Set-Content -Path $CordisPatch -Value $cpNew -Encoding UTF8
    Write-Host "  - removed: - id: hermes-link block"
  } else {
    Write-Host "  - no hermes-link row; skip"
  }
}

# ----- 4. Restore Hermes config.yaml from backup -------------------------------
if ($HermesHome -and (Test-Path $HermesHome)) {
  Write-Host "`n--- 4. Restoring Hermes config.yaml ---"
  $HermesConfig = Join-Path $HermesHome 'config.yaml'
  if (Test-Path $HermesConfig) {
    $bak = Get-ChildItem -Path "$HermesConfig.bak.hermes-link.*" -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($bak) {
      Write-Host "  + restoring from: $($bak.FullName)"
      Copy-Item -Path $bak.FullName -Destination $HermesConfig -Force
      Write-Host "    config.yaml restored (backup left in place)"
    } else {
      Write-Host "  - no .bak.hermes-link.* found; leaving config.yaml alone"
      Write-Host "    (you may want to manually revert /mcp/collab -> /mcp/dispatch)"
    }
  } else {
    Write-Host "  - Hermes config.yaml not found; skip"
  }
}

Write-Host ""
Write-Host "=== uninstall complete ==="
Write-Host "  hermes-link removed from DSH profile; restart dsh to take effect."
Write-Host "  user data in ~/.dsh/hermes-link/ was preserved."