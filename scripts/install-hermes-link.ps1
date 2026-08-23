# install-hermes-link.ps1
#
# Installs the hermes-link plugin into the current user's dsh profile and
# patches Hermes Agent's config.yaml so its mcp_servers.dsh-bridge URL points
# at the new path (/mcp/collab). Idempotent: safe to re-run.
#
# Side effects (in order):
#   1. Unlinks old hermes-* node_modules in $DSH_HOME/profiles/web/node_modules
#   2. Junctions hermes-link → $DSH_HOME/profiles/web/node_modules/hermes-link
#   3. Edits package.json: drops old entries from dependencies + bundles,
#      adds hermes-link via `link:...`
#   4. Edits cordis.patch.yml: keeps old entries (disabled), adds enabled row
#      for hermes-link
#   5. Edits Hermes config.yaml: /mcp/dispatch → /mcp/collab (timestamped backup)
#   6. Runs smoke-test.mjs + verify-install.mjs

[CmdletBinding()]
param(
  [string]$DSHProfile = (Join-Path $env:USERPROFILE '.dsh\profiles\web'),
  [string]$HermesHome = $null,
  [string]$Workspace  = $null,
  [switch]$SkipHermesConfig,
  [switch]$KeepOldPlugins,
  [switch]$NoTest
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
  } else {
    $HermesHome = (Join-Path $env:USERPROFILE 'AppData\Local\hermes')
  }
}

$HermesLinkSrc = Join-Path $Workspace 'packages\hermes-link'
$HermesLinkDst = Join-Path $DSHProfile 'node_modules\hermes-link'
$OldPlugins    = @('hermes-foundation','hermes-oneshot-arbitrate','hermes-dispatch-bridge','hermes-dsh-collab')

Write-Host "=== hermes-link install ==="
Write-Host "  workspace   : $Workspace"
Write-Host "  DSH profile : $DSHProfile"
Write-Host "  Hermes home : $HermesHome"
Write-Host "  source      : $HermesLinkSrc"

# ----- Sanity ------------------------------------------------------------------
if (-not (Test-Path $HermesLinkSrc)) {
  throw "hermes-link source not found: $HermesLinkSrc"
}
if (-not (Test-Path $HermesLinkSrc 'cordis.patch.yml')) {
  throw "missing cordis.patch.yml in $HermesLinkSrc"
}
if (-not (Test-Path $DSHProfile)) {
  throw "DSH profile not found: $DSHProfile (run 'dsh --profile web' once to bootstrap)"
}

# ----- 1. Unlink old plugins ---------------------------------------------------
if (-not $KeepOldPlugins) {
  Write-Host "`n--- 1. Unlinking old hermes-* plugins ---"
  foreach ($pkg in $OldPlugins) {
    $dst = Join-Path $DSHProfile "node_modules\$pkg"
    if (Test-Path $dst) {
      Write-Host "  - unlink: $dst"
      try {
        Remove-Item -Path $dst -Recurse -Force -ErrorAction Stop
      } catch {
        Write-Warning "    failed to remove $dst : $($_.Exception.Message)"
      }
    }
  }
}

# ----- 2. Symlink hermes-link --------------------------------------------------
Write-Host "`n--- 2. Symlinking hermes-link ---"
if (Test-Path $HermesLinkDst) {
  Write-Host "  - removing existing: $HermesLinkDst"
  try { Remove-Item -Path $HermesLinkDst -Recurse -Force -ErrorAction Stop }
  catch { Write-Warning "    could not remove existing $HermesLinkDst : $($_.Exception.Message)" }
}
Write-Host "  + junction $HermesLinkDst -> $HermesLinkSrc"
New-Item -ItemType Junction -Path $HermesLinkDst -Target $HermesLinkSrc | Out-Null

# ----- 3. Edit package.json ----------------------------------------------------
Write-Host "`n--- 3. Editing package.json ---"
$PkgJsonPath = Join-Path $DSHProfile 'package.json'
if (-not (Test-Path $PkgJsonPath)) {
  throw "package.json not found at $PkgJsonPath"
}
$PkgJsonRaw = Get-Content -Path $PkgJsonPath -Raw -Encoding UTF8
$PkgJson    = $PkgJsonRaw | ConvertFrom-Json

# Ensure dependencies object
if (-not $PkgJson.dependencies) {
  $PkgJson | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue ([pscustomobject]@{}) -Force
}

# Drop old
$removedDeps = @()
foreach ($pkg in $OldPlugins) {
  $names = @($PkgJson.dependencies.PSObject.Properties.Name)
  if ($names -contains $pkg) {
    $PkgJson.dependencies.PSObject.Properties.Remove($pkg)
    $removedDeps += $pkg
  }
}
if ($removedDeps.Count -gt 0) {
  Write-Host "  - dependencies: removed $($removedDeps -join ', ')"
}

# Add new
$linkRel = 'link:' + ($HermesLinkSrc -replace '\\','/')
$names = @($PkgJson.dependencies.PSObject.Properties.Name)
if (-not ($names -contains 'hermes-link')) {
  $PkgJson.dependencies | Add-Member -NotePropertyName 'hermes-link' -NotePropertyValue $linkRel -Force
  Write-Host "  + dependencies: added hermes-link = $linkRel"
}

# Bundles
$bundles = $PkgJson.dsh.profile.bundles
$removedBundles = @()
for ($i = $bundles.Count - 1; $i -ge 0; $i--) {
  if ($OldPlugins -contains $bundles[$i]) {
    $removedBundles += $bundles[$i]
    $bundles.RemoveAt($i)
  }
}
if ($removedBundles.Count -gt 0) {
  Write-Host "  - bundles: removed $($removedBundles -join ', ')"
}
if (-not ($bundles -contains 'hermes-link')) {
  $bundles.Add('hermes-link')
  Write-Host "  + bundles: added hermes-link"
}

$PkgJsonRaw = $PkgJson | ConvertTo-Json -Depth 16
Set-Content -Path $PkgJsonPath -Value $PkgJsonRaw -Encoding UTF8
Write-Host "  written: $PkgJsonPath"

# ----- 4. Edit cordis.patch.yml ------------------------------------------------
Write-Host "`n--- 4. Editing cordis.patch.yml ---"
$CordisPatch = Join-Path $DSHProfile 'cordis.patch.yml'
$cpRaw = Get-Content -Path $CordisPatch -Raw -Encoding UTF8

# Ensure old rows are still disabled (idempotent — leave as-is if already correct)
foreach ($pkg in $OldPlugins) {
  $row = "- id: $pkg"
  if ($cpRaw -notmatch [regex]::Escape($row)) {
    $cpRaw = $cpRaw.TrimEnd() + "`n$row`n  disabled: true`n"
    Write-Host "  + cordis.patch.yml: added disabled row for $pkg"
  } elseif ($cpRaw -notmatch "(?ms)$([regex]::Escape($row)).*?disabled:\s*true") {
    $cpRaw = $cpRaw -replace [regex]::Escape($row), "$row`n  disabled: true"
    Write-Host "  ~ cordis.patch.yml: marked $pkg disabled"
  }
}

# Add hermes-link row (enabled)
if ($cpRaw -notmatch '^- id: hermes-link\s*$') {
  $cpRaw = $cpRaw.TrimEnd() + "`n- id: hermes-link`n  disabled: false`n"
  Write-Host "  + cordis.patch.yml: added enabled row for hermes-link"
} elseif ($cpRaw -notmatch "(?ms)- id: hermes-link.*?disabled:\s*false") {
  $cpRaw = $cpRaw -replace '(?ms)(- id: hermes-link.*?)disabled:\s*\w+', '$1disabled: false'
  Write-Host "  ~ cordis.patch.yml: enabled hermes-link"
}

Set-Content -Path $CordisPatch -Value $cpRaw -Encoding UTF8
Write-Host "  written: $CordisPatch"

# ----- 5. Edit Hermes config.yaml ---------------------------------------------
if (-not $SkipHermesConfig) {
  Write-Host "`n--- 5. Patching Hermes config.yaml ---"
  $HermesConfig = Join-Path $HermesHome 'config.yaml'
  if (Test-Path $HermesConfig) {
    $hcRaw = Get-Content -Path $HermesConfig -Raw -Encoding UTF8
    $oldUrl = 'http://127.0.0.1:3080/mcp/dispatch'
    $newUrl = 'http://127.0.0.1:3080/mcp/collab'
    if ($hcRaw.Contains($oldUrl)) {
      $bak = "$HermesConfig.bak.hermes-link.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Copy-Item -Path $HermesConfig -Destination $bak
      $hcNew = $hcRaw -replace [regex]::Escape($oldUrl), $newUrl
      Set-Content -Path $HermesConfig -Value $hcNew -Encoding UTF8
      Write-Host "  + Hermes config.yaml: $oldUrl -> $newUrl"
      Write-Host "    backup: $bak"
    } elseif ($hcRaw.Contains($newUrl)) {
      Write-Host "  - Hermes config.yaml already points to $newUrl; no change"
    } else {
      Write-Host "  - Hermes config.yaml has no /mcp/dispatch or /mcp/collab reference; skip"
    }
  } else {
    Write-Host "  ! Hermes config.yaml not found at $HermesConfig ; skipping (Hermes may not be installed)"
  }
}

# ----- 6. Install hermes-imported agent preset --------------------------------
Write-Host "`n--- 6. Installing hermes-imported agent preset ---"
$PresetDstRoot = Join-Path $env:USERPROFILE '.dsh\.agent-presets'
$PresetDst = Join-Path $PresetDstRoot 'hermes-imported'
$PresetSrcStandard = Join-Path $DSHProfile 'node_modules\@deepseek-ai\dsh\config\agent-presets\standard'
# find the shipped standard preset wherever npx cache puts the dsh package
if (-not (Test-Path $PresetSrcStandard)) {
  $npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  if (Test-Path $npxRoot) {
    $found = Get-ChildItem $npxRoot -Recurse -Depth 4 -Directory -Filter 'standard' -ErrorAction SilentlyContinue |
             Where-Object { Test-Path (Join-Path $_.FullName 'agent.cordis.yml') } |
             Select-Object -First 1
    if ($found) { $PresetSrcStandard = $found.FullName }
  }
}
if (Test-Path $PresetSrcStandard) {
  if (-not (Test-Path $PresetDst)) {
    New-Item -ItemType Directory -Path $PresetDst -Force | Out-Null
    Copy-Item -Path (Join-Path $PresetSrcStandard 'agent.cordis.yml') -Destination (Join-Path $PresetDst 'agent.cordis.yml') -Force
    Copy-Item -Path (Join-Path $PresetSrcStandard 'preset.yml') -Destination (Join-Path $PresetDst 'preset.yml') -Force
    Write-Host "  + hermes-imported preset created (copied from standard)"
  } else {
    Write-Host "  - hermes-imported preset already exists"
  }
} else {
  Write-Host "  ! standard preset source not found; hermes-imported preset NOT installed (imported sessions will fail to resume)"
}

# ----- 7. Test -----------------------------------------------------------------
if (-not $NoTest) {
  Write-Host "`n--- 7. Smoke + verify ---"
  & node (Join-Path $Workspace 'scripts\smoke-test.mjs')
  if ($LASTEXITCODE -ne 0) { Write-Warning "smoke-test.mjs reported issues (exit $LASTEXITCODE)" }
  & node (Join-Path $Workspace 'scripts\verify-install.mjs')
  if ($LASTEXITCODE -ne 0) { Write-Warning "verify-install.mjs reported issues (exit $LASTEXITCODE)" }
}

Write-Host ""
Write-Host "=== install complete ==="
Write-Host "  symlink   : $HermesLinkDst"
Write-Host "  DSH route : POST http://127.0.0.1:3080/mcp/collab (and /mcp/collab/health, sessions, import, persona, consult)"
Write-Host "  Hermes    : config.yaml now points to /mcp/collab"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart dsh web session (close + reopen) to pick up the new plugin."
Write-Host "  2. Sanity:  curl http://127.0.0.1:3080/mcp/collab/health"
Write-Host "  3. List Hermes sessions:  curl 'http://127.0.0.1:3080/mcp/collab/sessions?limit=10'"
Write-Host "  4. Import one as live session:  curl -X POST http://127.0.0.1:3080/mcp/collab/import -d '{\"hermesSessionId\":\"<sid>\"}'"