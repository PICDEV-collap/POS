param(
  [switch]$CheckOnly,
  [switch]$Emergency,
  [switch]$RestartBackend,
  [string]$PgServiceName = $env:POS_PG_SERVICE,
  [string]$PgDataDir = $env:POS_PG_DATA,
  [string]$PgHome = $env:POS_PG_HOME
)

$ErrorActionPreference = 'Stop'

$serviceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Resolve-Path (Join-Path $serviceDir '..\..')
$logDir = Join-Path $rootDir 'deploy\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'ensure-postgresql.log'

function Write-Log {
  param([string]$Message)
  $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $Message
}

function Test-Admin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-PostgresPaths {
  param([string]$HomeOverride, [string]$DataOverride)

  $pgHomeRoot = $null
  if ($HomeOverride -and (Test-Path -LiteralPath (Join-Path $HomeOverride 'bin\pg_ctl.exe'))) {
    $pgHomeRoot = $HomeOverride
  } else {
    $candidates = @()
    $roots = Get-ChildItem -Path 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue
    if ($roots) {
      $candidates = $roots | ForEach-Object { $_.FullName }
    }
    if ($candidates.Count -eq 0) {
      $candidates = 18, 17, 16, 15, 14 | ForEach-Object {
        Join-Path 'C:\Program Files\PostgreSQL' $_
      }
    }
    foreach ($dir in ($candidates | Sort-Object -Descending)) {
      $pgCtlCandidate = Join-Path $dir 'bin\pg_ctl.exe'
      if (Test-Path -LiteralPath $pgCtlCandidate) {
        $pgHomeRoot = $dir
        break
      }
    }
    if (-not $pgHomeRoot) {
      throw 'PostgreSQL not found under C:\Program Files\PostgreSQL. Set POS_PG_HOME.'
    }
  }

  $pgCtl = Join-Path $pgHomeRoot 'bin\pg_ctl.exe'
  $data = if ($DataOverride) {
    $DataOverride
  } else {
    Join-Path $pgHomeRoot 'data'
  }

  if (-not (Test-Path -LiteralPath $data)) {
    throw "PostgreSQL data directory not found: $data"
  }

  return @{
    Home = $pgHomeRoot
    PgCtl = $pgCtl
    DataDir = $data
  }
}

function Resolve-PostgresServiceName {
  param([string]$Override)

  if ($Override) { return $Override }

  $svc = Get-Service -Name 'postgresql-x64-*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if ($svc) { return $svc.Name }

  $legacy = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'postgresql-x64-*' } |
    Select-Object -First 1
  if ($legacy) { return $legacy.Name }

  return 'postgresql-x64-18'
}

function Get-PgCtlStatus {
  param([string]$PgCtl, [string]$DataDir)
  $raw = & $PgCtl status -D $DataDir 2>&1 | Out-String
  return @{
    Raw = $raw.Trim()
    Running = $raw -match 'server is running'
  }
}

function Test-DbConnection {
  $script = Join-Path $rootDir 'backend\scripts\pg-conn-info.js'
  if (-not (Test-Path -LiteralPath $script)) {
    Write-Log "skip DB probe - $script not found"
    return $false
  }
  Push-Location (Join-Path $rootDir 'backend')
  try {
    $out = node $script 2>&1 | Out-String
    Write-Log $out.Trim()
    return $LASTEXITCODE -eq 0
  } finally {
    Pop-Location
  }
}

function Test-AuthStores {
  try {
    $res = Invoke-WebRequest -Uri 'http://127.0.0.1:4000/api/auth/stores' -UseBasicParsing -TimeoutSec 8
    Write-Log "GET /api/auth/stores -> $($res.StatusCode)"
    return $res.StatusCode -eq 200
  } catch {
    Write-Log "GET /api/auth/stores failed: $($_.Exception.Message)"
    return $false
  }
}

function Stop-ManualPostgres {
  param([string]$PgCtl, [string]$DataDir)
  $status = Get-PgCtlStatus -PgCtl $PgCtl -DataDir $DataDir
  if (-not $status.Running) { return }
  Write-Log 'Stopping manual PostgreSQL process (pg_ctl)...'
  & $PgCtl stop -D $DataDir -m fast 2>&1 | ForEach-Object { Write-Log $_ }
  Start-Sleep -Seconds 2
}

function Start-PostgresService {
  param([string]$Name)
  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) {
    throw "Windows service not found: $Name (set POS_PG_SERVICE)"
  }
  if ($svc.Status -eq 'Running') {
    Write-Log "PostgreSQL service already running: $Name"
    return 'running'
  }
  Write-Log "Starting PostgreSQL service: $Name"
  Start-Service -Name $Name
  Start-Sleep -Seconds 3
  $svc.Refresh()
  if ($svc.Status -ne 'Running') {
    throw "Service $Name did not reach Running (status=$($svc.Status))"
  }
  Write-Log "PostgreSQL service started: $Name"
  return 'started'
}

function Start-PostgresEmergency {
  param([string]$PgCtl, [string]$DataDir)
  $status = Get-PgCtlStatus -PgCtl $PgCtl -DataDir $DataDir
  if ($status.Running) {
    Write-Log 'PostgreSQL already running (manual pg_ctl process)'
    return 'running'
  }
  Write-Log 'Emergency start via pg_ctl (Windows service may stay Stopped)...'
  & $PgCtl start -D $DataDir -l (Join-Path $DataDir 'log\pos-v2-ensure-start.log') 2>&1 |
    ForEach-Object { Write-Log $_ }
  Start-Sleep -Seconds 3
  $status = Get-PgCtlStatus -PgCtl $PgCtl -DataDir $DataDir
  if (-not $status.Running) {
    throw 'pg_ctl start failed - see PostgreSQL log folder'
  }
  Write-Log 'PostgreSQL started via pg_ctl'
  return 'emergency'
}

function Restart-PosBackend {
  $exe = Join-Path $serviceDir 'pos-v2-backend.exe'
  if (-not (Test-Path -LiteralPath $exe)) {
    Write-Log "skip backend restart - $exe not found"
    return
  }
  Write-Log 'Restarting pos-v2-backend...'
  & $exe restart 2>&1 | ForEach-Object { Write-Log $_ }
  Start-Sleep -Seconds 2
}

try {
  Write-Log '=== ensure-postgresql ==='
  $paths = Resolve-PostgresPaths -HomeOverride $PgHome -DataOverride $PgDataDir
  $pgService = Resolve-PostgresServiceName -Override $PgServiceName
  $isAdmin = Test-Admin

  Write-Log "PG home: $($paths.Home)"
  Write-Log "PG data: $($paths.DataDir)"
  Write-Log "PG service: $pgService"
  Write-Log "Admin: $isAdmin | Emergency: $Emergency | CheckOnly: $CheckOnly"

  $svc = Get-Service -Name $pgService -ErrorAction SilentlyContinue
  if ($svc) {
    Write-Log "Service status before: $($svc.Status)"
  } else {
    Write-Log "Service $pgService not registered"
  }

  $pgStatus = Get-PgCtlStatus -PgCtl $paths.PgCtl -DataDir $paths.DataDir
  Write-Log "pg_ctl status: $($pgStatus.Raw)"

  if ($CheckOnly) {
    $dbOk = Test-DbConnection
    $apiOk = Test-AuthStores
    if ($pgStatus.Running -and $dbOk) {
      Write-Log 'CHECK OK - PostgreSQL reachable'
      exit 0
    }
    Write-Log 'CHECK FAIL - PostgreSQL down or DB unreachable'
    exit 1
  }

  $mode = $null
  if ($Emergency -or -not $isAdmin) {
    if (-not $isAdmin) {
      Write-Log 'Not running as Administrator - using emergency pg_ctl start'
    }
    $mode = Start-PostgresEmergency -PgCtl $paths.PgCtl -DataDir $paths.DataDir
  } else {
    Stop-ManualPostgres -PgCtl $paths.PgCtl -DataDir $paths.DataDir
    $mode = Start-PostgresService -Name $pgService
  }

  if (-not (Test-DbConnection)) {
    throw 'PostgreSQL is up but backend cannot connect - check backend/.env PGPASSWORD'
  }

  if ($RestartBackend) {
    Restart-PosBackend
    Test-AuthStores | Out-Null
  }

  Write-Log "DONE mode=$mode"
  if ($mode -eq 'emergency') {
    Write-Log 'WARN: PostgreSQL runs via pg_ctl only - Start-Service as Admin after reboot'
  }
  exit 0
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  exit 1
}
