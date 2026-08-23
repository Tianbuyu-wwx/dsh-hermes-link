# purge-hermes-sessions.ps1
#
# Delete every hermes-* session directory from the DSH sessions store.
# Run BEFORE restarting DSH when you want to re-import Hermes sessions with
# new workspace/title logic:
#
#   pwsh -File scripts/purge-hermes-sessions.ps1
#   (restart DSH)
#   curl -X POST http://127.0.0.1:3080/mcp/collab/import-all
#
# Why purge is needed: sessions imported before the Hermes-workspace logic
# carried cwd=C:\Users\<user> and cannot be re-attached to the Hermes
# workspace (DSH requires session.header.cwd === workspace path). The clean
# path is delete + re-import.
#
# NOTE: this only removes the DURABLE copy. Live in-memory sessions in the
# running DSH process keep running until that process exits — hence "restart
# before re-import".

[CmdletBinding()]
param(
  [string]$DSHHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$SessionsRoot = $null
)

$ErrorActionPreference = 'Stop'

if (-not $SessionsRoot) {
  $SessionsRoot = Join-Path $DSHHome 'sessions'
}

$removed = 0
$failed  = 0

Write-Host "=== purge hermes-* sessions ==="
Write-Host "  root: $SessionsRoot"

# DSH stores sessions under <root>/<workspace-dir>/<session-id>/
# where <workspace-dir> is a munged cwd (e.g. --C-Users-Tianbuyu--).
Get-ChildItem $SessionsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $wsDir = $_.FullName
  Get-ChildItem $wsDir -Directory -Filter 'hermes-*' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  - rm: $($_.FullName)"
    try {
      Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction Stop
      $removed++
    } catch {
      Write-Warning "    failed: $($_.Exception.Message)"
      $failed++
    }
  }
}

Write-Host ""
Write-Host "removed: $removed  failed: $failed"
Write-Host ""
Write-Host "Next: restart DSH, then:"
Write-Host "  curl -X POST http://127.0.0.1:3080/mcp/collab/import-all"
Write-Host "  curl -X POST http://127.0.0.1:3080/mcp/collab/rename-all"