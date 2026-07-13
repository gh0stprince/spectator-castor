$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Close Hermes through Electron first so its before-quit handler can flush state
# and stop the backend child. Only then terminate a stuck Spectator process.
$cleanup = Start-Process node.exe -ArgumentList @("src/cli.js", "--close-desktop") -NoNewWindow -PassThru -Wait
if ($cleanup.ExitCode -ne 0) { throw "Hermes Desktop did not close cleanly. See the error above." }

$managed = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq "node.exe" -and
  $_.CommandLine -match 'src[\\/]cli\.js' -and
  $_.CommandLine -match '--manage-desktop'
}

foreach ($process in $managed) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Spectator and Hermes Desktop are closed. The next Hermes launch will be standalone." -ForegroundColor Green
