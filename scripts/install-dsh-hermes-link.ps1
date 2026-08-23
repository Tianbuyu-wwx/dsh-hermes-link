# install-dsh-hermes-link.ps1
#
# Installs the dsh-hermes-link plugin into the current user's dsh profile and
# patches Hermes Agent's config.yaml so its mcp_servers.dsh-bridge URL points
# at the new path (/mcp/collab). Idempotent: safe to re-run.
#
# Side effects (in order):
#   1. Migrates legacy data directory: ~/.dsh/hermes-link/ → ~/.dsh/dsh-hermes-link/
#   2. Unlinks old hermes-* node_modules in $DSH_HOME/profiles/web/node_modules
#      (including the legacy "hermes-link" cordis id from v0.2.4)
#   3. Junctions dsh-hermes-link → $DSH_HOME/profiles/web/node_modules/dsh-hermes-link
#   4. Edits profile package.json: drops old entries from dependencies + bundles,
#      adds dsh-hermes-link via `link:...`
#   5. Edits profile cordis.patch.yml: keeps old entries (disabled), adds enabled
#      row for dsh-hermes-link. Legacy "hermes-link" row from v0.2.4 is also
#      marked disabled (with a comment) so DSH still boots cleanly.
#   6. Edits Hermes config.yaml: /mcp/dispatch → /mcp/collab (timestamped backup)
#   7. Installs the hermes-imported agent preset (copies from dsh's standard preset)
#   8. Runs smoke-test.mjs + verify-install.mjs
#
# Migration from v0.2.4 (the old "hermes-link" plugin id):
#   - The legacy "hermes-link" id in cordis.patch.yml is auto-marked disabled
#     with a comment pointing at dsh-hermes-link (re-running the script on a
#     v0.2.4 install will migrate in place; re-installing after is idempotent).
#   - The legacy "~/.dsh/hermes-link/" data directory is auto-renamed to
#     "~/.dsh/dsh-hermes-link/". Run "pwsh -File scripts/migrate-hermes-link-data.ps1"
#     separately to do the same on machines where dsh-hermes-link is not yet installed.
#
# This is the v0.2.5+ install script. The legacy filename "install-hermes-link.ps1"
# is gone — if you have it in $PATH/scripts, please update your docs / CI.

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

$DshHermesLinkSrc = Join-Path $Workspace 'packages\dsh-hermes-link'
$DshHermesLinkDst = Join-Path $DSHProfile 'node_modules\dsh-hermes-link'
$DshHome          = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$LegacyDataDir    = Join-Path $DshHome 'hermes-link'
$NewDataDir       = Join-Path $DshHome 'dsh-hermes-link'
# LegacyPluginIds: cordis ids that were shipped before dsh-hermes-link was introduced.
# hermes-link itself is here because v0.2.4 used that id and we want auto-cleanup
# on upgrade (its cordis row gets disabled in patch step 5).
$LegacyPluginIds  = @('hermes-foundation','hermes-oneshot-arbitrate','hermes-dispatch-bridge','hermes-dsh-collab','hermes-link')

Write-Host "=== dsh-hermes-link install ==="
Write-Host "  workspace   : $Workspace"
Write-Host "  DSH profile : $DSHProfile"
Write-Host "  Hermes home : $HermesHome"
Write-Host "  source      : $DshHermesLinkSrc"
Write-Host "  data dir    : $NewDataDir (legacy: $LegacyDataDir)"

# ----- Sanity ------------------------------------------------------------------
if (-not (Test-Path $DshHermesLinkSrc)) {
  throw "dsh-hermes-link source not found: $DshHermesLinkSrc"
}
if (-not (Test-Path (Join-Path $DshHermesLinkSrc 'cordis.patch.yml'))) {
  throw "missing cordis.patch.yml in $DshHermesLinkSrc"
}
if (-not (Test-Path $DSHProfile)) {
  throw "DSH profile not found: $DSHProfile (run 'dsh --profile web' once to bootstrap)"
}

# ----- 1. Migrate legacy data directory ----------------------------------------
Write-Host "`n--- 1. Migrating legacy data directory ---"
if (Test-Path $LegacyDataDir) {
  if (Test-Path $NewDataDir) {
    Write-Host "  - both legacy and new data dirs exist; leaving legacy in place (manual merge needed)"
  } else {
    try {
      Rename-Item -Path $LegacyDataDir -NewName 'dsh-hermes-link' -Force -ErrorAction Stop
      Write-Host "  + migrated: $LegacyDataDir -> $NewDataDir"
    } catch {
      Write-Warning "    failed to rename $LegacyDataDir : $($_.Exception.Message)"
      Write-Host ""
      Write-Host "    ! This usually means the DSH web process is currently running and holds open" -ForegroundColor Yellow
      Write-Host "      $LegacyDataDir\audit.jsonl. The rename is deferred." -ForegroundColor Yellow
      Write-Host "      Two safe options to finish the migration:" -ForegroundColor Yellow
      Write-Host "        (a) close dsh web, re-run this script." -ForegroundColor Yellow
      Write-Host "        (b) keep dsh web running, then later run:" -ForegroundColor Yellow
      Write-Host "            pwsh -File scripts/migrate-hermes-link-data.ps1" -ForegroundColor Yellow
      Write-Host "            (works without restart; deferred rename)." -ForegroundColor Yellow
      Write-Host ""
    }
  }
} else {
  Write-Host "  - no legacy data dir; nothing to migrate"
}

# ----- 2. Unlink legacy plugins ------------------------------------------------
if (-not $KeepOldPlugins) {
  Write-Host "`n--- 2. Unlinking legacy hermes-* plugins ---"
  foreach ($pkg in $LegacyPluginIds) {
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

# ----- 3. Symlink dsh-hermes-link ----------------------------------------------
Write-Host "`n--- 3. Symlinking dsh-hermes-link ---"
if (Test-Path $DshHermesLinkDst) {
  Write-Host "  - removing existing: $DshHermesLinkDst"
  try { Remove-Item -Path $DshHermesLinkDst -Recurse -Force -ErrorAction Stop }
  catch { Write-Warning "    could not remove existing $DshHermesLinkDst : $($_.Exception.Message)" }
}
Write-Host "  + junction $DshHermesLinkDst -> $DshHermesLinkSrc"
New-Item -ItemType Junction -Path $DshHermesLinkDst -Target $DshHermesLinkSrc | Out-Null

# ----- 4. Edit package.json ----------------------------------------------------
Write-Host "`n--- 4. Editing package.json ---"
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

# Drop legacy deps
$removedDeps = @()
foreach ($pkg in $LegacyPluginIds) {
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
$linkRel = 'link:' + ($DshHermesLinkSrc -replace '\\','/')
$names = @($PkgJson.dependencies.PSObject.Properties.Name)
if (-not ($names -contains 'dsh-hermes-link')) {
  $PkgJson.dependencies | Add-Member -NotePropertyName 'dsh-hermes-link' -NotePropertyValue $linkRel -Force
  Write-Host "  + dependencies: added dsh-hermes-link = $linkRel"
}

# Bundles
$bundles = [System.Collections.ArrayList]::new(@($PkgJson.dsh.profile.bundles))
$removedBundles = @()
for ($i = $bundles.Count - 1; $i -ge 0; $i--) {
  if ($LegacyPluginIds -contains $bundles[$i]) {
    $removedBundles += $bundles[$i]
    $bundles.RemoveAt($i)
  }
}
if ($removedBundles.Count -gt 0) {
  Write-Host "  - bundles: removed $($removedBundles -join ', ')"
}
if (-not ($bundles -contains 'dsh-hermes-link')) {
  [void]$bundles.Add('dsh-hermes-link')
  Write-Host "  + bundles: added dsh-hermes-link"
}
$PkgJson.dsh.profile.bundles = $bundles.ToArray([string])

$PkgJsonRaw = $PkgJson | ConvertTo-Json -Depth 16
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($PkgJsonPath, $PkgJsonRaw, $utf8NoBom)
Write-Host "  written: $PkgJsonPath"

# ----- 5. Edit cordis.patch.yml ------------------------------------------------
Write-Host "`n--- 5. Editing cordis.patch.yml ---"
$CordisPatch = Join-Path $DSHProfile 'cordis.patch.yml'
$cpRaw = Get-Content -Path $CordisPatch -Raw -Encoding UTF8

# Disable legacy "hermes-link" id with a comment so DSH still boots cleanly
# (this preserves it for audit/reference; DSH skips disabled rows).
# IMPORTANT: use a strict pattern that pins disabled:true to the LINE IMMEDIATELY
# FOLLOWING `- id: hermes-link`. The naive `(?ms)^\- id: hermes-link\b.*?disabled:\s*true`
# cross-row-scans to the NEXT `disabled: true` (often several rows down under a
# different id) and false-positives as "already disabled".
$legacyHermesLinkRow = '- id: hermes-link'
if ($cpRaw -match '(?ms)^\- id: hermes-link\s*\n\s*disabled:\s*true\s*(#.*)?$') {
  Write-Host "  - cordis.patch.yml: legacy hermes-link already disabled; skip"
} else {
  # Anchor the rewrite to the hermes-link block specifically, not the first
  # generic `disabled:` token that may belong to a different row.
  $cpRaw = [regex]::Replace(
    $cpRaw,
    '(?ms)(^\- id: hermes-link\s*\n\s*disabled:\s*)\w+',
    ('${1}true  # legacy v0.2.4 id, superseded by dsh-hermes-link'),
    1)
  Write-Host "  ~ cordis.patch.yml: marked legacy hermes-link disabled"
}

# Ensure other legacy rows are still disabled (idempotent — leave as-is if already correct)
foreach ($pkg in @('hermes-foundation','hermes-oneshot-arbitrate','hermes-dispatch-bridge','hermes-dsh-collab')) {
  $row = "- id: $pkg"
  if ($cpRaw -notmatch [regex]::Escape($row)) {
    $cpRaw = $cpRaw.TrimEnd() + "`n$row`n  disabled: true`n"
    Write-Host "  + cordis.patch.yml: added disabled row for $pkg"
  } elseif ($cpRaw -notmatch "(?ms)$([regex]::Escape($row)).*?disabled:\s*true") {
    $cpRaw = $cpRaw -replace [regex]::Escape($row), "$row`n  disabled: true"
    Write-Host "  ~ cordis.patch.yml: marked $pkg disabled"
  }
}

# Add dsh-hermes-link row (enabled)
# IMPORTANT: PowerShell's -notmatch defaults to SINGLE-LINE semantics for ^ and $,
# so without (?m) the `^` anchor never matches a row in the middle of the file
# and we'd add a fresh row on every run. Pin to (?ms).
if ($cpRaw -notmatch '(?ms)^\- id: dsh-hermes-link\s*$') {
  $cpRaw = $cpRaw.TrimEnd() + "`n- id: dsh-hermes-link`n  disabled: false`n"
  Write-Host "  + cordis.patch.yml: added enabled row for dsh-hermes-link"
} elseif ($cpRaw -notmatch '(?ms)^\- id: dsh-hermes-link\s*\n\s*disabled:\s*false\s*$') {
  $cpRaw = [regex]::Replace(
    $cpRaw,
    '(?ms)(^\- id: dsh-hermes-link\s*\n\s*disabled:\s*)\w+',
    '${1}false',
    1)
  Write-Host "  ~ cordis.patch.yml: enabled dsh-hermes-link"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($CordisPatch, $cpRaw, $utf8NoBom)
Write-Host "  written: $CordisPatch"

# ----- 6. Edit Hermes config.yaml ---------------------------------------------
if (-not $SkipHermesConfig) {
  Write-Host "`n--- 6. Patching Hermes config.yaml ---"
  $HermesConfig = Join-Path $HermesHome 'config.yaml'
  if (Test-Path $HermesConfig) {
    $hcRaw = Get-Content -Path $HermesConfig -Raw -Encoding UTF8
    $oldUrl = 'http://127.0.0.1:3080/mcp/dispatch'
    $newUrl = 'http://127.0.0.1:3080/mcp/collab'
    if ($hcRaw.Contains($oldUrl)) {
      $bak = "$HermesConfig.bak.dsh-hermes-link.$(Get-Date -Format 'yyyyMMdd-HHmmss')"
      Copy-Item -Path $HermesConfig -Destination $bak
      $hcNew = $hcRaw -replace [regex]::Escape($oldUrl), $newUrl
      $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($HermesConfig, $hcNew, $utf8NoBom)
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

# ----- 7. Install hermes-imported agent preset --------------------------------
Write-Host "`n--- 7. Installing hermes-imported agent preset ---"
$PresetDstRoot = Join-Path $env:USERPROFILE '.dsh\.agent-presets'
$PresetDst = Join-Path $PresetDstRoot 'hermes-imported'
$PresetSrcStandard = Join-Path $DSHProfile 'node_modules\@deepseek-ai\dsh\config\agent-presets\standard'
# find the shipped standard preset wherever npx cache puts the dsh package
if (-not (Test-Path $PresetSrcStandard)) {
  $npxRoot = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
  if (Test-Path $npxRoot) {
    $found = Get-ChildItem $npxRoot -Recurse -Depth 8 -Directory -Filter 'standard' -ErrorAction SilentlyContinue |
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

# ----- 8. Test -----------------------------------------------------------------
if (-not $NoTest) {
  Write-Host "`n--- 8. Smoke + verify ---"
  & node (Join-Path $Workspace 'scripts\smoke-test.mjs')
  if ($LASTEXITCODE -ne 0) { Write-Warning "smoke-test.mjs reported issues (exit $LASTEXITCODE)" }
  & node (Join-Path $Workspace 'scripts\verify-install.mjs')
  if ($LASTEXITCODE -ne 0) { Write-Warning "verify-install.mjs reported issues (exit $LASTEXITCODE)" }
}

Write-Host ""
Write-Host "=== install complete ==="
Write-Host "  symlink   : $DshHermesLinkDst"
Write-Host "  DSH route : POST http://127.0.0.1:3080/mcp/collab (and /mcp/collab/health, sessions, import, persona, consult)"
Write-Host "  Hermes    : config.yaml now points to /mcp/collab"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart dsh web session (close + reopen) to pick up the new plugin."
Write-Host "  2. Sanity:  curl http://127.0.0.1:3080/mcp/collab/health"
Write-Host "  3. List Hermes sessions:  curl 'http://127.0.0.1:3080/mcp/collab/sessions?limit=10'"
Write-Host "  4. Import one as live session:  curl -X POST http://127.0.0.1:3080/mcp/collab/import -d '{\"hermesSessionId\":\"<sid>\"}'"