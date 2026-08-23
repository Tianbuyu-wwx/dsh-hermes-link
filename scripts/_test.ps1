# install-all.ps1 鈥?install hermes-mirror + hermes-bridge-oneshot into the
# active DSH profile. Default profile is "web"; pass -Profile to override.
#
# Mechanism:
#   1. Resolve this repo's root (where packages/ lives).
#   2. Resolve the DSH profile dir (~/.dsh/profiles/<name>).
#   3. For each package, ensure it is registered both in
#      <profile>/package.json#dependencies (link:<abs path>) and
#      <profile>/package.json#dsh.profile.bundles.
#   4. `pnpm install` inside <profile> so node_modules/hermes-* resolves.
#
# Why not `dsh plugin add`?
#   The CLI's argv parser rejects --profile in our environment. Editing the
#   package.json + running pnpm install achieves the same result with no
#   surprises and is exactly how dsh-obsidian and hermes-dsh-collab are wired.
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string[]]$Packages = @(
    'hermes-foundation',
    'hermes-oneshot-arbitrate',
    'hermes-dispatch-bridge'
  )
)

$ErrorActionPreference = 'Stop'

# This script's directory = <repo>/scripts
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$packagesDir = Join-Path $repoRoot 'packages'

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $Profile
$profilePkg = Join-Path $profileDir 'package.json'

if (-not (Test-Path $profilePkg)) {
  throw "DSH profile '$Profile' not found at $profilePkg"
}

Write-Host "[install-all] repo=$repoRoot  profile=$Profile  dir=$profileDir" -ForegroundColor Cyan

# Load profile package.json; mutate JSON in place to keep all other fields intact.
$pkg = Get-Content $profilePkg -Raw | ConvertFrom-Json

if (-not $pkg.dependencies) {
  # PowerShell converts missing fields to $null; create the hashtable separately.
  $pkg | Add-Member -NotePropertyName 'dependencies' -NotePropertyValue (@{})
}

if (-not $pkg.dsh)                            { $pkg | Add-Member -NotePropertyName 'dsh' -NotePropertyValue ([pscustomobject]@{}) }
if (-not $pkg.dsh.profile)                    { $pkg.dsh | Add-Member -NotePropertyName 'profile' -NotePropertyValue ([pscustomobject]@{}) }
if (-not $pkg.dsh.profile.bundles)            { $pkg.dsh.profile | Add-Member -NotePropertyName 'bundles' -NotePropertyValue (@()) }

foreach ($name in $Packages) {
  $pkgDir = Join-Path $packagesDir $name
  if (-not (Test-Path $pkgDir)) { throw "package dir missing: $pkgDir" }

  $linkSpec = 'link:' + (Resolve-Path $pkgDir).Path.Replace('\','/')
  Write-Host "[install-all] + $name @ $linkSpec" -ForegroundColor Green

  # Set / replace dependency entry.
  if (-not $pkg.dependencies.$name) {
    $pkg.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $linkSpec
  } else {
    $pkg.dependencies.$name = $linkSpec
  }

  # Add to bundles if absent (preserve order: append at end so it loads after the rest).
  $bundles = @($pkg.dsh.profile.bundles)
  if ($bundles -notcontains $name) {
    $bundles = $bundles + @($name)
    $pkg.dsh.profile.bundles = $bundles
  }
}

# Write back with stable formatting; PowerShell's ConvertTo-Json re-orders keys
# alphabetically which is acceptable for the dsh bundle loader but suboptimal
# for human readability 鈥?we keep insertion order via an ordered dictionary.
$depHashtable = [ordered]@{}
foreach ($p in $pkg.dependencies.PSObject.Properties) { $depHashtable[$p.Name] = $p.Value }
$bundlesOrdered = @($pkg.dsh.profile.bundles)

$out = [ordered]@{
  name   = $pkg.name
  description = if ($pkg.description) { $pkg.description } else { '' }
  private = if ($pkg.private) { $pkg.private } else { $true }
  dependencies = $depHashtable
}
# Preserve any other top-level fields we touched.
if ($pkg.devDependencies)     { $out['devDependencies'] = $pkg.devDependencies }
if ($pkg.scripts)             { $out['scripts'] = $pkg.scripts }
if ($pkg.dsh) {
  $dshOut = [ordered]@{}
  if ($pkg.dsh.profile) {
    $dshOut['profile'] = [ordered]@{ bundles = $bundlesOrdered }
  } else { $dshOut = $pkg.dsh }
  $out['dsh'] = $dshOut
}

$json = $out | ConvertTo-Json -Depth 8
Set-Content -Path $profilePkg -Value $json -Encoding UTF8

Write-Host "[install-all] package.json written; running pnpm install鈥? -ForegroundColor Cyan

Push-Location $profileDir
try {
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
