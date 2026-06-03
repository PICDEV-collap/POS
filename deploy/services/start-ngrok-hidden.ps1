param()

$ErrorActionPreference = 'Stop'

$serviceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $serviceDir '..\..')
$logDir = Join-Path $rootDir 'deploy\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$ngrokPort = if ($env:NGROK_PORT) { $env:NGROK_PORT } else { '3000' }
$ngrokConfig = $env:NGROK_CONFIG
if (-not $ngrokConfig) {
  $candidate = Join-Path $rootDir 'deploy\ngrok.yml'
  if (Test-Path -LiteralPath $candidate) { $ngrokConfig = $candidate }
}
$ngrokTunnel = $env:NGROK_TUNNEL
if (-not $ngrokTunnel -and $ngrokConfig) { $ngrokTunnel = 'pos-v2' }
$ngrokDomain = $env:NGROK_DOMAIN

function Resolve-NgrokExe {
  if ($env:NGROK_EXE) {
    if (Test-Path -LiteralPath $env:NGROK_EXE) { return $env:NGROK_EXE }
    throw "NGROK_EXE is set but file was not found: $env:NGROK_EXE"
  }

  $pathCommand = Get-Command ngrok -ErrorAction SilentlyContinue
  $pathNgrok = if ($pathCommand) { $pathCommand.Source } else { $null }
  if ($pathNgrok) { return $pathNgrok }

  $candidates = @(
    'C:\ngrok\ngrok.exe',
    (Join-Path $env:USERPROFILE 'ngrok.exe'),
    (Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.exe'),
    (Join-Path $rootDir 'tools\ngrok.exe'),
    (Join-Path $rootDir 'ngrok.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw 'ngrok not found. Install ngrok or set PATH/NGROK_EXE.'
}

$ngrokExe = Resolve-NgrokExe
$outLog = Join-Path $logDir 'ngrok.out.log'
$errLog = Join-Path $logDir 'ngrok.err.log'

Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 700

$ngrokArgs = @()
if ($ngrokTunnel) {
  $ngrokArgs += @('start', $ngrokTunnel)
  if ($ngrokConfig) { $ngrokArgs += @('--config', $ngrokConfig) }
} elseif ($ngrokDomain) {
  $ngrokArgs += @('http', "--domain=$ngrokDomain", $ngrokPort)
  if ($ngrokConfig) { $ngrokArgs += @('--config', $ngrokConfig) }
} else {
  $ngrokArgs += @('http', $ngrokPort)
  if ($ngrokConfig) { $ngrokArgs += @('--config', $ngrokConfig) }
}
$ngrokArgs += @('--log=stdout')

Set-Content -Path $outLog -Value '' -Encoding UTF8
Set-Content -Path $errLog -Value '' -Encoding UTF8

$process = Start-Process -FilePath $ngrokExe `
  -ArgumentList $ngrokArgs `
  -WorkingDirectory $rootDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -PassThru

Start-Sleep -Seconds 3
if ($process.HasExited) {
  $stderr = if (Test-Path -LiteralPath $errLog) { Get-Content -Raw -LiteralPath $errLog } else { '' }
  $stdout = if (Test-Path -LiteralPath $outLog) { Get-Content -Raw -LiteralPath $outLog } else { '' }
  $details = (($stderr, $stdout) -join "`n").Trim()
  if (-not $details) { $details = "ngrok exited with code $($process.ExitCode)." }
  throw $details
}

try {
  $tunnels = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2
  $url = $tunnels.tunnels |
    Where-Object { $_.public_url -like 'https://*' } |
    Select-Object -First 1 -ExpandProperty public_url
  if ($url) { Write-Host "ngrok public URL: $url" } else { Write-Host 'ngrok started; public URL not ready yet.' }
} catch {
  Write-Host "ngrok started hidden; process id: $($process.Id). Inspect API not ready yet."
}
