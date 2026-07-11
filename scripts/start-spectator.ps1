param(
  [int]$HermesPort = 9119,
  [int]$TapPort = 9121,
  [int]$ViewerPort = 8787,
  [string]$ViewKey = $env:SPECTATOR_VIEW_KEY,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ExtraArgs
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $env:HERMES_DASHBOARD_SESSION_TOKEN) {
  $envFiles = @(
    (Join-Path $HOME ".hermes\.env"),
    (Join-Path $env:USERPROFILE ".hermes\.env"),
    (Join-Path $env:LOCALAPPDATA "hermes\.env")
  ) | Select-Object -Unique

  foreach ($envFile in $envFiles) {
    if (-not (Test-Path $envFile)) { continue }
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*HERMES_DASHBOARD_SESSION_TOKEN\s*=' } | Select-Object -Last 1
    if ($line) {
      $env:HERMES_DASHBOARD_SESSION_TOKEN = (($line -split '=', 2)[1]).Trim().Trim('"').Trim("'")
      break
    }
  }
}

if (-not $env:HERMES_DASHBOARD_SESSION_TOKEN) {
  throw "No HERMES_DASHBOARD_SESSION_TOKEN found. Pin it in ~/.hermes/.env or %LOCALAPPDATA%\hermes\.env."
}

try {
  $status = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$HermesPort/api/status"
  if ($status.StatusCode -ne 200) { throw "status $($status.StatusCode)" }
} catch {
  throw "Hermes is not ready on 127.0.0.1:$HermesPort. First run: hermes dashboard --no-open"
}

Write-Host "Starting Spectator. Keep this window open; press Ctrl+C to stop and restore Hermes." -ForegroundColor Yellow
$cliArgs = @(
  "src/cli.js",
  "--hermes-url", "http://127.0.0.1:$HermesPort",
  "--port", "$ViewerPort",
  "--tap-port", "$TapPort",
  "--manage-desktop",
  "--persist", ".spectator/session-events.jsonl"
)
if ($ViewKey) { $cliArgs += @("--view-key", $ViewKey) }
if ($ExtraArgs) { $cliArgs += $ExtraArgs }
& node.exe @cliArgs

if ($LASTEXITCODE -ne 0) {
  Write-Warning "Spectator exited unexpectedly. Running the Hermes restore safety net."
  & node.exe src/cli.js --restore-desktop
  exit $LASTEXITCODE
}
