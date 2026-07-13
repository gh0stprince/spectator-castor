$ErrorActionPreference = "Stop"
$matches = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
  Where-Object { $_.CommandLine -like '*spectator*session-watcher.py*' }
foreach ($process in $matches) {
  Stop-Process -Id $process.ProcessId -Force
  Write-Host "Stopped Spectator CLI watcher PID $($process.ProcessId)."
}
if (-not $matches) { Write-Host "Spectator CLI watcher was not running." }
