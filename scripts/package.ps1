# Package jy-draftc into dist\jy-draftc-<jianying version>-<yyMMddHH of now>-windows-amd64.zip
# Usage: pwsh -File scripts\package.ps1 [-SkipBuild]
param(
    [switch]$SkipBuild,
    [string]$OutDir = (Join-Path $PSScriptRoot '..\dist')
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$exe = Join-Path $root 'build\jy-draftc.exe'

if (-not $SkipBuild) {
    Write-Host '[package] building'
    $build = (& (Join-Path $root 'build.bat') 2>&1 | Out-String)
    $build | Out-Host
    if ($build -notmatch '\[build\].*\bok\b') { throw 'build failed (see output above)' }
}
if (-not (Test-Path -LiteralPath $exe)) { throw "missing $exe (run build.bat first)" }

# Version strings come from the binary itself, not from a duplicated literal.
$version = & $exe -v | Out-String
$tool = [regex]::Match($version, 'jy-draftc\s+([0-9][0-9.]*)').Groups[1].Value
$cam = [regex]::Match($version, '(?:jianying|绑定剪映)\s*\(?([0-9][0-9.]*)').Groups[1].Value
if (-not $tool -or -not $cam) { throw "cannot read version from '$version'" }

# Package name: jy-draftc-<jianying version>-<yy><MM><dd><HH>-windows-amd64 (e.g. -26101113 for 2026-10-11 13:00).
$stamp = Get-Date -Format 'yyMMddHH'
$name = "jy-draftc-$cam-$stamp-windows-amd64"
$stage = Join-Path $OutDir $name
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Copy-Item -LiteralPath $exe -Destination $stage
foreach ($file in 'README.md', '.env.example') {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination $stage
}
& $exe -h > (Join-Path $stage 'USAGE.txt')

# SHA256SUMS.txt (relative names, one per line, sorted).
$sums = Get-ChildItem -LiteralPath $stage -File |
    Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
    Sort-Object Name |
    ForEach-Object { '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $_.Name }
Set-Content -LiteralPath (Join-Path $stage 'SHA256SUMS.txt') -Value $sums -Encoding ASCII

$zip = Join-Path $OutDir "$name.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host ''
Write-Host ("[package] {0}  ({1:N0} bytes)" -f $zip, (Get-Item -LiteralPath $zip).Length)
exit 0
