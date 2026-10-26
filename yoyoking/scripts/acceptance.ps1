param(
  [Parameter(Mandatory=$true)][string]$HarnessCheckout,
  [Parameter(Mandatory=$true)][string]$JyInstallDirectory,
  [string]$PackagePath,
  [switch]$UseProfileWorkspace,
  [string]$InstalledExecutable,
  [string]$InstalledCliRunner,
  [string]$InstalledCliLauncher
)
$ErrorActionPreference = 'Stop'
$pluginDir = Split-Path -Parent $PSScriptRoot
if (!$PackagePath) { $PackagePath = $pluginDir }
$packageTarget = (Resolve-Path -LiteralPath $PackagePath).Path
$repoDir = Split-Path -Parent $pluginDir
$harnessDir = (Resolve-Path -LiteralPath $HarnessCheckout).Path
if (!(Test-Path -LiteralPath (Join-Path $harnessDir 'apps/cli/src/bin.ts'))) { throw 'Expected a DeepSeek Harness source checkout' }
$runDir = Join-Path $repoDir ('build/yoyoking-profile-' + [guid]::NewGuid().ToString('N').Substring(0,12))
New-Item -ItemType Directory -Path (Join-Path $runDir 'input') -Force | Out-Null
$overlay = @(
  @{id='preset-standard'; disabled=$true},
  @{id='preset-ptc'; disabled=$true},
  @{id='preset-minimal'; disabled=$true},
  @{id='preset-cordis'; disabled=$true},
  @{id='hmr'; disabled=$true},
  @{insert=@(@{id='yoyoking-profile-acceptance'; name=([uri](Join-Path $pluginDir 'tests/profile-probe.mjs')).AbsoluteUri; config=@{directory=$runDir}})}
)
$patchPath = Join-Path $runDir 'acceptance.patch.json'
$overlay | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $patchPath -Encoding UTF8
$keys = @('DSH_HOME','DSH_TELEMETRY_DISABLED','YOYOKING_WORKSPACE','YOYOKING_MEDIA_ROOTS','YOYOKING_JY_INSTALL_DIR','ELECTRON_RUN_AS_NODE')
$previous = @{}
foreach ($key in $keys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
try {
  if ($InstalledExecutable) {
    if (!$InstalledCliRunner) { throw 'InstalledCliRunner is required with InstalledExecutable' }
    $env:ELECTRON_RUN_AS_NODE = '1'
  }
  function Invoke-HarnessDsh {
    if ($InstalledCliLauncher) { & node $InstalledCliLauncher @args }
    elseif ($InstalledExecutable) { & $InstalledExecutable --expose-internals $InstalledCliRunner @args }
    else { & node --import tsx/esm apps/cli/src/bin.ts @args }
  }
  $env:DSH_HOME = Join-Path $runDir 'harness-home'
  $env:DSH_TELEMETRY_DISABLED = '1'
  $env:YOYOKING_WORKSPACE = if ($UseProfileWorkspace) { $null } else { Join-Path $runDir 'workspace' }
  $env:YOYOKING_MEDIA_ROOTS = ConvertTo-Json -InputObject @((Join-Path $runDir 'input')) -Compress
  $env:YOYOKING_JY_INSTALL_DIR = (Resolve-Path -LiteralPath $JyInstallDirectory).Path
  Push-Location -LiteralPath $harnessDir
  try {
    Invoke-HarnessDsh --profile yoyoking-acceptance --from-default-profile web --dump-config | Set-Content -LiteralPath (Join-Path $runDir 'initial-config.yml') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'Profile initialization failed' }
    Invoke-HarnessDsh plugin --profile yoyoking-acceptance add $packageTarget --config.auto-install-peers=false --offline --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Official plugin installation failed' }
    Invoke-HarnessDsh --profile yoyoking-acceptance --patch $patchPath --dump-config | Set-Content -LiteralPath (Join-Path $runDir 'installed-config.yml') -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw 'Installed profile composition failed' }
    Invoke-HarnessDsh --profile yoyoking-acceptance --patch $patchPath --no-open --port $port
    $launchExit = $LASTEXITCODE
    $receiptPath = Join-Path $runDir 'acceptance.json'
    if (!(Test-Path -LiteralPath $receiptPath)) { throw "Profile did not produce a receipt (exit $launchExit): $runDir" }
    $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$receipt.passed) { throw "Profile acceptance failed; inspect $receiptPath" }
    Write-Output "Acceptance passed: $receiptPath"
  } finally { Pop-Location }
} finally {
  foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
}
