$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Normal shutdown is Ctrl+C in the Start window. This is the recovery path when
# that window was closed or the process became stuck.
$managed = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq "node.exe" -and
  $_.CommandLine -match 'src[\\/]cli\.js' -and
  $_.CommandLine -match '--manage-desktop'
}

foreach ($process in $managed) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

& node.exe src/cli.js --restore-desktop
if ($LASTEXITCODE -ne 0) { throw "Hermes restore failed. See the error above." }
Write-Host "Spectator is stopped and Hermes has been reopened normally." -ForegroundColor Green
