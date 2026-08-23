$ErrorActionPreference = 'Stop'
$lines = Get-Content 'H:\scripts\install-all.ps1'

function Test-Range {
  param([int]$End)
  $subset = $lines[0..($End-1)]
  $tmp = 'H:\scripts\_test.ps1'
  Set-Content -Path $tmp -Value $subset -Encoding UTF8
  $out = powershell -NoProfile -ExecutionPolicy Bypass -File $tmp 2>&1
  $rc = $LASTEXITCODE
  Remove-Item $tmp -ErrorAction SilentlyContinue
  return @{
    rc = $rc
    first = ($out | Select-Object -First 1)
  }
}

$bad = 117
$good = 50
while (($bad - $good) -gt 1) {
  $mid = [int][Math]::Floor(($bad + $good) / 2)
  $r = Test-Range $mid
  if ($r.rc -ne 0) {
    Write-Output ("fail at {0}: {1}" -f $mid, $r.first)
    $bad = $mid
  } else {
    Write-Output ("ok at {0}" -f $mid)
    $good = $mid
  }
}
Write-Output ("smallest failing cut: {0} (good baseline at {1})" -f $bad, $good)
for ($i = [Math]::Max(0, $bad - 3); $i -le [Math]::Min($bad + 1, $lines.Count); $i++) {
  Write-Output ("L{0}: {1}" -f ($i+1), $lines[$i])
}
