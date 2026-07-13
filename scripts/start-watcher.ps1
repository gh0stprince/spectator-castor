$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$existing = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
  Where-Object { $_.CommandLine -like '*spectator*session-watcher.py*' }
if ($existing) {
  Write-Host "Spectator CLI watcher is already running (PID $($existing.ProcessId))."
  exit 0
}

Write-Host "Starting Spectator CLI watcher from $root"
$python = Join-Path $env:LOCALAPPDATA "Programs\Python\Python310\python.exe"
if (-not (Test-Path $python)) { $python = (Get-Command python.exe).Source }
$stdout = Join-Path $root ".spectator\watcher.stdout.log"
$stderr = Join-Path $root ".spectator\watcher.stderr.log"
New-Item -ItemType Directory -Force -Path (Split-Path $stdout) | Out-Null
Start-Process -FilePath $python -ArgumentList @("session-watcher.py") -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Write-Host "Spectator CLI watcher started with $python"
