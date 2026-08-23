# migrate-hermes-link-data.ps1
#
# Standalone data migration: ~/.dsh/hermes-link/  →  ~/.dsh/dsh-hermes-link/
#
# Run this BEFORE installing dsh-hermes-link v0.2.5 if you want to pre-migrate
# the legacy audit.jsonl + continuables.sqlite state directories without going
# through install-dsh-hermes-link.ps1.
#
# Behavior:
#   - If the legacy directory exists and the new one does NOT, it is renamed
#     in place. Audit + continuables state are preserved.
#   - If both exist, NO rename happens — print a warning telling you to merge
#     manually.
#   - If neither exists, this is a no-op (fresh install path).
#   - If $DSH_HOME is set, it overrides the default ~/.dsh lookup.
#
# Idempotent. Safe to re-run after install-dsh-hermes-link.ps1 has already
# auto-migrated (it will just report "no legacy data dir" and exit cleanly).
#
# Related: install-dsh-hermes-link.ps1 step 1 does the same rename
# automatically; this script is for users who want to migrate BEFORE install.

[CmdletBinding()]
param(
  [string]$DSHHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$Force   # If both dirs exist, do the rename anyway (legacy is treated as canonical).
)

$ErrorActionPreference = 'Stop'

$LegacyDir = Join-Path $DSHHome 'hermes-link'
$NewDir    = Join-Path $DSHHome 'dsh-hermes-link'

Write-Host "=== dsh-hermes-link data migration ==="
Write-Host "  DSH home   : $DSHHome"
Write-Host "  legacy dir : $LegacyDir"
Write-Host "  new dir    : $NewDir"

if (-not (Test-Path $LegacyDir)) {
  Write-Host "`n--- No legacy data dir found. Nothing to migrate. ---"
  exit 0
}

if (Test-Path $NewDir) {
  if (-not $Force) {
    Write-Host ""
    Write-Host "  ! Both legacy and new data dirs exist." -ForegroundColor Yellow
    Write-Host "    $LegacyDir"
    Write-Host "    $NewDir"
    Write-Host "    Refusing to rename to avoid silent overwrite of new-state data."
    Write-Host "    Manually inspect + merge, then delete the legacy dir."
    Write-Host "    Re-run with -Force to treat legacy as canonical (advanced)."
    exit 2
  } else {
    Write-Host ""
    Write-Host "  ! -Force given: treating legacy as canonical; renaming despite collision."
    Write-Host "    Pre-existing new-dir contents will be moved aside as $NewDir.pre-migrate-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
    $aside = "$NewDir.pre-migrate-$((Get-Date).ToString('yyyyMMdd-HHmmss'))"
    Move-Item -Path $NewDir -Destination $aside -Force
    Write-Host "    moved aside → $aside"
  }
}

try {
  Rename-Item -Path $LegacyDir -NewName 'dsh-hermes-link' -Force -ErrorAction Stop
  Write-Host ""
  Write-Host "  + migrated: $LegacyDir -> $NewDir" -ForegroundColor Green
  Write-Host ""
  Write-Host "    audit.jsonl + continuables.sqlite preserved (no copy needed)."
  Write-Host ""
  Write-Host "Next step: run install-dsh-hermes-link.ps1 (it will see the new dir already in place)."
} catch {
  Write-Host ""
  Write-Host "  ! migration failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 3
}